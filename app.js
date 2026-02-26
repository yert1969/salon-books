// ================================================================
//  SALON BOOKS — Main Application Logic
//  Data layer: Firebase Firestore  |  Auth: Google Sign-In
// ================================================================

'use strict';

// ----------------------------------------------------------------
// 1. FIREBASE INITIALIZATION
// ----------------------------------------------------------------

const firebaseConfig = {
  apiKey:            "AIzaSyAQ4HdSBoCDFe5I3k-aWXMCO-98N_44Cso",
  authDomain:        "mane-frame-salon.firebaseapp.com",
  projectId:         "mane-frame-salon",
  storageBucket:     "mane-frame-salon.firebasestorage.app",
  messagingSenderId: "261521689074",
  appId:             "1:261521689074:web:7d095aa53fd87301d8036b",
};

firebase.initializeApp(firebaseConfig);

const auth      = firebase.auth();
const firestore = firebase.firestore();

// Enable offline persistence so the app works without a network
firestore.enablePersistence({ synchronizeTabs: true })
  .catch(err => {
    if (err.code === 'failed-precondition') {
      console.warn('Firestore persistence: multiple tabs open.');
    } else if (err.code === 'unimplemented') {
      console.warn('Firestore persistence not available in this browser.');
    }
  });

// ----------------------------------------------------------------
// 2. AUTH STATE & CURRENT USER
// ----------------------------------------------------------------

// Holds the currently signed-in Firebase user (or null)
let currentUser = null;

// Returns a Firestore CollectionReference scoped to the signed-in user.
// Called lazily — only when an actual DB operation runs, after auth.
function userCol(name) {
  if (!currentUser) throw new Error('Not authenticated — cannot access DB.');
  return firestore.collection('users').doc(currentUser.uid).collection(name);
}

// ----------------------------------------------------------------
// 3. DB COMPATIBILITY SHIM  (drop-in Dexie replacement)
//
// Exposes a Dexie-like API so all existing app code works unchanged:
//   db.transactions.add(record)
//   db.transactions.where('date').equals(date).toArray()
//   db.settings.get('pin')
//   db.settings.put({key, value})
//   db.transaction('rw', ...tables, fn)
// ----------------------------------------------------------------

// Converts a Firestore DocumentSnapshot into a plain object with id field.
function docToObj(doc) {
  if (!doc.exists) return undefined;
  return { ...doc.data(), id: doc.id };
}

// Converts a Firestore QuerySnapshot into an array of plain objects.
function snapToArr(snap) {
  return snap.docs.map(d => ({ ...d.data(), id: d.id }));
}

// Creates a table wrapper for a Firestore collection.
function makeTable(colName) {
  // Lazy accessor — resolved at call time so currentUser is always set
  const col = () => userCol(colName);

  return {
    // ---- Read all ----
    async toArray() {
      const snap = await col().get();
      return snapToArr(snap);
    },

    // ---- Read one by Firestore doc ID ----
    async get(id) {
      const doc = await col().doc(String(id)).get();
      return docToObj(doc);
    },

    // ---- Insert (returns new string ID) ----
    async add(data) {
      const ref = await col().add(data);
      return ref.id;
    },

    // ---- Update fields on existing doc ----
    async update(id, changes) {
      await col().doc(String(id)).update(changes);
    },

    // ---- Delete a doc ----
    async delete(id) {
      await col().doc(String(id)).delete();
    },

    // ---- Delete all docs (used by restore) ----
    async clear() {
      const snap = await col().get();
      const batch = firestore.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    },

    // ---- Bulk insert (used by restore) ----
    async bulkAdd(records) {
      const CHUNK = 499; // Firestore batch limit is 500 ops
      for (let i = 0; i < records.length; i += CHUNK) {
        const batch = firestore.batch();
        records.slice(i, i + CHUNK).forEach(r => {
          batch.set(col().doc(), r); // auto-ID
        });
        await batch.commit();
      }
    },

    // ---- Query builder — mirrors Dexie's .where().equals() API ----
    where(field) {
      return {
        equals(value) {
          const q = col().where(field, '==', value);

          return {
            // Return all matching docs
            async toArray() {
              const snap = await q.get();
              return snapToArr(snap);
            },

            // Return first matching doc
            async first() {
              const snap = await q.limit(1).get();
              if (snap.empty) return undefined;
              return docToObj(snap.docs[0]);
            },

            // Apply an additional client-side filter, then return first match.
            // Used for saveRentPayment() to check if payment exists for a week.
            filter(fn) {
              return {
                async first() {
                  const snap = await q.get();
                  return snapToArr(snap).find(fn);
                },
              };
            },

            // Reverse order + limit — used for renter payment history.
            // Tries a Firestore server-side sort; falls back to client-side.
            reverse() {
              return {
                limit(n) {
                  return {
                    async toArray() {
                      try {
                        const snap = await q.orderBy('weekStart', 'desc').limit(n).get();
                        return snapToArr(snap);
                      } catch (_) {
                        // No composite index yet — sort client-side
                        const snap = await q.get();
                        return snapToArr(snap)
                          .sort((a, b) => (b.weekStart > a.weekStart ? 1 : -1))
                          .slice(0, n);
                      }
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

// ---- Settings table (special: key is the document ID) ----
const settingsTable = {
  async get(key) {
    try {
      const doc = await userCol('settings').doc(key).get();
      if (!doc.exists) return undefined;
      return { key: doc.id, ...doc.data() };
    } catch(_) { return undefined; }
  },

  // Dexie put({key, value}) → Firestore set at settings/{key}
  async put(obj) {
    const { key } = obj;
    // Skip Firebase sync for categories - they're saved separately in clean format
    if (key === 'categories') {
      // Only save to local Dexie, not Firebase
      return;
    }
    await userCol('settings').doc(key).set(obj);
  },

  async delete(key) {
    await userCol('settings').doc(key).delete();
  },

  async toArray() {
    const snap = await userCol('settings').get();
    return snap.docs.map(d => ({ key: d.id, ...d.data() }));
  },

  async clear() {
    const snap = await userCol('settings').get();
    const batch = firestore.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  },

  async bulkAdd(records) {
    const batch = firestore.batch();
    records.forEach(r => {
      const ref = userCol('settings').doc(r.key);
      batch.set(ref, r);
    });
    await batch.commit();
  },
};

// ---- The db object exposed to all app code ----
const db = {
  transactions:    makeTable('transactions'),
  dailySummary:    makeTable('dailySummary'),
  monthlyExpenses: makeTable('monthlyExpenses'),
  renters:         makeTable('renters'),
  rentPayments:    makeTable('rentPayments'),
  settings:        settingsTable,

  // Restore uses db.transaction('rw', ...tables, fn).
  // Firestore handles its own atomicity; we just call fn().
  async transaction(_mode, ...args) {
    const fn = args[args.length - 1];
    return fn();
  },
};

// ----------------------------------------------------------------
// 4. GOOGLE SIGN-IN / SIGN-OUT
// ----------------------------------------------------------------

async function signInWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    await auth.signInWithPopup(provider);
    // onAuthStateChanged below will fire and boot the app
  } catch (err) {
    if (err.code !== 'auth/popup-closed-by-user') {
      showToast('Sign-in failed — please try again');
      console.error(err);
    }
  }
}

async function signOutUser() {
  if (!confirm('Sign out of Mane Frame?')) return;
  await auth.signOut();
  // onAuthStateChanged fires → shows login screen
}

// ----------------------------------------------------------------
// 5. APP STATE
// ----------------------------------------------------------------

const state = {
  currentView:       'entries',
  selectedDate:      todayStr(),
  selectedMonth:     new Date().getMonth() + 1,
  selectedYear:      new Date().getFullYear(),
  reportType:        'daily',
  pinBuffer:         '',
  pinEnabled:        false,
  rentersWeekStart:  null,
  showRentersTab:    false,  // Updated by updateRentersTabVisibility() on boot
  entriesViewMode:   'daily', // 'daily', 'monthly', or 'all'
  categories:        { INCOME: [], EXPENSE: [] },
};

// ----------------------------------------------------------------
// 6. UTILITY FUNCTIONS
// ----------------------------------------------------------------

function todayStr() {
  // Force local timezone by using date parts, not ISO string
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Helper to ensure date input always shows correct local date
function ensureLocalDate(dateStr) {
  if (!dateStr) return todayStr();
  // If dateStr is valid YYYY-MM-DD, return as-is
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }
  // Otherwise return today
  return todayStr();
}

function formatDateDisplay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
}

function formatDateShort(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmt(amount) {
  if (amount === null || amount === undefined || isNaN(amount)) return '$0.00';
  return '$' + parseFloat(amount).toFixed(2);
}

function monthName(num) {
  return new Date(2000, num - 1, 1).toLocaleString('en-US', { month: 'long' });
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function getWeekStart(dateStr) {
  const d   = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split('T')[0];
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 2200);
}

// ----------------------------------------------------------------
// 7. CATEGORY MANAGEMENT
// ----------------------------------------------------------------

function _defaultCategoryMap() {
  return {
    INCOME: [
      'Haircut', 'Color', 'Highlights', 'Blowout', 'Treatment',
      'Nails', 'Waxing', 'Retail Product', 'Other',
    ],
    EXPENSE: [
      'Supplies', 'Products', 'Tools/Equipment', 'Advertising',
      'Education', 'Meals', 'Employee Pay', 'Rent', 'Electric', 
      'Water', 'Gas', 'Insurance', 'Cleaning Service', 
      'Booking Software', 'Phone', 'Marketing', 'Other',
    ],
  };
}

// Real-time category sync listener
// Categories are synced on app load/refresh, not in real-time
// This avoids race conditions with Firebase listeners

async function loadCategories() {
  console.log('🔍 loadCategories() started');
  try {
    // If logged in, try loading from Firebase first
    if (auth && auth.currentUser) {
      console.log('✓ User logged in:', auth.currentUser.uid);
      try {
        console.log('📥 Fetching categories from Firebase...');
        const doc = await firestore.collection('users')
          .doc(auth.currentUser.uid)
          .collection('settings')
          .doc('categories')
          .get();
        
        console.log('Firebase doc exists?', doc.exists);
        
        if (doc.exists) {
          const firestoreCategories = doc.data();
          console.log('📦 Firebase data:', JSON.stringify(firestoreCategories));
          console.log('Firebase has EXPENSE?', !!firestoreCategories.EXPENSE);
          console.log('Firebase has DAILY_EXPENSE?', !!firestoreCategories.DAILY_EXPENSE);
          console.log('Firebase has MONTHLY_EXPENSE?', !!firestoreCategories.MONTHLY_EXPENSE);
          
          // Support both old and new formats
          if (firestoreCategories.EXPENSE) {
            console.log('✓ Using NEW format from Firebase');
            console.log('EXPENSE count:', firestoreCategories.EXPENSE?.length);
            // New unified format
            state.categories = {
              INCOME: firestoreCategories.INCOME?.length ? firestoreCategories.INCOME : _defaultCategoryMap().INCOME,
              EXPENSE: firestoreCategories.EXPENSE?.length ? firestoreCategories.EXPENSE : _defaultCategoryMap().EXPENSE,
            };
          } else if (firestoreCategories.DAILY_EXPENSE || firestoreCategories.MONTHLY_EXPENSE) {
            console.log('⚠️ Using OLD format from Firebase - migrating locally only');
            // Old format - merge DAILY_EXPENSE and MONTHLY_EXPENSE locally
            // Don't auto-save - only user actions should save to Firebase
            const dailyExpenses = firestoreCategories.DAILY_EXPENSE || [];
            const monthlyExpenses = firestoreCategories.MONTHLY_EXPENSE || [];
            const mergedExpenses = [...new Set([...dailyExpenses, ...monthlyExpenses])];
            console.log('Merged count:', mergedExpenses.length);
            
            state.categories = {
              INCOME: firestoreCategories.INCOME?.length ? firestoreCategories.INCOME : _defaultCategoryMap().INCOME,
              EXPENSE: mergedExpenses.length > 0 ? mergedExpenses : _defaultCategoryMap().EXPENSE,
            };
          } else {
            console.log('⚠️ Firebase has no recognized format - using defaults locally');
            // Firebase document exists but has no recognizable fields - use defaults locally
            state.categories = _defaultCategoryMap();
          }
          
          console.log('✓ Set state.categories - INCOME:', state.categories.INCOME?.length, 'EXPENSE:', state.categories.EXPENSE?.length);
          
          // Save to local storage as backup
          await db.settings.put({ key: 'categories', value: JSON.stringify(state.categories) });
          console.log('✓ Saved to local storage');
          return;
        } else {
          console.log('⚠️ No Firebase document - using defaults locally');
          // No Firebase document - use defaults locally, DON'T save to Firebase
          state.categories = _defaultCategoryMap();
        }
      } catch (err) {
        console.error('❌ Firebase error:', err);
        console.log('Falling through to local storage...');
      }
    } else {
      console.log('⚠️ No user logged in');
    }
    
    // Fallback to local storage
    const saved = await db.settings.get('categories');
    if (saved?.value) {
      const parsed = JSON.parse(saved.value);
      
      // Support both formats
      if (parsed.EXPENSE) {
        state.categories = {
          INCOME: parsed.INCOME?.length ? parsed.INCOME : _defaultCategoryMap().INCOME,
          EXPENSE: parsed.EXPENSE?.length ? parsed.EXPENSE : _defaultCategoryMap().EXPENSE,
        };
      } else {
        // Merge old format
        const dailyExpenses = parsed.DAILY_EXPENSE || [];
        const monthlyExpenses = parsed.MONTHLY_EXPENSE || [];
        const mergedExpenses = [...new Set([...dailyExpenses, ...monthlyExpenses])];
        
        state.categories = {
          INCOME: parsed.INCOME?.length ? parsed.INCOME : _defaultCategoryMap().INCOME,
          EXPENSE: mergedExpenses.length > 0 ? mergedExpenses : _defaultCategoryMap().EXPENSE,
        };
      }
    } else {
      // No local storage either - use defaults locally, DON'T save to Firebase
      state.categories = _defaultCategoryMap();
    }
  } catch (e) {
    console.warn('loadCategories error:', e);
    // On error, use defaults locally, DON'T save to Firebase
    state.categories = _defaultCategoryMap();
  }
}

async function saveCategories() {
  // Save locally
  await db.settings.put({ key: 'categories', value: JSON.stringify(state.categories) });
  
  // Sync to Firebase if user is logged in
  if (auth && auth.currentUser) {
    try {
      await firestore.collection('users')
        .doc(auth.currentUser.uid)
        .collection('settings')
        .doc('categories')
        .set(state.categories);
    } catch (err) {
      console.error('Failed to sync categories to Firebase:', err);
    }
  }
}

function categoryOptions(type) {
  // For expense types, combine both daily and monthly categories
  if (type === 'DAILY_EXPENSE' || type === 'MONTHLY_EXPENSE') {
    const allExpenseCategories = [
      ...(state.categories.DAILY_EXPENSE || []),
      ...(state.categories.MONTHLY_EXPENSE || [])
    ];
    return allExpenseCategories
      .sort()  // Sort alphabetically
      .map(name => `<option value="${name}">${name}</option>`)
      .join('');
  }
  
  // For income, use income categories
  return (state.categories[type] || [])
    .sort()  // Sort alphabetically
    .map(name => `<option value="${name}">${name}</option>`)
    .join('');
}

// ----------------------------------------------------------------
// 8. NAVIGATION
// ----------------------------------------------------------------

/**
 * Updates whether the Renters tab is shown.
 * Auto-hides if no renters exist, unless manually overridden in Settings.
 */
async function updateRentersTabVisibility() {
  // Check for manual override first
  const override = await db.settings.get('showRentersTab');
  
  if (override?.value !== undefined) {
    // Manual override exists — respect it
    state.showRentersTab = override.value === 'true';
  } else {
    // No override — auto-detect based on renter data
    const allRenters = await db.renters.toArray();
    state.showRentersTab = allRenters.length > 0;
  }
}

/**
 * Wraps render functions with error handling to prevent blank pages
 */
async function safeRender(renderFn, viewName) {
  try {
    await renderFn();
    } catch (err) {
    console.error(`Error rendering ${viewName}:`, err);
    const content = document.getElementById('app-content');
    if (content) {
      content.innerHTML = `
        <div style="padding:40px 20px;text-align:center;">
          <div style="font-size:48px;margin-bottom:16px;">⚠️</div>
          <div style="font-size:18px;font-weight:600;color:var(--danger);margin-bottom:8px;">
            Error loading ${viewName}
          </div>
          <div style="font-size:14px;color:var(--text-muted);margin-bottom:20px;">
            ${err.message || 'Unknown error'}
          </div>
          <button class="btn-primary" onclick="navigate('${state.currentView}')">
            Try Again
          </button>
          <button class="btn-secondary" onclick="location.reload()" style="margin-left:8px;">
            Reload App
          </button>
        </div>
      `;
    }
  }
}

function navigate(view) {
  state.currentView = view;
  
  // Update all nav buttons
  ['entries', 'renters', 'reports', 'settings'].forEach(v => {
    const btn = document.getElementById('nav-' + v);
    if (btn) {
      btn.classList.toggle('active', v === view);
    }
  });
  
  // Always update renters tab visibility when navigating
  const rentersBtn = document.getElementById('nav-renters');
  if (rentersBtn) {
    const shouldShow = state.showRentersTab;
      rentersBtn.style.display = shouldShow ? 'flex' : 'none';
  } else {
    console.warn('Renters button not found in DOM');
  }
  
  const titles = {
    entries:  'Entries',
    renters:  'Booth Renters',
    reports:  'Reports',
    settings: 'Settings',
  };
  document.getElementById('view-title').textContent = titles[view] || '';
  
  const views = {
    entries:  () => safeRender(renderEntriesView, 'Entries'),
    renters:  () => safeRender(renderRentersView, 'Booth Renters'),
    reports:  () => safeRender(renderReportsView, 'Reports'),
    settings: () => safeRender(renderSettingsView, 'Settings'),
  };
  if (views[view]) views[view]();
}

// ----------------------------------------------------------------
// 9. DAILY VIEW
// ----------------------------------------------------------------

// ----------------------------------------------------------------
// ENTRIES VIEW (Unified Income/Expense Entry)
// ----------------------------------------------------------------

async function renderEntriesView() {
  const content = document.getElementById('app-content');
  const hdr = document.getElementById('header-actions');
  hdr.innerHTML = '';
  
  content.innerHTML = `
    <div class="card" style="margin-bottom:20px;">
      <h3 style="font-size:16px; margin-bottom:16px; font-weight:600;">Add Transaction</h3>
      
      <div class="form-group">
        <label class="form-label" style="font-size:13px; margin-bottom:8px; display:block; font-weight:500;">Type</label>
        <div style="display:flex; gap:16px;">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="radio" name="entry-type" value="INCOME" checked onchange="updateEntryForm()" style="width:20px; height:20px;">
            <span style="font-size:14px;">Income</span>
          </label>
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="radio" name="entry-type" value="EXPENSE" onchange="updateEntryForm()" style="width:20px; height:20px;">
            <span style="font-size:14px;">Expense</span>
          </label>
        </div>
      </div>
      
      <div class="form-group hidden" id="frequency-section">
        <label class="form-label" style="font-size:13px; margin-bottom:8px; display:block; font-weight:500;">Frequency</label>
        <div style="display:flex; gap:16px;">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="radio" name="entry-frequency" value="DAILY" checked onchange="updateEntryForm()" style="width:20px; height:20px;">
            <span style="font-size:14px;">Daily</span>
          </label>
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="radio" name="entry-frequency" value="MONTHLY" onchange="updateEntryForm()" style="width:20px; height:20px;">
            <span style="font-size:14px;">Monthly</span>
          </label>
        </div>
      </div>
      
      <div class="form-group">
        <label class="form-label" style="font-size:13px; margin-bottom:8px; display:block; font-weight:500;">Category</label>
        <select id="entry-category" class="form-select" style="width:100%; padding:12px; font-size:14px;"></select>
      </div>
      
      <div class="form-group" id="service-amount-section">
        <label class="form-label" style="font-size:13px; margin-bottom:8px; display:block; font-weight:500;">Service Amount</label>
        <input type="number" id="entry-amount" class="form-input" step="0.01" placeholder="0.00" style="width:100%; padding:12px; font-size:16px;">
      </div>
      
      <div class="form-group" id="tip-amount-section">
        <label class="form-label" style="font-size:13px; margin-bottom:8px; display:block; font-weight:500;">Tip Amount (optional)</label>
        <input type="number" id="entry-tip" class="form-input" step="0.01" placeholder="0.00" style="width:100%; padding:12px; font-size:16px;">
      </div>
      
      <div class="form-group hidden" id="expense-amount-section">
        <label class="form-label" style="font-size:13px; margin-bottom:8px; display:block; font-weight:500;">Amount</label>
        <input type="number" id="entry-expense-amount" class="form-input" step="0.01" placeholder="0.00" style="width:100%; padding:12px; font-size:16px;">
      </div>
      
      <div class="form-group" id="date-section">
        <label class="form-label" style="font-size:13px; margin-bottom:8px; display:block; font-weight:500;">Date</label>
        <input type="date" id="entry-date" class="form-input" value="${todayStr()}" style="width:100%; padding:12px; font-size:14px;">
      </div>
      
      <div class="form-group hidden" id="month-section">
        <label class="form-label" style="font-size:13px; margin-bottom:8px; display:block; font-weight:500;">Month</label>
        <select id="entry-month" class="form-select" style="width:100%; padding:12px; font-size:14px;">
          ${Array.from({length:12}, (_,i) => i+1).map(m => 
            `<option value="${m}" ${m === state.selectedMonth ? 'selected' : ''}>${monthName(m)}</option>`
          ).join('')}
        </select>
      </div>
      
      <div class="form-group hidden" id="year-section">
        <label class="form-label" style="font-size:13px; margin-bottom:8px; display:block; font-weight:500;">Year</label>
        <select id="entry-year" class="form-select" style="width:100%; padding:12px; font-size:14px;">
          ${[2023,2024,2025,2026,2027].map(y => 
            `<option value="${y}" ${y === state.selectedYear ? 'selected' : ''}>${y}</option>`
          ).join('')}
        </select>
      </div>
      
      <div class="form-group">
        <label class="form-label" style="font-size:13px; margin-bottom:8px; display:block; font-weight:500;">Notes (optional)</label>
        <input type="text" id="entry-notes" class="form-input" placeholder="Add notes..." style="width:100%; padding:12px; font-size:14px;">
      </div>
      
      <button class="btn-primary" onclick="saveEntryTransaction()" style="width:100%; padding:14px; font-size:15px; font-weight:600; margin-top:8px;">
        Add Entry
      </button>
    </div>
    
    <div class="card">
      <h3 style="font-size:16px; margin-bottom:16px; font-weight:600;">Transactions</h3>
      
      <div style="margin-bottom:16px;">
        <input type="text" id="transaction-search" class="form-input" placeholder="Search by category or notes..." 
          style="width:100%; padding:10px; font-size:14px; margin-bottom:8px;"
          oninput="filterTransactions()">
        
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
          <select id="filter-type" class="form-select" style="flex:1; min-width:120px; padding:8px; font-size:13px;" onchange="filterTransactions()">
            <option value="all">All Types</option>
            <option value="INCOME">Income Only</option>
            <option value="EXPENSE">Expenses Only</option>
          </select>
          
          <select id="filter-category" class="form-select" style="flex:1; min-width:120px; padding:8px; font-size:13px;" onchange="filterTransactions()">
            <option value="all">All Categories</option>
          </select>
        </div>
        
        <div style="display:flex; gap:8px; align-items:center;">
          <input type="text" id="filter-amount" class="form-input" placeholder="Amount: 50 or >50 or <50 or 50-100" 
            style="flex:1; padding:8px; font-size:13px;"
            oninput="filterTransactions()">
          
          <button onclick="clearFilters()" class="btn-secondary" style="padding:8px 12px; font-size:13px; white-space:nowrap;">Clear</button>
        </div>
      </div>
      
      <div id="recent-transactions"></div>
      <div id="load-more-container"></div>
    </div>
  `;
  
  updateEntryForm();
  
  // Initialize showing first 30 transactions
  if (!state.transactionsToShow) {
    state.transactionsToShow = 30;
  }
  
  // Populate category filter
  populateCategoryFilter();
  
  await renderRecentTransactions();
}

function populateCategoryFilter() {
  const filterCategory = document.getElementById('filter-category');
  if (!filterCategory) return;
  
  // Get all unique categories from both income and expense
  const allCategories = [
    ...(state.categories.INCOME || []),
    ...(state.categories.EXPENSE || [])
  ];
  const uniqueCategories = [...new Set(allCategories)].sort();
  
  filterCategory.innerHTML = '<option value="all">All Categories</option>' + 
    uniqueCategories.map(cat => `<option value="${cat}">${cat}</option>`).join('');
}

function clearFilters() {
  document.getElementById('transaction-search').value = '';
  document.getElementById('filter-type').value = 'all';
  document.getElementById('filter-category').value = 'all';
  document.getElementById('filter-amount').value = '';
  state.transactionsToShow = 30; // Reset pagination
  filterTransactions();
}

function filterTransactions() {
  state.transactionsToShow = 30; // Reset to first page when filtering
  renderRecentTransactions();
}

async function renderRecentTransactions() {
  const container = document.getElementById('recent-transactions');
  const loadMoreContainer = document.getElementById('load-more-container');
  if (!container) return;
  
  // Get filter values
  const searchText = document.getElementById('transaction-search')?.value.toLowerCase() || '';
  const filterType = document.getElementById('filter-type')?.value || 'all';
  const filterCategory = document.getElementById('filter-category')?.value || 'all';
  const filterAmount = document.getElementById('filter-amount')?.value.trim() || '';
  
  // Parse amount filter
  let amountFilter = null;
  if (filterAmount) {
    if (filterAmount.includes('-')) {
      // Range: 50-100
      const parts = filterAmount.split('-').map(p => parseFloat(p.trim()));
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        amountFilter = { type: 'range', min: parts[0], max: parts[1] };
      }
    } else if (filterAmount.startsWith('>=')) {
      const val = parseFloat(filterAmount.substring(2).trim());
      if (!isNaN(val)) amountFilter = { type: 'gte', value: val };
    } else if (filterAmount.startsWith('<=')) {
      const val = parseFloat(filterAmount.substring(2).trim());
      if (!isNaN(val)) amountFilter = { type: 'lte', value: val };
    } else if (filterAmount.startsWith('>')) {
      const val = parseFloat(filterAmount.substring(1).trim());
      if (!isNaN(val)) amountFilter = { type: 'gt', value: val };
    } else if (filterAmount.startsWith('<')) {
      const val = parseFloat(filterAmount.substring(1).trim());
      if (!isNaN(val)) amountFilter = { type: 'lt', value: val };
    } else {
      // Exact match
      const val = parseFloat(filterAmount);
      if (!isNaN(val)) amountFilter = { type: 'exact', value: val };
    }
  }
  
  // Get all transactions sorted by creation time (newest first)
  let allTransactions = await db.transactions.toArray();
  allTransactions.sort((a, b) => {
    const aTime = a.createdAt?.toDate?.() || new Date(0);
    const bTime = b.createdAt?.toDate?.() || new Date(0);
    return bTime - aTime;
  });
  
  // Apply filters
  allTransactions = allTransactions.filter(t => {
    // Type filter
    if (filterType !== 'all' && t.type !== filterType) return false;
    
    // Category filter
    if (filterCategory !== 'all' && t.category !== filterCategory) return false;
    
    // Search filter (search in category and notes)
    if (searchText) {
      const categoryMatch = t.category?.toLowerCase().includes(searchText);
      const notesMatch = t.notes?.toLowerCase().includes(searchText);
      if (!categoryMatch && !notesMatch) return false;
    }
    
    // Amount filter
    if (amountFilter) {
      const isIncome = t.type === 'INCOME';
      const amount = isIncome ? (t.serviceAmount || 0) + (t.tipAmount || 0) : (t.amount || 0);
      
      switch (amountFilter.type) {
        case 'exact':
          if (Math.abs(amount - amountFilter.value) > 0.01) return false;
          break;
        case 'gt':
          if (amount <= amountFilter.value) return false;
          break;
        case 'gte':
          if (amount < amountFilter.value) return false;
          break;
        case 'lt':
          if (amount >= amountFilter.value) return false;
          break;
        case 'lte':
          if (amount > amountFilter.value) return false;
          break;
        case 'range':
          if (amount < amountFilter.min || amount > amountFilter.max) return false;
          break;
      }
    }
    
    return true;
  });
  
  const toShow = state.transactionsToShow || 30;
  const recentTransactions = allTransactions.slice(0, toShow);
  const hasMore = allTransactions.length > toShow;
  
  if (recentTransactions.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:20px; color:var(--text-muted); font-size:14px;">
        ${searchText || filterType !== 'all' || filterCategory !== 'all' || filterAmount ? 'No matching transactions' : 'No transactions yet'}
      </div>
    `;
    if (loadMoreContainer) loadMoreContainer.innerHTML = '';
    return;
  }
  
  // Group by date
  const groupedByDate = {};
  const today = todayStr();
  
  recentTransactions.forEach(t => {
    if (!groupedByDate[t.date]) {
      groupedByDate[t.date] = [];
    }
    groupedByDate[t.date].push(t);
  });
  
  // Render grouped transactions
  const dates = Object.keys(groupedByDate).sort((a, b) => b.localeCompare(a));
  
  container.innerHTML = dates.map(date => {
    const dateObj = new Date(date + 'T00:00:00');
    const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
    const monthDay = dateObj.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
    const year = dateObj.toLocaleDateString('en-US', { year: '2-digit' });
    
    const dateLabel = date === today ? 'Today' : `${dayOfWeek}, ${monthDay}/${year}`;
    
    const transactions = groupedByDate[date];
    
    return `
      <div style="margin-bottom:16px;">
        <div style="font-size:13px; font-weight:600; color:var(--text-muted); margin-bottom:8px; text-transform:uppercase; letter-spacing:0.5px;">
          ${dateLabel}
        </div>
        ${transactions.map(t => {
          const isIncome = t.type === 'INCOME';
          const amount = isIncome ? (t.serviceAmount || 0) + (t.tipAmount || 0) : (t.amount || 0);
          const amountColor = isIncome ? 'var(--success)' : 'var(--danger)';
          const tipText = isIncome && t.tipAmount > 0 ? ` + $${t.tipAmount.toFixed(2)} tip` : '';
          
          return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid var(--border-light);">
              <div>
                <div style="font-size:14px; font-weight:500; color:var(--text);">${t.category}</div>
                ${t.notes ? `<div style="font-size:12px; color:var(--text-muted); margin-top:2px;">${t.notes}</div>` : ''}
              </div>
              <div style="text-align:right;">
                <div style="font-size:14px; font-weight:600; color:${amountColor};">
                  ${isIncome && t.serviceAmount > 0 ? `$${t.serviceAmount.toFixed(2)}` : `$${amount.toFixed(2)}`}${tipText}
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }).join('');
  
  // Show "Load More" button if there are more transactions
  if (loadMoreContainer) {
    if (hasMore) {
      loadMoreContainer.innerHTML = `
        <button class="btn-secondary" onclick="loadMoreTransactions()" style="width:100%; margin-top:16px; padding:12px;">
          Load More (${allTransactions.length - toShow} older)
        </button>
      `;
    } else if (recentTransactions.length > 0) {
      loadMoreContainer.innerHTML = `
        <div style="text-align:center; padding:16px; color:var(--text-muted); font-size:13px;">
          ${allTransactions.length} ${allTransactions.length === 1 ? 'transaction' : 'transactions'} shown
        </div>
      `;
    } else {
      loadMoreContainer.innerHTML = '';
    }
  }
}

function loadMoreTransactions() {
  state.transactionsToShow = (state.transactionsToShow || 30) + 30;
  renderRecentTransactions();
}

function updateEntryForm() {
  const type = document.querySelector('input[name="entry-type"]:checked')?.value || 'INCOME';
  const frequency = document.querySelector('input[name="entry-frequency"]:checked')?.value || 'DAILY';
  
  const frequencySection = document.getElementById('frequency-section');
  const dateSection = document.getElementById('date-section');
  const monthSection = document.getElementById('month-section');
  const yearSection = document.getElementById('year-section');
  const categorySelect = document.getElementById('entry-category');
  
  const serviceAmountSection = document.getElementById('service-amount-section');
  const tipAmountSection = document.getElementById('tip-amount-section');
  const expenseAmountSection = document.getElementById('expense-amount-section');
  
  // Show/hide frequency for expenses only
  if (type === 'EXPENSE') {
    frequencySection?.classList.remove('hidden');
    // Show expense amount field, hide income fields
    serviceAmountSection?.classList.add('hidden');
    tipAmountSection?.classList.add('hidden');
    expenseAmountSection?.classList.remove('hidden');
  } else {
    frequencySection?.classList.add('hidden');
    // Show income fields (service + tip), hide expense field
    serviceAmountSection?.classList.remove('hidden');
    tipAmountSection?.classList.remove('hidden');
    expenseAmountSection?.classList.add('hidden');
  }
  
  // Show date for income and daily expenses, show month/year for monthly expenses
  if (type === 'EXPENSE' && frequency === 'MONTHLY') {
    dateSection?.classList.add('hidden');
    monthSection?.classList.remove('hidden');
    yearSection?.classList.remove('hidden');
  } else {
    dateSection?.classList.remove('hidden');
    monthSection?.classList.add('hidden');
    yearSection?.classList.add('hidden');
  }
  
  // Update category dropdown
  if (categorySelect) {
    const categories = type === 'INCOME' ? state.categories.INCOME : state.categories.EXPENSE;
    const sortedCategories = [...categories].sort();  // Sort alphabetically
    categorySelect.innerHTML = sortedCategories.map(cat => `<option value="${cat}">${cat}</option>`).join('');
  }
}

async function saveEntryTransaction() {
  const type = document.querySelector('input[name="entry-type"]:checked')?.value;
  const frequency = document.querySelector('input[name="entry-frequency"]:checked')?.value || 'DAILY';
  const category = document.getElementById('entry-category')?.value;
  const notes = document.getElementById('entry-notes')?.value.trim() || '';
  
  let serviceAmount = 0;
  let tipAmount = 0;
  let expenseAmount = 0;
  let entryDate = '';
  
  if (type === 'INCOME') {
    serviceAmount = parseFloat(document.getElementById('entry-amount')?.value) || 0;
    tipAmount = parseFloat(document.getElementById('entry-tip')?.value) || 0;
    
    if (serviceAmount <= 0 && tipAmount <= 0) {
      showToast('Please enter service amount or tip');
      return;
    }
    
    entryDate = document.getElementById('entry-date').value;
  } else {
    expenseAmount = parseFloat(document.getElementById('entry-expense-amount')?.value) || 0;
    
    if (expenseAmount <= 0) {
      showToast('Please enter a valid amount');
      return;
    }
    
    if (frequency === 'DAILY') {
      entryDate = document.getElementById('entry-date').value;
    }
  }
  
  try {
    if (type === 'INCOME') {
      // Save as income transaction
      const date = entryDate;
      const transaction = {
        userId: auth.currentUser.uid,
        date: date,
        type: 'INCOME',
        category: category,
        serviceAmount: serviceAmount,
        tipAmount: tipAmount,
        notes: notes,
        createdAt: firebase.firestore.Timestamp.now()
      };
      
      const docRef = await firestore.collection('users').doc(auth.currentUser.uid).collection('transactions').add(transaction);
      await db.transactions.add({ id: docRef.id, ...transaction });
      
      // Switch to daily view showing the date where entry was added
      state.entriesViewMode = 'daily';
      state.selectedDate = date;
      
    } else if (frequency === 'DAILY') {
      // Save as daily expense transaction
      const date = entryDate;
      const transaction = {
        userId: auth.currentUser.uid,
        date: date,
        type: 'EXPENSE',
        category: category,
        amount: expenseAmount,
        notes: notes,
        createdAt: firebase.firestore.Timestamp.now()
      };
      
      const docRef = await firestore.collection('users').doc(auth.currentUser.uid).collection('transactions').add(transaction);
      await db.transactions.add({ id: docRef.id, ...transaction });
      
      // Switch to daily view showing the date where entry was added
      state.entriesViewMode = 'daily';
      state.selectedDate = date;
      
    } else {
      // Save as monthly expense
      const month = parseInt(document.getElementById('entry-month').value);
      const year = parseInt(document.getElementById('entry-year').value);
      
      const expense = {
        userId: auth.currentUser.uid,
        year: year,
        month: month,
        category: category,
        amount: expenseAmount,
        notes: notes,
        createdAt: firebase.firestore.Timestamp.now()
      };
      
      const docRef = await firestore.collection('users').doc(auth.currentUser.uid).collection('monthlyExpenses').add(expense);
      await db.monthlyExpenses.add({ id: docRef.id, ...expense });
      
      // Switch to monthly view showing the month where entry was added
      state.entriesViewMode = 'monthly';
      state.selectedMonth = month;
      state.selectedYear = year;
    }
    
    // Clear form fields
    document.getElementById('entry-amount').value = '';
    document.getElementById('entry-tip').value = '';
    document.getElementById('entry-expense-amount').value = '';
    document.getElementById('entry-notes').value = '';
    
    showToast('Entry added ✓');
    
    // Refresh recent transactions to show the new entry
    await renderRecentTransactions();
    
  } catch (error) {
    console.error('Error saving entry:', error);
    showToast('Error saving entry');
  }
}

async function renderEntriesContent() {
  const viewMode = state.entriesViewMode || 'daily';
  const entriesContent = document.getElementById('entries-content');
  if (!entriesContent) return;
  
  if (viewMode === 'daily') {
    await renderDailyEntries(entriesContent);
  } else if (viewMode === 'monthly') {
    await renderMonthlyEntries(entriesContent);
  } else {
    await renderAllEntries(entriesContent);
  }
}

async function renderDailyEntries(container) {
  const dateObj = new Date(state.selectedDate + 'T00:00:00');
  const dateDisplay = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  
  container.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:16px; padding:12px; background:var(--cream); border-radius:8px;">
      <button class="btn-secondary" onclick="changeEntriesDate(-1)" style="padding:10px 14px; font-size:13px;">←</button>
      <input type="date" class="form-input" style="flex:1; padding:10px; font-size:13px;" value="${state.selectedDate}" onchange="state.selectedDate=this.value; renderEntriesContent()">
      <button class="btn-secondary" onclick="changeEntriesDate(1)" style="padding:10px 14px; font-size:13px;">→</button>
    </div>
    <button class="btn-secondary" onclick="state.selectedDate=todayStr(); renderEntriesContent()" style="width:100%; margin-bottom:16px; padding:10px; font-size:13px;">Today</button>
    <div id="daily-entries-list"></div>
  `;
  
  const transactions = await db.transactions.where('date').equals(state.selectedDate).toArray();
  const listEl = document.getElementById('daily-entries-list');
  
  if (transactions.length === 0) {
    listEl.innerHTML = `
      <div style="text-align:center; padding:40px 20px; color:var(--text-muted);">
        <div style="font-size:48px; margin-bottom:12px; opacity:0.3;">📋</div>
        <div style="font-size:14px;">No entries for ${dateDisplay}</div>
      </div>
    `;
    return;
  }
  
  transactions.sort((a, b) => {
    const aTime = a.createdAt?.toDate?.() || new Date(0);
    const bTime = b.createdAt?.toDate?.() || new Date(0);
    return bTime - aTime;
  });
  
  listEl.innerHTML = transactions.map(t => {
    const isIncome = t.type === 'INCOME';
    const amount = isIncome ? (t.serviceAmount || 0) + (t.tipAmount || 0) : (t.amount || 0);
    const icon = isIncome ? '💰' : '💸';
    const amountClass = isIncome ? 'positive' : 'negative';
    const sign = isIncome ? '+' : '-';
    
    return `
      <div class="card" style="margin-bottom:12px; padding:14px; position:relative;">
        <button onclick="deleteDailyEntry('${t.id}')" style="position:absolute; left:14px; top:50%; transform:translateY(-50%); background:none; border:none; font-size:20px; color:#C13838; cursor:pointer; padding:0; width:24px; height:24px; display:flex; align-items:center; justify-content:center;">✕</button>
        <div style="display:flex; align-items:center; justify-content:space-between; padding-left:32px;">
          <div style="display:flex; align-items:center; flex:1;">
            <span style="font-size:24px; margin-right:12px;">${icon}</span>
            <div>
              <div style="font-size:15px; font-weight:600; margin-bottom:2px;">${t.category}</div>
              <div style="font-size:12px; color:var(--text-muted);">${isIncome ? 'Income' : 'Daily Expense'}</div>
            </div>
          </div>
          <span class="summary-amount ${amountClass}" style="font-size:18px; font-weight:700;">${sign}${fmt(amount)}</span>
        </div>
      </div>
    `;
  }).join('');
}

async function renderMonthlyEntries(container) {
  const monthDisplay = `${monthName(state.selectedMonth)} ${state.selectedYear}`;
  
  container.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:16px; padding:12px; background:var(--cream); border-radius:8px;">
      <button class="btn-secondary" onclick="changeEntriesMonth(-1)" style="padding:10px 14px; font-size:13px;">←</button>
      <div style="flex:1; text-align:center; font-size:14px; font-weight:600;">${monthDisplay}</div>
      <button class="btn-secondary" onclick="changeEntriesMonth(1)" style="padding:10px 14px; font-size:13px;">→</button>
    </div>
    <button class="btn-secondary" onclick="goToCurrentEntriesMonth()" style="width:100%; margin-bottom:16px; padding:10px; font-size:13px;">Current Month</button>
    <div id="monthly-entries-list"></div>
  `;
  
  // Get date range for this month
  const year = state.selectedYear;
  const month = state.selectedMonth;
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  
  console.log('=== MONTHLY VIEW DEBUG ===');
  console.log('Year:', year, 'Month:', month);
  console.log('Start date:', startDate);
  console.log('End date:', endDate);
  console.log('Last day:', lastDay);
  
  // Get all transactions and filter by month
  const allTransactions = await db.transactions.toArray();
  console.log('Total transactions in DB:', allTransactions.length);
  console.log('Sample dates:', allTransactions.slice(0, 5).map(t => t.date));
  
  const dailyTransactions = allTransactions.filter(t => 
    t.date >= startDate && t.date <= endDate
  );
  console.log('Filtered transactions for', monthDisplay, ':', dailyTransactions.length);
  
  // Get monthly expenses for this month
  const allMonthlyExpenses = await db.monthlyExpenses.toArray();
  const monthlyExpenses = allMonthlyExpenses.filter(e => 
    e.year === year && e.month === month
  );
  console.log('Monthly expenses:', monthlyExpenses.length);
  
  const listEl = document.getElementById('monthly-entries-list');
  
  if (dailyTransactions.length === 0 && monthlyExpenses.length === 0) {
    listEl.innerHTML = `
      <div style="text-align:center; padding:40px 20px; color:var(--text-muted);">
        <div style="font-size:48px; margin-bottom:12px; opacity:0.3;">📋</div>
        <div style="font-size:14px;">No entries for ${monthDisplay}</div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:8px;">
          Looking for dates: ${startDate} to ${endDate}
        </div>
      </div>
    `;
    return;
  }
  
  // Combine and sort all entries
  const allEntries = [];
  
  // Add daily transactions
  dailyTransactions.forEach(t => {
    const isIncome = t.type === 'INCOME';
    const amount = isIncome ? (t.serviceAmount || 0) + (t.tipAmount || 0) : (t.amount || 0);
    allEntries.push({
      id: t.id,
      date: t.date,
      type: isIncome ? 'income' : 'daily-expense',
      category: t.category,
      amount: amount,
      isIncome: isIncome,
      sortDate: t.date,
      createdAt: t.createdAt
    });
  });
  
  // Add monthly expenses (show at top of month)
  monthlyExpenses.forEach(e => {
    allEntries.push({
      id: e.id,
      date: `${year}-${String(month).padStart(2, '0')}-01`,
      type: 'monthly-expense',
      category: e.category,
      amount: e.amount,
      isIncome: false,
      sortDate: `${year}-${String(month).padStart(2, '0')}-00`, // Sort before daily entries
      createdAt: e.createdAt
    });
  });
  
  // Sort by date (newest first)
  allEntries.sort((a, b) => b.sortDate.localeCompare(a.sortDate));
  
  listEl.innerHTML = allEntries.map(entry => {
    const icon = entry.type === 'income' ? '💰' : entry.type === 'monthly-expense' ? '🏠' : '💸';
    const amountClass = entry.isIncome ? 'positive' : 'negative';
    const sign = entry.isIncome ? '+' : '-';
    const typeLabel = entry.type === 'income' ? 'Income' : entry.type === 'monthly-expense' ? 'Monthly Expense' : 'Daily Expense';
    const dateDisplay = new Date(entry.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    
    return `
      <div class="card" style="margin-bottom:12px; padding:14px; position:relative;">
        <button onclick="${entry.type === 'monthly-expense' ? 'deleteMonthlyExpenseEntry' : 'deleteDailyEntry'}('${entry.id}')" style="position:absolute; left:14px; top:50%; transform:translateY(-50%); background:none; border:none; font-size:20px; color:#C13838; cursor:pointer; padding:0; width:24px; height:24px; display:flex; align-items:center; justify-content:center;">✕</button>
        <div style="display:flex; align-items:center; justify-content:space-between; padding-left:32px;">
          <div style="display:flex; align-items:center; flex:1;">
            <span style="font-size:24px; margin-right:12px;">${icon}</span>
            <div>
              <div style="font-size:15px; font-weight:600; margin-bottom:2px;">${entry.category}</div>
              <div style="font-size:12px; color:var(--text-muted);">${typeLabel} • ${dateDisplay}</div>
            </div>
          </div>
          <span class="summary-amount ${amountClass}" style="font-size:18px; font-weight:700;">${sign}${fmt(entry.amount)}</span>
        </div>
      </div>
    `;
  }).join('');
}

async function renderAllEntries(container) {
  container.innerHTML = `
    <div style="margin-bottom:16px; padding:12px; background:var(--cream); border-radius:8px; text-align:center;">
      <div style="font-size:14px; font-weight:600; color:var(--text);">All Transactions</div>
      <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">Showing most recent 50</div>
    </div>
    <div id="all-entries-list"></div>
  `;
  
  // Get all transactions
  const dailyTransactions = await db.transactions.toArray();
  
  // Get all monthly expenses
  const monthlyExpenses = await db.monthlyExpenses.toArray();
  
  const listEl = document.getElementById('all-entries-list');
  
  if (dailyTransactions.length === 0 && monthlyExpenses.length === 0) {
    listEl.innerHTML = `
      <div style="text-align:center; padding:40px 20px; color:var(--text-muted);">
        <div style="font-size:48px; margin-bottom:12px; opacity:0.3;">📋</div>
        <div style="font-size:14px;">No transactions yet</div>
      </div>
    `;
    return;
  }
  
  // Combine all entries
  const allEntries = [];
  
  // Add daily transactions
  dailyTransactions.forEach(t => {
    const isIncome = t.type === 'INCOME';
    const amount = isIncome ? (t.serviceAmount || 0) + (t.tipAmount || 0) : (t.amount || 0);
    allEntries.push({
      id: t.id,
      date: t.date,
      type: isIncome ? 'income' : 'daily-expense',
      category: t.category,
      amount: amount,
      isIncome: isIncome,
      sortDate: t.date,
      createdAt: t.createdAt
    });
  });
  
  // Add monthly expenses
  monthlyExpenses.forEach(e => {
    const dateStr = `${e.year}-${String(e.month).padStart(2, '0')}-01`;
    allEntries.push({
      id: e.id,
      date: dateStr,
      type: 'monthly-expense',
      category: e.category,
      amount: e.amount,
      isIncome: false,
      sortDate: dateStr,
      monthYear: `${monthName(e.month)} ${e.year}`,
      createdAt: e.createdAt
    });
  });
  
  // Sort by date (newest first)
  allEntries.sort((a, b) => {
    const dateCompare = b.sortDate.localeCompare(a.sortDate);
    if (dateCompare !== 0) return dateCompare;
    // If same date, sort by createdAt
    const aTime = a.createdAt?.toDate?.() || new Date(0);
    const bTime = b.createdAt?.toDate?.() || new Date(0);
    return bTime - aTime;
  });
  
  // Take only first 50
  const displayEntries = allEntries.slice(0, 50);
  
  listEl.innerHTML = displayEntries.map(entry => {
    const icon = entry.type === 'income' ? '💰' : entry.type === 'monthly-expense' ? '🏠' : '💸';
    const amountClass = entry.isIncome ? 'positive' : 'negative';
    const sign = entry.isIncome ? '+' : '-';
    const typeLabel = entry.type === 'income' ? 'Income' : entry.type === 'monthly-expense' ? 'Monthly Expense' : 'Daily Expense';
    const dateDisplay = entry.type === 'monthly-expense' 
      ? entry.monthYear
      : new Date(entry.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    
    return `
      <div class="card" style="margin-bottom:12px; padding:14px; position:relative;">
        <button onclick="${entry.type === 'monthly-expense' ? 'deleteMonthlyExpenseEntry' : 'deleteDailyEntry'}('${entry.id}')" style="position:absolute; left:14px; top:50%; transform:translateY(-50%); background:none; border:none; font-size:20px; color:#C13838; cursor:pointer; padding:0; width:24px; height:24px; display:flex; align-items:center; justify-content:center;">✕</button>
        <div style="display:flex; align-items:center; justify-content:space-between; padding-left:32px;">
          <div style="display:flex; align-items:center; flex:1;">
            <span style="font-size:24px; margin-right:12px;">${icon}</span>
            <div>
              <div style="font-size:15px; font-weight:600; margin-bottom:2px;">${entry.category}</div>
              <div style="font-size:12px; color:var(--text-muted);">${typeLabel} • ${dateDisplay}</div>
            </div>
          </div>
          <span class="summary-amount ${amountClass}" style="font-size:18px; font-weight:700;">${sign}${fmt(entry.amount)}</span>
        </div>
      </div>
    `;
  }).join('');
}

function switchEntriesView(mode) {
  state.entriesViewMode = mode;
  renderEntriesView();
}

function changeEntriesDate(days) {
  state.selectedDate = addDays(state.selectedDate, days);
  renderEntriesContent();
}

function changeEntriesMonth(months) {
  let newMonth = state.selectedMonth + months;
  let newYear = state.selectedYear;
  
  if (newMonth > 12) {
    newMonth = 1;
    newYear++;
  } else if (newMonth < 1) {
    newMonth = 12;
    newYear--;
  }
  
  state.selectedMonth = newMonth;
  state.selectedYear = newYear;
  renderEntriesContent();
}

function goToCurrentEntriesMonth() {
  const now = new Date();
  state.selectedMonth = now.getMonth() + 1;
  state.selectedYear = now.getFullYear();
  renderEntriesContent();
}

async function deleteDailyEntry(id) {
  const transaction = await db.transactions.get(id);
  if (!transaction) return;
  
  const isIncome = transaction.type === 'INCOME';
  const amount = isIncome ? (transaction.serviceAmount || 0) + (transaction.tipAmount || 0) : (transaction.amount || 0);
  
  if (!confirm(`Delete ${transaction.category} (${fmt(amount)})?`)) return;
  
  try {
    await firestore.collection('users').doc(auth.currentUser.uid).collection('transactions').doc(id).delete();
    await db.transactions.delete(id);
    showToast('Deleted');
    renderEntriesContent();
  } catch (err) {
    console.error('Delete error:', err);
    showToast('Error deleting');
  }
}

async function deleteMonthlyExpenseEntry(id) {
  const e = await db.monthlyExpenses.get(id);
  if (!e) return;
  
  if (!confirm(`Delete ${e.category} (${fmt(e.amount)})?`)) return;
  
  try {
    await firestore.collection('users').doc(auth.currentUser.uid).collection('monthlyExpenses').doc(id).delete();
    await db.monthlyExpenses.delete(id);
    showToast('Deleted');
    renderEntriesContent();
  } catch (err) {
    console.error('Delete error:', err);
    showToast('Error deleting');
  }
}

async function renderDailyView() {
  const content = document.getElementById('app-content');
  const hdr = document.getElementById('header-actions');
  hdr.innerHTML = '';

  const txns    = await db.transactions.where('date').equals(state.selectedDate).toArray();
  const summary = await db.dailySummary.where('date').equals(state.selectedDate).first();

  const income   = txns.filter(t => t.type === 'INCOME');
  const expenses = txns.filter(t => t.type === 'EXPENSE');

  const totalService = income.reduce((s, t) => s + (t.serviceAmount || 0), 0);
  const totalTips    = income.reduce((s, t) => s + (t.tipAmount    || 0), 0);
  const totalIncome  = totalService + totalTips;
  const totalExp     = expenses.reduce((s, t) => s + (t.amount || 0), 0);
  const net          = totalIncome - totalExp;

  const isToday = state.selectedDate === todayStr();

  // Calculate comparison stats (only for today)
  let comparisonHTML = '';
  if (isToday) {
    const allTxns = await db.transactions.toArray();
    
    // Yesterday
    const yesterday = addDays(todayStr(), -1);
    const yesterdayIncome = allTxns
      .filter(t => t.date === yesterday && t.type === 'INCOME')
      .reduce((s, t) => s + (t.serviceAmount || 0) + (t.tipAmount || 0), 0);
    
    // Last Week (same day of week - this makes sense for salons!)
    const lastWeek = addDays(todayStr(), -7);
    const lastWeekIncome = allTxns
      .filter(t => t.date === lastWeek && t.type === 'INCOME')
      .reduce((s, t) => s + (t.serviceAmount || 0) + (t.tipAmount || 0), 0);
    
    // Calculate percentage changes
    const calcChange = (current, previous) => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return ((current - previous) / previous) * 100;
    };
    
    const vsYesterday = calcChange(totalIncome, yesterdayIncome);
    const vsLastWeek = calcChange(totalIncome, lastWeekIncome);
    
    const formatChange = (change, prevAmount) => {
      if (prevAmount === 0 && change === 0) {
        return '<span style="color:var(--text-muted); font-size:14px;">No data</span>';
      }
      const arrow = change > 0 ? '↑' : change < 0 ? '↓' : '→';
      const color = change > 0 ? '#2D7A4C' : change < 0 ? '#C13838' : '#999';
      const percent = Math.abs(change).toFixed(0);
      return `
        <div style="color:${color};">
          <span class="comparison-arrow">${arrow}</span><span class="comparison-percent">${percent}%</span>
        </div>
      `;
    };
    
    // Get day of week for label
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const todayDayOfWeek = new Date().getDay();
    const dayName = dayNames[todayDayOfWeek];
    
    comparisonHTML = `
      <div class="comparison-cards">
        <div class="comparison-card">
          <div class="comparison-label">vs Yesterday</div>
          <div class="comparison-value">${formatChange(vsYesterday, yesterdayIncome)}</div>
          <div class="comparison-amount">${fmt(yesterdayIncome)}</div>
        </div>
        <div class="comparison-card">
          <div class="comparison-label">vs Last ${dayName}</div>
          <div class="comparison-value">${formatChange(vsLastWeek, lastWeekIncome)}</div>
          <div class="comparison-amount">${fmt(lastWeekIncome)}</div>
        </div>
      </div>
    `;
  }

  const lastBackupSetting = await db.settings.get('lastBackup');
  let backupNudge = '';
  if (isToday) {
    const lastBackupDate = lastBackupSetting?.value;
    const daysOverdue = lastBackupDate
      ? Math.floor((new Date() - new Date(lastBackupDate + 'T12:00:00')) / 86400000)
      : 999;
    if (daysOverdue >= 30) {
      backupNudge = `
        <div class="backup-nudge" onclick="navigate('settings')">
          💾 Export a local backup — ${daysOverdue >= 999 ? "no local backup yet" : `last export ${daysOverdue} days ago`}
          <span style="margin-left:6px;opacity:.7;">›</span>
        </div>`;
    }
  }

  content.innerHTML = `
    ${backupNudge}

    <div class="daily-date-bar">
      <button class="date-nav-btn" onclick="changeDate(-1)">‹</button>
      <div class="current-date" onclick="openDatePicker()">${isToday ? 'Today' : formatDateDisplay(state.selectedDate)}</div>
      <button class="date-nav-btn" onclick="changeDate(1)">›</button>
    </div>

    <div class="summary-cards">
      <div class="summary-card income-card">
        <div class="summary-label">Income</div>
        <div class="summary-amount">${fmt(totalIncome)}</div>
        ${totalTips > 0 ? `<div class="summary-sub">incl. ${fmt(totalTips)} tips</div>` : ''}
      </div>
      <div class="summary-card expense-card">
        <div class="summary-label">Expenses</div>
        <div class="summary-amount">${fmt(totalExp)}</div>
      </div>
      <div class="summary-card net-card">
        <div class="summary-label">Net</div>
        <div class="summary-amount ${net >= 0 ? 'positive' : 'negative'}">${fmt(net)}</div>
      </div>
    </div>

    ${comparisonHTML}

    ${summary ? `
    <div class="day-summary-card" onclick="openDaySummaryModal()">
      <div style="display:flex;align-items:center;gap:12px;flex:1;font-size:13px;">
        <span>👤 ${summary.clientsSeen} clients</span>
        <span>⏱ ${summary.hoursWorked}h</span>
      </div>
      <span style="opacity:.5;font-size:12px;">edit ✏</span>
    </div>
    ` : `
    <div class="day-summary-card empty" onclick="openDaySummaryModal()">
      <div style="flex:1;">
        <div style="font-weight:600;font-size:13px;color:var(--plum);margin-bottom:1px;">
          📋 Log today's activity
        </div>
        <div style="font-size:12px;color:var(--text-muted);">
          Track clients & hours
        </div>
      </div>
      <span style="font-size:20px;opacity:.3;">+</span>
    </div>
    `}

    <div style="padding: 0 16px 8px;">
      <div class="section-label">Income</div>
      ${income.length === 0 ? `
        <div class="empty-state">
          <div class="empty-icon">💈</div>
          <div class="empty-text">No income yet. Tap + below.</div>
        </div>
      ` : income.map(t => renderTransactionItem(t)).join('')}

      <div class="section-label" style="margin-top:12px;">Expenses</div>
      ${expenses.length === 0 ? `
        <div class="empty-state">
          <div class="empty-icon">🧾</div>
          <div class="empty-text">No expenses yet.</div>
        </div>
      ` : expenses.map(t => renderTransactionItem(t)).join('')}
    </div>

    <div class="fab-row">
      <button class="fab fab-income"  onclick="openAddTransactionModal('INCOME')">
        <span style="font-size:18px">+</span> Income
      </button>
      <button class="fab fab-expense" onclick="openAddTransactionModal('EXPENSE')">
        <span style="font-size:18px">+</span> Expense
      </button>
    </div>

    <div style="height:16px;"></div>
  `;
}

function renderTransactionItem(t) {
  const isIncome = t.type === 'INCOME';
  const total    = isIncome ? (t.serviceAmount || 0) + (t.tipAmount || 0) : (t.amount || 0);
  const sign     = isIncome ? '+' : '-';
  const colorClass = isIncome ? 'income-amount' : 'expense-amount';

  return `
    <div class="txn-row">
      <div class="txn-body" onclick="openEditTransactionModal('${t.id}')">
        <div class="txn-category">${t.category || '—'} <span style="font-size:11px;color:var(--text-light);font-weight:400;">✏</span></div>
        <div class="txn-meta">${t.paymentMethod || ''}${t.notes ? ' · ' + t.notes : ''}${isIncome && t.tipAmount > 0 ? ' · tip ' + fmt(t.tipAmount) : ''}</div>
      </div>
      <div class="txn-amount-col ${colorClass}" onclick="openEditTransactionModal('${t.id}')">${sign}${fmt(Math.abs(total))}</div>
      <button class="txn-delete" onclick="deleteTransaction('${t.id}')">✕</button>
    </div>`;
}

function openDatePicker() {
  openModal(`
    <h2 class="modal-title">Go to Date</h2>
    <div class="form-group">
      <input type="date" class="form-input" id="date-picker-val" value="${state.selectedDate}">
    </div>
    <button class="btn-submit" onclick="jumpToDate()">Go</button>
  `);
}

function jumpToDate() {
  const v = document.getElementById('date-picker-val').value;
  if (v) { state.selectedDate = v; closeModal(); renderDailyView(); }
}

function changeDate(delta) {
  state.selectedDate = addDays(state.selectedDate, delta);
  renderDailyView();
}

// ----------------------------------------------------------------
// 10. TRANSACTION MODALS
// ----------------------------------------------------------------

async function openAddTransactionModal(type) {
  await loadCategories();
  const isIncome = type === 'INCOME';
  const catKey   = isIncome ? 'INCOME' : 'DAILY_EXPENSE';
  const catOptions = categoryOptions(catKey);
  const pmOptions = ['Cash','Card','Venmo','Zelle','Check','Other']
    .map(m => `<option>${m}</option>`).join('');

  // TIMEZONE FIX: Ensure we always use a valid local date
  const defaultDate = ensureLocalDate(state.selectedDate);

  openModal(`
    <h2 class="modal-title">+ Add ${isIncome ? 'Income' : 'Expense'}</h2>

    <div class="form-group">
      <label class="form-label">Date</label>
      <input type="date" class="form-input" id="txn-date" value="${defaultDate}">
    </div>

    <div class="form-group">
      <label class="form-label">Category</label>
      <select class="form-select" id="txn-category">
        <option value="">Select category…</option>
        ${catOptions}
      </select>
    </div>

    <div class="form-group">
      <label class="form-label">${isIncome ? 'Service Amount ($)' : 'Amount ($)'}</label>
      <input type="number" class="form-input" id="txn-amount" placeholder="0.00" step="0.01" min="0" inputmode="decimal">
    </div>

    <div class="form-group">
      <label class="form-label">Payment Method</label>
      <select class="form-select" id="txn-payment">${pmOptions}</select>
    </div>

    ${isIncome ? `
    <hr class="form-section-divider">
    <div class="form-section-label">Tip (optional)</div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Tip Amount ($)</label>
        <input type="number" class="form-input" id="txn-tip" placeholder="0.00" step="0.01" min="0" inputmode="decimal">
      </div>
      <div class="form-group">
        <label class="form-label">Tip Method</label>
        <select class="form-select" id="txn-tip-method">
          <option value="">None</option>
          <option value="Cash">Cash</option>
          <option value="Card">Card</option>
        </select>
      </div>
    </div>
    ` : ''}

    <div class="form-group">
      <label class="form-label">Notes (optional)</label>
      <input type="text" class="form-input" id="txn-notes" placeholder="e.g. regular client, product used…">
    </div>

    <button class="btn-submit" onclick="saveTransaction('${type}')">Save Entry</button>
  `);
}

async function saveTransaction(type) {
  const isIncome = type === 'INCOME';
  let date       = document.getElementById('txn-date').value;
  const category = document.getElementById('txn-category').value;
  const amount   = parseFloat(document.getElementById('txn-amount').value) || 0;
  const payment  = document.getElementById('txn-payment').value;
  const notes    = document.getElementById('txn-notes').value.trim();

  if (!category) { alert('Please select a category.'); return; }
  if (amount <= 0) { alert('Please enter an amount greater than zero.'); return; }

  // TIMEZONE FIX: Ensure date is valid local date string
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    date = state.selectedDate || todayStr();
  }

  const record = { date, type, category, paymentMethod: payment, notes };

  if (isIncome) {
    const tip       = parseFloat(document.getElementById('txn-tip').value) || 0;
    const tipMethod = document.getElementById('txn-tip-method').value;
    record.serviceAmount = amount;
    record.tipAmount     = tip;
    record.tipMethod     = tipMethod;
    record.amount        = amount;
  } else {
    record.serviceAmount = 0;
    record.tipAmount     = 0;
    record.amount        = amount;
  }

  await db.transactions.add(record);
  if (date !== state.selectedDate) state.selectedDate = date;

  closeModal();
  showToast(isIncome ? 'Income saved ✓' : 'Expense saved ✓');
  renderDailyView();
}

async function deleteTransaction(id) {
  const t = await db.transactions.get(id);
  if (!t) return;
  
  const amount = t.type === 'INCOME' 
    ? fmt((t.serviceAmount || 0) + (t.tipAmount || 0))
    : fmt(t.amount || 0);
  const type = t.type === 'INCOME' ? 'income' : 'expense';
  
  const message = `Are you sure you want to delete this ${type}?\n\n${t.category || 'Entry'}: ${amount}\n\nThis cannot be undone.`;
  
  const confirmed = await confirmDialog(message, 'Confirm Delete');
  if (!confirmed) return;
  
  await db.transactions.delete(id);
  showToast('Entry deleted');
  renderDailyView();
}

async function openEditTransactionModal(id) {
  await loadCategories();
  const t = await db.transactions.get(id);
  if (!t) return;

  const isIncome = t.type === 'INCOME';
  const catKey   = isIncome ? 'INCOME' : 'DAILY_EXPENSE';
  const availableCategories = state.categories[catKey] || [];
  
  // Check if transaction's category exists in current categories
  const categoryExists = availableCategories.includes(t.category);
  
  // Build category options
  let catOptions = availableCategories
    .map(name => `<option value="${name}" ${name === t.category ? 'selected' : ''}>${name}</option>`)
    .join('');
  
  // If transaction has a category that's not in the list (legacy category), add it
  if (t.category && !categoryExists) {
    catOptions = `<option value="${t.category}" selected>${t.category} (legacy)</option>` + catOptions;
  }
  
  const pmOptions = ['Cash','Card','Venmo','Zelle','Check','Other']
    .map(m => `<option ${m === t.paymentMethod ? 'selected' : ''}>${m}</option>`).join('');

  openModal(`
    <h2 class="modal-title">Edit ${isIncome ? 'Income' : 'Expense'}</h2>

    <div class="form-group">
      <label class="form-label">Date</label>
      <input type="date" class="form-input" id="txn-date" value="${t.date}">
    </div>

    <div class="form-group">
      <label class="form-label">Category</label>
      <select class="form-select" id="txn-category">
        <option value="">Select category…</option>
        ${catOptions}
      </select>
    </div>

    <div class="form-group">
      <label class="form-label">${isIncome ? 'Service Amount ($)' : 'Amount ($)'}</label>
      <input type="number" class="form-input" id="txn-amount" step="0.01" min="0" inputmode="decimal"
        value="${isIncome ? (t.serviceAmount || '') : (t.amount || '')}">
    </div>

    <div class="form-group">
      <label class="form-label">Payment Method</label>
      <select class="form-select" id="txn-payment">${pmOptions}</select>
    </div>

    ${isIncome ? `
    <hr class="form-section-divider">
    <div class="form-section-label">Tip (optional)</div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Tip Amount ($)</label>
        <input type="number" class="form-input" id="txn-tip" step="0.01" min="0" inputmode="decimal"
          value="${t.tipAmount || ''}">
      </div>
      <div class="form-group">
        <label class="form-label">Tip Method</label>
        <select class="form-select" id="txn-tip-method">
          <option value="">None</option>
          <option value="Cash" ${t.tipMethod === 'Cash' ? 'selected' : ''}>Cash</option>
          <option value="Card" ${t.tipMethod === 'Card' ? 'selected' : ''}>Card</option>
        </select>
      </div>
    </div>
    ` : ''}

    <div class="form-group">
      <label class="form-label">Notes (optional)</label>
      <input type="text" class="form-input" id="txn-notes" value="${t.notes || ''}">
    </div>

    <button class="btn-submit" onclick="updateTransaction('${id}', '${t.type}')">Save Changes</button>
  `);
}

async function updateTransaction(id, type) {
  const isIncome = type === 'INCOME';
  const date     = document.getElementById('txn-date').value;
  const category = document.getElementById('txn-category').value;
  const amount   = parseFloat(document.getElementById('txn-amount').value) || 0;
  const payment  = document.getElementById('txn-payment').value;
  const notes    = document.getElementById('txn-notes').value.trim();

  if (!category) { alert('Please select a category.'); return; }
  if (amount <= 0) { alert('Please enter an amount greater than zero.'); return; }

  const changes = { date, category, paymentMethod: payment, notes };

  if (isIncome) {
    const tip       = parseFloat(document.getElementById('txn-tip').value) || 0;
    const tipMethod = document.getElementById('txn-tip-method').value;
    changes.serviceAmount = amount;
    changes.tipAmount     = tip;
    changes.tipMethod     = tipMethod;
    changes.amount        = amount;
  } else {
    changes.amount        = amount;
    changes.serviceAmount = 0;
    changes.tipAmount     = 0;
  }

  await db.transactions.update(id, changes);
  if (date !== state.selectedDate) state.selectedDate = date;

  closeModal();
  showToast('Entry updated ✓');
  renderDailyView();
}

// ----------------------------------------------------------------
// 11. DAY SUMMARY MODAL
// ----------------------------------------------------------------

async function openDaySummaryModal() {
  const s = await db.dailySummary.where('date').equals(state.selectedDate).first();
  openModal(`
    <h2 class="modal-title">Edit Day Summary</h2>
    <p style="color:var(--text-muted);font-size:14px;margin-bottom:20px;">${formatDateDisplay(state.selectedDate)}</p>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Clients Seen</label>
        <input type="number" class="form-input" id="ds-clients" min="0" inputmode="numeric"
          value="${s ? s.clientsSeen : ''}">
      </div>
      <div class="form-group">
        <label class="form-label">Hours Worked</label>
        <input type="number" class="form-input" id="ds-hours" min="0" step="0.5" inputmode="decimal"
          value="${s ? s.hoursWorked : ''}">
      </div>
    </div>

    <button class="btn-submit" onclick="saveDaySummary()">Save</button>
  `);
}

async function saveDaySummary() {
  const clients = parseFloat(document.getElementById('ds-clients').value) || 0;
  const hours   = parseFloat(document.getElementById('ds-hours').value)   || 0;

  const existing = await db.dailySummary.where('date').equals(state.selectedDate).first();
  if (existing) {
    await db.dailySummary.update(existing.id, { clientsSeen: clients, hoursWorked: hours });
  } else {
    await db.dailySummary.add({ date: state.selectedDate, clientsSeen: clients, hoursWorked: hours });
  }

  closeModal();
  showToast('Day summary saved ✓');
  renderDailyView();
}

// ----------------------------------------------------------------
// 12. MONTHLY EXPENSES VIEW
// ----------------------------------------------------------------

async function renderMonthlyView() {
  const content = document.getElementById('app-content');
  document.getElementById('header-actions').innerHTML = '';

  const allExpenses = await db.monthlyExpenses.toArray();
  const expenses = allExpenses.filter(
    e => e.year === state.selectedYear && e.month === state.selectedMonth
  );

  const total = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  
  // Calculate comparison stats
  let comparisonHTML = '';
  const isCurrentMonth = state.selectedYear === new Date().getFullYear() && 
                        state.selectedMonth === (new Date().getMonth() + 1);
  
  if (isCurrentMonth) {
    // Last month
    let lastMonth = state.selectedMonth - 1;
    let lastYear = state.selectedYear;
    if (lastMonth < 1) {
      lastMonth = 12;
      lastYear--;
    }
    const lastMonthExpenses = allExpenses
      .filter(e => e.year === lastYear && e.month === lastMonth)
      .reduce((s, e) => s + (e.amount || 0), 0);
    
    // Same month last year
    const lastYearExpenses = allExpenses
      .filter(e => e.year === state.selectedYear - 1 && e.month === state.selectedMonth)
      .reduce((s, e) => s + (e.amount || 0), 0);
    
    const calcChange = (current, previous) => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return ((current - previous) / previous) * 100;
    };
    
    const vsLastMonth = calcChange(total, lastMonthExpenses);
    const vsLastYear = calcChange(total, lastYearExpenses);
    
    const formatChange = (change, prevAmount) => {
      if (prevAmount === 0 && change === 0) {
        return '<span style="color:var(--text-muted); font-size:14px;">No data</span>';
      }
      const arrow = change > 0 ? '↑' : change < 0 ? '↓' : '→';
      // For expenses, reverse colors: higher = bad (red), lower = good (green)
      const color = change > 0 ? '#C13838' : change < 0 ? '#2D7A4C' : '#999';
      const percent = Math.abs(change).toFixed(0);
      return `
        <div style="color:${color};">
          <span class="comparison-arrow">${arrow}</span><span class="comparison-percent">${percent}%</span>
        </div>
      `;
    };
    
    comparisonHTML = `
      <div class="comparison-cards">
        <div class="comparison-card">
          <div class="comparison-label">vs ${monthName(lastMonth)}</div>
          <div class="comparison-value">${formatChange(vsLastMonth, lastMonthExpenses)}</div>
          <div class="comparison-amount">${fmt(lastMonthExpenses)}</div>
        </div>
        <div class="comparison-card">
          <div class="comparison-label">vs Last Year</div>
          <div class="comparison-value">${formatChange(vsLastYear, lastYearExpenses)}</div>
          <div class="comparison-amount">${fmt(lastYearExpenses)}</div>
        </div>
      </div>
    `;
  }

  const monthOptions = Array.from({length:12}, (_,i) =>
    `<option value="${i+1}" ${i+1 === state.selectedMonth ? 'selected' : ''}>${monthName(i+1)}</option>`
  ).join('');

  const yearNow = new Date().getFullYear();
  const yearOptions = [yearNow-1, yearNow, yearNow+1].map(y =>
    `<option value="${y}" ${y === state.selectedYear ? 'selected' : ''}>${y}</option>`
  ).join('');

  content.innerHTML = `
    <div class="monthly-header">
      <button class="date-nav-btn" onclick="changeMonth(-1)">‹</button>
      <div>
        <select class="report-select" style="margin-bottom:4px" onchange="state.selectedMonth=parseInt(this.value);renderMonthlyView()">${monthOptions}</select>
        <select class="report-select" onchange="state.selectedYear=parseInt(this.value);renderMonthlyView()">${yearOptions}</select>
      </div>
      <button class="date-nav-btn" onclick="changeMonth(1)">›</button>
    </div>

    <div class="monthly-total-card">
      <div class="monthly-total-label">Total Fixed Expenses — ${monthName(state.selectedMonth)} ${state.selectedYear}</div>
      <div class="monthly-total-value">${fmt(total)}</div>
    </div>

    ${comparisonHTML}

    <div style="padding: 0 16px 8px;">
      <div class="section-label">Expenses</div>
      ${expenses.length === 0 ? `
        <div class="empty-state">
          <div class="empty-icon">🏠</div>
          <div class="empty-text">No monthly expenses logged yet.<br>Tap below to add one.</div>
        </div>
      ` : expenses.map(e => `
        <div class="monthly-expense-item">
          <div style="flex:1;cursor:pointer;" onclick="openEditMonthlyExpenseModal('${e.id}')">
            <div class="mexp-category">${e.category} <span style="font-size:11px;color:var(--text-light);font-weight:400;">✏</span></div>
            <div class="mexp-notes">${e.datePaid ? formatDateShort(e.datePaid) : ''}${e.notes ? (e.datePaid ? ' · ' : '') + e.notes : ''}</div>
          </div>
          <div class="mexp-amount" onclick="openEditMonthlyExpenseModal('${e.id}')" style="cursor:pointer;">${fmt(e.amount)}</div>
          <button class="mexp-delete" onclick="deleteMonthlyExpense('${e.id}')">✕</button>
        </div>
      `).join('')}

      <div class="fab-row" style="padding: 16px 0;">
        <button class="fab fab-expense" onclick="openAddMonthlyExpenseModal()" style="background:var(--plum)">
          <span style="font-size:18px">+</span> Add Monthly Expense
        </button>
      </div>
    </div>
  `;
}

function changeMonth(delta) {
  state.selectedMonth += delta;
  if (state.selectedMonth > 12) { state.selectedMonth = 1;  state.selectedYear++; }
  if (state.selectedMonth < 1)  { state.selectedMonth = 12; state.selectedYear--; }
  renderMonthlyView();
}

async function openAddMonthlyExpenseModal() {
  await loadCategories();
  const catOptions = categoryOptions('MONTHLY_EXPENSE');

  openModal(`
    <h2 class="modal-title">+ Add Monthly Expense</h2>

    <div class="form-group">
      <label class="form-label">Date Paid</label>
      <input type="date" class="form-input" id="me-date" value="${todayStr()}">
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Month</label>
        <select class="form-select" id="me-month">
          ${Array.from({length:12},(_,i)=>`<option value="${i+1}" ${i+1===state.selectedMonth?'selected':''}>${monthName(i+1)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Year</label>
        <input type="number" class="form-input" id="me-year" value="${state.selectedYear}" min="2020" max="2099" inputmode="numeric">
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Category</label>
      <select class="form-select" id="me-category">
        <option value="">Select category…</option>
        ${catOptions}
      </select>
    </div>

    <div class="form-group">
      <label class="form-label">Amount ($)</label>
      <input type="number" class="form-input" id="me-amount" placeholder="0.00" step="0.01" min="0" inputmode="decimal">
    </div>

    <div class="form-group">
      <label class="form-label">Notes (optional)</label>
      <input type="text" class="form-input" id="me-notes" placeholder="e.g. annual increase, pro-rated…">
    </div>

    <button class="btn-submit" onclick="saveMonthlyExpense()">Save</button>
  `);
}

async function saveMonthlyExpense() {
  const datePaid = document.getElementById('me-date').value;
  const month    = parseInt(document.getElementById('me-month').value);
  const year     = parseInt(document.getElementById('me-year').value);
  const category = document.getElementById('me-category').value;
  const amount   = parseFloat(document.getElementById('me-amount').value) || 0;
  const notes    = document.getElementById('me-notes').value.trim();

  if (!category) { alert('Please select a category.'); return; }
  if (amount <= 0) { alert('Please enter an amount greater than zero.'); return; }

  await db.monthlyExpenses.add({ datePaid, month, year, category, amount, notes });
  state.selectedMonth = month;
  state.selectedYear  = year;

  closeModal();
  showToast('Monthly expense saved ✓');
  renderMonthlyView();
}

async function deleteMonthlyExpense(id) {
  const e = await db.monthlyExpenses.get(id);
  if (!e) return;
  
  const monthYear = `${monthName(e.month)} ${e.year}`;
  const message = `Are you sure you want to delete this monthly expense?\n\n${e.category}: ${fmt(e.amount)}\n${monthYear}\n\nThis cannot be undone.`;
  
  const confirmed = await confirmDialog(message, 'Confirm Delete');
  if (!confirmed) return;
  
  await db.monthlyExpenses.delete(id);
  showToast('Expense deleted');
  renderMonthlyView();
}

async function openEditMonthlyExpenseModal(id) {
  await loadCategories();
  const e = await db.monthlyExpenses.get(id);
  if (!e) return;
  
  // Get all expense categories (both daily and monthly)
  const allExpenseCategories = [
    ...(state.categories.DAILY_EXPENSE || []),
    ...(state.categories.MONTHLY_EXPENSE || [])
  ];
  const catOptions = allExpenseCategories
    .map(name => `<option value="${name}" ${name === e.category ? 'selected' : ''}>${name}</option>`)
    .join('');

  openModal(`
    <h2 class="modal-title">Edit Monthly Expense</h2>

    <div class="form-group">
      <label class="form-label">Date Paid</label>
      <input type="date" class="form-input" id="me-date" value="${e.datePaid || ''}">
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Month</label>
        <select class="form-select" id="me-month">
          ${Array.from({length:12},(_,i)=>`<option value="${i+1}" ${i+1===e.month?'selected':''}>${monthName(i+1)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Year</label>
        <input type="number" class="form-input" id="me-year" value="${e.year}" min="2020" max="2099" inputmode="numeric">
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Category</label>
      <select class="form-select" id="me-category">
        <option value="">Select category…</option>
        ${catOptions}
      </select>
    </div>

    <div class="form-group">
      <label class="form-label">Amount ($)</label>
      <input type="number" class="form-input" id="me-amount" placeholder="0.00" step="0.01" min="0" inputmode="decimal"
        value="${e.amount || ''}">
    </div>

    <div class="form-group">
      <label class="form-label">Notes (optional)</label>
      <input type="text" class="form-input" id="me-notes" value="${e.notes || ''}">
    </div>

    <button class="btn-submit" onclick="updateMonthlyExpense('${id}')">Save Changes</button>
  `);
}

async function updateMonthlyExpense(id) {
  const datePaid = document.getElementById('me-date').value;
  const month    = parseInt(document.getElementById('me-month').value);
  const year     = parseInt(document.getElementById('me-year').value);
  const category = document.getElementById('me-category').value;
  const amount   = parseFloat(document.getElementById('me-amount').value) || 0;
  const notes    = document.getElementById('me-notes').value.trim();

  if (!category) { alert('Please select a category.'); return; }
  if (amount <= 0) { alert('Please enter an amount greater than zero.'); return; }

  await db.monthlyExpenses.update(id, { datePaid, month, year, category, amount, notes });
  state.selectedMonth = month;
  state.selectedYear  = year;

  closeModal();
  showToast('Expense updated ✓');
  renderMonthlyView();
}

// ----------------------------------------------------------------
// 13. REPORTS VIEW
// ----------------------------------------------------------------

async function renderReportsView() {
  const content = document.getElementById('app-content');
  document.getElementById('header-actions').innerHTML = '';

  const reportTypes = [
    { id: 'daily',    label: 'Daily' },
    { id: 'weekly',   label: 'Weekly' },
    { id: 'monthly',  label: 'Monthly' },
    { id: 'month-compare', label: 'Month Compare' },
    { id: 'date-compare', label: 'Date Range' },
    { id: 'annual',   label: 'Annual' },
    { id: 'yoy',      label: 'Year vs Year' },
    { id: 'category', label: 'By Category' },
    { id: 'export',   label: '📥 Export CSV' },
  ];

  const tabs = reportTypes.map(r =>
    `<button class="tab-btn ${state.reportType === r.id ? 'active' : ''}"
      onclick="state.reportType='${r.id}'; renderReportsView()">
      ${r.label}
    </button>`
  ).join('');

  content.innerHTML = `
    <div class="report-type-tabs">${tabs}</div>
    <div id="report-inner"></div>
  `;

  await renderReportInner();
}

async function renderReportInner() {
  const el = document.getElementById('report-inner');
  if (!el) return;

  const yearNow  = new Date().getFullYear();
  const monthNow = new Date().getMonth() + 1;

  switch (state.reportType) {

    case 'daily': {
      el.innerHTML = `
        <div class="report-controls">
          <input type="date" class="report-input" id="r-date" value="${state.selectedDate}">
          <button class="report-btn" onclick="runDailyReport()">View</button>
        </div>
        <div class="report-body" id="report-output"></div>
      `;
      await runDailyReport();
      break;
    }

    case 'weekly': {
      el.innerHTML = `
        <div class="report-controls" style="display:flex; gap:8px; align-items:center;">
          <button class="report-btn" onclick="navigateWeek(-1)" style="padding:8px 12px;">◄</button>
          <input type="date" class="report-input" id="r-week-date" value="${state.selectedDate}"
            placeholder="Pick any day in the week" style="flex:1;">
          <button class="report-btn" onclick="navigateWeek(1)" style="padding:8px 12px;">►</button>
          <button class="report-btn" onclick="runWeeklyReport()">View</button>
        </div>
        <div class="report-body" id="report-output"></div>
      `;
      await runWeeklyReport();
      break;
    }

    case 'monthly': {
      const monthOpts = Array.from({length:12},(_,i)=>
        `<option value="${i+1}" ${i+1===monthNow?'selected':''}>${monthName(i+1)}</option>`).join('');
      el.innerHTML = `
        <div class="report-controls">
          <select class="report-select" id="r-month">${monthOpts}</select>
          <input type="number" class="report-input" id="r-year" value="${yearNow}" min="2020" max="2099" style="max-width:90px" inputmode="numeric">
          <button class="report-btn" onclick="runMonthlyReport()">View</button>
        </div>
        <div class="report-body" id="report-output"></div>
      `;
      await runMonthlyReport();
      break;
    }

    case 'month-compare': {
      // Initialize comparison state if needed
      if (!state.compareMonth) {
        state.compareMonth = monthNow;
        state.compareYear = yearNow - 1; // Default to same month last year
      }
      
      const monthOpts = Array.from({length:12},(_,i)=> i+1);
      const currentMonthOpts = monthOpts.map(m => 
        `<option value="${m}" ${m===state.selectedMonth?'selected':''}>${monthName(m)}</option>`).join('');
      const compareMonthOpts = monthOpts.map(m => 
        `<option value="${m}" ${m===state.compareMonth?'selected':''}>${monthName(m)}</option>`).join('');
      
      el.innerHTML = `
        <div class="report-body" style="padding:16px;">
          <h4 style="margin-bottom:16px; text-align:center;">Month Comparison</h4>
          
          <div style="display:grid; grid-template-columns:1fr auto 1fr; gap:12px; align-items:center; margin-bottom:16px;">
            <!-- Current Period -->
            <div>
              <div style="font-weight:600; font-size:14px; margin-bottom:8px; text-align:center;">Current</div>
              <select class="report-select" id="r-month-curr" onchange="state.selectedMonth=parseInt(this.value); renderReportsView()">
                ${currentMonthOpts}
              </select>
              <input type="number" class="report-input" id="r-year-curr" value="${state.selectedYear}" min="2020" max="2099" 
                onchange="state.selectedYear=parseInt(this.value); renderReportsView()" inputmode="numeric" style="margin-top:4px;">
            </div>
            
            <!-- VS -->
            <div style="font-size:18px; font-weight:600; color:var(--text-muted);">VS</div>
            
            <!-- Compare Period -->
            <div>
              <div style="font-weight:600; font-size:14px; margin-bottom:8px; text-align:center;">Compare</div>
              <select class="report-select" id="r-month-comp" onchange="state.compareMonth=parseInt(this.value); renderReportsView()">
                ${compareMonthOpts}
              </select>
              <input type="number" class="report-input" id="r-year-comp" value="${state.compareYear}" min="2020" max="2099" 
                onchange="state.compareYear=parseInt(this.value); renderReportsView()" inputmode="numeric" style="margin-top:4px;">
            </div>
          </div>
          
          <!-- Quick Presets -->
          <div style="display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap;">
            <button class="btn-secondary" style="flex:1; font-size:12px; padding:8px;" 
              onclick="state.compareMonth=state.selectedMonth; state.compareYear=state.selectedYear-1; renderReportsView()">
              Same Month Last Year
            </button>
            <button class="btn-secondary" style="flex:1; font-size:12px; padding:8px;" 
              onclick="state.compareMonth=(state.selectedMonth > 1 ? state.selectedMonth-1 : 12); state.compareYear=(state.selectedMonth > 1 ? state.selectedYear : state.selectedYear-1); renderReportsView()">
              Previous Month
            </button>
          </div>
          
          <button class="btn-primary" style="width:100%;" onclick="runMonthCompareReport()">Compare</button>
          
          <div id="report-output" style="margin-top:16px;"></div>
        </div>
      `;
      await runMonthCompareReport();
      break;
    }

    case 'date-compare': {
      // Initialize date range state if needed
      if (!state.range1Start) {
        state.range1Start = `${yearNow}-01-01`;
        state.range1End = `${yearNow}-03-31`;
        state.range2Start = `${yearNow-1}-01-01`;
        state.range2End = `${yearNow-1}-03-31`;
      }
      
      el.innerHTML = `
        <div class="report-body" style="padding:16px;">
          <h4 style="margin-bottom:16px; text-align:center;">Date Range Comparison</h4>
          
          <div style="display:grid; grid-template-columns:1fr auto 1fr; gap:12px; margin-bottom:16px;">
            <!-- Period 1 -->
            <div>
              <div style="font-weight:600; font-size:14px; margin-bottom:8px;">Period 1</div>
              <input type="date" class="report-input" value="${state.range1Start}" 
                onchange="state.range1Start=this.value; renderReportsView()" style="font-size:13px;">
              <input type="date" class="report-input" value="${state.range1End}" 
                onchange="state.range1End=this.value; renderReportsView()" style="font-size:13px; margin-top:4px;">
            </div>
            
            <!-- VS -->
            <div style="display:flex; align-items:center; font-size:18px; font-weight:600; color:var(--text-muted);">VS</div>
            
            <!-- Period 2 -->
            <div>
              <div style="font-weight:600; font-size:14px; margin-bottom:8px;">Period 2</div>
              <input type="date" class="report-input" value="${state.range2Start}" 
                onchange="state.range2Start=this.value; renderReportsView()" style="font-size:13px;">
              <input type="date" class="report-input" value="${state.range2End}" 
                onchange="state.range2End=this.value; renderReportsView()" style="font-size:13px; margin-top:4px;">
            </div>
          </div>
          
          <!-- Quick Presets -->
          <div style="margin-bottom:16px;">
            <label style="font-size:13px; font-weight:600; display:block; margin-bottom:6px;">Quick Preset:</label>
            <select class="report-select" style="width:100%; font-size:13px;" onchange="
              const val = this.value;
              const y = ${yearNow};
              if (val === 'q1') {
                state.range1Start = y+'-01-01'; state.range1End = y+'-03-31';
                state.range2Start = (y-1)+'-01-01'; state.range2End = (y-1)+'-03-31';
              } else if (val === 'q2') {
                state.range1Start = y+'-04-01'; state.range1End = y+'-06-30';
                state.range2Start = (y-1)+'-04-01'; state.range2End = (y-1)+'-06-30';
              } else if (val === 'q3') {
                state.range1Start = y+'-07-01'; state.range1End = y+'-09-30';
                state.range2Start = (y-1)+'-07-01'; state.range2End = (y-1)+'-09-30';
              } else if (val === 'q4') {
                state.range1Start = y+'-10-01'; state.range1End = y+'-12-31';
                state.range2Start = (y-1)+'-10-01'; state.range2End = (y-1)+'-12-31';
              } else if (val === 'h1') {
                state.range1Start = y+'-01-01'; state.range1End = y+'-06-30';
                state.range2Start = (y-1)+'-01-01'; state.range2End = (y-1)+'-06-30';
              } else if (val === 'h2') {
                state.range1Start = y+'-07-01'; state.range1End = y+'-12-31';
                state.range2Start = (y-1)+'-07-01'; state.range2End = (y-1)+'-12-31';
              } else if (val === 'fy') {
                state.range1Start = y+'-01-01'; state.range1End = y+'-12-31';
                state.range2Start = (y-1)+'-01-01'; state.range2End = (y-1)+'-12-31';
              }
              if (val !== '') renderReportsView();
              this.value = '';
            ">
              <option value="">-- Select a preset --</option>
              <option value="q1">Q1: Jan-Mar (YoY)</option>
              <option value="q2">Q2: Apr-Jun (YoY)</option>
              <option value="q3">Q3: Jul-Sep (YoY)</option>
              <option value="q4">Q4: Oct-Dec (YoY)</option>
              <option value="h1">H1: Jan-Jun (YoY)</option>
              <option value="h2">H2: Jul-Dec (YoY)</option>
              <option value="fy">Full Year (YoY)</option>
            </select>
          </div>
          
          <button class="btn-primary" style="width:100%;" onclick="runDateRangeCompareReport()">Compare</button>
          
          <div id="report-output" style="margin-top:16px;"></div>
        </div>
      `;
      await runDateRangeCompareReport();
      break;
    }

    case 'annual': {
      el.innerHTML = `
        <div class="report-controls">
          <input type="number" class="report-input" id="r-annual-year" value="${yearNow}" min="2020" max="2099" style="max-width:100px" inputmode="numeric">
          <button class="report-btn" onclick="runAnnualReport()">View</button>
        </div>
        <div class="report-body" id="report-output"></div>
      `;
      await runAnnualReport();
      break;
    }

    case 'yoy': {
      el.innerHTML = `
        <div class="report-controls" style="gap:6px;">
          <input type="number" class="report-input" id="r-yoy-year1" value="${yearNow-1}" min="2020" max="2099" inputmode="numeric">
          <span style="color:var(--text-muted)">vs</span>
          <input type="number" class="report-input" id="r-yoy-year2" value="${yearNow}" min="2020" max="2099" inputmode="numeric">
          <button class="report-btn" onclick="runYOYReport()">View</button>
        </div>
        <div class="report-body" id="report-output"></div>
      `;
      await runYOYReport();
      break;
    }

    case 'category': {
      el.innerHTML = `
        <div class="report-controls" style="flex-wrap:wrap; gap:8px;">
          <input type="date" class="report-input" id="r-cat-from" value="${new Date().getFullYear()}-01-01">
          <span style="color:var(--text-muted)">to</span>
          <input type="date" class="report-input" id="r-cat-to" value="${todayStr()}">
          <button class="report-btn" onclick="runCategoryReport()">View</button>
        </div>
        <div class="report-body" id="report-output"></div>
      `;
      await runCategoryReport();
      break;
    }

    case 'export': {
      el.innerHTML = `
        <div class="report-controls" style="flex-wrap:wrap; gap:8px;">
          <div style="flex:1; min-width:200px;">
            <label style="font-size:12px; color:var(--text-muted); display:block; margin-bottom:4px;">From Date</label>
            <input type="date" class="report-input" id="r-exp-from" value="${new Date().getFullYear()}-01-01">
          </div>
          <div style="flex:1; min-width:200px;">
            <label style="font-size:12px; color:var(--text-muted); display:block; margin-bottom:4px;">To Date</label>
            <input type="date" class="report-input" id="r-exp-to" value="${todayStr()}">
          </div>
        </div>
        <div class="report-body">
          <p style="color:var(--text-muted); font-size:14px; margin-bottom:16px; line-height:1.6;">
            Export all transactions in the selected date range to a CSV file.
            Open it in Excel or Google Sheets for further analysis.
          </p>
          <button class="export-btn" onclick="exportCSV()">
            📥 Download CSV File
          </button>
        </div>
      `;
      break;
    }
  }
}

// ---- Daily Report ----
async function runDailyReport() {
  const date = document.getElementById('r-date')?.value || state.selectedDate;
  const txns = await db.transactions.where('date').equals(date).toArray();
  const sum  = await db.dailySummary.where('date').equals(date).first();

  const income   = txns.filter(t => t.type === 'INCOME');
  const expenses = txns.filter(t => t.type === 'EXPENSE');
  const svcTotal = income.reduce((s,t) => s + (t.serviceAmount||0), 0);
  const tipTotal = income.reduce((s,t) => s + (t.tipAmount||0), 0);
  const expTotal = expenses.reduce((s,t) => s + (t.amount||0), 0);

  document.getElementById('report-output').innerHTML = `
    <div class="report-section-title">${formatDateDisplay(date)}</div>
    <div class="report-stat-grid">
      <div class="report-stat"><div class="report-stat-label">Services</div><div class="report-stat-value green">${fmt(svcTotal)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Tips</div><div class="report-stat-value gold">${fmt(tipTotal)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Expenses</div><div class="report-stat-value red">${fmt(expTotal)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Net</div><div class="report-stat-value plum">${fmt(svcTotal+tipTotal-expTotal)}</div></div>
      ${sum ? `
      <div class="report-stat"><div class="report-stat-label">Clients</div><div class="report-stat-value">${sum.clientsSeen}</div></div>
      <div class="report-stat"><div class="report-stat-label">Hours</div><div class="report-stat-value">${sum.hoursWorked}</div></div>
      ` : ''}
    </div>
    ${income.length > 0 ? `
      <div class="report-white-card">
        <div class="report-section-title">Income Breakdown</div>
        ${income.map(t=>`
          <div class="report-row">
            <div><div class="report-row-label">${t.category}</div><div class="report-row-sub">${t.paymentMethod||''}</div></div>
            <div class="report-row-value income">+${fmt((t.serviceAmount||0)+(t.tipAmount||0))}</div>
          </div>
        `).join('')}
      </div>
    ` : ''}
    ${expenses.length > 0 ? `
      <div class="report-white-card">
        <div class="report-section-title">Expense Breakdown</div>
        ${expenses.map(t=>`
          <div class="report-row">
            <div><div class="report-row-label">${t.category}</div><div class="report-row-sub">${t.notes||''}</div></div>
            <div class="report-row-value expense">-${fmt(t.amount)}</div>
          </div>
        `).join('')}
      </div>
    ` : ''}
    ${txns.length === 0 ? `<p style="color:var(--text-muted);text-align:center;padding:30px 0;">No entries for this date.</p>` : ''}
  `;
}

// ---- Weekly Report ----
function navigateWeek(direction) {
  // direction: -1 for previous week, +1 for next week
  const currentDate = document.getElementById('r-week-date')?.value || state.selectedDate;
  const newDate = addDays(currentDate, direction * 7);
  
  // Update the date input
  const dateInput = document.getElementById('r-week-date');
  if (dateInput) {
    dateInput.value = newDate;
  }
  
  // Update state and run report
  state.selectedDate = newDate;
  runWeeklyReport();
}

async function runWeeklyReport() {
  const pickedDate = document.getElementById('r-week-date')?.value || state.selectedDate;
  const weekStart  = getWeekStart(pickedDate);

  let weeklyIncome = 0, weeklyTips = 0, weeklyExp = 0, weeklyClients = 0;
  const rows = [];

  for (let i = 0; i < 7; i++) {
    const d    = addDays(weekStart, i);
    const txns = await db.transactions.where('date').equals(d).toArray();
    const sum  = await db.dailySummary.where('date').equals(d).first();
    const inc  = txns.filter(t=>t.type==='INCOME').reduce((s,t)=>s+(t.serviceAmount||0),0);
    const tips = txns.filter(t=>t.type==='INCOME').reduce((s,t)=>s+(t.tipAmount||0),0);
    const exp  = txns.filter(t=>t.type==='EXPENSE').reduce((s,t)=>s+(t.amount||0),0);
    const cls  = sum ? sum.clientsSeen : 0;
    weeklyIncome  += inc;
    weeklyTips    += tips;
    weeklyExp     += exp;
    weeklyClients += cls;
    if (txns.length > 0 || sum) {
      rows.push({ d, inc, tips, exp, cls, net: inc+tips-exp });
    }
  }
  
  // Calculate comparison stats
  let comparisonHTML = '';
  const isCurrentWeek = getWeekStart(todayStr()) === weekStart;
  
  if (isCurrentWeek) {
    const allTxns = await db.transactions.toArray();
    
    // Last week
    const lastWeekStart = addDays(weekStart, -7);
    let lastWeekIncome = 0;
    for (let i = 0; i < 7; i++) {
      const d = addDays(lastWeekStart, i);
      const dayIncome = allTxns
        .filter(t => t.date === d && t.type === 'INCOME')
        .reduce((s, t) => s + (t.serviceAmount || 0) + (t.tipAmount || 0), 0);
      lastWeekIncome += dayIncome;
    }
    
    // 4 weeks ago (monthly comparison)
    const fourWeeksStart = addDays(weekStart, -28);
    let fourWeeksIncome = 0;
    for (let i = 0; i < 7; i++) {
      const d = addDays(fourWeeksStart, i);
      const dayIncome = allTxns
        .filter(t => t.date === d && t.type === 'INCOME')
        .reduce((s, t) => s + (t.serviceAmount || 0) + (t.tipAmount || 0), 0);
      fourWeeksIncome += dayIncome;
    }
    
    const totalCurrentIncome = weeklyIncome + weeklyTips;
    
    const calcChange = (current, previous) => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return ((current - previous) / previous) * 100;
    };
    
    const vsLastWeek = calcChange(totalCurrentIncome, lastWeekIncome);
    const vsFourWeeks = calcChange(totalCurrentIncome, fourWeeksIncome);
    
    const formatChange = (change, prevAmount) => {
      if (prevAmount === 0 && change === 0) {
        return '<span style="color:var(--text-muted); font-size:14px;">No data</span>';
      }
      const arrow = change > 0 ? '↑' : change < 0 ? '↓' : '→';
      const color = change > 0 ? '#2D7A4C' : change < 0 ? '#C13838' : '#999';
      const percent = Math.abs(change).toFixed(0);
      return `
        <div style="color:${color};">
          <span class="comparison-arrow">${arrow}</span><span class="comparison-percent">${percent}%</span>
        </div>
      `;
    };
    
    comparisonHTML = `
      <div class="comparison-cards" style="margin-top:16px;">
        <div class="comparison-card">
          <div class="comparison-label">vs Last Week</div>
          <div class="comparison-value">${formatChange(vsLastWeek, lastWeekIncome)}</div>
          <div class="comparison-amount">${fmt(lastWeekIncome)}</div>
        </div>
        <div class="comparison-card">
          <div class="comparison-label">vs 4 Weeks Ago</div>
          <div class="comparison-value">${formatChange(vsFourWeeks, fourWeeksIncome)}</div>
          <div class="comparison-amount">${fmt(fourWeeksIncome)}</div>
        </div>
      </div>
    `;
  }

  document.getElementById('report-output').innerHTML = `
    <div class="report-section-title">Week of ${formatDateShort(weekStart)}</div>
    <div class="report-stat-grid">
      <div class="report-stat"><div class="report-stat-label">Total Income</div><div class="report-stat-value green">${fmt(weeklyIncome)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Tips</div><div class="report-stat-value gold">${fmt(weeklyTips)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Expenses</div><div class="report-stat-value red">${fmt(weeklyExp)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Net</div><div class="report-stat-value plum">${fmt(weeklyIncome+weeklyTips-weeklyExp)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Clients</div><div class="report-stat-value">${weeklyClients}</div></div>
      <div class="report-stat"><div class="report-stat-label">Avg/Client</div><div class="report-stat-value">${weeklyClients>0?fmt((weeklyIncome+weeklyTips)/weeklyClients):'—'}</div></div>
    </div>
    ${comparisonHTML}
    ${rows.length > 0 ? `
    <div class="report-white-card">
      <div class="report-section-title">Daily Breakdown</div>
      ${rows.map(r=>`
        <div class="report-row">
          <div>
            <div class="report-row-label">${formatDateShort(r.d)}</div>
            <div class="report-row-sub">${r.cls} clients</div>
          </div>
          <div style="text-align:right">
            <div class="report-row-value income">+${fmt(r.inc+r.tips)}</div>
            <div style="font-size:12px; color:var(--danger)">-${fmt(r.exp)}</div>
          </div>
        </div>
      `).join('')}
    </div>
    ` : '<p style="color:var(--text-muted);text-align:center;padding:30px 0;">No data for this week.</p>'}
  `;
}

// ---- Monthly Report ----
async function runMonthlyReport() {
  const month = parseInt(document.getElementById('r-month')?.value) || state.selectedMonth;
  const year  = parseInt(document.getElementById('r-year')?.value)  || state.selectedYear;

  const monthStr = `${year}-${String(month).padStart(2,'0')}`;
  const allTxns  = await db.transactions.toArray();
  const txns     = allTxns.filter(t => t.date && t.date.startsWith(monthStr));
  const allMExps = await db.monthlyExpenses.toArray();
  const mExps    = allMExps.filter(e => e.year === year && e.month === month);
  const sums     = await db.dailySummary.toArray();

  const income   = txns.filter(t => t.type === 'INCOME');
  const dExpense = txns.filter(t => t.type === 'EXPENSE');

  const svcTotal  = income.reduce((s,t)=>s+(t.serviceAmount||0),0);
  const tipTotal  = income.reduce((s,t)=>s+(t.tipAmount||0),0);
  const dExpTotal = dExpense.reduce((s,t)=>s+(t.amount||0),0);
  const mExpTotal = mExps.reduce((s,e)=>s+(e.amount||0),0);
  const totalExp  = dExpTotal + mExpTotal;

  const allRentPmts = await db.rentPayments.toArray();
  const monthRent   = allRentPmts.filter(p => p.datePaid && p.datePaid.startsWith(monthStr));
  const rentTotal   = monthRent.reduce((s,p)=>s+(p.amount||0),0);
  const renters     = await db.renters.where('status').equals('active').toArray();
  const expectedRent = renters.reduce((s,r)=>s+(r.weeklyRate||0),0) * 4;

  // Net profit calculation: Services + Tips + Booth Rent (income from renters) - Expenses
  const net       = svcTotal + tipTotal + rentTotal - totalExp;
  const totalIncome = svcTotal + tipTotal + rentTotal;

  const monthSums    = sums.filter(s => s.date && s.date.startsWith(monthStr));
  const totalClients = monthSums.reduce((s,d)=>s+(d.clientsSeen||0),0);
  const totalHours   = monthSums.reduce((s,d)=>s+(d.hoursWorked||0),0);

  document.getElementById('report-output').innerHTML = `
    <div class="report-section-title">${monthName(month)} ${year}</div>
    
    <div class="report-white-card" style="padding:20px;">
      <div style="font-weight:700; font-size:15px; color:var(--plum); margin-bottom:16px; text-align:center;">Monthly Calculation</div>
      
      <!-- Income Section -->
      <div class="report-stat" style="background:rgba(123, 203, 138, 0.1); border-radius:6px; padding:12px; margin-bottom:6px;">
        <div class="report-stat-label">Services</div>
        <div class="report-stat-value green">${fmt(svcTotal)}</div>
      </div>
      
      <div class="report-stat" style="background:rgba(123, 203, 138, 0.1); border-radius:6px; padding:12px; margin-bottom:6px;">
        <div class="report-stat-label"><span style="color:var(--success); font-size:18px; margin-right:4px;">+</span> Tips</div>
        <div class="report-stat-value green">${fmt(tipTotal)}</div>
      </div>
      
      ${rentTotal > 0 ? `
      <div class="report-stat" style="background:rgba(123, 203, 138, 0.1); border-radius:6px; padding:12px; margin-bottom:6px;">
        <div class="report-stat-label"><span style="color:var(--success); font-size:18px; margin-right:4px;">+</span> Booth Rent</div>
        <div class="report-stat-value green">${fmt(rentTotal)}</div>
      </div>
      ` : ''}
      
      <div style="border-top:2px solid var(--success); margin:10px 0; padding-top:10px;">
        <div class="report-stat" style="background:rgba(123, 203, 138, 0.2); border-radius:6px; padding:14px; border:2px solid var(--success);">
          <div class="report-stat-label" style="font-weight:700;"><span style="color:var(--success); font-size:20px; margin-right:4px;">=</span> Total Income</div>
          <div class="report-stat-value green" style="font-size:22px; font-weight:800;">${fmt(totalIncome)}</div>
        </div>
      </div>
      
      <!-- Expense Section -->
      <div style="margin-top:20px;">
        <div class="report-stat" style="background:rgba(193, 56, 56, 0.1); border-radius:6px; padding:12px; margin-bottom:6px;">
          <div class="report-stat-label"><span style="color:var(--danger); font-size:18px; margin-right:4px;">−</span> Daily Exp</div>
          <div class="report-stat-value red">${fmt(dExpTotal)}</div>
        </div>
        
        <div class="report-stat" style="background:rgba(193, 56, 56, 0.1); border-radius:6px; padding:12px; margin-bottom:6px;">
          <div class="report-stat-label"><span style="color:var(--danger); font-size:18px; margin-right:4px;">−</span> Monthly Exp</div>
          <div class="report-stat-value red">${fmt(mExpTotal)}</div>
        </div>
        
        <div style="border-top:3px solid var(--success); margin:10px 0; padding-top:10px;">
          <div class="report-stat" style="background:rgba(123, 203, 138, 0.25); border-radius:6px; padding:16px; border:3px solid var(--success);">
            <div class="report-stat-label" style="font-weight:700; font-size:16px;"><span style="color:var(--success); font-size:22px; margin-right:4px;">=</span> Net Profit</div>
            <div class="report-stat-value green" style="font-size:26px; font-weight:800;">${fmt(net)}</div>
          </div>
        </div>
      </div>
      
      <!-- Stats -->
      <div style="margin-top:20px; padding-top:16px; border-top:1px solid var(--border);">
        <div class="report-stat-grid" style="grid-template-columns:1fr 1fr; gap:12px;">
          <div class="report-stat">
            <div class="report-stat-label">Clients</div>
            <div class="report-stat-value">${totalClients}</div>
          </div>
          <div class="report-stat">
            <div class="report-stat-label">Hours</div>
            <div class="report-stat-value">${totalHours}</div>
          </div>
        </div>
      </div>
    </div>

    ${(svcTotal + tipTotal + rentTotal) > 0 ? `
    <div class="report-white-card">
      <div class="report-section-title">Income Sources</div>
      <div class="pie-chart-wrap">
        <canvas id="pie-monthly-income" width="260" height="260"></canvas>
      </div>
    </div>` : ''}

    ${totalExp > 0 ? `
    <div class="report-white-card">
      <div class="report-section-title">Expense Breakdown</div>
      <div class="pie-chart-wrap">
        <canvas id="pie-monthly-exp" width="260" height="260"></canvas>
      </div>
    </div>` : ''}

    ${rentTotal > 0 ? `
    <div class="report-white-card">
      <div class="report-section-title">Booth Rent Collected</div>
      <div class="report-row"><div class="report-row-label">Collected</div><div class="report-row-value income">+${fmt(rentTotal)}</div></div>
      <div class="report-row"><div class="report-row-label">Payments</div><div class="report-row-value">${monthRent.length}</div></div>
    </div>` : ''}
    ${mExps.length > 0 ? `
    <div class="report-white-card">
      <div class="report-section-title">Fixed Monthly Expenses</div>
      ${mExps.map(e=>`
        <div class="report-row">
          <div class="report-row-label">${e.category}</div>
          <div class="report-row-value expense">-${fmt(e.amount)}</div>
        </div>
      `).join('')}
    </div>` : ''}
  `;

  // Income sources pie
  if ((svcTotal + tipTotal + rentTotal) > 0) {
        const incLabels = [], incVals = [];
    if (svcTotal  > 0) { incLabels.push('Services');    incVals.push(svcTotal); }
    if (tipTotal  > 0) { incLabels.push('Tips');        incVals.push(tipTotal); }
    if (rentTotal > 0) { incLabels.push('Booth Rent');  incVals.push(rentTotal); }
    drawPie('pie-monthly-income', incLabels, incVals);
  } else {
    }

  // Expense breakdown pie — daily exp by category + monthly exp by category
  if (totalExp > 0) {
        const expMap = {};
    dExpense.forEach(t => {
      expMap[t.category] = (expMap[t.category]||0) + (t.amount||0);
    });
    mExps.forEach(e => {
      expMap[e.category] = (expMap[e.category]||0) + (e.amount||0);
    });
    const expEntries = Object.entries(expMap).sort((a,b)=>b[1]-a[1]);
      drawPie('pie-monthly-exp', expEntries.map(([k])=>k), expEntries.map(([,v])=>v));
  } else {
    }
}

// ---- Month Compare Report ----
async function runMonthCompareReport() {
  const allTxns = await db.transactions.toArray();
  
  // Current period
  const currentTxns = allTxns.filter(t => {
    const [y, m] = t.date.split('-');
    return parseInt(y) === state.selectedYear && parseInt(m) === state.selectedMonth;
  });
  
  const currentIncome = currentTxns.filter(t => t.type === 'INCOME');
  const currentExpenses = currentTxns.filter(t => t.type === 'EXPENSE');
  const currentTotalIncome = currentIncome.reduce((s, t) => s + (t.serviceAmount||0) + (t.tipAmount||0), 0);
  const currentTotalExpense = currentExpenses.reduce((s, t) => s + (t.amount||0), 0);
  
  const allMonthlyExpenses = await db.monthlyExpenses.toArray();
  const currentMonthlyExpenses = allMonthlyExpenses.filter(e => 
    e.year === state.selectedYear && e.month === state.selectedMonth
  );
  const currentMonthlyExpenseTotal = currentMonthlyExpenses.reduce((s, e) => s + (e.amount||0), 0);
  const currentNet = currentTotalIncome - currentTotalExpense - currentMonthlyExpenseTotal;
  
  // Comparison period
  const compareTxns = allTxns.filter(t => {
    const [y, m] = t.date.split('-');
    return parseInt(y) === state.compareYear && parseInt(m) === state.compareMonth;
  });
  
  const compareIncome = compareTxns.filter(t => t.type === 'INCOME');
  const compareExpenses = compareTxns.filter(t => t.type === 'EXPENSE');
  const compareTotalIncome = compareIncome.reduce((s, t) => s + (t.serviceAmount||0) + (t.tipAmount||0), 0);
  const compareTotalExpense = compareExpenses.reduce((s, t) => s + (t.amount||0), 0);
  
  const compareMonthlyExpenses = allMonthlyExpenses.filter(e => 
    e.year === state.compareYear && e.month === state.compareMonth
  );
  const compareMonthlyExpenseTotal = compareMonthlyExpenses.reduce((s, e) => s + (e.amount||0), 0);
  const compareNet = compareTotalIncome - compareTotalExpense - compareMonthlyExpenseTotal;
  
  // Calculate changes
  const incomeChange = currentTotalIncome - compareTotalIncome;
  const incomeChangePercent = compareTotalIncome !== 0 ? ((incomeChange / compareTotalIncome) * 100) : 0;
  const expenseChange = (currentTotalExpense + currentMonthlyExpenseTotal) - (compareTotalExpense + compareMonthlyExpenseTotal);
  const expenseChangePercent = (compareTotalExpense + compareMonthlyExpenseTotal) !== 0 ? ((expenseChange / (compareTotalExpense + compareMonthlyExpenseTotal)) * 100) : 0;
  const netChange = currentNet - compareNet;
  const netChangePercent = compareNet !== 0 ? ((netChange / compareNet) * 100) : 0;
  
  const out = document.getElementById('report-output');
  if (!out) return;
  
  out.innerHTML = `
    <!-- Mobile-Optimized Comparison Cards -->
    <div style="display:flex; flex-direction:column; gap:16px;">
      
      <!-- Income Card -->
      <div style="background:var(--bg-secondary); border-radius:12px; padding:16px; border-left:4px solid var(--success);">
        <div style="font-weight:700; font-size:16px; margin-bottom:12px; color:var(--text);">💰 Income</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;">
          <div>
            <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">${monthName(state.selectedMonth)} ${state.selectedYear}</div>
            <div style="font-size:20px; font-weight:700; color:var(--success);">${fmt(currentTotalIncome)}</div>
          </div>
          <div>
            <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">${monthName(state.compareMonth)} ${state.compareYear}</div>
            <div style="font-size:20px; font-weight:700; color:var(--success);">${fmt(compareTotalIncome)}</div>
          </div>
        </div>
        <div style="padding-top:12px; border-top:1px solid var(--border);">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:14px; color:var(--text-muted);">Change:</span>
            <div style="text-align:right;">
              <div style="font-size:18px; font-weight:700; color:${incomeChange >= 0 ? 'var(--success)' : 'var(--danger)'};">
                ${incomeChange >= 0 ? '+' : ''}${fmt(incomeChange)}
              </div>
              <div style="font-size:13px; color:${incomeChange >= 0 ? 'var(--success)' : 'var(--danger)'};">
                ${incomeChangePercent >= 0 ? '+' : ''}${incomeChangePercent.toFixed(1)}%
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Expenses Card -->
      <div style="background:var(--bg-secondary); border-radius:12px; padding:16px; border-left:4px solid var(--danger);">
        <div style="font-weight:700; font-size:16px; margin-bottom:12px; color:var(--text);">💸 Expenses</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;">
          <div>
            <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">${monthName(state.selectedMonth)} ${state.selectedYear}</div>
            <div style="font-size:20px; font-weight:700; color:var(--danger);">${fmt(currentTotalExpense + currentMonthlyExpenseTotal)}</div>
          </div>
          <div>
            <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">${monthName(state.compareMonth)} ${state.compareYear}</div>
            <div style="font-size:20px; font-weight:700; color:var(--danger);">${fmt(compareTotalExpense + compareMonthlyExpenseTotal)}</div>
          </div>
        </div>
        <div style="padding-top:12px; border-top:1px solid var(--border);">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:14px; color:var(--text-muted);">Change:</span>
            <div style="text-align:right;">
              <div style="font-size:18px; font-weight:700; color:${expenseChange <= 0 ? 'var(--success)' : 'var(--danger)'};">
                ${expenseChange >= 0 ? '+' : ''}${fmt(expenseChange)}
              </div>
              <div style="font-size:13px; color:${expenseChange <= 0 ? 'var(--success)' : 'var(--danger)'};">
                ${expenseChangePercent >= 0 ? '+' : ''}${expenseChangePercent.toFixed(1)}%
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Net Profit Card -->
      <div style="background:var(--bg-secondary); border-radius:12px; padding:16px; border-left:4px solid ${netChange >= 0 ? 'var(--success)' : 'var(--danger)'};">
        <div style="font-weight:700; font-size:16px; margin-bottom:12px; color:var(--text);">📊 Net Profit</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;">
          <div>
            <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">${monthName(state.selectedMonth)} ${state.selectedYear}</div>
            <div style="font-size:20px; font-weight:700; color:${currentNet >= 0 ? 'var(--success)' : 'var(--danger)'};">${fmt(currentNet)}</div>
          </div>
          <div>
            <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">${monthName(state.compareMonth)} ${state.compareYear}</div>
            <div style="font-size:20px; font-weight:700; color:${compareNet >= 0 ? 'var(--success)' : 'var(--danger)'};">${fmt(compareNet)}</div>
          </div>
        </div>
        <div style="padding-top:12px; border-top:1px solid var(--border);">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:14px; color:var(--text-muted);">Change:</span>
            <div style="text-align:right;">
              <div style="font-size:18px; font-weight:700; color:${netChange >= 0 ? 'var(--success)' : 'var(--danger)'};">
                ${netChange >= 0 ? '+' : ''}${fmt(netChange)}
              </div>
              <div style="font-size:13px; color:${netChange >= 0 ? 'var(--success)' : 'var(--danger)'};">
                ${netChangePercent >= 0 ? '+' : ''}${netChangePercent.toFixed(1)}%
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Summary Card -->
      <div style="background:var(--bg-secondary); border-radius:12px; padding:16px; border:2px solid var(--border);">
        <div style="font-weight:700; font-size:16px; margin-bottom:12px; color:var(--text); display:flex; align-items:center; gap:8px;">
          <span style="font-size:20px;">📊</span> Summary
        </div>
        <div style="font-size:15px; line-height:1.8; color:var(--text);">
          <div style="margin-bottom:8px;">
            <span style="font-size:18px;">${incomeChange >= 0 ? '✅' : '📉'}</span> 
            <strong>Income ${incomeChange >= 0 ? 'increased' : 'decreased'}:</strong><br>
            <span style="font-size:17px; font-weight:700; color:${incomeChange >= 0 ? 'var(--success)' : 'var(--danger)'};">
              ${fmt(Math.abs(incomeChange))}
            </span>
            <span style="color:var(--text-muted);"> (${Math.abs(incomeChangePercent).toFixed(1)}%)</span>
          </div>
          <div>
            <span style="font-size:18px;">${netChange >= 0 ? '✅' : '⚠️'}</span> 
            <strong>Net profit ${netChange >= 0 ? 'improved' : 'declined'}:</strong><br>
            <span style="font-size:17px; font-weight:700; color:${netChange >= 0 ? 'var(--success)' : 'var(--danger)'};">
              ${fmt(Math.abs(netChange))}
            </span>
            <span style="color:var(--text-muted);"> (${Math.abs(netChangePercent).toFixed(1)}%)</span>
          </div>
        </div>
      </div>
      
    </div>
  `;
}

// ---- Date Range Compare Report ----
async function runDateRangeCompareReport() {
  const allTxns = await db.transactions.toArray();
  
  // Helper to calculate range stats
  const calculateRangeStats = (startDate, endDate) => {
    const txns = allTxns.filter(t => t.date >= startDate && t.date <= endDate);
    const income = txns.filter(t => t.type === 'INCOME');
    const expenses = txns.filter(t => t.type === 'EXPENSE');
    const totalIncome = income.reduce((s, t) => s + (t.serviceAmount||0) + (t.tipAmount||0), 0);
    const totalExpense = expenses.reduce((s, t) => s + (t.amount||0), 0);
    
    return {
      income: totalIncome,
      expense: totalExpense,
      net: totalIncome - totalExpense,
      transactionCount: txns.length
    };
  };
  
  const range1 = calculateRangeStats(state.range1Start, state.range1End);
  const range2 = calculateRangeStats(state.range2Start, state.range2End);
  
  // Calculate changes
  const incomeChange = range1.income - range2.income;
  const incomeChangePercent = range2.income !== 0 ? ((incomeChange / range2.income) * 100) : 0;
  const expenseChange = range1.expense - range2.expense;
  const expenseChangePercent = range2.expense !== 0 ? ((expenseChange / range2.expense) * 100) : 0;
  const netChange = range1.net - range2.net;
  const netChangePercent = range2.net !== 0 ? ((netChange / range2.net) * 100) : 0;
  
  const out = document.getElementById('report-output');
  if (!out) return;
  
  out.innerHTML = `
    <!-- Mobile-Optimized Comparison Cards -->
    <div style="display:flex; flex-direction:column; gap:16px;">
      
      <!-- Date Ranges Header -->
      <div style="display:grid; grid-template-columns:1fr auto 1fr; gap:8px; padding:12px; background:var(--bg-secondary); border-radius:8px; font-size:13px;">
        <div>
          <div style="font-weight:600; color:var(--text); margin-bottom:4px;">Period 1</div>
          <div style="color:var(--text-muted);">${new Date(state.range1Start).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'})} - ${new Date(state.range1End).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'})}</div>
        </div>
        <div style="display:flex; align-items:center; justify-content:center; font-size:18px; color:var(--text-muted); font-weight:600;">VS</div>
        <div>
          <div style="font-weight:600; color:var(--text); margin-bottom:4px;">Period 2</div>
          <div style="color:var(--text-muted);">${new Date(state.range2Start).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'})} - ${new Date(state.range2End).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'})}</div>
        </div>
      </div>
      
      <!-- Income Card -->
      <div style="background:var(--bg-secondary); border-radius:12px; padding:16px; border-left:4px solid var(--success);">
        <div style="font-weight:700; font-size:16px; margin-bottom:12px; color:var(--text);">💰 Income</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;">
          <div>
            <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">Period 1</div>
            <div style="font-size:20px; font-weight:700; color:var(--success);">${fmt(range1.income)}</div>
          </div>
          <div>
            <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">Period 2</div>
            <div style="font-size:20px; font-weight:700; color:var(--success);">${fmt(range2.income)}</div>
          </div>
        </div>
        <div style="padding-top:12px; border-top:1px solid var(--border);">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:14px; color:var(--text-muted);">Change:</span>
            <div style="text-align:right;">
              <div style="font-size:18px; font-weight:700; color:${incomeChange >= 0 ? 'var(--success)' : 'var(--danger)'};">
                ${incomeChange >= 0 ? '+' : ''}${fmt(incomeChange)}
              </div>
              <div style="font-size:13px; color:${incomeChange >= 0 ? 'var(--success)' : 'var(--danger)'};">
                ${incomeChangePercent >= 0 ? '+' : ''}${incomeChangePercent.toFixed(1)}%
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Expenses Card -->
      <div style="background:var(--bg-secondary); border-radius:12px; padding:16px; border-left:4px solid var(--danger);">
        <div style="font-weight:700; font-size:16px; margin-bottom:12px; color:var(--text);">💸 Expenses</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;">
          <div>
            <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">Period 1</div>
            <div style="font-size:20px; font-weight:700; color:var(--danger);">${fmt(range1.expense)}</div>
          </div>
          <div>
            <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">Period 2</div>
            <div style="font-size:20px; font-weight:700; color:var(--danger);">${fmt(range2.expense)}</div>
          </div>
        </div>
        <div style="padding-top:12px; border-top:1px solid var(--border);">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:14px; color:var(--text-muted);">Change:</span>
            <div style="text-align:right;">
              <div style="font-size:18px; font-weight:700; color:${expenseChange <= 0 ? 'var(--success)' : 'var(--danger)'};">
                ${expenseChange >= 0 ? '+' : ''}${fmt(expenseChange)}
              </div>
              <div style="font-size:13px; color:${expenseChange <= 0 ? 'var(--success)' : 'var(--danger)'};">
                ${expenseChangePercent >= 0 ? '+' : ''}${expenseChangePercent.toFixed(1)}%
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Net Profit Card -->
      <div style="background:var(--bg-secondary); border-radius:12px; padding:16px; border-left:4px solid ${netChange >= 0 ? 'var(--success)' : 'var(--danger)'};">
        <div style="font-weight:700; font-size:16px; margin-bottom:12px; color:var(--text);">📊 Net Profit</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;">
          <div>
            <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">Period 1</div>
            <div style="font-size:20px; font-weight:700; color:${range1.net >= 0 ? 'var(--success)' : 'var(--danger)'};">${fmt(range1.net)}</div>
          </div>
          <div>
            <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">Period 2</div>
            <div style="font-size:20px; font-weight:700; color:${range2.net >= 0 ? 'var(--success)' : 'var(--danger)'};">${fmt(range2.net)}</div>
          </div>
        </div>
        <div style="padding-top:12px; border-top:1px solid var(--border);">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:14px; color:var(--text-muted);">Change:</span>
            <div style="text-align:right;">
              <div style="font-size:18px; font-weight:700; color:${netChange >= 0 ? 'var(--success)' : 'var(--danger)'};">
                ${netChange >= 0 ? '+' : ''}${fmt(netChange)}
              </div>
              <div style="font-size:13px; color:${netChange >= 0 ? 'var(--success)' : 'var(--danger)'};">
                ${netChangePercent >= 0 ? '+' : ''}${netChangePercent.toFixed(1)}%
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Transaction Count Card -->
      <div style="background:var(--bg-secondary); border-radius:12px; padding:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div style="font-size:14px; color:var(--text-muted);">Total Transactions:</div>
          <div style="display:flex; align-items:center; gap:12px;">
            <div>
              <div style="font-size:11px; color:var(--text-muted);">Period 1</div>
              <div style="font-size:18px; font-weight:700; color:var(--text);">${range1.transactionCount}</div>
            </div>
            <div style="color:var(--text-muted); font-size:14px;">→</div>
            <div>
              <div style="font-size:11px; color:var(--text-muted);">Period 2</div>
              <div style="font-size:18px; font-weight:700; color:var(--text);">${range2.transactionCount}</div>
            </div>
            <div>
              <div style="font-size:11px; color:var(--text-muted);">Change</div>
              <div style="font-size:18px; font-weight:700; color:${range1.transactionCount - range2.transactionCount >= 0 ? 'var(--success)' : 'var(--danger)'};">
                ${range1.transactionCount - range2.transactionCount >= 0 ? '+' : ''}${range1.transactionCount - range2.transactionCount}
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Summary Card -->
      <div style="background:var(--bg-secondary); border-radius:12px; padding:16px; border:2px solid var(--border);">
        <div style="font-weight:700; font-size:16px; margin-bottom:12px; color:var(--text); display:flex; align-items:center; gap:8px;">
          <span style="font-size:20px;">📊</span> Summary
        </div>
        <div style="font-size:15px; line-height:1.8; color:var(--text);">
          <div style="margin-bottom:8px;">
            <span style="font-size:18px;">${incomeChange >= 0 ? '✅' : '📉'}</span> 
            <strong>Income ${incomeChange >= 0 ? 'increased' : 'decreased'}:</strong><br>
            <span style="font-size:17px; font-weight:700; color:${incomeChange >= 0 ? 'var(--success)' : 'var(--danger)'};">
              ${fmt(Math.abs(incomeChange))}
            </span>
            <span style="color:var(--text-muted);"> (${Math.abs(incomeChangePercent).toFixed(1)}%)</span>
          </div>
          <div>
            <span style="font-size:18px;">${netChange >= 0 ? '✅' : '⚠️'}</span> 
            <strong>Net profit ${netChange >= 0 ? 'improved' : 'declined'}:</strong><br>
            <span style="font-size:17px; font-weight:700; color:${netChange >= 0 ? 'var(--success)' : 'var(--danger)'};">
              ${fmt(Math.abs(netChange))}
            </span>
            <span style="color:var(--text-muted);"> (${Math.abs(netChangePercent).toFixed(1)}%)</span>
          </div>
        </div>
      </div>
      
    </div>
  `;
}

// ---- Annual Report ----
async function runAnnualReport() {
  const year = parseInt(document.getElementById('r-annual-year')?.value) || state.selectedYear;

  const allTxns = await db.transactions.toArray();
  const allMExp = await db.monthlyExpenses.toArray();
  const allSums = await db.dailySummary.toArray();
  const allRentPmts = await db.rentPayments.toArray();

  let yearIncome=0, yearTips=0, yearExp=0, yearClients=0, yearRent=0;
  const rows = [];

  for (let m = 1; m <= 12; m++) {
    const ms    = `${year}-${String(m).padStart(2,'0')}`;
    const txns  = allTxns.filter(t => t.date?.startsWith(ms));
    const mExps = allMExp.filter(e => e.year === year && e.month === m);
    const inc   = txns.filter(t=>t.type==='INCOME').reduce((s,t)=>s+(t.serviceAmount||0),0);
    const tips  = txns.filter(t=>t.type==='INCOME').reduce((s,t)=>s+(t.tipAmount||0),0);
    const dExp  = txns.filter(t=>t.type==='EXPENSE').reduce((s,t)=>s+(t.amount||0),0);
    const mExp  = mExps.reduce((s,e)=>s+(e.amount||0),0);
    const rent  = allRentPmts.filter(p=>p.datePaid?.startsWith(ms)).reduce((s,p)=>s+(p.amount||0),0);
    const cls   = allSums.filter(s=>s.date?.startsWith(ms)).reduce((s,d)=>s+(d.clientsSeen||0),0);
    yearIncome  += inc;
    yearTips    += tips;
    yearExp     += dExp + mExp;
    yearClients += cls;
    yearRent    += rent;
    rows.push({ m, inc, tips, rent, dExp, mExp, cls, net: inc+tips+rent-dExp-mExp });
  }

  document.getElementById('report-output').innerHTML = `
    <div class="report-section-title">${year} Annual Summary</div>
    <div class="report-stat-grid">
      <div class="report-stat"><div class="report-stat-label">Services</div><div class="report-stat-value green">${fmt(yearIncome)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Tips</div><div class="report-stat-value gold">${fmt(yearTips)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Booth Rent</div><div class="report-stat-value green">${fmt(yearRent)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Expenses</div><div class="report-stat-value red">${fmt(yearExp)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Net Profit</div><div class="report-stat-value plum">${fmt(yearIncome+yearTips+yearRent-yearExp)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Clients</div><div class="report-stat-value">${yearClients}</div></div>
    </div>
    <div class="report-white-card">
      <div class="report-section-title">Monthly Breakdown</div>
      ${rows.map(r=>`
        <div class="report-row">
          <div>
            <div class="report-row-label">${monthName(r.m)}</div>
            <div class="report-row-sub">${r.cls} clients${r.rent>0?` · rent +${fmt(r.rent)}`:''}</div>
          </div>
          <div style="text-align:right">
            <div class="report-row-value income">+${fmt(r.inc+r.tips+r.rent)}</div>
            <div style="font-size:12px; color:var(--danger)">exp -${fmt(r.dExp+r.mExp)}</div>
            <div style="font-size:12px; color:var(--plum); font-weight:600">net ${fmt(r.net)}</div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// ---- Year Over Year Report ----
async function runYOYReport() {
  const y1 = parseInt(document.getElementById('r-yoy-year1')?.value);
  const y2 = parseInt(document.getElementById('r-yoy-year2')?.value);
  if (!y1 || !y2) return;

  async function yearTotals(year) {
    const txns  = await db.transactions.toArray();
    const yTxns = txns.filter(t => t.date?.startsWith(String(year)));
    const mExps = await db.monthlyExpenses.toArray();
    const yMExp = mExps.filter(e => e.year === year);
    const inc   = yTxns.filter(t=>t.type==='INCOME').reduce((s,t)=>s+(t.serviceAmount||0),0);
    const tips  = yTxns.filter(t=>t.type==='INCOME').reduce((s,t)=>s+(t.tipAmount||0),0);
    const dExp  = yTxns.filter(t=>t.type==='EXPENSE').reduce((s,t)=>s+(t.amount||0),0);
    const mExp  = yMExp.reduce((s,e)=>s+(e.amount||0),0);
    const sums  = await db.dailySummary.toArray();
    const cls   = sums.filter(s=>s.date?.startsWith(String(year))).reduce((s,d)=>s+(d.clientsSeen||0),0);
    return { inc, tips, exp: dExp+mExp, net: inc+tips-dExp-mExp, cls };
  }

  const [a, b] = await Promise.all([yearTotals(y1), yearTotals(y2)]);

  const diff = (v1, v2) => {
    if (v1 === 0) return '';
    const pct   = ((v2-v1)/Math.abs(v1)*100).toFixed(1);
    const arrow = v2 >= v1 ? '▲' : '▼';
    const color = v2 >= v1 ? 'green' : 'red';
    return `<span style="color:var(--${color}); font-size:12px; margin-left:6px">${arrow} ${Math.abs(pct)}%</span>`;
  };

  document.getElementById('report-output').innerHTML = `
    <div class="report-white-card">
      <div class="report-section-title">Year Over Year Comparison</div>
      <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; text-align:center; font-size:13px; color:var(--text-muted); font-weight:600; padding-bottom:8px; border-bottom:1px solid var(--border);">
        <span></span><span>${y1}</span><span>${y2}</span>
      </div>
      ${[
        ['Income',   fmt(a.inc),  fmt(b.inc),  diff(a.inc, b.inc)],
        ['Tips',     fmt(a.tips), fmt(b.tips), diff(a.tips, b.tips)],
        ['Expenses', fmt(a.exp),  fmt(b.exp),  diff(a.exp, b.exp)],
        ['Net',      fmt(a.net),  fmt(b.net),  diff(a.net, b.net)],
        ['Clients',  a.cls,       b.cls,       diff(a.cls, b.cls)],
      ].map(([label, v1, v2, ch]) => `
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; align-items:center; padding:10px 0; border-bottom:1px solid var(--border); font-size:14px;">
          <span style="color:var(--text-muted); font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.5px;">${label}</span>
          <span style="text-align:center; font-weight:600;">${v1}</span>
          <span style="text-align:center; font-weight:600;">${v2}${ch}</span>
        </div>
      `).join('')}
    </div>
  `;
}

// ---- Category Report ----
async function runCategoryReport() {
  const from = document.getElementById('r-cat-from')?.value;
  const to   = document.getElementById('r-cat-to')?.value;
  if (!from || !to) return;

  // Get daily transactions
  const allTxns = await db.transactions.toArray();
  const txns    = allTxns.filter(t => t.date >= from && t.date <= to);

  // Get monthly expenses
  const allMonthlyExp = await db.monthlyExpenses.toArray();
  const monthlyExp = allMonthlyExp.filter(e => {
    if (!e.month) return false;
    // Convert month (YYYY-MM) to date for comparison
    const monthDate = e.month + '-01';
    return monthDate >= from && monthDate <= to;
  });

  const incMap = {}, expMap = {};
  
  // Add income from daily transactions
  txns.filter(t=>t.type==='INCOME').forEach(t => {
    incMap[t.category] = (incMap[t.category]||0) + (t.serviceAmount||0) + (t.tipAmount||0);
  });
  
  // Add expenses from daily transactions
  txns.filter(t=>t.type==='EXPENSE').forEach(t => {
    expMap[t.category] = (expMap[t.category]||0) + (t.amount||0);
  });
  
  // Add monthly expenses
  monthlyExp.forEach(e => {
    expMap[e.category] = (expMap[e.category]||0) + (e.amount||0);
  });

  const sortDesc = obj => Object.entries(obj).sort((a,b)=>b[1]-a[1]);
  const hasInc   = Object.keys(incMap).length > 0;
  const hasExp   = Object.keys(expMap).length > 0;

  document.getElementById('report-output').innerHTML = `
    <div style="font-size:13px; color:var(--text-muted); padding: 4px 0 12px;">${from} — ${to}</div>

    ${hasInc ? `
    <div class="report-white-card">
      <div class="report-section-title">Income by Category</div>
      <div class="pie-chart-wrap">
        <canvas id="pie-income" width="260" height="260"></canvas>
      </div>
      ${sortDesc(incMap).map(([k,v])=>`
        <div class="report-row">
          <div class="report-row-label">${k}</div>
          <div class="report-row-value income">+${fmt(v)}</div>
        </div>
      `).join('')}
    </div>` : ''}

    ${hasExp ? `
    <div class="report-white-card">
      <div class="report-section-title">Expenses by Category</div>
      <div class="pie-chart-wrap">
        <canvas id="pie-expense" width="260" height="260"></canvas>
      </div>
      ${sortDesc(expMap).map(([k,v])=>`
        <div class="report-row">
          <div class="report-row-label">${k}</div>
          <div class="report-row-value expense">-${fmt(v)}</div>
        </div>
      `).join('')}
    </div>` : ''}

    ${!hasInc && !hasExp
      ? '<p style="color:var(--text-muted);text-align:center;padding:30px 0;">No data for this date range.</p>'
      : ''}
  `;

  // Draw after innerHTML is set so canvas elements exist in DOM
  if (hasInc) {
      const incEntries = sortDesc(incMap);
      drawPie('pie-income', incEntries.map(([k])=>k), incEntries.map(([,v])=>v));
  } else {
    }
  if (hasExp) {
      const expEntries = sortDesc(expMap);
      drawPie('pie-expense', expEntries.map(([k])=>k), expEntries.map(([,v])=>v));
  } else {
    }
}

// ----------------------------------------------------------------
// 14. PIE CHART HELPER
// ----------------------------------------------------------------

// Tracks live Chart.js instances so we can destroy before re-drawing
const _chartInstances = {};

// Salon-brand colour palette for pie slices
const PIE_COLORS = [
  '#E74C3C', // Red
  '#3498DB', // Blue
  '#F39C12', // Orange
  '#9B59B6', // Purple
  '#1ABC9C', // Turquoise
  '#E67E22', // Dark Orange
  '#34495E', // Dark Gray-Blue
  '#16A085', // Dark Turquoise
  '#D35400', // Burnt Orange
  '#8E44AD', // Dark Purple
  '#27AE60', // Green
  '#2980B9', // Dark Blue
];

/**
 * Renders a doughnut chart into a <canvas id="canvasId">.
 * Call after setting innerHTML so the canvas exists in the DOM.
 * @param {string} canvasId
 * @param {string[]} labels
 * @param {number[]} values
 * @param {string} centerLabel  — small text shown below the canvas (optional)
 */
function drawPie(canvasId, labels, values, centerLabel) {
  
  // Check if Chart.js is loaded
  if (typeof Chart === 'undefined') {
    console.error('Chart.js not loaded');
    return;
  }
  
  if (_chartInstances[canvasId]) {
      _chartInstances[canvasId].destroy();
    delete _chartInstances[canvasId];
  }
  const canvas = document.getElementById(canvasId);
  if (!canvas) {
    console.warn(`Canvas not found: ${canvasId}`);
    return;
  }
  const ctx = canvas.getContext('2d');

  try {
    _chartInstances[canvasId] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data:            values,
        backgroundColor: PIE_COLORS.slice(0, values.length),
        borderColor:     '#fff',
        borderWidth:     2,
        hoverOffset:     6,
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: true,
      cutout:              '58%',
      plugins: {
        legend: {
          position:  'bottom',
          labels: {
            color:      '#5C3A4A',
            font:       { size: 11, family: "'DM Sans', sans-serif" },
            padding:    10,
            boxWidth:   12,
            boxHeight:  12,
          },
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct   = total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) : 0;
              return ` ${ctx.label}: ${fmt(ctx.parsed)} (${pct}%)`;
            },
          },
        },
      },
    },
  });
  } catch (err) {
    console.error('Chart creation failed:', err);
  }
}

async function exportCSV() {
  const from = document.getElementById('r-exp-from')?.value;
  const to   = document.getElementById('r-exp-to')?.value;
  if (!from || !to) { alert('Please select a date range.'); return; }

  const allTxns = await db.transactions.toArray();
  const txns    = allTxns.filter(t => t.date >= from && t.date <= to);
  const mExps   = await db.monthlyExpenses.toArray();

  let csv = 'Date,Type,Category,Service Amount,Tip Amount,Tip Method,Payment Method,Notes\n';

  txns.forEach(t => {
    const row = [
      t.date,
      t.type,
      t.category || '',
      t.type === 'INCOME' ? (t.serviceAmount || 0) : (t.amount || 0),
      t.type === 'INCOME' ? (t.tipAmount || 0) : '',
      t.type === 'INCOME' ? (t.tipMethod  || '') : '',
      t.paymentMethod || '',
      (t.notes || '').replace(/,/g, ';'),
    ];
    csv += row.join(',') + '\n';
  });

  csv += '\n\nMonthly Expenses:\nYear,Month,Category,Amount,Notes\n';
  mExps.filter(e => {
    const d = `${e.year}-${String(e.month).padStart(2,'0')}-01`;
    return d >= from && d <= to;
  }).forEach(e => {
    csv += `${e.year},${monthName(e.month)},${e.category},${e.amount},"${e.notes||''}"\n`;
  });

  const renters   = await db.renters.toArray();
  const renterMap = {};
  renters.forEach(r => { renterMap[r.id] = r.name; });
  const rentPmts = await db.rentPayments.toArray();
  const filteredRent = rentPmts.filter(p => p.datePaid >= from && p.datePaid <= to);
  if (filteredRent.length > 0) {
    csv += '\n\nBooth Rent Payments:\nDate Paid,Renter,Week Of,Amount,Method,Notes\n';
    filteredRent.forEach(p => {
      csv += `${p.datePaid},"${renterMap[p.renterId] || 'Unknown'}",${p.weekStart},${p.amount},${p.paymentMethod || ''},"${p.notes || ''}"\n`;
    });
  }

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `salon-books-${from}-to-${to}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('CSV downloaded ✓');
}

// ----------------------------------------------------------------
// 15. SETTINGS VIEW
// ----------------------------------------------------------------

async function renderSettingsView() {
  const content = document.getElementById('app-content');
  document.getElementById('header-actions').innerHTML = '';

  const bizName = await db.settings.get('businessName');
  const pinSet  = await db.settings.get('pin');
  const pinOn   = await db.settings.get('pinEnabled');
  
  // Get renters tab status
  const rentersOverride = await db.settings.get('showRentersTab');
  const allRenters = await db.renters.toArray();
  let rentersStatus;
  if (!rentersOverride || rentersOverride.value === undefined) {
    rentersStatus = allRenters.length > 0 
      ? 'Auto (shown — you have renters)' 
      : 'Auto (hidden — no renters yet)';
  } else if (rentersOverride.value === 'true') {
    rentersStatus = 'Always shown';
  } else {
    rentersStatus = 'Always hidden';
  }

  content.innerHTML = `
    <!-- Business Name -->
    <div class="settings-section">
      <div class="settings-label">Business</div>
      <div class="card" style="margin-bottom: 8px;">
        <label class="form-label" style="margin-bottom:8px;">Business Name</label>
        <input type="text" class="business-name-input" id="biz-name"
          placeholder="e.g. Annette's Salon"
          value="${bizName ? bizName.value : ''}">
        <button class="btn-add-chip" style="width:100%;margin-top:10px;" onclick="saveBusinessName()">Save Name</button>
      </div>
    </div>

    <!-- Categories -->
    <div class="settings-section">
      <div class="settings-label">Income Categories</div>
      <div class="card" style="margin-bottom: 8px;">
        <div id="income-cats"></div>
        <div class="add-category-row">
          <input type="text" class="add-category-input" id="new-income-cat" placeholder="Add category…">
          <button class="btn-add-chip" onclick="addCategory('INCOME')">+ Add</button>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-label">Expense Categories</div>
      <div class="card" style="margin-bottom: 8px;">
        <div id="all-exp-cats"></div>
        <div class="add-category-row">
          <input type="text" class="add-category-input" id="new-exp-cat" placeholder="Add category…">
          <button class="btn-add-chip" onclick="addCategory('EXPENSE')">+ Add</button>
        </div>
      </div>
    </div>

    <!-- PIN Lock -->
    <div class="settings-section">
      <div class="settings-label">Security</div>
      <div class="settings-item" onclick="openPINSettings()">
        <div>
          <div class="settings-item-label">${pinSet ? 'Change PIN' : 'Set Up PIN Lock'}</div>
          <div class="settings-item-sub">${pinOn?.value === 'true' ? 'PIN lock is ON' : 'PIN lock is OFF'}</div>
        </div>
        <span class="settings-item-arrow">›</span>
      </div>
      ${pinSet ? `
      <div class="settings-item">
        <div>
          <div class="settings-item-label">PIN Lock</div>
          <div class="settings-item-sub">Require PIN on startup</div>
        </div>
        <label class="toggle" onclick="event.stopPropagation()">
          <input type="checkbox" ${pinOn?.value === 'true' ? 'checked' : ''} onchange="togglePINLock()">
          <span class="toggle-slider"></span>
        </label>
      </div>
      ` : ''}
    </div>

    <!-- Features -->
    <div class="settings-section">
      <div class="settings-label">Features</div>
      <div class="settings-item">
        <div>
          <div class="settings-item-label">Show Booth Renters Tab</div>
          <div class="settings-item-sub">${rentersStatus}</div>
        </div>
        <label class="toggle" onclick="event.stopPropagation()">
          <input type="checkbox" id="renters-tab-toggle" ${state.showRentersTab ? 'checked' : ''} onchange="toggleRentersTab()">
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <!-- Backup & Restore -->
    <div class="settings-section">
      <div class="settings-label">Local Backup</div>
      <div class="card" style="margin-bottom:8px;">
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px;line-height:1.5;">
          Export your data to a JSON file. Save it to Google Drive or email it to yourself as an extra safety net alongside automatic cloud sync.
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px;">
          Last local export: <strong style="color:var(--plum);" id="last-backup-display">Loading…</strong>
        </div>
        <button class="btn-primary" style="width:100%;margin-bottom:8px;" onclick="exportBackup()">
          ⬇ Export Backup File
        </button>
        <button class="btn-secondary" style="width:100%;" onclick="triggerRestoreFilePicker()">
          ⬆ Restore from Backup File
        </button>
        <div style="background:#fff3cd;border:1px solid #ffc107;padding:10px;border-radius:6px;margin-top:12px;font-size:11px;color:#856404;line-height:1.4;">
          <strong>⚠️ Important:</strong><br>
          • Restore replaces ALL current data<br>
          • Keep backup file until verified<br>
          • Don't close app during restore<br>
          • Large restores take 30-60 seconds
        </div>
      </div>
    </div>

    <div style="height: 24px;"></div>

    <!-- App Updates -->
    <div class="settings-section">
      <div class="settings-label">App Updates</div>
      <div class="card" style="margin-bottom:8px;">
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px;line-height:1.5;">
          If you don't see the latest changes, use one of these options:
        </div>
        <button class="btn-secondary" style="width:100%;margin-bottom:8px;" onclick="reloadApp()">
          🔄 Reload App
        </button>
        <button class="btn-secondary" style="width:100%;background:#C13838;color:white;" onclick="forceReload()">
          ⚡ Force Clear & Reload
        </button>
        <div style="font-size:11px;color:var(--text-muted);margin-top:8px;line-height:1.4;">
          "Force Clear" removes all cached data and does a clean reload. Use this if updates aren't appearing.
        </div>
      </div>
    </div>

    <div style="height: 24px;"></div>

    <!-- Account -->
    <div class="settings-section">
      <div class="settings-label">Account</div>
      <div class="card" style="margin-bottom:8px;">
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:4px;">Signed in as</div>
        <div style="font-size:14px;font-weight:600;color:var(--plum);margin-bottom:16px;">${currentUser?.email || ''}</div>
        <button class="btn-secondary" style="width:100%;" onclick="signOutUser()">
          Sign Out
        </button>
      </div>
    </div>

    <div style="height: 24px;"></div>
  `;

  if (!document.getElementById('restore-file-input')) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.id   = 'restore-file-input';
    inp.accept = '.json';
    inp.style.display = 'none';
    inp.addEventListener('change', e => importBackup(e.target.files[0]));
    document.body.appendChild(inp);
  }

  loadCategoryChips();

  const lastBackup = await db.settings.get('lastBackup');
  const el = document.getElementById('last-backup-display');
  if (el) {
    el.textContent = lastBackup?.value
      ? formatDateDisplay(lastBackup.value)
      : 'Never';
    if (!lastBackup?.value) el.style.color = 'var(--danger)';
  }
}

async function saveBusinessName() {
  const val = document.getElementById('biz-name').value.trim();
  if (!val) return;
  await db.settings.put({ key: 'businessName', value: val });
  showToast('Business name saved ✓');
}

function loadCategoryChips() {
  // Income categories - sorted alphabetically
  const incomeEl = document.getElementById('income-cats');
  if (incomeEl) {
    const sortedIncome = [...(state.categories.INCOME || [])].sort();
    incomeEl.innerHTML = sortedIncome.map(name =>
      `<span class="category-chip">${name}
        <button class="chip-delete" onclick="deleteCategory('INCOME','${name.replace(/'/g,"\\'")}')">×</button>
      </span>`
    ).join('');
  }
  
  // Unified expense categories - sorted alphabetically
  const expenseEl = document.getElementById('all-exp-cats');
  if (expenseEl) {
    const sortedExpenses = [...(state.categories.EXPENSE || [])].sort();
    
    expenseEl.innerHTML = sortedExpenses.map(name => {
      return `<span class="category-chip">${name}
        <button class="chip-delete" onclick="deleteCategory('EXPENSE','${name.replace(/'/g,"\\'")}')">×</button>
      </span>`;
    }).join('');
  }
}

async function addCategory(type) {
  const inputMap = { 
    INCOME: 'new-income-cat', 
    EXPENSE: 'new-exp-cat'
  };
  const inputId = inputMap[type];
  const input = document.getElementById(inputId);
  const name = input?.value.trim();
  
  if (!name) return;
  
  if (!state.categories[type]) {
    state.categories[type] = [];
  }
  
  if (state.categories[type].includes(name)) { 
    showToast('Already exists'); 
    return; 
  }
  
  state.categories[type].push(name);
  await saveCategories();
  
  // Clear input and refresh UI
  input.value = '';
  loadCategoryChips();
  showToast(`"${name}" added ✓`);
}

async function deleteCategory(type, name) {
  if (!confirm(`Remove "${name}"?`)) return;
  state.categories[type] = state.categories[type].filter(n => n !== name);
  await saveCategories();
  loadCategoryChips();
}

// ----------------------------------------------------------------
// 16. PIN SYSTEM
// ----------------------------------------------------------------

function openPINSettings() {
  openModal(`
    <h2 class="modal-title">Set PIN</h2>
    <p style="color:var(--text-muted); font-size:14px; margin-bottom:20px;">Choose a 4-digit PIN to secure the app.</p>
    <div class="form-group">
      <label class="form-label">New PIN (4 digits)</label>
      <input type="password" class="form-input" id="new-pin" maxlength="4" inputmode="numeric" placeholder="••••">
    </div>
    <div class="form-group">
      <label class="form-label">Confirm PIN</label>
      <input type="password" class="form-input" id="confirm-pin" maxlength="4" inputmode="numeric" placeholder="••••">
    </div>
    <button class="btn-submit" onclick="savePIN()">Set PIN</button>
  `);
}

async function savePIN() {
  const p1 = document.getElementById('new-pin').value;
  const p2 = document.getElementById('confirm-pin').value;
  if (p1.length !== 4 || !/^\d{4}$/.test(p1)) { alert('PIN must be exactly 4 digits.'); return; }
  if (p1 !== p2) { alert('PINs do not match. Try again.'); return; }
  await db.settings.put({ key: 'pin', value: p1 });
  await db.settings.put({ key: 'pinEnabled', value: 'true' });
  closeModal();
  showToast('PIN set ✓');
  renderSettingsView();
}

async function togglePINLock() {
  const current = await db.settings.get('pinEnabled');
  const newVal  = current?.value === 'true' ? 'false' : 'true';
  await db.settings.put({ key: 'pinEnabled', value: newVal });
  renderSettingsView();
}

async function toggleRentersTab() {
  const override = await db.settings.get('showRentersTab');
  const allRenters = await db.renters.toArray();
  const wasHidden = !state.showRentersTab;
  
  // Cycle through: Auto → Always Show → Always Hide → Auto
  let newValue;
  let message;
  let newStatus;
  
  if (!override || override.value === undefined) {
    // Currently Auto → switch to Always Show
    newValue = 'true';
    message = 'Renters tab set to Always Show';
    newStatus = 'Always shown';
    state.showRentersTab = true;
  } else if (override.value === 'true') {
    // Currently Always Show → switch to Always Hide
    newValue = 'false';
    message = 'Renters tab set to Always Hide';
    newStatus = 'Always hidden';
    state.showRentersTab = false;
  } else {
    // Currently Always Hide → back to Auto
    await db.settings.delete('showRentersTab');
    state.showRentersTab = allRenters.length > 0;
    newStatus = allRenters.length > 0 
      ? 'Auto (shown — you have renters)' 
      : 'Auto (hidden — no renters yet)';
    showToast('Renters tab set to Auto');
    
    // Update the status text directly if on settings page
    const statusEl = document.querySelector('.settings-item .settings-item-sub');
    if (statusEl && state.currentView === 'settings') {
      statusEl.textContent = newStatus;
      // Update checkbox
      const checkbox = document.getElementById('renters-tab-toggle');
      if (checkbox) checkbox.checked = state.showRentersTab;
    }
    
    navigate(state.currentView);
    return;
  }
  
  // Save to database and wait for it to complete
  await db.settings.put({ key: 'showRentersTab', value: newValue });
  
  showToast(message);
  
  // Update the status text directly if on settings page (avoids re-render cache issues)
  const statusEl = document.querySelector('.settings-item .settings-item-sub');
  if (statusEl && state.currentView === 'settings') {
    statusEl.textContent = newStatus;
    // Update checkbox
    const checkbox = document.getElementById('renters-tab-toggle');
    if (checkbox) checkbox.checked = state.showRentersTab;
  }
  
  // Update navigation
  if (wasHidden && state.showRentersTab) {
    navigate('renters');
  } else {
    navigate(state.currentView);
  }
}

let pinBuffer = '';
let pinPadInitialized = false; // Prevent duplicate event listeners

function initPINPad() {
  if (pinPadInitialized) return; // Already initialized
  
  document.querySelectorAll('.pin-btn[data-num]').forEach(btn => {
    btn.addEventListener('click', () => enterPin(btn.dataset.num));
  });
  document.getElementById('pin-back')?.addEventListener('click', clearPin);
  
  pinPadInitialized = true;
}

function enterPin(num) {
  if (pinBuffer.length >= 4) return;
  pinBuffer += num;
  updatePinDots();
  if (pinBuffer.length === 4) {
    setTimeout(checkPin, 150);
  }
}

function clearPin() {
  pinBuffer = pinBuffer.slice(0, -1);
  updatePinDots();
  document.getElementById('pin-error').classList.add('hidden');
}

function updatePinDots() {
  for (let i = 0; i < 4; i++) {
    document.getElementById(`dot-${i}`)?.classList.toggle('filled', i < pinBuffer.length);
  }
}

async function checkPin() {
  const stored = await db.settings.get('pin');
  
  if (stored && pinBuffer === stored.value) {
      try {
      document.getElementById('pin-screen').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      
          
      // Call navigate to update tab visibility and render the view
      navigate('entries');
      
          
      // Give renderDailyView a moment to complete
      // (navigate is sync but calls async renderDailyView)
      await new Promise(resolve => setTimeout(resolve, 100));
      
        } catch (err) {
      console.error('Error after PIN entry:', err);
      showToast('Error loading app — please refresh');
    }
  } else {
      document.getElementById('pin-error').classList.remove('hidden');
    pinBuffer = '';
    updatePinDots();
  }
}

// ----------------------------------------------------------------
// 17. RENTERS VIEW
// ----------------------------------------------------------------

// Week date helpers
function getWeekDue(weekStart) { return addDays(weekStart, 5); } // Saturday
function nextWeekStart(ws) { return addDays(ws, 7); }
function prevWeekStart(ws) { return addDays(ws, -7); }

function formatWeekRange(ws) {
  const end = addDays(ws, 6);
  const s   = new Date(ws  + 'T12:00:00');
  const e   = new Date(end + 'T12:00:00');
  const opts = { month: 'short', day: 'numeric' };
  return s.toLocaleDateString('en-US', opts) + ' – ' + e.toLocaleDateString('en-US', opts);
}

function getRentStatus(weekStart, datePaid) {
  if (!datePaid) return 'unpaid';
  const due  = new Date(getWeekDue(weekStart) + 'T23:59:59');
  const paid = new Date(datePaid + 'T12:00:00');
  return paid <= due ? 'ontime' : 'late';
}

async function renderRentersView() {
  const content = document.getElementById('app-content');
  document.getElementById('header-actions').innerHTML = `
    <button class="header-icon-btn" onclick="openAddRenterModal()" title="Add Renter">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>`;

  if (!state.rentersWeekStart) {
    state.rentersWeekStart = getWeekStart(todayStr());
  }

  const ws       = state.rentersWeekStart;
  const weekDue  = getWeekDue(ws);
  const renters  = await db.renters.where('status').equals('active').toArray();
  const payments = await db.rentPayments.where('weekStart').equals(ws).toArray();

  const payMap = {};
  payments.forEach(p => { payMap[p.renterId] = p; });

  const expectedTotal  = renters.reduce((s, r) => s + (r.weeklyRate || 0), 0);
  const collectedTotal = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const outstanding    = expectedTotal - collectedTotal;

  const isCurrentWeek = ws === getWeekStart(todayStr());

  content.innerHTML = `
    <div class="daily-date-bar">
      <button class="date-nav-btn" onclick="rentersChangeWeek(-1)">‹</button>
      <div class="current-date">Week of ${formatWeekRange(ws)}</div>
      <button class="date-nav-btn" onclick="rentersChangeWeek(1)" ${isCurrentWeek ? 'disabled style="opacity:0.3"' : ''}>›</button>
    </div>

    <div class="renters-summary">
      <div class="renters-sum-item">
        <div class="renters-sum-label">Expected</div>
        <div class="renters-sum-value">${fmt(expectedTotal)}</div>
      </div>
      <div class="renters-sum-divider"></div>
      <div class="renters-sum-item">
        <div class="renters-sum-label">Collected</div>
        <div class="renters-sum-value" style="color:var(--success)">${fmt(collectedTotal)}</div>
      </div>
      <div class="renters-sum-divider"></div>
      <div class="renters-sum-item">
        <div class="renters-sum-label">Outstanding</div>
        <div class="renters-sum-value" style="color:${outstanding > 0 ? 'var(--danger)' : 'var(--success)'}">
          ${outstanding > 0 ? fmt(outstanding) : '✓ Paid'}
        </div>
      </div>
    </div>

    <div class="renters-due-note">Rent due Saturday ${formatDateDisplay(weekDue)}</div>

    <div id="renter-list">
      ${renters.length === 0 ? `
        <div class="empty-state" style="padding:40px 20px;">
          <div style="font-size:36px;margin-bottom:12px;">👥</div>
          <div style="font-weight:600;color:var(--plum);margin-bottom:6px;">No booth renters yet</div>
          <div style="color:var(--text-muted);font-size:14px;">Tap + to add your first renter</div>
        </div>` :
        renters.map(r => {
          const p           = payMap[r.id];
          const status      = p ? getRentStatus(ws, p.datePaid) : 'unpaid';
          const statusLabel = { ontime: 'On Time', late: 'Late', unpaid: 'Unpaid' }[status];
          const statusClass = { ontime: 'status-ontime', late: 'status-late', unpaid: 'status-unpaid' }[status];
          const icon        = { ontime: '✅', late: '⚠️', unpaid: '○' }[status];
          return `
          <div class="renter-row" onclick="openRenterDetail('${r.id}')">
            <div class="renter-icon">${icon}</div>
            <div class="renter-info">
              <div class="renter-name">${r.name}${r.booth ? ` <span class="renter-booth">Booth ${r.booth}</span>` : ''}</div>
              <div class="renter-meta">
                ${p
                  ? `Paid ${formatDateDisplay(p.datePaid)} · ${p.paymentMethod} · <span class="${statusClass}">${statusLabel}</span>`
                  : `<span class="${statusClass}">Not yet paid</span> · Due ${fmt(r.weeklyRate || 0)}`}
              </div>
            </div>
            <div class="renter-amount">
              <div style="font-weight:700;color:${p ? 'var(--success)' : 'var(--text-muted)'}">${p ? fmt(p.amount) : fmt(r.weeklyRate || 0)}</div>
              ${!p ? `<button class="renter-pay-btn" onclick="event.stopPropagation();openLogPaymentModal('${r.id}')">Log Payment</button>` : ''}
            </div>
          </div>`;
        }).join('')
      }
    </div>
    <div style="height:20px;"></div>
  `;
}

function rentersChangeWeek(dir) {
  state.rentersWeekStart = dir === 1
    ? nextWeekStart(state.rentersWeekStart)
    : prevWeekStart(state.rentersWeekStart);
  renderRentersView();
}

function openLogPaymentModal(renterId) {
  db.renters.get(renterId).then(r => {
    if (!r) return;
    openModal(`
      <h2 class="modal-title">Log Rent Payment</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:14px;">${r.name} · Week of ${formatWeekRange(state.rentersWeekStart)}</p>

      <label class="form-label">Amount Paid ($)</label>
      <input type="number" inputmode="decimal" class="form-input" id="rp-amount"
        value="${r.weeklyRate || 140}" step="0.01" min="0">

      <label class="form-label">Date Paid</label>
      <input type="date" class="form-input" id="rp-date" value="${todayStr()}">

      <label class="form-label">Payment Method</label>
      <select class="form-select" id="rp-method">
        <option>Cash</option>
        <option>Venmo</option>
        <option>Zelle</option>
        <option>Card</option>
        <option>Check</option>
        <option>Other</option>
      </select>

      <label class="form-label">Notes (optional)</label>
      <input type="text" class="form-input" id="rp-notes" placeholder="Any notes…">

      <button class="btn-primary" style="width:100%;margin-top:8px;" onclick="saveRentPayment('${renterId}')">Save Payment</button>
    `);
  });
}

async function saveRentPayment(renterId) {
  const amount  = parseFloat(document.getElementById('rp-amount').value);
  const datePaid = document.getElementById('rp-date').value;
  const method  = document.getElementById('rp-method').value;
  const notes   = document.getElementById('rp-notes').value.trim();

  if (!amount || !datePaid) { showToast('Please fill in amount and date'); return; }

  const ws = state.rentersWeekStart;

  // Check if payment already exists for this renter + week
  const existing = await db.rentPayments
    .where('renterId').equals(renterId)
    .filter(p => p.weekStart === ws)
    .first();

  if (existing) {
    await db.rentPayments.update(existing.id, { amount, datePaid, paymentMethod: method, notes });
  } else {
    await db.rentPayments.add({
      renterId,
      weekStart:     ws,
      amount,
      datePaid,
      paymentMethod: method,
      notes,
    });
  }

  closeModal();
  showToast('Payment saved ✓');
  renderRentersView();
}

function openRenterDetail(renterId) {
  db.renters.get(renterId).then(async r => {
    if (!r) return;
    const payments = await db.rentPayments
      .where('renterId').equals(renterId)
      .reverse()
      .limit(20)
      .toArray();

    const historyHTML = payments.length === 0
      ? '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:16px 0;">No payment history yet.</p>'
      : payments.map(p => {
          const status      = getRentStatus(p.weekStart, p.datePaid);
          const statusClass = { ontime: 'status-ontime', late: 'status-late' }[status];
          const icon        = status === 'ontime' ? '✅' : '⚠️';
          return `
          <div class="renter-history-row">
            <span>${icon}</span>
            <div style="flex:1">
              <div style="font-size:12px;font-weight:500;">${formatWeekRange(p.weekStart)}</div>
              <div style="font-size:11px;color:var(--text-muted);">Paid ${formatDateDisplay(p.datePaid)} · ${p.paymentMethod}</div>
            </div>
            <div style="text-align:right">
              <div style="font-weight:700;color:var(--success);font-size:13px;">${fmt(p.amount)}</div>
              <div class="${statusClass}" style="font-size:10px;">${status === 'ontime' ? 'On Time' : 'Late'}</div>
            </div>
          </div>`;
        }).join('');

    openModal(`
      <h2 class="modal-title">${r.name}</h2>
      <div style="display:flex;gap:12px;margin-bottom:14px;font-size:13px;color:var(--text-muted);">
        ${r.booth ? `<span>Booth ${r.booth}</span>` : ''}
        <span>${fmt(r.weeklyRate || 0)}/week</span>
        <span>Since ${r.startDate ? formatDateDisplay(r.startDate) : '—'}</span>
      </div>

      <div style="display:flex;gap:8px;margin-bottom:16px;">
        <button class="btn-secondary" style="flex:1;" onclick="openLogPaymentModal('${r.id}');closeModal()">+ Log Payment</button>
        <button class="btn-secondary" style="flex:1;" onclick="openEditRenterModal('${r.id}')">Edit Profile</button>
        <button class="btn-danger-sm" onclick="deactivateRenter('${r.id}')">Deactivate</button>
      </div>

      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:8px;">Payment History</div>
      ${historyHTML}
    `);
  });
}

function openAddRenterModal() {
  openModal(`
    <h2 class="modal-title">Add Booth Renter</h2>

    <label class="form-label">Name *</label>
    <input type="text" class="form-input" id="nr-name" placeholder="First name or full name">

    <label class="form-label">Booth #</label>
    <input type="text" class="form-input" id="nr-booth" placeholder="e.g. 1, 2, 3…">

    <label class="form-label">Weekly Rate ($)</label>
    <input type="number" inputmode="decimal" class="form-input" id="nr-rate" value="140" step="0.01" min="0">

    <label class="form-label">Start Date</label>
    <input type="date" class="form-input" id="nr-start" value="${todayStr()}">

    <label class="form-label">Notes (optional)</label>
    <input type="text" class="form-input" id="nr-notes" placeholder="Any notes about this renter…">

    <button class="btn-primary" style="width:100%;margin-top:8px;" onclick="saveNewRenter()">Add Renter</button>
  `);
}

async function saveNewRenter() {
  const name  = document.getElementById('nr-name').value.trim();
  const booth = document.getElementById('nr-booth').value.trim();
  const rate  = parseFloat(document.getElementById('nr-rate').value);
  const start = document.getElementById('nr-start').value;
  const notes = document.getElementById('nr-notes').value.trim();

  if (!name) { showToast('Name is required'); return; }

  await db.renters.add({
    name,
    booth:      booth || null,
    weeklyRate: rate || 140,
    startDate:  start,
    notes,
    status:     'active',
  });

  // Update tab visibility in case this is the first renter
  await updateRentersTabVisibility();
  
  closeModal();
  showToast(`${name} added ✓`);
  navigate('renters'); // Refresh nav bar + render view
}

function openEditRenterModal(renterId) {
  db.renters.get(renterId).then(r => {
    if (!r) return;
    openModal(`
      <h2 class="modal-title">Edit Renter</h2>

      <label class="form-label">Name</label>
      <input type="text" class="form-input" id="er-name" value="${r.name}">

      <label class="form-label">Booth #</label>
      <input type="text" class="form-input" id="er-booth" value="${r.booth || ''}">

      <label class="form-label">Weekly Rate ($)</label>
      <input type="number" inputmode="decimal" class="form-input" id="er-rate" value="${r.weeklyRate || 140}">

      <label class="form-label">Notes</label>
      <input type="text" class="form-input" id="er-notes" value="${r.notes || ''}">

      <button class="btn-primary" style="width:100%;margin-top:8px;" onclick="saveEditRenter('${r.id}')">Save Changes</button>
    `);
  });
}

async function saveEditRenter(renterId) {
  const name  = document.getElementById('er-name').value.trim();
  const booth = document.getElementById('er-booth').value.trim();
  const rate  = parseFloat(document.getElementById('er-rate').value);
  const notes = document.getElementById('er-notes').value.trim();

  if (!name) { showToast('Name is required'); return; }

  await db.renters.update(renterId, { name, booth: booth || null, weeklyRate: rate, notes });
  closeModal();
  showToast('Renter updated ✓');
  renderRentersView();
}

async function deactivateRenter(renterId) {
  const r = await db.renters.get(renterId);
  if (!r) return;
  if (!confirm(`Deactivate ${r.name}? They will be hidden from the weekly view but their payment history is preserved.`)) return;
  await db.renters.update(renterId, { status: 'inactive' });
  closeModal();
  showToast(`${r.name} deactivated`);
  renderRentersView();
}

// ----------------------------------------------------------------
// 18. BACKUP & RESTORE
// ----------------------------------------------------------------

async function exportBackup() {
  try {
    const backup = {
      exportDate:      todayStr(),
      appVersion:      '5.0',
      businessName:    (await db.settings.get('businessName'))?.value || '',
      categories:      state.categories,
      transactions:    await db.transactions.toArray(),
      dailySummary:    await db.dailySummary.toArray(),
      monthlyExpenses: await db.monthlyExpenses.toArray(),
      renters:         await db.renters.toArray(),
      rentPayments:    await db.rentPayments.toArray(),
      settings:        await db.settings.toArray(),
    };

    const json = JSON.stringify(backup, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `mane-frame-backup-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    await db.settings.put({ key: 'lastBackup', value: todayStr() });
    showToast('Backup exported ✓');
    renderSettingsView();
  } catch (err) {
    showToast('Export failed — try again');
    console.error(err);
  }
}

async function importBackup(file) {
  if (!file) return;

  const confirmed = confirm(
    '⚠️ Restore from backup?\n\nThis will REPLACE all current data with the backup file. This cannot be undone.\n\nAre you sure?'
  );
  if (!confirmed) return;

  // Show progress modal
  openModal(`
    <h2 class="modal-title">Restoring Backup...</h2>
    <div style="text-align:center; padding:32px;">
      <div style="font-size:48px; margin-bottom:16px;">🔄</div>
      <div style="font-size:16px; margin-bottom:8px;" id="restore-progress-text">
        Reading backup file...
      </div>
      <div style="width:100%; background:var(--border); border-radius:4px; height:8px; overflow:hidden; margin-top:16px;">
        <div id="restore-progress-bar" style="width:0%; height:100%; background:var(--primary); transition:width 0.3s;"></div>
      </div>
      <div style="font-size:13px; color:var(--text-muted); margin-top:12px;">
        Please don't close the app during restore
      </div>
    </div>
  `);

  // Helper to update progress
  const updateProgress = (percent, message) => {
    const bar = document.getElementById('restore-progress-bar');
    const text = document.getElementById('restore-progress-text');
    if (bar) bar.style.width = percent + '%';
    if (text) text.textContent = message;
  };

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    // Validate backup file
    if (!data.transactions) { 
      closeModal();
      showToast('Invalid backup file'); 
      return; 
    }

    updateProgress(10, 'Validating backup...');

    // Parse categories
    let catMap;
    if (Array.isArray(data.categories)) {
      catMap = { INCOME: [], DAILY_EXPENSE: [], MONTHLY_EXPENSE: [] };
      data.categories.forEach(c => {
        if (c.type && catMap[c.type]) catMap[c.type].push(c.name);
      });
    } else if (data.categories && typeof data.categories === 'object') {
      catMap = data.categories;
    } else {
      catMap = _defaultCategoryMap();
    }

    updateProgress(20, 'Preparing data...');

    // Strip IDs (Firestore uses string IDs)
    const strip = arr => arr.map(({ id, ...rest }) => rest);
    
    const transactionsToRestore = strip(data.transactions);
    const dailySummaryToRestore = data.dailySummary ? strip(data.dailySummary) : [];
    const monthlyExpensesToRestore = data.monthlyExpenses ? strip(data.monthlyExpenses) : [];
    const rentersToRestore = data.renters ? strip(data.renters) : [];
    const rentPaymentsToRestore = data.rentPayments ? strip(data.rentPayments) : [];
    const settingsToRestore = data.settings || [];

    // Calculate total for progress
    const totalItems = transactionsToRestore.length + 
                      dailySummaryToRestore.length + 
                      monthlyExpensesToRestore.length + 
                      rentersToRestore.length + 
                      rentPaymentsToRestore.length;

    updateProgress(30, 'Creating backup of current data...');

    // SAFETY: Backup current data before deleting
    let currentDataBackup = null;
    try {
      currentDataBackup = {
        transactions: await db.transactions.toArray(),
        dailySummary: await db.dailySummary.toArray(),
        monthlyExpenses: await db.monthlyExpenses.toArray(),
        renters: await db.renters.toArray(),
        rentPayments: await db.rentPayments.toArray(),
        settings: await db.settings.toArray(),
        categories: { ...state.categories }
      };
    } catch (err) {
      closeModal();
      showToast('Failed to backup current data');
      console.error(err);
      return;
    }

    updateProgress(40, 'Deleting old data...');

    // Clear all existing data
    try {
      await db.transactions.clear();
      await db.dailySummary.clear();
      await db.monthlyExpenses.clear();
      await db.settings.clear();
      await db.renters.clear();
      await db.rentPayments.clear();
    } catch (err) {
      closeModal();
      showToast('Failed to clear old data');
      console.error(err);
      return;
    }

    updateProgress(50, 'Restoring transactions...');

    let restored = 0;

    try {
      // Restore transactions in chunks with progress
      if (transactionsToRestore.length > 0) {
        const CHUNK = 499;
        for (let i = 0; i < transactionsToRestore.length; i += CHUNK) {
          const chunk = transactionsToRestore.slice(i, i + CHUNK);
          await db.transactions.bulkAdd(chunk);
          restored += chunk.length;
          const progress = 50 + ((restored / totalItems) * 30);
          updateProgress(progress, `Restoring transactions... ${restored}/${transactionsToRestore.length}`);
        }
      }

      updateProgress(80, 'Restoring other data...');

      // Restore other data
      if (dailySummaryToRestore.length > 0) {
        await db.dailySummary.bulkAdd(dailySummaryToRestore);
        restored += dailySummaryToRestore.length;
      }
      
      if (monthlyExpensesToRestore.length > 0) {
        await db.monthlyExpenses.bulkAdd(monthlyExpensesToRestore);
        restored += monthlyExpensesToRestore.length;
      }
      
      if (rentersToRestore.length > 0) {
        await db.renters.bulkAdd(rentersToRestore);
        restored += rentersToRestore.length;
      }
      
      if (rentPaymentsToRestore.length > 0) {
        await db.rentPayments.bulkAdd(rentPaymentsToRestore);
        restored += rentPaymentsToRestore.length;
      }

      if (settingsToRestore.length > 0) {
        await db.settings.bulkAdd(settingsToRestore);
      }

      updateProgress(90, 'Finalizing...');

      // Update categories
      state.categories = catMap;
      await saveCategories();
      await db.settings.put({ key: 'lastBackup', value: todayStr() });

      // Update tab visibility
      await updateRentersTabVisibility();

      updateProgress(100, 'Complete!');

      // Show success
      setTimeout(() => {
        closeModal();
        showToast('Restore complete ✓');
        navigate('entries');
      }, 500);

    } catch (err) {
      // ROLLBACK: Restore from backup if restore failed
      console.error('Restore failed, rolling back...', err);
      updateProgress(50, 'Restore failed! Rolling back...');

      try {
        // Clear partial data
        await db.transactions.clear();
        await db.dailySummary.clear();
        await db.monthlyExpenses.clear();
        await db.settings.clear();
        await db.renters.clear();
        await db.rentPayments.clear();

        // Restore from backup
        if (currentDataBackup) {
          if (currentDataBackup.transactions.length > 0) {
            await db.transactions.bulkAdd(currentDataBackup.transactions.map(({ id, ...rest }) => rest));
          }
          if (currentDataBackup.dailySummary.length > 0) {
            await db.dailySummary.bulkAdd(currentDataBackup.dailySummary.map(({ id, ...rest }) => rest));
          }
          if (currentDataBackup.monthlyExpenses.length > 0) {
            await db.monthlyExpenses.bulkAdd(currentDataBackup.monthlyExpenses.map(({ id, ...rest }) => rest));
          }
          if (currentDataBackup.renters.length > 0) {
            await db.renters.bulkAdd(currentDataBackup.renters.map(({ id, ...rest }) => rest));
          }
          if (currentDataBackup.rentPayments.length > 0) {
            await db.rentPayments.bulkAdd(currentDataBackup.rentPayments.map(({ id, ...rest }) => rest));
          }
          if (currentDataBackup.settings.length > 0) {
            await db.settings.bulkAdd(currentDataBackup.settings);
          }

          state.categories = currentDataBackup.categories;
          await saveCategories();
        }

        closeModal();
        showToast('Restore failed - your original data has been preserved ✓');
        navigate('entries');

      } catch (rollbackErr) {
        console.error('Rollback also failed!', rollbackErr);
        closeModal();
        showToast('⚠️ Critical error: Please export backup ASAP!');
      }
    }

  } catch (err) {
    closeModal();
    if (err instanceof SyntaxError) {
      showToast('Restore failed — file is not valid JSON');
    } else {
      showToast('Restore failed — file may be corrupt');
    }
    console.error(err);
  }
}

function triggerRestoreFilePicker() {
  const input = document.getElementById('restore-file-input');
  if (input) input.click();
}

// ----------------------------------------------------------------
// 19. MODAL SYSTEM
// ----------------------------------------------------------------

function openModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal').classList.remove('hidden');
  setTimeout(() => {
    const first = document.querySelector('#modal input, #modal select');
    if (first) first.focus();
  }, 300);
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('modal').classList.add('hidden');
  document.getElementById('modal-content').innerHTML = '';
}

// Custom confirmation dialog (replaces browser's confirm)
function confirmDialog(message, title = 'Mane Frame') {
  return new Promise((resolve) => {
    openModal(`
      <h2 class="modal-title">${title}</h2>
      <div style="font-size:15px;line-height:1.6;color:var(--text);margin:20px 0;white-space:pre-line;">${message}</div>
      <div style="display:flex;gap:8px;margin-top:24px;">
        <button class="btn-secondary" style="flex:1;" onclick="window._confirmResolve(false)">Cancel</button>
        <button class="btn-submit" style="flex:1;background:var(--danger);" onclick="window._confirmResolve(true)">Delete</button>
      </div>
    `);
    
    window._confirmResolve = (result) => {
      closeModal();
      delete window._confirmResolve;
      resolve(result);
    };
  });
}

// Add swipe-down gesture to close modal
let modalTouchStart = null;
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('modal');
  const modalHandle = document.querySelector('.modal-handle');
  
  if (modalHandle) {
    modalHandle.addEventListener('touchstart', (e) => {
      modalTouchStart = e.touches[0].clientY;
    }, { passive: true });
    
    modalHandle.addEventListener('touchend', (e) => {
      if (modalTouchStart === null) return;
      const touchEnd = e.changedTouches[0].clientY;
      const diff = touchEnd - modalTouchStart;
      
      // If swiped down at least 50px, close modal
      if (diff > 50) {
        closeModal();
      }
      
      modalTouchStart = null;
    }, { passive: true });
  }
});

// ----------------------------------------------------------------
// 20. APP INITIALIZATION
// ----------------------------------------------------------------

// Called after Firebase confirms the user is signed in.
async function bootApp() {
  await loadCategories();
  await updateRentersTabVisibility();

  const pinSetting  = await db.settings.get('pin');
  const pinEnabled  = await db.settings.get('pinEnabled');
  const shouldPin   = pinSetting && pinEnabled?.value === 'true';

  // Hide login screen, show correct gate
  document.getElementById('login-screen').classList.add('hidden');

  if (shouldPin) {
    document.getElementById('pin-screen').classList.remove('hidden');
    initPINPad();
  } else {
    document.getElementById('app').classList.remove('hidden');
    navigate('entries');
  }
}

// Firebase auth state listener — this is the single entry point for the app.
auth.onAuthStateChanged(user => {
  if (user) {
    currentUser = user;
    bootApp();
  } else {
    currentUser = null;
    // Hide everything, show login screen
    document.getElementById('app').classList.add('hidden');
    document.getElementById('pin-screen').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
  }
});

// ----------------------------------------------------------------
// 21. SERVICE WORKER (auto-update)
// ----------------------------------------------------------------

let _swRegistration = null;
let _updateAvailable = false;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Register normally (no cache busting - causes false positives)
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(reg => {
        _swRegistration = reg;

        // Check for updates immediately on load
        reg.update().catch(() => {});

        // Listen for updates
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              // When new service worker is installed and waiting
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                _updateAvailable = true;
                
                // Auto-reload to prevent white screen
                // But give user option to do it manually
                showUpdateNotification();
              }
            });
          }
        });

        // Check for waiting service worker (update already downloaded)
        if (reg.waiting && navigator.serviceWorker.controller) {
          _updateAvailable = true;
          showUpdateNotification();
        }
      })
      .catch(err => console.log('SW registration skipped:', err));

    // When new service worker takes control, reload immediately
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // Clear the dismiss flag so banner doesn't persist
      sessionStorage.removeItem('updateBannerDismissed');
      window.location.reload();
    });
  });

  // Check for updates when app becomes visible (but not too aggressively)
  let lastVisibilityCheck = Date.now();
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && _swRegistration) {
      // Only check if it's been more than 5 seconds since last check
      const now = Date.now();
      if (now - lastVisibilityCheck < 5000) return;
      lastVisibilityCheck = now;
      
      // Check for updates
      await _swRegistration.update().catch(() => {});
      
      // If there's a waiting service worker after the update check,
      // it means an update happened while we were in the background
      // We need to reload immediately to prevent white screen
      setTimeout(() => {
        if (_swRegistration.waiting && navigator.serviceWorker.controller) {
          // Show toast and auto-reload to prevent white screen
          showToast('New version detected - updating app...');
          
          // Give the toast a moment to show, then reload
          setTimeout(() => {
            _swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
            // The controllerchange will trigger reload
            // But add fallback just in case
            setTimeout(() => {
              window.location.reload(true);
            }, 1000);
          }, 1500);
        }
      }, 500);
    }
  });

  // Removed frequent 30-second checks - too aggressive
}

function showUpdateNotification() {
  // Don't show if already dismissed in this session
  if (sessionStorage.getItem('updateBannerDismissed') === 'true') {
    return;
  }
  
  // Only show if there's actually a waiting service worker
  if (!_swRegistration || !_swRegistration.waiting) {
    return;
  }
  
  // Show a non-intrusive update banner at the top
  const existing = document.getElementById('update-banner');
  if (existing) return; // Already showing

  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    background: #2D7A4C;
    color: white;
    padding: 12px 16px;
    text-align: center;
    z-index: 10000;
    font-size: 14px;
    font-weight: 500;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  `;
  banner.innerHTML = `
    <span>✨ Update available!</span>
    <div style="display:flex;gap:8px;align-items:center;">
      <button onclick="applyUpdate()" style="
        background: white;
        color: #2D7A4C;
        border: none;
        padding: 6px 16px;
        border-radius: 6px;
        font-weight: 600;
        cursor: pointer;
        font-size: 13px;
      ">Update Now</button>
      <button onclick="dismissUpdateBanner()" style="
        background: transparent;
        color: white;
        border: 1px solid white;
        padding: 6px 12px;
        border-radius: 6px;
        font-weight: 600;
        cursor: pointer;
        font-size: 13px;
      ">Later</button>
    </div>
  `;
  document.body.prepend(banner);
}

window.dismissUpdateBanner = function() {
  const banner = document.getElementById('update-banner');
  if (banner) {
    banner.remove();
  }
  _updateAvailable = false;
  // Mark as dismissed for this session
  sessionStorage.setItem('updateBannerDismissed', 'true');
};

window.applyUpdate = async function() {
  // Remove banner immediately
  const banner = document.getElementById('update-banner');
  if (banner) {
    banner.remove();
  }
  
  _updateAvailable = false;
  
  showToast('Updating app...');
  
  if (_swRegistration && _swRegistration.waiting) {
    // Tell the waiting service worker to skip waiting and become active
    // This triggers controllerchange which will reload the page
    _swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
  } else {
    // No waiting worker, do aggressive reload
    try {
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const registration of registrations) {
          await registration.unregister();
        }
      }
      await new Promise(resolve => setTimeout(resolve, 300));
      window.location.reload(true);
    } catch (e) {
      window.location.reload(true);
    }
  }
};

async function reloadApp() {
  showToast('Reloading app...');
  
  try {
    // Unregister current service worker
    if (_swRegistration) {
      await _swRegistration.unregister();
    }
    
    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Force a hard reload (bypasses all caches)
    window.location.reload(true);
  } catch (e) {
    // Fallback: just do a hard reload
    window.location.reload(true);
  }
}

async function forceReload() {
  showToast('Force reloading app...');
  
  // Unregister all service workers
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      await registration.unregister();
    }
  }
  
  // Clear all caches
  if ('caches' in window) {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map(name => caches.delete(name)));
  }
  
  // Hard reload
  setTimeout(() => {
    window.location.reload(true);
  }, 500);
}
