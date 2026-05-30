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
  _appBooted = false;
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
  employees:         ['Chasity McGill'],  // Employee list for payroll tracking
};

// ----------------------------------------------------------------
// MOBILE CATEGORY PICKER
// ----------------------------------------------------------------

function openCategoryPicker(options) {
  const { 
    title = 'Select Category',
    items = [], 
    selectedValue = '', 
    onSelect = () => {},
    searchable = true
  } = options;
  
  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'picker-overlay';
  overlay.id = 'category-picker-overlay';
  
  let filteredItems = [...items];
  
  function renderOptions() {
    const container = overlay.querySelector('.picker-options');
    if (!container) return;
    
    if (filteredItems.length === 0) {
      container.innerHTML = '<div class="picker-empty">No categories found</div>';
      return;
    }
    
    container.innerHTML = filteredItems.map(item => `
      <div class="picker-option ${item === selectedValue ? 'selected' : ''}" data-value="${item}">
        ${item}
      </div>
    `).join('');
    
    // Add click handlers
    container.querySelectorAll('.picker-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const value = opt.dataset.value;
        onSelect(value);
        closePicker();
      });
    });
  }
  
  function closePicker() {
    const el = document.getElementById('category-picker-overlay');
    if (el) {
      el.style.animation = 'pickerFadeIn 0.15s ease reverse';
      setTimeout(() => el.remove(), 150);
    }
  }
  
  function filterItems(query) {
    const q = query.toLowerCase().trim();
    if (!q) {
      filteredItems = [...items];
    } else {
      filteredItems = items.filter(item => item.toLowerCase().includes(q));
    }
    renderOptions();
  }
  
  overlay.innerHTML = `
    <div class="picker-sheet">
      <div class="picker-header">
        <span class="picker-title">${title}</span>
        <button class="picker-close" type="button">&times;</button>
      </div>
      ${searchable && items.length > 5 ? `
        <div class="picker-search">
          <input type="text" placeholder="Search categories..." autocomplete="off" autocorrect="off" autocapitalize="off">
        </div>
      ` : ''}
      <div class="picker-options"></div>
    </div>
  `;
  
  document.body.appendChild(overlay);
  
  // Close when clicking overlay background
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePicker();
  });
  
  // Close button
  overlay.querySelector('.picker-close').addEventListener('click', closePicker);
  
  // Search input
  const searchInput = overlay.querySelector('.picker-search input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => filterItems(e.target.value));
  }
  
  // Render initial options
  renderOptions();
  
  // Scroll selected into view
  setTimeout(() => {
    const selected = overlay.querySelector('.picker-option.selected');
    if (selected) selected.scrollIntoView({ block: 'center' });
  }, 50);
}

// Helper to create a category picker trigger button
function createCategoryPickerTrigger(id, placeholder = 'Select category...') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'category-picker-trigger placeholder';
  btn.id = id;
  btn.textContent = placeholder;
  btn.dataset.value = '';
  return btn;
}

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

// Security: Escape HTML to prevent XSS attacks from user-generated content
function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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
// CLIENT NAME AUTOCOMPLETE
// ----------------------------------------------------------------

let _clientNameCache = null;
let _clientNameCacheTime = 0;

async function getClientNames() {
  // Cache for 30 seconds to avoid repeated DB queries during typing
  if (_clientNameCache && Date.now() - _clientNameCacheTime < 30000) return _clientNameCache;
  
  const allTxns = await db.transactions.toArray();
  const names = {};
  allTxns.forEach(t => {
    if (t.clientName?.trim()) {
      const key = t.clientName.trim().toLowerCase();
      if (!names[key]) names[key] = { name: t.clientName.trim(), count: 0 };
      names[key].count++;
    }
  });
  // Sort by frequency (most used first)
  _clientNameCache = Object.values(names).sort((a, b) => b.count - a.count).map(n => n.name);
  _clientNameCacheTime = Date.now();
  return _clientNameCache;
}

function setupClientAutocomplete(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  
  // Remove any existing autocomplete dropdown
  const existingList = document.getElementById('client-ac-dropdown');
  if (existingList) existingList.remove();
  
  // Create dropdown as a direct child of body so it's never clipped
  const dropdown = document.createElement('div');
  dropdown.id = 'client-ac-dropdown';
  dropdown.style.cssText = `
    display:none; position:fixed; 
    background:#fff; border:1px solid #ccc;
    border-radius:0 0 12px 12px; max-height:180px; overflow-y:auto;
    z-index:9999; box-shadow:0 4px 12px rgba(0,0,0,0.15);
  `;
  document.body.appendChild(dropdown);
  
  let selectedIdx = -1;
  
  function positionDropdown() {
    const rect = input.getBoundingClientRect();
    dropdown.style.left = rect.left + 'px';
    dropdown.style.top = rect.bottom + 'px';
    dropdown.style.width = rect.width + 'px';
  }
  
  input.addEventListener('input', async () => {
    const val = input.value.trim().toLowerCase();
    if (val.length < 1) { dropdown.style.display = 'none'; return; }
    
    const names = await getClientNames();
    const matches = names.filter(n => n.toLowerCase().includes(val)).slice(0, 6);
    
    if (matches.length === 0 || (matches.length === 1 && matches[0].toLowerCase() === val)) {
      dropdown.style.display = 'none';
      return;
    }
    
    selectedIdx = -1;
    dropdown.innerHTML = matches.map((name, i) => {
      const idx = name.toLowerCase().indexOf(val);
      const before = name.substring(0, idx);
      const match = name.substring(idx, idx + val.length);
      const after = name.substring(idx + val.length);
      return `<div class="client-ac-item" data-idx="${i}"
        style="padding:10px 14px;font-size:14px;cursor:pointer;border-bottom:1px solid #eee;background:#fff;"
        onmousedown="document.getElementById('${inputId}').value='${name.replace(/'/g, "\\'")}';document.getElementById('client-ac-dropdown').style.display='none';_clientNameCache=null;"
        ontouchstart="document.getElementById('${inputId}').value='${name.replace(/'/g, "\\'")}';document.getElementById('client-ac-dropdown').style.display='none';_clientNameCache=null;"
        onmouseenter="this.style.background='rgba(93,56,84,0.06)'"
        onmouseleave="this.style.background='#fff'">
        ${before}<strong style="color:#5D3854">${match}</strong>${after}
      </div>`;
    }).join('');
    
    positionDropdown();
    dropdown.style.display = 'block';
  });
  
  input.addEventListener('keydown', (e) => {
    const items = dropdown.querySelectorAll('.client-ac-item');
    if (items.length === 0 || dropdown.style.display === 'none') return;
    
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
      items.forEach((el, i) => el.style.background = i === selectedIdx ? 'rgba(93,56,84,0.06)' : '#fff');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
      items.forEach((el, i) => el.style.background = i === selectedIdx ? 'rgba(93,56,84,0.06)' : '#fff');
    } else if (e.key === 'Enter' && selectedIdx >= 0) {
      e.preventDefault();
      const name = items[selectedIdx]?.textContent.trim();
      if (name) { input.value = name; dropdown.style.display = 'none'; }
    } else if (e.key === 'Escape') {
      dropdown.style.display = 'none';
    }
  });
  
  input.addEventListener('blur', () => {
    setTimeout(() => { dropdown.style.display = 'none'; }, 200);
  });
  
  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 1) input.dispatchEvent(new Event('input'));
  });
}

function selectClientName(inputId, name) {
  const input = document.getElementById(inputId);
  if (input) {
    input.value = name;
    const dropdown = document.getElementById('client-ac-dropdown');
    if (dropdown) dropdown.style.display = 'none';
  }
  _clientNameCache = null;
}

// ----------------------------------------------------------------
// 7. CATEGORY MANAGEMENT
// ----------------------------------------------------------------

function _defaultCategoryMap() {
  return {
    INCOME: [
      'Haircut', 'Color', 'Highlights', 'Blowout', 'Treatment',
      'Nails', 'Waxing', 'Retail Product', 'Other',
      'Vagaro Income', "Women's haircut", 'Roots, hilites haircut',
      'Full highlights haircut', 'Roots & haircut', 'Roots and hilites with haircut',
      'Partial highlights haircut', "Men's haircut", 'Highlites and Haircut',
    ],
    EXPENSE: [
      'Supplies', 'Products', 'Tools/Equipment', 'Advertising',
      'Education', 'Meals', 'Employee Pay', 'Rent', 'Electric',
      'Water', 'Gas', 'Insurance', 'Cleaning Service',
      'Booking Software', 'Phone', 'Marketing', 'Other',
      'Numa', 'Aflac', 'Vagaro', 'YouTube TV', 'Garbage Collection',
      'AT&T Internet', 'State Farm',
    ],
  };
}

// Real-time category sync listener
// Categories are synced on app load/refresh, not in real-time
// This avoids race conditions with Firebase listeners

async function loadCategories() {
  console.log('🔍 loadCategories() started');
  try {
    // Load local categories first as our baseline
    let localCategories = null;
    const saved = await db.settings.get('categories');
    if (saved?.value) {
      const parsed = JSON.parse(saved.value);
      if (parsed.EXPENSE) {
        localCategories = {
          INCOME: parsed.INCOME || [],
          EXPENSE: parsed.EXPENSE || [],
        };
      } else {
        const dailyExpenses = parsed.DAILY_EXPENSE || [];
        const monthlyExpenses = parsed.MONTHLY_EXPENSE || [];
        localCategories = {
          INCOME: parsed.INCOME || [],
          EXPENSE: [...new Set([...dailyExpenses, ...monthlyExpenses])],
        };
      }
    }

    // If logged in, try loading from Firebase
    if (auth && auth.currentUser) {
      try {
        const doc = await firestore.collection('users')
          .doc(auth.currentUser.uid)
          .collection('settings')
          .doc('categories')
          .get();
        
        if (doc.exists) {
          const fb = doc.data();
          let fbCategories;
          
          if (fb.EXPENSE) {
            fbCategories = {
              INCOME: fb.INCOME || [],
              EXPENSE: fb.EXPENSE || [],
            };
          } else if (fb.DAILY_EXPENSE || fb.MONTHLY_EXPENSE) {
            const dailyExpenses = fb.DAILY_EXPENSE || [];
            const monthlyExpenses = fb.MONTHLY_EXPENSE || [];
            fbCategories = {
              INCOME: fb.INCOME || [],
              EXPENSE: [...new Set([...dailyExpenses, ...monthlyExpenses])],
            };
          }

          if (fbCategories) {
            // MERGE: take the union of local + Firebase + defaults so we never lose categories
            const defaults = _defaultCategoryMap();
            if (localCategories) {
              state.categories = {
                INCOME: [...new Set([...defaults.INCOME, ...fbCategories.INCOME, ...localCategories.INCOME])],
                EXPENSE: [...new Set([...defaults.EXPENSE, ...fbCategories.EXPENSE, ...localCategories.EXPENSE])],
              };
            } else {
              state.categories = {
                INCOME: [...new Set([...defaults.INCOME, ...fbCategories.INCOME])],
                EXPENSE: [...new Set([...defaults.EXPENSE, ...fbCategories.EXPENSE])],
              };
            }

            // Use defaults if still empty
            if (!state.categories.INCOME.length) state.categories.INCOME = _defaultCategoryMap().INCOME;
            if (!state.categories.EXPENSE.length) state.categories.EXPENSE = _defaultCategoryMap().EXPENSE;

            console.log('✓ Merged categories - INCOME:', state.categories.INCOME.length, 'EXPENSE:', state.categories.EXPENSE.length);
            
            // Save merged result to both local and Firebase
            await db.settings.put({ key: 'categories', value: JSON.stringify(state.categories) });
            await firestore.collection('users')
              .doc(auth.currentUser.uid)
              .collection('settings')
              .doc('categories')
              .set(state.categories);
            return;
          }
        }
      } catch (err) {
        console.error('Firebase category load error:', err);
      }
    }
    
    // Use local categories if we have them
    if (localCategories && localCategories.INCOME.length && localCategories.EXPENSE.length) {
      state.categories = localCategories;
      return;
    }

    // Last resort: defaults
    state.categories = _defaultCategoryMap();
  } catch (e) {
    console.warn('loadCategories error:', e);
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

async function loadEmployees() {
  try {
    // Try Firebase first
    if (auth && auth.currentUser) {
      const doc = await firestore.collection('users')
        .doc(auth.currentUser.uid)
        .collection('settings')
        .doc('employees')
        .get();
      
      if (doc.exists && doc.data().list?.length) {
        state.employees = doc.data().list;
        return;
      }
    }
    
    // Try local storage
    const saved = await db.settings.get('employees');
    if (saved?.value) {
      const parsed = JSON.parse(saved.value);
      if (Array.isArray(parsed) && parsed.length) {
        state.employees = parsed;
        return;
      }
    }
    
    // Default
    state.employees = ['Chasity McGill'];
  } catch (e) {
    console.warn('loadEmployees error:', e);
    state.employees = ['Chasity McGill'];
  }
}

async function saveEmployees() {
  // Save locally
  await db.settings.put({ key: 'employees', value: JSON.stringify(state.employees) });
  
  // Sync to Firebase
  if (auth && auth.currentUser) {
    try {
      await firestore.collection('users')
        .doc(auth.currentUser.uid)
        .collection('settings')
        .doc('employees')
        .set({ list: state.employees });
    } catch (err) {
      console.error('Failed to sync employees to Firebase:', err);
    }
  }
}

function categoryOptions(type) {
  // For expense types, check unified EXPENSE key first, then fall back to old split keys
  if (type === 'EXPENSE' || type === 'DAILY_EXPENSE' || type === 'MONTHLY_EXPENSE') {
    const allExpenseCategories = [
      ...(state.categories.EXPENSE || []),
      ...(state.categories.DAILY_EXPENSE || []),
      ...(state.categories.MONTHLY_EXPENSE || [])
    ];
    // Deduplicate
    const unique = [...new Set(allExpenseCategories)];
    return unique
      .sort()
      .map(name => `<option value="${name}">${name}</option>`)
      .join('');
  }
  
  // For income, use income categories
  return (state.categories[type] || [])
    .sort()
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
  
  // Update all nav buttons - remove all active states first, then add to current
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
  
  ['entries', 'insights', 'renters', 'reports', 'settings'].forEach(v => {
    const btn = document.getElementById('nav-' + v);
    if (btn && v === view) {
      btn.classList.add('active');
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
    insights: 'Dashboard',
    renters:  'Booth Renters',
    reports:  'Reports',
    settings: 'Settings',
  };
  const viewTitle = document.getElementById('view-title');
  if (viewTitle) {
    viewTitle.textContent = titles[view] || '';
  }
  
  const views = {
    entries:  () => safeRender(renderEntriesView, 'Entries'),
    insights: () => safeRender(renderInsightsView, 'Dashboard'),
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
// SMART INSIGHTS ENGINE
// ----------------------------------------------------------------

// Track shown insights to avoid repetition (stored in localStorage)
function getShownInsights() {
  try {
    const data = JSON.parse(localStorage.getItem('mf_shown_insights') || '{}');
    const now = Date.now();
    const cleaned = {};
    Object.entries(data).forEach(([key, timestamp]) => {
      if (now - timestamp < 3 * 24 * 60 * 60 * 1000) cleaned[key] = timestamp;
    });
    return cleaned;
  } catch { return {}; }
}

function markInsightShown(key) {
  const data = getShownInsights();
  data[key] = Date.now();
  localStorage.setItem('mf_shown_insights', JSON.stringify(data));
}

function wasRecentlyShown(key) {
  const data = getShownInsights();
  if (!data[key]) return false;
  return Date.now() - data[key] < 24 * 60 * 60 * 1000;
}

function generateSmartInsights(allTxns, allMExp, allRenters, allRentPmts) {
  const insights = [];
  const now = new Date();
  const today = todayStr();
  const dayOfWeek = now.getDay();
  const dayOfMonth = now.getDate();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastMonth = `${now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()}-${String(now.getMonth() === 0 ? 12 : now.getMonth()).padStart(2, '0')}`;
  const thisYear = String(now.getFullYear());
  
  const incomeFor = (txns) => txns.filter(t => t.type === 'INCOME').reduce((s,t) => s + (t.serviceAmount||0) + (t.tipAmount||0), 0);
  
  // This month vs last month pace
  const thisMonthTxns = allTxns.filter(t => t.date?.startsWith(thisMonth));
  const thisMonthIncome = incomeFor(thisMonthTxns);
  const lastMonthSameDay = `${lastMonth}-${String(dayOfMonth).padStart(2, '0')}`;
  const lastMonthToDate = allTxns.filter(t => t.date?.startsWith(lastMonth) && t.date <= lastMonthSameDay);
  const lastMonthPace = incomeFor(lastMonthToDate);
  
  if (lastMonthPace > 0 && dayOfMonth >= 5) {
    const paceChange = Math.round(((thisMonthIncome - lastMonthPace) / lastMonthPace) * 100);
    if (Math.abs(paceChange) >= 10) {
      insights.push({
        key: `pace_${thisMonth}`,
        priority: Math.abs(paceChange) >= 20 ? 95 : 70,
        icon: paceChange > 0 ? '📈' : '📉',
        type: paceChange > 0 ? 'success' : 'warning',
        text: paceChange > 0 
          ? `You're ${paceChange}% ahead of last month's pace!`
          : `Income is ${Math.abs(paceChange)}% behind last month's pace.`
      });
    }
  }
  
  // Yesterday was exceptional
  const yesterday = addDays(today, -1);
  const yesterdayIncome = incomeFor(allTxns.filter(t => t.date === yesterday));
  const thisMonthDays = {};
  thisMonthTxns.forEach(t => {
    if (!thisMonthDays[t.date]) thisMonthDays[t.date] = 0;
    if (t.type === 'INCOME') thisMonthDays[t.date] += (t.serviceAmount||0) + (t.tipAmount||0);
  });
  const dailyIncomes = Object.values(thisMonthDays);
  const avgDaily = dailyIncomes.length > 0 ? dailyIncomes.reduce((a,b) => a+b, 0) / dailyIncomes.length : 0;
  
  if (yesterdayIncome > avgDaily * 1.5 && yesterdayIncome > 200) {
    insights.push({
      key: `best_day_${yesterday}`,
      priority: 85,
      icon: '🌟',
      type: 'success',
      text: `Yesterday (${fmt(yesterdayIncome)}) was ${Math.round((yesterdayIncome/avgDaily - 1) * 100)}% above average!`
    });
  }
  
  // Clients overdue
  const clientLastVisit = {};
  allTxns.filter(t => t.type === 'INCOME' && t.clientName).forEach(t => {
    const name = t.clientName.trim();
    if (!clientLastVisit[name] || t.date > clientLastVisit[name]) {
      clientLastVisit[name] = t.date;
    }
  });
  const overdueClients = Object.entries(clientLastVisit).filter(([name, lastVisit]) => {
    const days = Math.floor((new Date(today) - new Date(lastVisit)) / 86400000);
    return days >= 45 && days <= 90;
  });
  
  if (overdueClients.length > 0) {
    insights.push({
      key: `overdue_clients_${thisMonth}`,
      priority: overdueClients.length >= 5 ? 80 : 60,
      icon: '👋',
      type: 'info',
      text: `${overdueClients.length} regular client${overdueClients.length > 1 ? 's haven\'t' : ' hasn\'t'} visited in 45+ days.`
    });
  }
  
  // Booth rent outstanding
  if (allRenters.length > 0) {
    const currentWS = getWeekStart(today);
    const lastWS = addDays(currentWS, -7);
    let outstanding = 0;
    let overdueCount = 0;
    
    allRenters.forEach(r => {
      ensureRateHistory(r);
      const rate = getRateForWeek(r, lastWS);
      const pmt = allRentPmts.find(p => p.renterId === r.id && p.weekStart === lastWS);
      if (!pmt || pmt.amount < rate) {
        outstanding += rate - (pmt?.amount || 0);
        overdueCount++;
      }
    });
    
    if (overdueCount > 0) {
      insights.push({
        key: `rent_overdue_${lastWS}`,
        priority: 90,
        icon: '🏠',
        type: 'warning',
        text: `${overdueCount} booth renter${overdueCount > 1 ? 's are' : ' is'} behind on rent (${fmt(outstanding)}).`
      });
    }
  }
  
  // Week comparison mid-week
  if (dayOfWeek >= 3 && dayOfWeek <= 5) {
    const thisWeekStart = getWeekStart(today);
    const lastWeekStart = addDays(thisWeekStart, -7);
    const thisWeekIncome = incomeFor(allTxns.filter(t => t.date >= thisWeekStart && t.date <= today));
    const lastWeekSamePoint = incomeFor(allTxns.filter(t => t.date >= lastWeekStart && t.date < addDays(lastWeekStart, dayOfWeek)));
    
    if (lastWeekSamePoint > 0) {
      const weekChange = Math.round(((thisWeekIncome - lastWeekSamePoint) / lastWeekSamePoint) * 100);
      if (Math.abs(weekChange) >= 15) {
        insights.push({
          key: `week_pace_${thisWeekStart}`,
          priority: 65,
          icon: weekChange > 0 ? '💪' : '⚡',
          type: weekChange > 0 ? 'success' : 'info',
          text: weekChange > 0 
            ? `This week is ${weekChange}% ahead of last week!`
            : `This week is ${Math.abs(weekChange)}% behind last week.`
        });
      }
    }
  }
  
  // YTD milestone
  const ytdIncome = incomeFor(allTxns.filter(t => t.date?.startsWith(thisYear)));
  const milestones = [10000, 25000, 50000, 75000, 100000, 150000, 200000];
  const lastMilestone = milestones.filter(m => ytdIncome >= m).pop();
  const nextMilestone = milestones.find(m => ytdIncome < m);
  
  if (lastMilestone && ytdIncome < lastMilestone * 1.05) {
    insights.push({
      key: `milestone_${lastMilestone}_${thisYear}`,
      priority: 88,
      icon: '🎉',
      type: 'success',
      text: `You passed ${fmt(lastMilestone)} this year! Next: ${fmt(nextMilestone)}`
    });
  }
  
  // Top client shoutout
  const clientTotals = {};
  allTxns.filter(t => t.type === 'INCOME' && t.clientName && t.date >= addDays(today, -90)).forEach(t => {
    const name = t.clientName.trim();
    clientTotals[name] = (clientTotals[name] || 0) + (t.serviceAmount||0) + (t.tipAmount||0);
  });
  const topClient = Object.entries(clientTotals).sort((a,b) => b[1] - a[1])[0];
  if (topClient && topClient[1] > 500) {
    insights.push({
      key: `top_client_${thisMonth}`,
      priority: 40,
      icon: '⭐',
      type: 'info',
      text: `${topClient[0]} is your top client this quarter (${fmt(topClient[1])}).`
    });
  }
  
  // Filter and select
  const filtered = insights.filter(i => !wasRecentlyShown(i.key));
  filtered.sort((a, b) => b.priority - a.priority);
  
  let selected;
  if (filtered.length === 0 && insights.length > 0) {
    const shuffled = [...insights].sort(() => Math.random() - 0.5);
    selected = shuffled.slice(0, 2);
  } else {
    selected = filtered.slice(0, Math.min(3, Math.max(2, filtered.length)));
  }
  
  selected.forEach(i => markInsightShown(i.key));
  return selected;
}

// ----------------------------------------------------------------
// DASHBOARD VIEW (replaces Insights)
// ----------------------------------------------------------------

async function renderInsightsView() {
  const content = document.getElementById('app-content');
  const hdr = document.getElementById('header-actions');
  hdr.innerHTML = '';

  // Initialize dashboard month to current if not set
  if (!state.dashboardMonth || !state.dashboardYear) {
    const now = new Date();
    state.dashboardMonth = now.getMonth() + 1;
    state.dashboardYear = now.getFullYear();
  }

  content.innerHTML = `
    <div style="padding:0 0 80px;">
      <div id="dashboard-loading" style="text-align:center; padding:60px; color:var(--text-muted);">
        Loading dashboard...
      </div>
      <div id="dashboard-content"></div>
    </div>
  `;

  await buildDashboard();
}

function dashboardNav(dir) {
  let m = state.dashboardMonth + dir;
  let y = state.dashboardYear;
  if (m < 1) { m = 12; y--; }
  if (m > 12) { m = 1; y++; }
  // Don't go past current month
  const now = new Date();
  if (y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth() + 1)) return;
  state.dashboardMonth = m;
  state.dashboardYear = y;
  buildDashboard();
}

async function buildDashboard() {
  const container = document.getElementById('dashboard-content');
  const loader = document.getElementById('dashboard-loading');

  try {
    // ---- Gather all data ----
    const allTxns    = await db.transactions.toArray();
    const allSums    = await db.dailySummary.toArray();
    const allRenters = await db.renters.where('status').equals('active').toArray();
    const allRentPmts = await db.rentPayments.toArray();

    // Employee income categories (excluded from personal service metrics)
    const employeeCategories = ['Vagaro Income', 'Chasity (Vagaro Income)'];
    const isPersonalService = (t) => t.type === 'INCOME' && !employeeCategories.includes(t.category);
    const isEmployeeIncome = (t) => t.type === 'INCOME' && employeeCategories.includes(t.category);

    const today     = todayStr();
    const now       = new Date();
    const viewMonth = state.dashboardMonth;
    const viewYear  = state.dashboardYear;
    const isCurrentMonth = (viewMonth === now.getMonth() + 1 && viewYear === now.getFullYear());
    const curMonthStr = `${viewYear}-${String(viewMonth).padStart(2,'0')}`;
    const daysInViewMonth = new Date(viewYear, viewMonth, 0).getDate();
    // The effective "today" for this view — last day of month if viewing past, actual today if current
    const viewToday = isCurrentMonth ? today : `${viewYear}-${String(viewMonth).padStart(2,'0')}-${String(daysInViewMonth).padStart(2,'0')}`;

    // ---- This week vs last week ----
    // For current month: use current week. For past months: use last full week of that month.
    const thisWS   = isCurrentMonth ? getWeekStart(today) : getWeekStart(viewToday);
    const lastWS   = addDays(thisWS, -7);
    const dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

    // Day-by-day income for this week and last week
    const thisWeekDays = [];
    const lastWeekDays = [];
    for (let i = 0; i < 7; i++) {
      const thisDayStr = addDays(thisWS, i);
      const lastDayStr = addDays(lastWS, i);
      const thisInc = allTxns.filter(t => t.date === thisDayStr && t.type === 'INCOME')
        .reduce((s,t) => s + (t.serviceAmount||0) + (t.tipAmount||0), 0);
      const lastInc = allTxns.filter(t => t.date === lastDayStr && t.type === 'INCOME')
        .reduce((s,t) => s + (t.serviceAmount||0) + (t.tipAmount||0), 0);
      thisWeekDays.push(thisInc);
      lastWeekDays.push(lastInc);
    }

    const thisWeekTotal = thisWeekDays.reduce((s,v) => s+v, 0);
    const lastWeekTotal = lastWeekDays.reduce((s,v) => s+v, 0);

    // For current month, compare same point in week. For past months, compare full weeks.
    let dayOfWeek;
    if (isCurrentMonth) {
      dayOfWeek = (now.getDay() + 6) % 7; // Convert Sun=0 to Mon=0
    } else {
      dayOfWeek = 6; // Show full week for past months
    }
    const lastWeekSamePoint = lastWeekDays.slice(0, dayOfWeek + 1).reduce((s,v) => s+v, 0);
    const weekPaceChange = lastWeekSamePoint > 0
      ? Math.round(((thisWeekTotal - lastWeekSamePoint) / lastWeekSamePoint) * 100)
      : (thisWeekTotal > 0 ? 100 : 0);

    // Max for bar chart scaling
    const allDayVals = [...thisWeekDays, ...lastWeekDays];
    const maxDayVal = Math.max(...allDayVals, 1);

    // ---- Month to date ----
    const mtdIncome = allTxns.filter(t => t.date?.startsWith(curMonthStr) && t.type === 'INCOME')
      .reduce((s,t) => s + (t.serviceAmount||0) + (t.tipAmount||0), 0);
    const mtdDailyExp   = allTxns.filter(t => t.date?.startsWith(curMonthStr) && t.type === 'EXPENSE' && !t.recurring)
      .reduce((s,t) => s + (t.amount||0), 0);
    const mtdMonthlyExp = allTxns.filter(t => t.date?.startsWith(curMonthStr) && t.type === 'EXPENSE' && t.recurring)
      .reduce((s,t) => s + (t.amount||0), 0);
    const mtdExpenses = mtdDailyExp + mtdMonthlyExp;
    const mtdNet = mtdIncome - mtdExpenses;
    const mtdMargin = mtdIncome > 0 ? Math.round((mtdNet / mtdIncome) * 100) : 0;

    // Last month for comparison
    const prevMonth = viewMonth === 1 ? 12 : viewMonth - 1;
    const prevYear  = viewMonth === 1 ? viewYear - 1 : viewYear;
    const prevMonthStr = `${prevYear}-${String(prevMonth).padStart(2,'0')}`;
    const prevMonthIncome = allTxns.filter(t => t.date?.startsWith(prevMonthStr) && t.type === 'INCOME')
      .reduce((s,t) => s + (t.serviceAmount||0) + (t.tipAmount||0), 0);
    const monthChange = prevMonthIncome > 0
      ? Math.round(((mtdIncome - prevMonthIncome) / prevMonthIncome) * 100) : 0;

    // ---- YTD ----
    const yearStr = String(viewYear);
    const ytdIncome = allTxns.filter(t => t.date?.startsWith(yearStr) && t.type === 'INCOME')
      .reduce((s,t) => s + (t.serviceAmount||0) + (t.tipAmount||0), 0);
    const ytdDailyExp   = allTxns.filter(t => t.date?.startsWith(yearStr) && t.type === 'EXPENSE' && !t.recurring)
      .reduce((s,t) => s + (t.amount||0), 0);
    const ytdMonthlyExp = allTxns.filter(t => t.date?.startsWith(yearStr) && t.type === 'EXPENSE' && t.recurring)
      .reduce((s,t) => s + (t.amount||0), 0);
    const ytdExpenses = ytdDailyExp + ytdMonthlyExp;
    const ytdRentCollected = allRentPmts.filter(p => p.datePaid?.startsWith(yearStr))
      .reduce((s,p) => s + (p.amount||0), 0);

    // ---- Avg per client (personal services only) ----
    const mtdSums = allSums.filter(s => s.date?.startsWith(curMonthStr));
    const mtdClients = mtdSums.reduce((s,d) => s + (d.clientsSeen||0), 0);
    const mtdPersonalIncome = allTxns.filter(t => t.date?.startsWith(curMonthStr) && isPersonalService(t))
      .reduce((s,t) => s + (t.serviceAmount||0) + (t.tipAmount||0), 0);
    const avgPerClient = mtdClients > 0 ? mtdPersonalIncome / mtdClients : 0;

    const prevMoSums = allSums.filter(s => s.date?.startsWith(prevMonthStr));
    const prevMoClients = prevMoSums.reduce((s,d) => s + (d.clientsSeen||0), 0);
    const prevMoPersonalIncome = allTxns.filter(t => t.date?.startsWith(prevMonthStr) && isPersonalService(t))
      .reduce((s,t) => s + (t.serviceAmount||0) + (t.tipAmount||0), 0);
    const prevAvgPerClient = prevMoClients > 0 ? prevMoPersonalIncome / prevMoClients : 0;

    // ---- Tip rate (personal services only) ----
    const mtdServices = allTxns.filter(t => t.date?.startsWith(curMonthStr) && isPersonalService(t))
      .reduce((s,t) => s + (t.serviceAmount||0), 0);
    const mtdTips = allTxns.filter(t => t.date?.startsWith(curMonthStr) && isPersonalService(t))
      .reduce((s,t) => s + (t.tipAmount||0), 0);
    const tipRate = mtdServices > 0 ? ((mtdTips / mtdServices) * 100).toFixed(1) : '0.0';

    // ---- Top service (personal services only) ----
    const serviceRevMap = {};
    allTxns.filter(t => t.date?.startsWith(curMonthStr) && isPersonalService(t)).forEach(t => {
      if (!serviceRevMap[t.category]) serviceRevMap[t.category] = 0;
      serviceRevMap[t.category] += (t.serviceAmount||0) + (t.tipAmount||0);
    });
    const topService = Object.entries(serviceRevMap).sort((a,b) => b[1] - a[1])[0];

    // ---- Forecasting ----
    const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();
    const dayOfMonth = isCurrentMonth ? now.getDate() : daysInViewMonth;
    // Count actual working days (days with income entries) this month
    const workingDays = new Set(allTxns.filter(t => t.date?.startsWith(curMonthStr) && t.type === 'INCOME').map(t => t.date)).size;
    const dailyAvg = workingDays > 0 ? mtdIncome / workingDays : 0;
    // Estimate remaining working days (use ratio of working days so far)
    const workdayRatio = dayOfMonth > 0 ? workingDays / dayOfMonth : 0;
    const estRemainingWorkdays = Math.round((daysInMonth - dayOfMonth) * workdayRatio);
    const projectedMonth = mtdIncome + (dailyAvg * estRemainingWorkdays);

    // Monthly avg for annual projection (use months with data)
    const monthsWithData = new Set(allTxns.filter(t => t.date?.startsWith(yearStr) && t.type === 'INCOME').map(t => t.date?.substring(0,7))).size;
    const avgMonthlyIncome = monthsWithData > 0 ? ytdIncome / monthsWithData : mtdIncome;
    const projectedAnnualIncome = avgMonthlyIncome * 12;
    const projectedAnnualRent = allRenters.reduce((s,r) => s + getCurrentRate(r), 0) * 52;
    const projectedTotalRevenue = projectedAnnualIncome + projectedAnnualRent;
    const ytdTotalRevenue = ytdIncome + ytdRentCollected;

    // ---- Month trend (last 6 months) ----
    const trendMonths = [];
    for (let i = 5; i >= 0; i--) {
      let tM = viewMonth - i;
      let tY = viewYear;
      while (tM <= 0) { tM += 12; tY--; }
      const ms = `${tY}-${String(tM).padStart(2,'0')}`;
      const inc = allTxns.filter(t => t.date?.startsWith(ms) && t.type === 'INCOME')
        .reduce((s,t) => s + (t.serviceAmount||0) + (t.tipAmount||0), 0);
      trendMonths.push({ month: tM, year: tY, income: inc, isCurrent: i === 0 });
    }
    const maxTrend = Math.max(...trendMonths.map(m => m.income), 1);

    // ---- Booth rent last completed week ----
    // Rent is due Saturday for the PRIOR week's work, so always show previous week
    const ws = getWeekStart(viewToday);
    const rentDisplayWS = addDays(ws, -7); // Always show last week
    const weekRentPmts = allRentPmts.filter(p => p.weekStart === rentDisplayWS);
    const rentCollected = weekRentPmts.reduce((s,p) => s + (p.amount||0), 0);
    const rentExpected  = allRenters.reduce((s,r) => s + getRateForWeek(r, rentDisplayWS), 0);
    const rentersPaid   = new Set(weekRentPmts.map(p => p.renterId)).size;
    const rentOutstanding = Math.max(0, rentExpected - rentCollected);
    const rentWeekLabel = 'Last Week';

    // ---- Alerts ----
    const alerts = [];

    // Late rent payments — check ALL completed weeks, accounting for partial payments
    const prevWS = addDays(ws, -7); // Last completed week
    const yearStartWS = getWeekStart(`${viewYear}-01-01`); // Don't go before this year
    
    allRenters.forEach(r => {
      ensureRateHistory(r);
      const renterPmts = allRentPmts.filter(p => p.renterId === r.id);
      
      // Build a map of weekStart → amount paid for this renter
      const paidByWeek = {};
      renterPmts.forEach(p => {
        paidByWeek[p.weekStart] = (paidByWeek[p.weekStart] || 0) + (p.amount || 0);
      });
      
      // Start limit: renter start date or Jan 1 of current year, whichever is later
      const renterStart = r.startDate ? getWeekStart(r.startDate) : yearStartWS;
      const startLimit = renterStart > yearStartWS ? renterStart : yearStartWS;
      
      let checkWS = prevWS;
      let unpaidWeeks = 0;
      let partialWeeks = 0;
      let totalOwed = 0;
      
      while (checkWS >= startLimit) {
        const rate = getRateForWeek(r, checkWS);
        const paid = paidByWeek[checkWS] || 0;
        const shortfall = rate - paid;
        
        if (shortfall > 0.01) {
          totalOwed += shortfall;
          if (paid < 0.01) {
            unpaidWeeks++;
          } else {
            partialWeeks++;
          }
        }
        checkWS = addDays(checkWS, -7);
      }
      
      // Check late pattern from actual payments
      const sortedPmts = renterPmts.sort((a,b) => b.weekStart.localeCompare(a.weekStart)).slice(0, 6);
      const lateCount = sortedPmts.filter(p => getRentStatus(p.weekStart, p.datePaid) === 'late').length;

      if (totalOwed > 0.01) {
        const weekDetail = [];
        if (unpaidWeeks > 0) weekDetail.push(`${unpaidWeeks} unpaid`);
        if (partialWeeks > 0) weekDetail.push(`${partialWeeks} partial`);
        
        alerts.push({
          type: 'danger',
          icon: '🔴',
          title: `${escapeHTML(r.name)} owes ${fmt(totalOwed)}`,
          sub: `${weekDetail.join(', ')} week${(unpaidWeeks + partialWeeks) > 1 ? 's' : ''}${lateCount >= 3 ? ` · Pattern: late ${lateCount} of last 6 payments` : ''}`,
          priority: 1
        });
      }
    });

    // YTD rent collection summary - only for current month
    if (isCurrentMonth && allRenters.length > 0) {
      let ytdExpected = 0;
      let ytdCollected = 0;
      const yearStart = `${viewYear}-01-01`;
      
      allRenters.forEach(r => {
        ensureRateHistory(r);
        const startLimit = r.startDate && r.startDate > yearStart ? getWeekStart(r.startDate) : getWeekStart(yearStart);
        let wk = startLimit;
        while (wk <= prevWS) {
          ytdExpected += getRateForWeek(r, wk);
          wk = addDays(wk, 7);
        }
      });
      
      ytdCollected = allRentPmts
        .filter(p => p.datePaid >= yearStart && p.datePaid <= todayStr())
        .reduce((s,p) => s + (p.amount || 0), 0);
      
      const ytdOutstanding = Math.max(0, ytdExpected - ytdCollected);
      const collectionPct = ytdExpected > 0 ? Math.round((ytdCollected / ytdExpected) * 100) : 100;
      
      if (ytdOutstanding > 0) {
        alerts.push({
          type: 'warn',
          icon: '⚠️',
          title: `${fmt(ytdOutstanding)} booth rent outstanding YTD`,
          sub: `Collected ${fmt(ytdCollected)} of ${fmt(ytdExpected)} expected (${collectionPct}%)`,
          priority: 2
        });
      } else {
        alerts.push({
          type: 'good',
          icon: '✅',
          title: 'Booth rent fully collected YTD',
          sub: `${fmt(ytdCollected)} collected · ${collectionPct}% collection rate`,
          priority: 5
        });
      }
    }

    // Tips trend (personal services only)
    const prevMoTips = allTxns.filter(t => t.date?.startsWith(prevMonthStr) && isPersonalService(t))
      .reduce((s,t) => s + (t.tipAmount||0), 0);
    if (prevMoTips > 0 && mtdTips > 0) {
      const tipChange = Math.round(((mtdTips - prevMoTips) / prevMoTips) * 100);
      if (Math.abs(tipChange) >= 10) {
        alerts.push({
          type: tipChange > 0 ? 'good' : 'warn',
          icon: tipChange > 0 ? '📈' : '📉',
          title: `Tips ${tipChange > 0 ? 'up' : 'down'} ${Math.abs(tipChange)}% this month`,
          sub: `${fmt(mtdTips)} vs ${fmt(prevMoTips)} last month · Avg tip rate: ${tipRate}%`,
          priority: 3
        });
      }
    }

    // Avg per client trend
    if (prevAvgPerClient > 0 && avgPerClient > 0) {
      const apcChange = Math.round(((avgPerClient - prevAvgPerClient) / prevAvgPerClient) * 100);
      if (Math.abs(apcChange) >= 5) {
        alerts.push({
          type: apcChange > 0 ? 'good' : 'info',
          icon: '💡',
          title: `Avg ${fmt(avgPerClient)} per client this month`,
          sub: `${apcChange > 0 ? 'Up' : 'Down'} from ${fmt(prevAvgPerClient)} in ${monthName(prevMonth)}${apcChange > 0 ? ' · Higher-value services trending upward' : ''}`,
          priority: 4
        });
      }
    }

    // Expense alert
    const prevMoDailyExp   = allTxns.filter(t => t.date?.startsWith(prevMonthStr) && t.type === 'EXPENSE' && !t.recurring)
      .reduce((s,t) => s + (t.amount||0), 0);
    const prevMoMonthlyExp = allTxns.filter(t => t.date?.startsWith(prevMonthStr) && t.type === 'EXPENSE' && t.recurring)
      .reduce((s,t) => s + (t.amount||0), 0);
    const prevMoTotalExp = prevMoDailyExp + prevMoMonthlyExp;
    if (prevMoTotalExp > 0 && mtdExpenses > prevMoTotalExp * 1.2) {
      alerts.push({
        type: 'warn',
        icon: '⚠️',
        title: 'Expenses higher than last month',
        sub: `${fmt(mtdExpenses)} vs ${fmt(prevMoTotalExp)} in ${monthName(prevMonth)}`,
        priority: 3
      });
    }

    // Sort alerts by priority
    alerts.sort((a,b) => a.priority - b.priority);

    // ---- Short month names for trend ----
    const mShort = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    // ---- Build HTML ----
    let html = '';

    // == MONTH NAVIGATION ==
    const isAtCurrentMonth = isCurrentMonth;
    const monthLabel = `${monthName(viewMonth)} ${viewYear}`;
    html += `
    <div style="display:flex;align-items:center;justify-content:center;gap:16px;padding:12px 16px 4px;">
      <button onclick="dashboardNav(-1)" style="background:none;border:none;font-size:24px;color:var(--plum);cursor:pointer;padding:8px 12px;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;">‹</button>
      <div style="font-size:17px;font-weight:700;color:var(--text);min-width:160px;text-align:center;">${monthLabel}${isCurrentMonth ? '' : ''}</div>
      <button onclick="dashboardNav(1)" style="background:none;border:none;font-size:24px;color:${isAtCurrentMonth ? 'var(--border-light)' : 'var(--plum)'};cursor:pointer;padding:8px 12px;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;" ${isAtCurrentMonth ? 'disabled' : ''}>›</button>
    </div>`;

    // == WEEK PACE HERO ==
    const paceDir = weekPaceChange >= 0 ? 'up' : 'down';
    const paceArrow = weekPaceChange >= 0 ? '↑' : '↓';
    const weekLabel = isCurrentMonth ? "This Week's Pace" : "Last Week of Month";
    html += `
    <div style="margin:12px 16px;background:var(--bg-card);border-radius:16px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,0.04);">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-muted);font-weight:600;margin-bottom:8px;">${weekLabel}</div>
      <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:6px;">
        <div style="font-size:32px;font-weight:800;color:var(--text);letter-spacing:-1px;">${fmt(thisWeekTotal)}</div>
        ${lastWeekSamePoint > 0 ? `<div style="font-size:15px;font-weight:700;padding:2px 8px;border-radius:6px;background:${paceDir==='up'?'#E8F5E8':'#FDE8E8'};color:${paceDir==='up'?'var(--success)':'var(--danger)'};">${paceArrow} ${Math.abs(weekPaceChange)}%</div>` : ''}
      </div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:14px;">vs ${fmt(lastWeekSamePoint)} prior week ${lastWeekTotal > lastWeekSamePoint ? `(${fmt(lastWeekTotal)} final)` : ''}</div>

      <div style="display:flex;align-items:flex-end;gap:6px;height:60px;">
        ${dayNames.map((d, i) => {
          const thisH = maxDayVal > 0 ? Math.round((thisWeekDays[i] / maxDayVal) * 100) : 0;
          const lastH = maxDayVal > 0 ? Math.round((lastWeekDays[i] / maxDayVal) * 100) : 0;
          const isFuture = i > dayOfWeek;
          return `
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;height:100%;justify-content:flex-end;">
            <div style="width:100%;border-radius:3px 3px 0 0;min-height:2px;height:${lastH}%;background:#C49BA5;opacity:0.4;"></div>
            <div style="width:100%;border-radius:3px 3px 0 0;min-height:${isFuture?0:2}px;height:${thisH}%;background:var(--plum);${isFuture?'opacity:0.15;':''}"></div>
            <div style="font-size:10px;color:${isFuture?'#C49BA5':'var(--text-muted)'};font-weight:500;">${d}</div>
          </div>`;
        }).join('')}
      </div>
      <div style="display:flex;gap:16px;margin-top:8px;justify-content:center;">
        <span style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-muted);"><span style="width:8px;height:8px;border-radius:2px;background:var(--plum);"></span> This week</span>
        <span style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-muted);"><span style="width:8px;height:8px;border-radius:2px;background:#C49BA5;opacity:0.4;"></span> Last week</span>
      </div>
    </div>`;

    // == KEY STATS ==
    html += `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:0 16px;margin-bottom:12px;">
      <div style="background:var(--bg-card);border-radius:12px;padding:14px;box-shadow:0 1px 4px rgba(0,0,0,0.04);">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);font-weight:600;margin-bottom:4px;">${isCurrentMonth ? 'Month to Date' : mShort[viewMonth] + ' Total'}</div>
        <div style="font-size:22px;font-weight:700;color:var(--success);">${fmt(mtdIncome)}</div>
        ${prevMonthIncome > 0 ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${monthChange >= 0 ? '↑' : '↓'} ${Math.abs(monthChange)}% vs ${mShort[prevMonth]}</div>` : ''}
      </div>
      <div style="background:var(--bg-card);border-radius:12px;padding:14px;box-shadow:0 1px 4px rgba(0,0,0,0.04);">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);font-weight:600;margin-bottom:4px;">${isCurrentMonth ? 'Net Profit MTD' : 'Net Profit'}</div>
        <div style="font-size:22px;font-weight:700;color:var(--plum);">${fmt(mtdNet)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${mtdMargin}% margin</div>
      </div>
      <div style="background:var(--bg-card);border-radius:12px;padding:14px;box-shadow:0 1px 4px rgba(0,0,0,0.04);">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);font-weight:600;margin-bottom:4px;">YTD Income</div>
        <div style="font-size:22px;font-weight:700;">${fmt(ytdIncome)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Services + Tips</div>
      </div>
      <div style="background:var(--bg-card);border-radius:12px;padding:14px;box-shadow:0 1px 4px rgba(0,0,0,0.04);">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);font-weight:600;margin-bottom:4px;">YTD Expenses</div>
        <div style="font-size:22px;font-weight:700;color:var(--danger);">${fmt(ytdExpenses)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Daily + Monthly</div>
      </div>
    </div>`;

    // == SMART INSIGHTS ==
    if (isCurrentMonth) {
      const smartInsights = generateSmartInsights(allTxns, [], allRenters, allRentPmts);
      if (smartInsights.length > 0) {
        html += `
        <div style="padding:0 16px;margin-bottom:12px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-muted);font-weight:600;margin-bottom:10px;">✨ Smart Insights</div>
          ${smartInsights.map(i => {
            const borderColor = i.type === 'success' ? 'var(--success)' : i.type === 'warning' ? 'var(--gold)' : 'var(--plum)';
            return `
            <div style="display:flex;align-items:start;gap:10px;background:var(--bg-card);border-radius:12px;padding:12px 14px;margin-bottom:8px;box-shadow:0 1px 4px rgba(0,0,0,0.04);border-left:3px solid ${borderColor};">
              <div style="font-size:20px;flex-shrink:0;margin-top:1px;">${i.icon}</div>
              <div style="font-size:13px;line-height:1.4;color:var(--text);">${i.text}</div>
            </div>`;
          }).join('')}
        </div>`;
      }
    }

    // == ALERTS ==
    if (alerts.length > 0) {
      html += `
      <div style="padding:0 16px;margin-bottom:12px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-muted);font-weight:600;margin-bottom:10px;">⚡ Needs Attention</div>
        ${alerts.map(a => `
          <div style="display:flex;align-items:start;gap:10px;background:var(--bg-card);border-radius:12px;padding:12px 14px;margin-bottom:8px;box-shadow:0 1px 4px rgba(0,0,0,0.04);border-left:3px solid ${{danger:'var(--danger)',warn:'var(--gold)',good:'var(--success)',info:'var(--plum)'}[a.type]};">
            <div style="font-size:20px;flex-shrink:0;margin-top:1px;">${a.icon}</div>
            <div style="font-size:13px;line-height:1.4;color:var(--text);">
              <strong>${a.title}</strong>
              <span style="color:var(--text-muted);font-size:12px;display:block;margin-top:2px;">${a.sub}</span>
            </div>
          </div>
        `).join('')}
      </div>`;
    }

    // == FORECAST ==
    html += `
    <div style="margin:12px 16px;background:var(--bg-card);border-radius:16px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,0.04);">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-muted);font-weight:600;margin-bottom:12px;">${isCurrentMonth ? '📊 Pace Projections' : '📊 Month Summary & Projections'}</div>

      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border-light);">
        <div>
          <div style="font-size:14px;font-weight:500;">${isCurrentMonth ? 'Projected This Month' : mShort[viewMonth] + ' Final Income'}</div>
          <div style="font-size:11px;color:var(--text-muted);">Based on ${workingDays} working days avg of ${fmt(dailyAvg)}</div>
        </div>
        <div style="font-size:18px;font-weight:700;color:var(--success);text-align:right;">${fmt(projectedMonth)}</div>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border-light);">
        <div>
          <div style="font-size:14px;font-weight:500;">Projected Annual Income</div>
          <div style="font-size:11px;color:var(--text-muted);">At current monthly pace</div>
        </div>
        <div style="font-size:18px;font-weight:700;color:var(--plum);text-align:right;">${fmt(projectedAnnualIncome)}</div>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border-light);">
        <div>
          <div style="font-size:14px;font-weight:500;">Projected Annual Booth Rent</div>
          <div style="font-size:11px;color:var(--text-muted);">${allRenters.length} renters × ${fmt(allRenters.length > 0 ? getCurrentRate(allRenters[0]) || 140 : 140)}/wk × 52 wks</div>
        </div>
        <div style="font-size:18px;font-weight:700;color:var(--success);text-align:right;">${fmt(projectedAnnualRent)}</div>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;">
        <div style="font-size:14px;font-weight:700;">Projected Total Revenue</div>
        <div style="font-size:20px;font-weight:700;color:var(--text);text-align:right;">${fmt(projectedTotalRevenue)}</div>
      </div>

      <div style="margin-top:14px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-bottom:6px;">
          <span>YTD Progress</span>
          <span>${fmt(ytdTotalRevenue)} of ~${fmt(projectedTotalRevenue)}</span>
        </div>
        <div style="height:8px;background:var(--bg-input);border-radius:4px;overflow:hidden;">
          <div style="height:100%;border-radius:4px;background:linear-gradient(90deg,var(--plum),#C49BA5);width:${Math.min(100, Math.round((ytdTotalRevenue / Math.max(projectedTotalRevenue,1)) * 100))}%;"></div>
        </div>
        <div style="text-align:right;font-size:10px;color:var(--text-muted);margin-top:4px;">
          ${viewMonth} of 12 months (${Math.round((viewMonth / 12) * 100)}% of year)
        </div>
      </div>
    </div>`;

    // == MONTH TREND ==
    const hasAnyTrend = trendMonths.some(m => m.income > 0);
    if (hasAnyTrend) {
      html += `
      <div style="margin:12px 16px;background:var(--bg-card);border-radius:16px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,0.04);">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-muted);font-weight:600;margin-bottom:12px;">Monthly Income Trend</div>
        <div style="display:flex;gap:0;margin-top:10px;">
          ${trendMonths.map(m => {
            const h = maxTrend > 0 ? Math.round((m.income / maxTrend) * 100) : 0;
            const hasData = m.income > 0;
            return `
            <div style="flex:1;text-align:center;">
              <div style="height:80px;display:flex;align-items:flex-end;justify-content:center;padding:0 3px;">
                <div style="width:100%;border-radius:4px 4px 0 0;min-height:${hasData?4:0}px;height:${h}%;background:${m.isCurrent ? 'linear-gradient(180deg,var(--plum),#C49BA5)' : 'var(--plum)'};opacity:${hasData ? (m.isCurrent ? 1 : 0.6) : 0.1};"></div>
              </div>
              <div style="font-size:10px;color:${m.isCurrent?'var(--plum)':'var(--text-muted)'};margin-top:4px;font-weight:${m.isCurrent?700:500};">${mShort[m.month]}</div>
              ${hasData ? `<div style="font-size:9px;color:${m.isCurrent?'var(--plum)':'var(--text-muted)'};margin-top:1px;${m.isCurrent?'font-weight:600;':''}">$${Math.round(m.income/1000*10)/10}k</div>` : ''}
            </div>`;
          }).join('')}
        </div>
        ${trendMonths.filter(m => m.income > 0).length < 3 ? `<div style="font-size:11px;color:var(--text-muted);text-align:center;margin-top:8px;">More months will fill in as data builds</div>` : ''}
      </div>`;
    }

    // == QUICK INSIGHTS ==
    html += `
    <div style="padding:0 16px;margin-bottom:8px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-muted);font-weight:600;margin-bottom:10px;">💡 Quick Insights</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:0 16px;margin-bottom:16px;">
      <div style="background:var(--bg-card);border-radius:12px;padding:14px;box-shadow:0 1px 4px rgba(0,0,0,0.04);text-align:center;">
        <div style="font-size:24px;margin-bottom:6px;">💳</div>
        <div style="font-size:18px;font-weight:700;color:var(--success);">${avgPerClient > 0 ? fmt(avgPerClient) : '—'}</div>
        <div style="font-size:11px;color:var(--text-muted);">Avg per client</div>
      </div>
      <div style="background:var(--bg-card);border-radius:12px;padding:14px;box-shadow:0 1px 4px rgba(0,0,0,0.04);text-align:center;">
        <div style="font-size:24px;margin-bottom:6px;">💰</div>
        <div style="font-size:18px;font-weight:700;color:var(--gold);">${tipRate}%</div>
        <div style="font-size:11px;color:var(--text-muted);">Avg tip rate</div>
      </div>
      <div style="background:var(--bg-card);border-radius:12px;padding:14px;box-shadow:0 1px 4px rgba(0,0,0,0.04);text-align:center;">
        <div style="font-size:24px;margin-bottom:6px;">🏆</div>
        <div style="font-size:18px;font-weight:700;color:var(--plum);">${topService ? topService[0] : '—'}</div>
        <div style="font-size:11px;color:var(--text-muted);">Top service by $</div>
      </div>
      <div style="background:var(--bg-card);border-radius:12px;padding:14px;box-shadow:0 1px 4px rgba(0,0,0,0.04);text-align:center;">
        <div style="font-size:24px;margin-bottom:6px;">💵</div>
        <div style="font-size:18px;font-weight:700;">${mtdMargin}%</div>
        <div style="font-size:11px;color:var(--text-muted);">Profit margin${isCurrentMonth ? ' MTD' : ''}</div>
      </div>
    </div>`;

    // == RENT SNAPSHOT ==
    if (allRenters.length > 0) {
      html += `
      <div style="padding:0 16px;margin-bottom:8px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-muted);font-weight:600;margin-bottom:10px;">🏠 Booth Rent ${rentWeekLabel}</div>
      </div>
      <div style="margin:0 16px 16px;background:var(--bg-card);border-radius:16px;padding:16px 20px;box-shadow:0 1px 4px rgba(0,0,0,0.04);display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="display:flex;gap:16px;align-items:baseline;">
            <div style="font-size:22px;font-weight:700;color:var(--success);">${fmt(rentCollected)}</div>
            <div style="font-size:13px;color:var(--text-muted);">of ${fmt(rentExpected)}</div>
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${rentersPaid} of ${allRenters.length} renters paid</div>
        </div>
        <div style="font-size:13px;font-weight:600;padding:4px 10px;border-radius:8px;background:${rentOutstanding > 0 ? '#FDE8E8' : '#E8F5E8'};color:${rentOutstanding > 0 ? 'var(--danger)' : 'var(--success)'};">
          ${rentOutstanding > 0 ? fmt(rentOutstanding) + ' due' : '✓ All paid'}
        </div>
      </div>`;
    }

    html += '<div style="height:24px;"></div>';

    loader.style.display = 'none';
    container.innerHTML = html;

  } catch (error) {
    console.error('Dashboard error:', error);
    loader.style.display = 'none';
    container.innerHTML = `
      <div style="text-align:center;padding:40px;color:var(--danger);">
        Error loading dashboard. Please try again.
      </div>
    `;
  }
}

// ----------------------------------------------------------------
// ENTRIES VIEW (Unified Income/Expense Entry)
// ----------------------------------------------------------------

async function renderEntriesView() {
  const content = document.getElementById('app-content');
  const hdr = document.getElementById('header-actions');
  hdr.innerHTML = '';

  const txns    = await db.transactions.where('date').equals(state.selectedDate).toArray();
  const summary = await db.dailySummary.where('date').equals(state.selectedDate).first();

  const income   = txns.filter(t => t.type === 'INCOME');
  const expenses = txns.filter(t => t.type === 'EXPENSE');

  const totalService  = income.reduce((s, t) => s + (t.serviceAmount || 0), 0);
  const totalTips     = income.reduce((s, t) => s + (t.tipAmount    || 0), 0);
  const totalIncome   = totalService + totalTips;
  const totalDailyExp = expenses.reduce((s, t) => s + (t.amount || 0), 0);
  const net           = totalIncome - totalDailyExp;

  const isToday = state.selectedDate === todayStr();

  // Comparison cards (today only)
  let comparisonHTML = '';
  if (isToday) {
    const allTxns = await db.transactions.toArray();
    const yesterday = addDays(todayStr(), -1);
    const lastWeek  = addDays(todayStr(), -7);
    const yesterdayIncome = allTxns.filter(t => t.date === yesterday && t.type === 'INCOME')
      .reduce((s, t) => s + (t.serviceAmount || 0) + (t.tipAmount || 0), 0);
    const lastWeekIncome  = allTxns.filter(t => t.date === lastWeek  && t.type === 'INCOME')
      .reduce((s, t) => s + (t.serviceAmount || 0) + (t.tipAmount || 0), 0);

    const calcChange = (cur, prev) => prev === 0 ? (cur > 0 ? 100 : 0) : ((cur - prev) / prev) * 100;
    const vsYesterday = calcChange(totalIncome, yesterdayIncome);
    const vsLastWeek  = calcChange(totalIncome, lastWeekIncome);

    const formatChange = (change, prevAmount) => {
      if (prevAmount === 0 && change === 0) return '<span style="color:var(--text-muted);font-size:14px;">No data</span>';
      const arrow = change > 0 ? '↑' : change < 0 ? '↓' : '→';
      const color = change > 0 ? '#2D7A4C' : change < 0 ? '#C13838' : '#999';
      return `<div style="color:${color};"><span class="comparison-arrow">${arrow}</span><span class="comparison-percent">${Math.abs(change).toFixed(0)}%</span></div>`;
    };

    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dayName  = dayNames[new Date().getDay()];

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
      </div>`;
  }

  // Backup nudge
  const lastBackupSetting = await db.settings.get('lastBackup');
  let backupNudge = '';
  if (isToday) {
    const lastBackupDate = lastBackupSetting?.value;
    const daysOverdue = lastBackupDate
      ? Math.floor((new Date() - new Date(lastBackupDate + 'T12:00:00')) / 86400000)
      : 999;
    if (daysOverdue >= 30) {
      backupNudge = `<div class="backup-nudge" onclick="navigate('settings')">💾 Export a local backup — ${daysOverdue >= 999 ? 'no local backup yet' : `last export ${daysOverdue} days ago`} <span style="margin-left:6px;opacity:.7;">›</span></div>`;
    }
  }

  const entriesTab = state.entriesTab || 'add';

  // If Browse & Search tab is selected, render that instead
  if (entriesTab === 'search') {
    content.innerHTML = `
      ${backupNudge}
      <div style="display:flex;gap:0;padding:0 16px 8px;">
        <button class="tab-btn" onclick="switchEntriesTab('add')" style="flex:1;">Add Entry</button>
        <button class="tab-btn active" onclick="switchEntriesTab('search')" style="flex:1;">Browse &amp; Search</button>
      </div>
      <div id="entries-tab-content"></div>
    `;
    await renderSearchTab(document.getElementById('entries-tab-content'));
    return;
  }

  content.innerHTML = `
    ${backupNudge}

    <div style="display:flex;gap:0;padding:0 16px 8px;">
      <button class="tab-btn active" onclick="switchEntriesTab('add')" style="flex:1;">Add Entry</button>
      <button class="tab-btn" onclick="switchEntriesTab('search')" style="flex:1;">Browse &amp; Search</button>
    </div>

    <div class="daily-date-bar">
      <button class="date-nav-btn" onclick="changeDate(-1)">‹</button>
      <div class="current-date" onclick="openDatePicker()">${isToday ? 'Today' : formatDateDisplay(state.selectedDate)}</div>
      <button class="date-nav-btn" onclick="changeDate(1)">›</button>
    </div>

    <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; padding:0 16px 12px;">
      <div class="summary-card income-card">
        <div class="summary-label">Income</div>
        <div class="summary-amount">${fmt(totalIncome)}</div>
        ${totalTips > 0 ? `<div class="summary-sub">incl. ${fmt(totalTips)} tips</div>` : ''}
      </div>
      <div class="summary-card net-card">
        <div class="summary-label">Net (Daily)</div>
        <div class="summary-amount ${net >= 0 ? 'positive' : 'negative'}">${fmt(net)}</div>
      </div>
      <div class="summary-card expense-card">
        <div class="summary-label">Expenses</div>
        <div class="summary-amount">${fmt(totalDailyExp)}</div>
        ${expenses.filter(t => t.recurring).length > 0 ? `<div class="summary-sub" style="color:#9b6e9b;">${expenses.filter(t => t.recurring).length} recurring</div>` : ''}
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
        <div style="font-weight:600;font-size:13px;color:var(--plum);margin-bottom:1px;">📋 Log today's activity</div>
        <div style="font-size:12px;color:var(--text-muted);">Track clients & hours</div>
      </div>
      <span style="font-size:20px;opacity:.3;">+</span>
    </div>
    `}

    <div class="fab-row" style="padding:0 16px 12px;">
      <button class="fab fab-income"  onclick="openAddTransactionModal('INCOME')"><span style="font-size:18px">+</span> Income</button>
      <button class="fab fab-expense" onclick="openAddTransactionModal('EXPENSE')"><span style="font-size:18px">+</span> Expense</button>
    </div>

    <div style="padding:0 16px 8px;">
      <div class="section-label">Income</div>
      ${income.length === 0 ? `
        <div class="empty-state">
          <div class="empty-icon">💈</div>
          <div class="empty-text">No income yet.</div>
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

    <div style="height:16px;"></div>
  `;
}

function switchEntriesTab(tab) {
  state.entriesTab = tab;
  if (state.editingTransactionId && tab !== 'add') {
    delete state.editingTransactionId;
    hideEditBanner();
  }
  renderEntriesView();
}

async function renderEntriesTabContent() {
  const container = document.getElementById('entries-tab-content');
  if (!container) return;
  
  const entriesTab = state.entriesTab || 'add';
  
  if (entriesTab === 'add') {
    await renderAddEntryTab(container);
  } else {
    await renderSearchTab(container);
  }
}

async function renderAddEntryTab(container) {
  const isEditing = !!state.editingTransactionId;
  
  container.innerHTML = `
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
        <button type="button" class="category-picker-trigger placeholder" id="entry-category-btn" onclick="openEntryCategoryPicker()">Select category...</button>
        <input type="hidden" id="entry-category" value="">
      </div>
      
      <!-- Employee Pay Fields (shown when category is Employee Pay) -->
      <div id="employee-pay-section" class="hidden">
        <div class="form-group">
          <label class="form-label" style="font-size:13px; margin-bottom:8px; display:block; font-weight:500;">Employee</label>
          <button type="button" class="category-picker-trigger" id="entry-employee-btn" onclick="openEmployeePicker()">Chasity McGill</button>
          <input type="hidden" id="entry-employee" value="Chasity McGill">
        </div>
        <div class="form-group">
          <label class="form-label" style="font-size:13px; margin-bottom:8px; display:block; font-weight:500;">Type</label>
          <div style="display:flex; gap:12px;">
            <label id="paytype-pay-label" style="display:flex; align-items:center; gap:8px; cursor:pointer; flex:1; padding:12px; background:var(--cream); border-radius:8px; border:2px solid var(--gold);">
              <input type="radio" name="entry-paytype" value="pay" checked style="width:18px; height:18px;" onchange="updatePayTypeStyle()">
              <span style="font-size:14px; font-weight:500;">💰 Pay</span>
            </label>
            <label id="paytype-taxes-label" style="display:flex; align-items:center; gap:8px; cursor:pointer; flex:1; padding:12px; background:var(--cream); border-radius:8px; border:2px solid transparent;">
              <input type="radio" name="entry-paytype" value="taxes" style="width:18px; height:18px;" onchange="updatePayTypeStyle()">
              <span style="font-size:14px; font-weight:500;">📋 Taxes</span>
            </label>
          </div>
        </div>
      </div>
      
      <!-- Vagaro Income Employee Field (shown when category is Vagaro Income) -->
      <div id="vagaro-employee-section" class="hidden">
        <div class="form-group">
          <label class="form-label" style="font-size:13px; margin-bottom:8px; display:block; font-weight:500;">Employee</label>
          <button type="button" class="category-picker-trigger" id="entry-vagaro-employee-btn" onclick="openVagaroEmployeePicker()">Chasity McGill</button>
          <input type="hidden" id="entry-vagaro-employee" value="Chasity McGill">
        </div>
      </div>
      
      <div class="form-group" id="service-amount-section">
        <label class="form-label" style="font-size:13px; margin-bottom:8px; display:block; font-weight:500;">Service Amount</label>
        <input type="number" id="entry-amount" class="form-input" step="0.01" placeholder="0.00" style="width:100%; padding:12px; font-size:16px;">
      </div>
      
      <div class="form-group" id="tip-amount-section">
        <label class="form-label" style="font-size:13px; margin-bottom:8px; display:block; font-weight:500;">Tip Amount (optional)</label>
        <input type="number" id="entry-tip" class="form-input" step="0.01" placeholder="0.00" style="width:100%; padding:12px; font-size:16px;">
      </div>
      
      <div class="form-group" id="client-name-section">
        <label class="form-label" style="font-size:13px; margin-bottom:8px; display:block; font-weight:500;">Client Name (optional)</label>
        <input type="text" id="entry-client" class="form-input" placeholder="e.g. Sarah M." style="width:100%; padding:12px; font-size:14px;" autocomplete="off">
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
    
    ${!isEditing ? `
      <div class="card">
        <h3 style="font-size:16px; margin-bottom:16px; font-weight:600;">Recent (Last 30)</h3>
        <div id="recent-transactions-simple"></div>
      </div>
    ` : ''}
  `;
  
  updateEntryForm();
  setupClientAutocomplete('entry-client');
  
  // Only render recent transactions list if not editing
  if (!isEditing) {
    await renderRecentTransactionsSimple();
  }
}

async function renderSearchTab(container) {
  container.innerHTML = `
    <style>
      @keyframes mf-filter-pulse {
        0%   { box-shadow: 0 0 0 0 rgba(93,56,84,0.55); }
        60%  { box-shadow: 0 0 0 10px rgba(93,56,84,0); }
        100% { box-shadow: 0 0 0 0 rgba(93,56,84,0); }
      }
      #search-filter-toggle {
        animation: mf-filter-pulse 0.9s ease-out 3;
      }
    </style>
    <div class="card">
      <button id="search-filter-toggle" onclick="toggleSearchFilters()"
        style="display:flex; align-items:center; justify-content:space-between; width:100%; background:var(--plum); color:#fff; border:none; border-radius:12px; padding:12px 16px; cursor:pointer; user-select:none; margin-bottom:4px;">
        <span style="font-size:15px; font-weight:700; letter-spacing:0.2px;">Search & Filter</span>
        <span id="search-filter-chevron" style="font-size:22px; font-weight:700; line-height:1; transition:transform 0.2s;">▸</span>
      </button>

      <div id="search-filter-body" style="display:none; margin-top:14px; margin-bottom:8px;">
        <input type="text" id="transaction-search" class="form-input" placeholder="Search by category, notes, or client name..."
          style="width:100%; padding:10px; font-size:14px; margin-bottom:8px;"
          oninput="filterTransactions()">

        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
          <button type="button" class="category-picker-trigger" id="filter-type-btn" onclick="openFilterTypePicker()" style="flex:1; min-width:120px; padding:8px; font-size:13px;">All Types</button>
          <input type="hidden" id="filter-type" value="all">

          <button type="button" class="category-picker-trigger" id="filter-category-btn" onclick="openFilterCategoryPicker()" style="flex:1; min-width:120px; padding:8px; font-size:13px;">All Categories</button>
          <input type="hidden" id="filter-category" value="all">
        </div>

        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
          <div style="flex:1; min-width:130px;">
            <label style="font-size:11px; color:var(--text-muted); display:block; margin-bottom:3px;">From Date</label>
            <input type="date" id="filter-date-from" class="form-input" style="width:100%; padding:8px; font-size:13px;" onchange="filterTransactions()">
          </div>
          <div style="flex:1; min-width:130px;">
            <label style="font-size:11px; color:var(--text-muted); display:block; margin-bottom:3px;">To Date</label>
            <input type="date" id="filter-date-to" class="form-input" style="width:100%; padding:8px; font-size:13px;" onchange="filterTransactions()">
          </div>
        </div>

        <div style="margin-bottom:8px;">
          <button type="button" class="category-picker-trigger" id="filter-amount-type-btn" onclick="openAmountFilterPicker()" style="width:100%; padding:10px; font-size:14px; margin-bottom:8px;">No Amount Filter</button>
          <input type="hidden" id="filter-amount-type" value="">

          <div id="amount-inputs-container"></div>
        </div>

        <button onclick="clearFilters()" class="btn-secondary" style="width:100%; padding:10px; font-size:13px;">Clear All Filters</button>
      </div>

      <div id="search-transactions"></div>
      <div id="load-more-container"></div>
    </div>
  `;
  
  populateCategoryFilter();
  
  if (!state.transactionsToShow) {
    state.transactionsToShow = 30;
  }
  
  await renderRecentTransactions();
}

function toggleSearchFilters() {
  const body = document.getElementById('search-filter-body');
  const chevron = document.getElementById('search-filter-chevron');
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : '';
  chevron.textContent = isOpen ? '▸' : '▾';
}

function updateAmountFilter() {
  const amountType = document.getElementById('filter-amount-type')?.value;
  const container = document.getElementById('amount-inputs-container');
  
  if (!container) return;
  
  if (amountType === 'range') {
    container.innerHTML = `
      <div style="display:flex; gap:8px;">
        <input type="number" id="filter-amount-min" class="form-input" placeholder="Min" 
          style="flex:1; padding:10px; font-size:14px;" step="0.01" 
          oninput="filterTransactions()">
        <input type="number" id="filter-amount-max" class="form-input" placeholder="Max" 
          style="flex:1; padding:10px; font-size:14px;" step="0.01" 
          oninput="filterTransactions()">
      </div>
    `;
  } else if (amountType) {
    container.innerHTML = `
      <input type="number" id="filter-amount-value" class="form-input" placeholder="Amount" 
        style="width:100%; padding:10px; font-size:14px;" step="0.01" 
        oninput="filterTransactions()">
    `;
  } else {
    container.innerHTML = '';
  }
  
  filterTransactions();
}

function populateCategoryFilter() {
  // Get all unique categories from income and all expense types
  const allCategories = [
    ...(state.categories.INCOME || []),
    ...(state.categories.EXPENSE || []),
    ...(state.categories.DAILY_EXPENSE || []),
    ...(state.categories.MONTHLY_EXPENSE || [])
  ];
  window._filterCategories = [...new Set(allCategories)].sort();
}

function openFilterCategoryPicker() {
  const filterInput = document.getElementById('filter-category');
  const filterBtn = document.getElementById('filter-category-btn');
  
  const items = ['All Categories', ...(window._filterCategories || [])];
  
  openCategoryPicker({
    title: 'Filter by Category',
    items: items,
    selectedValue: filterInput?.value === 'all' ? 'All Categories' : filterInput?.value || 'All Categories',
    onSelect: (value) => {
      const actualValue = value === 'All Categories' ? 'all' : value;
      if (filterInput) filterInput.value = actualValue;
      if (filterBtn) filterBtn.textContent = value;
      filterTransactions();
    }
  });
}

function openFilterTypePicker() {
  const filterInput = document.getElementById('filter-type');
  const filterBtn = document.getElementById('filter-type-btn');
  
  const items = [
    { value: 'all', label: 'All Types' },
    { value: 'INCOME', label: 'Income Only' },
    { value: 'EXPENSE', label: 'Expenses Only' }
  ];
  
  openCategoryPicker({
    title: 'Filter by Type',
    items: items.map(i => i.label),
    selectedValue: items.find(i => i.value === filterInput?.value)?.label || 'All Types',
    searchable: false,
    onSelect: (label) => {
      const item = items.find(i => i.label === label);
      if (filterInput) filterInput.value = item?.value || 'all';
      if (filterBtn) filterBtn.textContent = label;
      filterTransactions();
    }
  });
}

function clearFilters() {
  const searchInput = document.getElementById('transaction-search');
  const typeFilter = document.getElementById('filter-type');
  const typeFilterBtn = document.getElementById('filter-type-btn');
  const categoryFilter = document.getElementById('filter-category');
  const categoryFilterBtn = document.getElementById('filter-category-btn');
  const amountTypeFilter = document.getElementById('filter-amount-type');
  const amountInputsContainer = document.getElementById('amount-inputs-container');
  
  if (searchInput) searchInput.value = '';
  if (typeFilter) typeFilter.value = 'all';
  if (typeFilterBtn) typeFilterBtn.textContent = 'All Types';
  if (categoryFilter) categoryFilter.value = 'all';
  if (categoryFilterBtn) categoryFilterBtn.textContent = 'All Categories';
  if (amountTypeFilter) amountTypeFilter.value = '';
  const amountTypeFilterBtn = document.getElementById('filter-amount-type-btn');
  if (amountTypeFilterBtn) amountTypeFilterBtn.textContent = 'No Amount Filter';
  if (amountInputsContainer) amountInputsContainer.innerHTML = '';
  const dateFrom = document.getElementById('filter-date-from');
  const dateTo = document.getElementById('filter-date-to');
  if (dateFrom) dateFrom.value = '';
  if (dateTo) dateTo.value = '';
  
  state.transactionsToShow = 30; // Reset pagination
  filterTransactions();
}

function openAmountFilterPicker() {
  const filterInput = document.getElementById('filter-amount-type');
  const filterBtn = document.getElementById('filter-amount-type-btn');
  
  const items = [
    { value: '', label: 'No Amount Filter' },
    { value: 'exact', label: 'Exact Amount' },
    { value: 'gt', label: 'Greater Than' },
    { value: 'lt', label: 'Less Than' },
    { value: 'range', label: 'Between' }
  ];
  
  openCategoryPicker({
    title: 'Amount Filter',
    items: items.map(i => i.label),
    selectedValue: items.find(i => i.value === filterInput?.value)?.label || 'No Amount Filter',
    searchable: false,
    onSelect: (label) => {
      const item = items.find(i => i.label === label);
      if (filterInput) filterInput.value = item?.value || '';
      if (filterBtn) filterBtn.textContent = label;
      updateAmountFilter();
    }
  });
}

function filterTransactions() {
  state.transactionsToShow = 30; // Reset to first page when filtering
  renderRecentTransactions();
}

async function renderRecentTransactionsSimple() {
  const container = document.getElementById('recent-transactions-simple');
  if (!container) return;
  
  // Get last 30 transactions sorted by creation time (newest first)
  const allTransactions = await db.transactions.toArray();
  allTransactions.sort((a, b) => {
    const aTime = a.createdAt?.toDate?.() || new Date(0);
    const bTime = b.createdAt?.toDate?.() || new Date(0);
    return bTime - aTime;
  });
  
  const recentTransactions = allTransactions.slice(0, 30);
  
  if (recentTransactions.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:20px; color:var(--text-muted); font-size:14px;">
        No transactions yet
      </div>
    `;
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
        <div style="display:inline-block; font-size:12px; font-weight:700; color:#fff; background:var(--plum); padding:4px 12px; border-radius:20px; margin-bottom:8px; text-transform:uppercase; letter-spacing:0.6px;">
          ${dateLabel}
        </div>
        ${transactions.map(t => {
          const isIncome = t.type === 'INCOME';
          const amount = isIncome ? (t.serviceAmount || 0) + (t.tipAmount || 0) : (t.amount || 0);
          const amountColor = isIncome ? 'var(--success)' : 'var(--danger)';
          const tipText = isIncome && t.tipAmount > 0 ? ` + $${t.tipAmount.toFixed(2)} tip` : '';
          
          // Build category display
          let categoryDisplay = escapeHTML(t.category);
          if (t.category === 'Vagaro Income' && t.employee) {
            categoryDisplay = `Vagaro Income (${escapeHTML(t.employee.split(' ')[0])})`;
          } else if (t.category?.includes('Vagaro Income')) {
            const match = t.category.match(/^(\w+)\s*\(Vagaro Income\)$/);
            if (match) categoryDisplay = `Vagaro Income (${escapeHTML(match[1])})`;
          } else if (t.category === 'Employee Pay' && t.employee) {
            const typeLabel = t.payType === 'taxes' ? '📋' : '💰';
            categoryDisplay = `Employee Pay — ${escapeHTML(t.employee.split(' ')[0])} ${typeLabel}`;
          }
          
          return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid var(--border-light);">
              <div style="flex:1;">
                <div style="font-size:15px; font-weight:500; color:var(--text);">${categoryDisplay}</div>
                ${t.clientName ? `<div style="font-size:12px; color:var(--plum); margin-top:2px;">👤 ${escapeHTML(t.clientName)}</div>` : ''}
                ${t.notes ? `<div style="font-size:13px; color:var(--text-muted); margin-top:2px;">${escapeHTML(t.notes)}</div>` : ''}
              </div>
              <div style="text-align:right; display:flex; align-items:center; gap:4px;">
                <div style="margin-right:8px;">
                  <div style="font-size:15px; font-weight:600; color:${amountColor};">
                    ${isIncome && t.serviceAmount > 0 ? `$${t.serviceAmount.toFixed(2)}` : `$${amount.toFixed(2)}`}${tipText}
                  </div>
                </div>
                <button onclick="openEditTransactionModal('${t.id}')" style="background:none; border:none; color:var(--plum); font-size:28px; padding:8px 12px; cursor:pointer; min-width:44px; min-height:44px; display:flex; align-items:center; justify-content:center;">✎</button>
                <button onclick="deleteTransaction('${t.id}')" style="background:none; border:none; color:var(--danger); font-size:24px; padding:8px 12px; cursor:pointer; min-width:44px; min-height:44px; display:flex; align-items:center; justify-content:center;">✕</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }).join('');
}

async function renderRecentTransactions() {
  const container = document.getElementById('search-transactions');
  const loadMoreContainer = document.getElementById('load-more-container');
  if (!container) return;
  
  // Get filter values
  const searchText = document.getElementById('transaction-search')?.value.toLowerCase() || '';
  const filterType = document.getElementById('filter-type')?.value || 'all';
  const filterCategory = document.getElementById('filter-category')?.value || 'all';
  const filterAmountType = document.getElementById('filter-amount-type')?.value || '';
  const filterDateFrom = document.getElementById('filter-date-from')?.value || '';
  const filterDateTo = document.getElementById('filter-date-to')?.value || '';
  
  // Get amount values based on filter type
  let amountFilter = null;
  if (filterAmountType === 'range') {
    const min = parseFloat(document.getElementById('filter-amount-min')?.value) || 0;
    const max = parseFloat(document.getElementById('filter-amount-max')?.value) || 0;
    if (min > 0 && max > 0) {
      amountFilter = { type: 'range', min: min, max: max };
    }
  } else if (filterAmountType) {
    const value = parseFloat(document.getElementById('filter-amount-value')?.value) || 0;
    if (value > 0) {
      amountFilter = { type: filterAmountType, value: value };
    }
  }
  
  // Get all daily transactions
  let allTransactions = await db.transactions.toArray();

  // Also include monthly expenses (normalized to look like transactions)
  const allMonthly = await db.monthlyExpenses.toArray();
  allMonthly.forEach(e => {
    allTransactions.push({
      ...e,
      _isMonthly: true,
      type: 'EXPENSE',
      date: `${e.year}-${String(e.month).padStart(2,'0')}-01`,
      amount: e.amount || 0,
      serviceAmount: 0,
      tipAmount: 0,
    });
  });

  allTransactions.sort((a, b) => {
    const aTime = a.createdAt?.toDate?.() || new Date(a.date + 'T12:00:00' || 0);
    const bTime = b.createdAt?.toDate?.() || new Date(b.date + 'T12:00:00' || 0);
    return bTime - aTime;
  });
  
  // Apply filters
  allTransactions = allTransactions.filter(t => {
    // Type filter
    if (filterType !== 'all' && t.type !== filterType) return false;
    
    // Category filter
    if (filterCategory !== 'all' && t.category !== filterCategory) return false;
    
    // Date filters
    if (filterDateFrom && t.date < filterDateFrom) return false;
    if (filterDateTo && t.date > filterDateTo) return false;
    
    // Search filter (search in category, notes, and client name)
    if (searchText) {
      const categoryMatch = t.category?.toLowerCase().includes(searchText);
      const notesMatch = t.notes?.toLowerCase().includes(searchText);
      const clientMatch = t.clientName?.toLowerCase().includes(searchText);
      if (!categoryMatch && !notesMatch && !clientMatch) return false;
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
        ${searchText || filterType !== 'all' || filterCategory !== 'all' || amountFilter ? 'No matching transactions' : 'No transactions yet'}
      </div>
    `;
    if (loadMoreContainer) loadMoreContainer.innerHTML = '';
    return;
  }
  
  // Group by date
  const groupedByDate = {};
  const today = todayStr();
  
  recentTransactions.forEach(t => {
    const groupDate = t._isMonthly ? `monthly-${t.year}-${String(t.month).padStart(2,'0')}` : t.date;
    if (!groupedByDate[groupDate]) {
      groupedByDate[groupDate] = { items: [], isMonthlyGroup: t._isMonthly, month: t.month, year: t.year, date: t.date };
    }
    groupedByDate[groupDate].items.push(t);
  });
  
  // Render grouped transactions
  const groupKeys = Object.keys(groupedByDate).sort((a, b) => b.localeCompare(a));
  
  container.innerHTML = groupKeys.map(key => {
    const group = groupedByDate[key];
    let dateLabel;
    if (group.isMonthlyGroup) {
      dateLabel = `${monthName(group.month)} ${group.year} — Monthly Expenses`;
    } else {
      const dateObj = new Date(group.date + 'T00:00:00');
      const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
      const monthDay = dateObj.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
      const yr = dateObj.toLocaleDateString('en-US', { year: '2-digit' });
      dateLabel = group.date === today ? 'Today' : `${dayOfWeek}, ${monthDay}/${yr}`;
    }
    
    const transactions = group.items;
    
    return `
      <div style="margin-bottom:16px;">
        <div style="display:inline-block; font-size:12px; font-weight:700; color:#fff; background:var(--plum); padding:4px 12px; border-radius:20px; margin-bottom:8px; text-transform:uppercase; letter-spacing:0.6px;">
          ${dateLabel}
        </div>
        ${transactions.map(t => {
          const isIncome = t.type === 'INCOME';
          const isMonthly = !!t._isMonthly;
          const amount = isIncome ? (t.serviceAmount || 0) + (t.tipAmount || 0) : (t.amount || 0);
          const amountColor = isIncome ? 'var(--success)' : 'var(--danger)';
          const tipText = isIncome && t.tipAmount > 0 ? ` + $${t.tipAmount.toFixed(2)} tip` : '';
          const monthlyBadge = isMonthly ? '<span style="font-size:10px;background:var(--plum);color:#fff;padding:1px 6px;border-radius:4px;margin-left:6px;">Monthly</span>' : '';
          const editFn = isMonthly ? `openEditMonthlyExpenseModal('${t.id}')` : `openEditTransactionModal('${t.id}')`;
          const deleteFn = isMonthly ? `deleteMonthlyExpenseEntry('${t.id}')` : `deleteTransaction('${t.id}')`;
          
          // Build category display
          let categoryDisplay = escapeHTML(t.category);
          if (t.category === 'Vagaro Income' && t.employee) {
            categoryDisplay = `Vagaro Income (${escapeHTML(t.employee.split(' ')[0])})`;
          } else if (t.category?.includes('Vagaro Income')) {
            const match = t.category.match(/^(\w+)\s*\(Vagaro Income\)$/);
            if (match) categoryDisplay = `Vagaro Income (${escapeHTML(match[1])})`;
          } else if (t.category === 'Employee Pay' && t.employee) {
            const typeLabel = t.payType === 'taxes' ? '📋' : '💰';
            categoryDisplay = `Employee Pay — ${escapeHTML(t.employee.split(' ')[0])} ${typeLabel}`;
          }
          
          return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid var(--border-light);">
              <div style="flex:1;">
                <div style="font-size:15px; font-weight:500; color:var(--text);">${categoryDisplay}${monthlyBadge}</div>
                ${t.clientName ? `<div style="font-size:12px; color:var(--plum); margin-top:2px;">${escapeHTML(t.clientName)}</div>` : ''}
                ${t.notes ? `<div style="font-size:13px; color:var(--text-muted); margin-top:2px;">${escapeHTML(t.notes)}</div>` : ''}
              </div>
              <div style="text-align:right; display:flex; align-items:center; gap:4px;">
                <div style="margin-right:8px;">
                  <div style="font-size:15px; font-weight:600; color:${amountColor};">
                    ${isIncome && t.serviceAmount > 0 ? `$${t.serviceAmount.toFixed(2)}` : `$${amount.toFixed(2)}`}${tipText}
                  </div>
                </div>
                <button onclick="${editFn}" style="background:none; border:none; color:var(--plum); font-size:28px; padding:8px 12px; cursor:pointer; min-width:44px; min-height:44px; display:flex; align-items:center; justify-content:center;">✎</button>
                <button onclick="${deleteFn}" style="background:none; border:none; color:var(--danger); font-size:24px; padding:8px 12px; cursor:pointer; min-width:44px; min-height:44px; display:flex; align-items:center; justify-content:center;">✕</button>
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
          ${allTransactions.length} ${allTransactions.length === 1 ? 'entry' : 'entries'} shown
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

async function editTransaction(id) {
  const transaction = await db.transactions.get(id);
  if (!transaction) {
    showToast('Transaction not found');
    return;
  }
  
  // Store the transaction ID being edited FIRST (before re-rendering)
  state.editingTransactionId = id;
  
  // Switch to Add Entry tab — update nav UI without triggering navigate's render
  state.entriesTab = 'add';
  state.currentView = 'entries';
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
  const navBtn = document.getElementById('nav-entries');
  if (navBtn) navBtn.classList.add('active');
  document.getElementById('view-title').textContent = 'Entries';
  
  // Single controlled render
  await renderEntriesView();
  
  // Now populate form with transaction data
  if (transaction.type === 'INCOME') {
    document.querySelector('input[name="entry-type"][value="INCOME"]').checked = true;
    document.getElementById('entry-amount').value = transaction.serviceAmount || 0;
    document.getElementById('entry-tip').value = transaction.tipAmount || 0;
    document.getElementById('entry-date').value = transaction.date;
  } else {
    document.querySelector('input[name="entry-type"][value="EXPENSE"]').checked = true;
    document.getElementById('entry-expense-amount').value = transaction.amount || 0;
    document.getElementById('entry-date').value = transaction.date;
  }
  
  document.getElementById('entry-category').value = transaction.category;
  const categoryBtn = document.getElementById('entry-category-btn');
  if (categoryBtn && transaction.category) {
    categoryBtn.textContent = transaction.category;
    categoryBtn.classList.remove('placeholder');
  }
  document.getElementById('entry-notes').value = transaction.notes || '';
  if (document.getElementById('entry-client')) {
    document.getElementById('entry-client').value = transaction.clientName || '';
  }

  updateEntryForm();

  // Restore Employee Pay fields if applicable
  if (transaction.category === 'Employee Pay') {
    toggleEmployeePayFields('Employee Pay');
    const empInput = document.getElementById('entry-employee');
    const empBtn = document.getElementById('entry-employee-btn');
    if (empInput && transaction.employee) {
      empInput.value = transaction.employee;
      if (empBtn) empBtn.textContent = transaction.employee;
    }
    const payType = transaction.payType || 'pay';
    const radio = document.querySelector(`input[name="entry-paytype"][value="${payType}"]`);
    if (radio) { radio.checked = true; updatePayTypeStyle(); }
  }

  // Restore Vagaro employee if applicable
  if (transaction.category === 'Vagaro Income' && transaction.employee) {
    toggleEmployeePayFields('Vagaro Income');
    const vInput = document.getElementById('entry-vagaro-employee');
    const vBtn = document.getElementById('entry-vagaro-employee-btn');
    if (vInput) { vInput.value = transaction.employee; if (vBtn) vBtn.textContent = transaction.employee; }
  }
  
  // Show persistent edit banner
  showEditBanner();
  
  // Change button to show Update and Cancel
  const addButton = document.querySelector('.btn-primary');
  if (addButton) {
    addButton.textContent = 'Update Entry';
    addButton.onclick = () => updateTransaction();
    
    // Add cancel button after the update button
    const cancelButton = document.createElement('button');
    cancelButton.className = 'btn-secondary';
    cancelButton.textContent = 'Cancel Edit';
    cancelButton.style.width = '100%';
    cancelButton.style.padding = '14px';
    cancelButton.style.fontSize = '15px';
    cancelButton.style.fontWeight = '600';
    cancelButton.style.marginTop = '8px';
    cancelButton.onclick = () => cancelEdit();
    addButton.parentNode.insertBefore(cancelButton, addButton.nextSibling);
  }
  
  window.scrollTo(0, 0);
}

function showEditBanner() {
  // Remove any existing banner
  const existingBanner = document.getElementById('edit-banner');
  if (existingBanner) existingBanner.remove();
  
  // Create new banner
  const banner = document.createElement('div');
  banner.id = 'edit-banner';
  banner.style.cssText = `
    position: sticky;
    top: 0;
    z-index: 1000;
    background: var(--danger);
    color: white;
    padding: 12px 16px;
    text-align: center;
    font-weight: 600;
    font-size: 14px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  `;
  banner.innerHTML = '✎ EDITING TRANSACTION';
  
  // Insert at top of app content
  const appContent = document.getElementById('app-content');
  if (appContent && appContent.firstChild) {
    appContent.insertBefore(banner, appContent.firstChild);
  }
}

function hideEditBanner() {
  const banner = document.getElementById('edit-banner');
  if (banner) banner.remove();
}

function cancelEdit() {
  // Clear editing state
  delete state.editingTransactionId;
  
  // Hide edit banner
  hideEditBanner();
  
  showToast('Edit cancelled');
  
  // Re-render the Add Entry tab to show the list again
  renderEntriesTabContent();
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

  try {
    await db.transactions.delete(id);
    showToast('Entry deleted');
    const searchContainer = document.getElementById('search-transactions');
    if (searchContainer) {
      await renderRecentTransactions();
    } else {
      renderEntriesView();
    }
  } catch (error) {
    console.error('Error deleting transaction:', error);
    showToast('Error deleting transaction');
  }
}

async function updateTransaction() {
  const id = state.editingTransactionId;
  if (!id) {
    showToast('Error: No transaction to update');
    return;
  }
  
  const type = document.querySelector('input[name="entry-type"]:checked')?.value;
  const category = document.getElementById('entry-category')?.value;
  const notes = document.getElementById('entry-notes')?.value.trim() || '';
  const clientName = document.getElementById('entry-client')?.value.trim() || '';
  
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
    
    entryDate = document.getElementById('entry-date').value;
  }
  
  try {
    const updatedTransaction = {
      type: type,
      category: category,
      notes: notes,
      date: entryDate
    };
    
    if (type === 'INCOME') {
      updatedTransaction.serviceAmount = serviceAmount;
      updatedTransaction.tipAmount = tipAmount;
      updatedTransaction.clientName = clientName || null;
    } else {
      updatedTransaction.amount = expenseAmount;
    }
    
    // Update in DB
    await db.transactions.update(id, updatedTransaction);
    
    // Clear editing state
    delete state.editingTransactionId;
    
    // Hide edit banner
    hideEditBanner();
    
    showToast('Transaction updated ✓');
    
    // Re-render the Add Entry tab to show the list again
    await renderEntriesTabContent();
    
  } catch (error) {
    console.error('Error updating transaction:', error);
    showToast('Error updating transaction');
  }
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
  const clientNameSection = document.getElementById('client-name-section');
  
  // Show/hide frequency for expenses only
  if (type === 'EXPENSE') {
    frequencySection?.classList.remove('hidden');
    // Show expense amount field, hide income fields
    serviceAmountSection?.classList.add('hidden');
    tipAmountSection?.classList.add('hidden');
    expenseAmountSection?.classList.remove('hidden');
    clientNameSection?.classList.add('hidden');
  } else {
    frequencySection?.classList.add('hidden');
    // Show income fields (service + tip), hide expense field
    serviceAmountSection?.classList.remove('hidden');
    tipAmountSection?.classList.remove('hidden');
    expenseAmountSection?.classList.add('hidden');
    clientNameSection?.classList.remove('hidden');
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
  
  // Store current categories for the picker
  let categories;
  if (type === 'INCOME') {
    categories = state.categories.INCOME || [];
  } else {
    const allExpenseCategories = [
      ...(state.categories.EXPENSE || []),
      ...(state.categories.DAILY_EXPENSE || []),
      ...(state.categories.MONTHLY_EXPENSE || [])
    ];
    categories = [...new Set(allExpenseCategories)];
  }
  window._entryCategories = [...categories].sort();
  
  // Reset category selection when type changes
  const categoryInput = document.getElementById('entry-category');
  const categoryBtn = document.getElementById('entry-category-btn');
  if (categoryInput && categoryBtn) {
    // If current value not in new category list, reset
    if (!window._entryCategories.includes(categoryInput.value)) {
      categoryInput.value = window._entryCategories[0] || '';
      if (categoryInput.value) {
        categoryBtn.textContent = categoryInput.value;
        categoryBtn.classList.remove('placeholder');
      } else {
        categoryBtn.textContent = 'Select category...';
        categoryBtn.classList.add('placeholder');
      }
    }
  }

  // Sync employee pay section visibility with current category
  toggleEmployeePayFields(categoryInput?.value || '');
}

function openEntryCategoryPicker() {
  const categoryInput = document.getElementById('entry-category');
  const categoryBtn = document.getElementById('entry-category-btn');
  const type = document.querySelector('input[name="entry-type"]:checked')?.value || 'INCOME';
  
  openCategoryPicker({
    title: type === 'INCOME' ? 'Select Service' : 'Select Expense',
    items: window._entryCategories || [],
    selectedValue: categoryInput?.value || '',
    onSelect: (value) => {
      if (categoryInput) categoryInput.value = value;
      if (categoryBtn) {
        categoryBtn.textContent = value;
        categoryBtn.classList.remove('placeholder');
      }
      // Show/hide employee pay fields
      toggleEmployeePayFields(value);
    }
  });
}

function toggleEmployeePayFields(category) {
  const section = document.getElementById('employee-pay-section');
  const vagaroSection = document.getElementById('vagaro-employee-section');
  
  // Employee Pay fields (expense)
  if (section) {
    if (category === 'Employee Pay') {
      section.classList.remove('hidden');
    } else {
      section.classList.add('hidden');
    }
  }
  
  // Vagaro Income employee field (income)
  if (vagaroSection) {
    if (category === 'Vagaro Income' || category?.includes('Vagaro Income')) {
      vagaroSection.classList.remove('hidden');
    } else {
      vagaroSection.classList.add('hidden');
    }
  }
}

function openEmployeePicker() {
  const employeeInput = document.getElementById('entry-employee');
  const employeeBtn = document.getElementById('entry-employee-btn');
  
  openCategoryPicker({
    title: 'Select Employee',
    items: state.employees || ['Chasity McGill'],
    selectedValue: employeeInput?.value || 'Chasity McGill',
    onSelect: (value) => {
      if (employeeInput) employeeInput.value = value;
      if (employeeBtn) employeeBtn.textContent = value;
    }
  });
}

function openVagaroEmployeePicker() {
  const employeeInput = document.getElementById('entry-vagaro-employee');
  const employeeBtn = document.getElementById('entry-vagaro-employee-btn');
  
  openCategoryPicker({
    title: 'Select Employee',
    items: state.employees || ['Chasity McGill'],
    selectedValue: employeeInput?.value || 'Chasity McGill',
    onSelect: (value) => {
      if (employeeInput) employeeInput.value = value;
      if (employeeBtn) employeeBtn.textContent = value;
    }
  });
}

function updatePayTypeStyle() {
  const payLabel = document.getElementById('paytype-pay-label');
  const taxesLabel = document.getElementById('paytype-taxes-label');
  const selected = document.querySelector('input[name="entry-paytype"]:checked')?.value;
  
  if (payLabel && taxesLabel) {
    if (selected === 'pay') {
      payLabel.style.borderColor = 'var(--gold)';
      taxesLabel.style.borderColor = 'transparent';
    } else {
      payLabel.style.borderColor = 'transparent';
      taxesLabel.style.borderColor = 'var(--gold)';
    }
  }
}

// Modal category picker (for Add/Edit Transaction modals)
function openTxnCategoryPicker() {
  const categoryInput = document.getElementById('txn-category');
  const categoryBtn = document.getElementById('txn-category-btn');
  
  // Determine if income or expense based on modal title or context
  const modalTitle = document.querySelector('.modal-title')?.textContent || '';
  const isIncome = modalTitle.includes('Income') || modalTitle.includes('Edit') && document.getElementById('txn-tip');
  
  let categories;
  if (isIncome) {
    categories = [...(state.categories.INCOME || [])].sort();
  } else {
    const allExpenseCategories = [
      ...(state.categories.EXPENSE || []),
      ...(state.categories.DAILY_EXPENSE || []),
      ...(state.categories.MONTHLY_EXPENSE || [])
    ];
    categories = [...new Set(allExpenseCategories)].sort();
  }
  
  openCategoryPicker({
    title: isIncome ? 'Select Service' : 'Select Expense',
    items: categories,
    selectedValue: categoryInput?.value || '',
    onSelect: (value) => {
      if (categoryInput) categoryInput.value = value;
      if (categoryBtn) {
        categoryBtn.textContent = value;
        categoryBtn.classList.remove('placeholder');
      }
      // Toggle employee pay fields in edit modal
      toggleTxnEmployeePayFields(value);
    }
  });
}

function toggleTxnEmployeePayFields(category) {
  // Toggle Employee Pay section (for expenses)
  const section = document.getElementById('txn-employee-pay-section');
  if (section) {
    if (category === 'Employee Pay') {
      section.classList.remove('hidden');
    } else {
      section.classList.add('hidden');
    }
  }
  
  // Toggle Vagaro Income employee section (for income)
  const vagaroSection = document.getElementById('txn-vagaro-employee-section');
  if (vagaroSection) {
    if (category === 'Vagaro Income' || category?.includes('Vagaro Income')) {
      vagaroSection.classList.remove('hidden');
    } else {
      vagaroSection.classList.add('hidden');
    }
  }
}

function openTxnEmployeePicker() {
  const employeeInput = document.getElementById('txn-employee');
  const employeeBtn = document.getElementById('txn-employee-btn');
  
  openCategoryPicker({
    title: 'Select Employee',
    items: state.employees || ['Chasity McGill'],
    selectedValue: employeeInput?.value || 'Chasity McGill',
    onSelect: (value) => {
      if (employeeInput) employeeInput.value = value;
      if (employeeBtn) employeeBtn.textContent = value;
    }
  });
}

function openTxnVagaroEmployeePicker() {
  const employeeInput = document.getElementById('txn-vagaro-employee');
  const employeeBtn = document.getElementById('txn-vagaro-employee-btn');
  
  openCategoryPicker({
    title: 'Select Employee',
    items: state.employees || ['Chasity McGill'],
    selectedValue: employeeInput?.value || 'Chasity McGill',
    onSelect: (value) => {
      if (employeeInput) employeeInput.value = value;
      if (employeeBtn) employeeBtn.textContent = value;
    }
  });
}

function updateTxnPayTypeStyle() {
  const payLabel = document.getElementById('txn-paytype-pay-label');
  const taxesLabel = document.getElementById('txn-paytype-taxes-label');
  const selected = document.querySelector('input[name="txn-paytype"]:checked')?.value;
  
  if (payLabel && taxesLabel) {
    if (selected === 'pay') {
      payLabel.style.borderColor = 'var(--gold)';
      taxesLabel.style.borderColor = 'transparent';
    } else {
      payLabel.style.borderColor = 'transparent';
      taxesLabel.style.borderColor = 'var(--gold)';
    }
  }
}

// Payment method picker
function openPaymentPicker() {
  const paymentInput = document.getElementById('txn-payment');
  const paymentBtn = document.getElementById('txn-payment-btn');
  
  const methods = ['Cash', 'Card', 'Amex', 'Venmo', 'Check', 'Other'];
  
  openCategoryPicker({
    title: 'Payment Method',
    items: methods,
    selectedValue: paymentInput?.value || 'Cash',
    searchable: false,
    onSelect: (value) => {
      if (paymentInput) paymentInput.value = value;
      if (paymentBtn) paymentBtn.textContent = value;
    }
  });
}

// Tip method picker
function openTipMethodPicker() {
  const tipMethodInput = document.getElementById('txn-tip-method');
  const tipMethodBtn = document.getElementById('txn-tip-method-btn');
  
  const methods = ['Cash', 'Card', 'None'];
  
  openCategoryPicker({
    title: 'Tip Method',
    items: methods,
    selectedValue: tipMethodInput?.value || 'Cash',
    searchable: false,
    onSelect: (value) => {
      if (tipMethodInput) tipMethodInput.value = value;
      if (tipMethodBtn) tipMethodBtn.textContent = value;
    }
  });
}

// Monthly expense category picker
function openMECategoryPicker() {
  const categoryInput = document.getElementById('me-category');
  const categoryBtn = document.getElementById('me-category-btn');
  
  const allExpenseCategories = [
    ...(state.categories.EXPENSE || []),
    ...(state.categories.DAILY_EXPENSE || []),
    ...(state.categories.MONTHLY_EXPENSE || [])
  ];
  const categories = [...new Set(allExpenseCategories)].sort();
  
  openCategoryPicker({
    title: 'Select Expense Category',
    items: categories,
    selectedValue: categoryInput?.value || '',
    onSelect: (value) => {
      if (categoryInput) categoryInput.value = value;
      if (categoryBtn) {
        categoryBtn.textContent = value;
        categoryBtn.classList.remove('placeholder');
      }
    }
  });
}

async function saveEntryTransaction() {
  const type = document.querySelector('input[name="entry-type"]:checked')?.value;
  const frequency = document.querySelector('input[name="entry-frequency"]:checked')?.value || 'DAILY';
  const category = document.getElementById('entry-category')?.value;
  const notes = document.getElementById('entry-notes')?.value.trim() || '';
  const clientName = document.getElementById('entry-client')?.value.trim() || '';
  
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
        clientName: clientName || null,
        notes: notes,
        createdAt: firebase.firestore.Timestamp.now()
      };
      
      // Add employee for Vagaro Income
      if (category === 'Vagaro Income' || category?.includes('Vagaro Income')) {
        transaction.employee = document.getElementById('entry-vagaro-employee')?.value || 'Chasity McGill';
      }
      
      await db.transactions.add(transaction);
      
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
      
      // Add employee pay fields if applicable
      if (category === 'Employee Pay') {
        transaction.employee = document.getElementById('entry-employee')?.value || 'Chasity McGill';
        transaction.payType = document.querySelector('input[name="entry-paytype"]:checked')?.value || 'pay';
      }
      
      await db.transactions.add(transaction);
      
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
      
      await db.monthlyExpenses.add(expense);
      
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
    _clientNameCache = null; // Refresh autocomplete with new name
    
    // Refresh simple recent transactions list on Add Entry tab
    await renderRecentTransactionsSimple();
    
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
    
    // Build category display
    let categoryDisplay = escapeHTML(t.category);
    if (t.category === 'Vagaro Income' && t.employee) {
      categoryDisplay = `Vagaro Income (${escapeHTML(t.employee.split(' ')[0])})`;
    } else if (t.category?.includes('Vagaro Income')) {
      const match = t.category.match(/^(\w+)\s*\(Vagaro Income\)$/);
      if (match) categoryDisplay = `Vagaro Income (${escapeHTML(match[1])})`;
    } else if (t.category === 'Employee Pay' && t.employee) {
      const typeLabel = t.payType === 'taxes' ? '📋' : '💰';
      categoryDisplay = `Employee Pay — ${escapeHTML(t.employee.split(' ')[0])} ${typeLabel}`;
    }
    
    return `
      <div class="card" style="margin-bottom:12px; padding:14px; position:relative;">
        <button onclick="deleteDailyEntry('${t.id}')" style="position:absolute; left:14px; top:50%; transform:translateY(-50%); background:none; border:none; font-size:20px; color:#C13838; cursor:pointer; padding:0; width:24px; height:24px; display:flex; align-items:center; justify-content:center;">✕</button>
        <div style="display:flex; align-items:center; justify-content:space-between; padding-left:32px;">
          <div style="display:flex; align-items:center; flex:1;">
            <span style="font-size:24px; margin-right:12px;">${icon}</span>
            <div>
              <div style="font-size:15px; font-weight:600; margin-bottom:2px;">${categoryDisplay}</div>
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
              <div style="font-size:15px; font-weight:600; margin-bottom:2px;">${escapeHTML(entry.category)}</div>
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
              <div style="font-size:15px; font-weight:600; margin-bottom:2px;">${escapeHTML(entry.category)}</div>
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
    await db.monthlyExpenses.delete(id);
    showToast('Deleted');
    const searchContainer = document.getElementById('search-transactions');
    if (searchContainer) {
      await renderRecentTransactions();
    } else {
      renderEntriesContent();
    }
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

  // Build category display - show employee for Vagaro Income and Employee Pay
  let categoryDisplay = escapeHTML(t.category) || '—';
  if (t.category === 'Vagaro Income' && t.employee) {
    categoryDisplay = `Vagaro Income (${escapeHTML(t.employee.split(' ')[0])})`;
  } else if (t.category?.includes('Vagaro Income')) {
    // Old format: "Chasity (Vagaro Income)" - extract name from category
    const match = t.category.match(/^(\w+)\s*\(Vagaro Income\)$/);
    if (match) {
      categoryDisplay = `Vagaro Income (${escapeHTML(match[1])})`;
    }
  } else if (t.category === 'Employee Pay' && t.employee) {
    const typeLabel = t.payType === 'taxes' ? '📋' : '💰';
    categoryDisplay = `Employee Pay — ${escapeHTML(t.employee.split(' ')[0])} ${typeLabel}`;
  }

  const recurringBadge = (!isIncome && t.recurring)
    ? '<span style="font-size:10px;background:#9b6e9b;color:#fff;padding:1px 5px;border-radius:4px;margin-left:5px;vertical-align:middle;">recurring</span>'
    : '';

  return `
    <div class="txn-row">
      <div class="txn-body" onclick="openEditTransactionModal('${t.id}')">
        <div class="txn-category">${categoryDisplay}${recurringBadge} <span style="font-size:11px;color:var(--text-light);font-weight:400;">✏</span></div>
        <div class="txn-meta">${t.clientName ? '👤 ' + escapeHTML(t.clientName) + ' · ' : ''}${escapeHTML(t.paymentMethod) || ''}${t.notes ? ' · ' + escapeHTML(t.notes) : ''}${isIncome && t.tipAmount > 0 ? ' · tip ' + fmt(t.tipAmount) : ''}</div>
      </div>
      <div class="txn-amount-col ${colorClass}" onclick="openEditTransactionModal('${t.id}')">${sign}${fmt(Math.abs(total))}</div>
      <button class="txn-delete" onclick="deleteTransaction('${t.id}')">✕</button>
    </div>`;
}

function renderMonthlyExpenseItem(e) {
  return `
    <div class="txn-row">
      <div class="txn-body" onclick="openEditMonthlyExpenseModal('${e.id}')">
        <div class="txn-category">${escapeHTML(e.category) || '—'} <span style="font-size:11px;color:var(--text-light);font-weight:400;">✏</span></div>
        <div class="txn-meta">Monthly${e.notes ? ' · ' + escapeHTML(e.notes) : ''}</div>
      </div>
      <div class="txn-amount-col expense-amount" onclick="openEditMonthlyExpenseModal('${e.id}')">-${fmt(e.amount || 0)}</div>
      <button class="txn-delete" onclick="deleteMonthlyExpenseFromEntries('${e.id}')">✕</button>
    </div>`;
}

async function deleteMonthlyExpenseFromEntries(id) {
  const e = await db.monthlyExpenses.get(id);
  if (!e) return;
  const message = `Are you sure you want to delete this monthly expense?\n\n${e.category}: ${fmt(e.amount)}\n\nThis cannot be undone.`;
  const confirmed = await confirmDialog(message, 'Confirm Delete');
  if (!confirmed) return;
  try {
    await db.monthlyExpenses.delete(id);
    showToast('Monthly expense deleted');
    renderEntriesView();
  } catch (err) {
    console.error('Error deleting monthly expense:', err);
    showToast('Error deleting');
  }
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
  if (v) { state.selectedDate = v; closeModal(); renderEntriesView(); }
}

function changeDate(delta) {
  state.selectedDate = addDays(state.selectedDate, delta);
  renderEntriesView();
}

// ----------------------------------------------------------------
// 10. TRANSACTION MODALS
// ----------------------------------------------------------------

async function openAddTransactionModal(type) {
  await loadCategories();
  const isIncome = type === 'INCOME';
  const catOptions = categoryOptions(isIncome ? 'INCOME' : 'EXPENSE');
  const pmOptions = ['Cash','Card','Amex','Venmo','Check','Other']
    .map(m => `<option>${m}</option>`).join('');

  const defaultDate = ensureLocalDate(state.selectedDate);

  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const now = new Date();
  const monthOptions = monthNames.map((m, i) => `<option value="${i+1}" ${i === now.getMonth() ? 'selected' : ''}>${m}</option>`).join('');
  const yearOptions = [now.getFullYear()-1, now.getFullYear(), now.getFullYear()+1]
    .map(y => `<option value="${y}" ${y === now.getFullYear() ? 'selected' : ''}>${y}</option>`).join('');

  openModal(`
    <h2 class="modal-title">+ Add ${isIncome ? 'Income' : 'Expense'}</h2>

    <div class="form-group">
      <label class="form-label">Date</label>
      <input type="date" class="form-input" id="txn-date" value="${defaultDate}">
    </div>

    ${!isIncome ? `
    <div class="form-group" id="txn-recurring-group">
      <label style="display:flex; align-items:center; gap:10px; cursor:pointer; font-size:14px; font-weight:500;">
        <input type="checkbox" id="txn-recurring" onchange="toggleRecurringFields()"
          style="width:18px; height:18px; accent-color:var(--plum); flex-shrink:0;">
        <span>Recurring monthly expense</span>
      </label>
      <div id="txn-usual-payday-section" style="display:none; margin-top:10px;">
        <label class="form-label">Usually paid on day ___ of month (optional)</label>
        <input type="number" class="form-input" id="txn-usual-payday"
          placeholder="e.g. 1" min="1" max="31" inputmode="numeric" style="max-width:120px;">
      </div>
    </div>
    ` : ''}

    <div class="form-group">
      <label class="form-label">Category</label>
      <button type="button" class="category-picker-trigger placeholder" id="txn-category-btn" onclick="openTxnCategoryPicker()">Select category...</button>
      <input type="hidden" id="txn-category" value="">
    </div>

    <!-- Vagaro Income Employee Field (shown when category is Vagaro Income) -->
    ${isIncome ? `
    <div id="txn-vagaro-employee-section" class="hidden">
      <div class="form-group">
        <label class="form-label">Employee</label>
        <button type="button" class="category-picker-trigger" id="txn-vagaro-employee-btn" onclick="openTxnVagaroEmployeePicker()">${state.employees?.[0] || 'Chasity McGill'}</button>
        <input type="hidden" id="txn-vagaro-employee" value="${state.employees?.[0] || 'Chasity McGill'}">
      </div>
    </div>
    ` : ''}

    <!-- Employee Pay Fields (shown when category is Employee Pay) -->
    ${!isIncome ? `
    <div id="txn-employee-pay-section" class="hidden">
      <div class="form-group">
        <label class="form-label">Employee</label>
        <button type="button" class="category-picker-trigger" id="txn-employee-btn" onclick="openTxnEmployeePicker()">${state.employees?.[0] || 'Chasity McGill'}</button>
        <input type="hidden" id="txn-employee" value="${state.employees?.[0] || 'Chasity McGill'}">
      </div>
      <div class="form-group">
        <label class="form-label">Type</label>
        <div style="display:flex; gap:12px;">
          <label id="txn-paytype-pay-label" style="display:flex; align-items:center; gap:8px; cursor:pointer; flex:1; padding:12px; background:var(--cream); border-radius:8px; border:2px solid var(--gold);">
            <input type="radio" name="txn-paytype" value="pay" checked style="width:18px; height:18px;" onchange="updateTxnPayTypeStyle()">
            <span style="font-size:14px; font-weight:500;">💰 Pay</span>
          </label>
          <label id="txn-paytype-taxes-label" style="display:flex; align-items:center; gap:8px; cursor:pointer; flex:1; padding:12px; background:var(--cream); border-radius:8px; border:2px solid transparent;">
            <input type="radio" name="txn-paytype" value="taxes" style="width:18px; height:18px;" onchange="updateTxnPayTypeStyle()">
            <span style="font-size:14px; font-weight:500;">📋 Taxes</span>
          </label>
        </div>
      </div>
    </div>
    ` : ''}

    <div class="form-group">
      <label class="form-label">${isIncome ? 'Service Amount ($)' : 'Amount ($)'}</label>
      <input type="number" class="form-input" id="txn-amount" placeholder="0.00" step="0.01" min="0" inputmode="decimal">
    </div>

    <div id="txn-payment-section" class="form-group">
      <label class="form-label">Payment Method</label>
      <button type="button" class="category-picker-trigger" id="txn-payment-btn" onclick="openPaymentPicker()">Cash</button>
      <input type="hidden" id="txn-payment" value="Cash">
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
        <button type="button" class="category-picker-trigger" id="txn-tip-method-btn" onclick="openTipMethodPicker()">Cash</button>
        <input type="hidden" id="txn-tip-method" value="Cash">
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Client Name (optional)</label>
      <input type="text" class="form-input" id="txn-client" placeholder="e.g. Sarah M." autocomplete="off">
    </div>
    ` : ''}

    <div class="form-group">
      <label class="form-label">Notes (optional)</label>
      <input type="text" class="form-input" id="txn-notes" placeholder="e.g. regular client, product used…">
    </div>

    <button class="btn-submit" onclick="saveTransaction('${type}')">Save Entry</button>
  `);
  if (isIncome) setupClientAutocomplete('txn-client');
}

function toggleRecurringFields() {
  const isChecked = document.getElementById('txn-recurring')?.checked;
  const section = document.getElementById('txn-usual-payday-section');
  if (section) section.style.display = isChecked ? '' : 'none';
}


async function saveTransaction(type) {
  const isIncome = type === 'INCOME';

  const category = document.getElementById('txn-category').value;
  const amount   = parseFloat(document.getElementById('txn-amount').value) || 0;
  const notes    = document.getElementById('txn-notes').value.trim();
  const clientName = isIncome ? (document.getElementById('txn-client')?.value.trim() || '') : '';

  if (!category) { alert('Please select a category.'); return; }
  if (amount <= 0) { alert('Please enter an amount greater than zero.'); return; }

  let date = document.getElementById('txn-date').value;
  const payment = document.getElementById('txn-payment').value;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    date = state.selectedDate || todayStr();
  }

  // Duplicate detection for expenses only (3-day window, same category + amount)
  if (!isIncome) {
    const allTxns = await db.transactions.toArray();
    const enteredMs = new Date(date + 'T12:00:00').getTime();
    const threeDays = 3 * 24 * 60 * 60 * 1000;
    const dupe = allTxns.find(t =>
      t.type === 'EXPENSE' &&
      t.category === category &&
      Math.abs(t.amount - amount) < 0.01 &&
      Math.abs(new Date(t.date + 'T12:00:00').getTime() - enteredMs) <= threeDays
    );
    if (dupe) {
      const dupeDate = formatDateDisplay(dupe.date);
      const confirmed = await confirmDuplicateEntry(
        `You already have an entry on <strong>${dupeDate}</strong> for <strong>${category}</strong> — <strong>${fmt(dupe.amount)}</strong>.<br><br>Are you sure you want to add another?`
      );
      if (!confirmed) return;
    }
  }

  const record = { date, type, category, paymentMethod: payment, notes };

  if (isIncome) {
    const tip       = parseFloat(document.getElementById('txn-tip').value) || 0;
    const tipMethod = document.getElementById('txn-tip-method').value;
    record.serviceAmount = amount;
    record.tipAmount     = tip;
    record.tipMethod     = tipMethod;
    record.amount        = amount;
    record.clientName    = clientName || null;
    
    // Add employee for Vagaro Income
    if (category === 'Vagaro Income' || category?.includes('Vagaro Income')) {
      record.employee = document.getElementById('txn-vagaro-employee')?.value || 'Chasity McGill';
    }
  } else {
    record.serviceAmount = 0;
    record.tipAmount     = 0;
    record.amount        = amount;
    record.recurring     = document.getElementById('txn-recurring')?.checked || false;
    record.usualPayDay   = record.recurring
      ? (parseInt(document.getElementById('txn-usual-payday')?.value) || null)
      : null;
    if (category === 'Employee Pay') {
      record.employee = document.getElementById('txn-employee')?.value || 'Chasity McGill';
      record.payType  = document.querySelector('input[name="txn-paytype"]:checked')?.value || 'pay';
    }
  }

  try {
    await db.transactions.add(record);
    if (date !== state.selectedDate) state.selectedDate = date;
    closeModal();
    showToast(isIncome ? 'Income saved ✓' : 'Expense saved ✓');
    renderEntriesView();
  } catch (err) {
    console.error('Error saving transaction:', err);
    showToast('Error saving entry');
  }
}

// (deleteTransaction defined earlier in file)

async function openEditTransactionModal(id) {
  await loadCategories();
  const t = await db.transactions.get(id);
  if (!t) return;

  const isIncome = t.type === 'INCOME';
  const availableCategories = state.categories[isIncome ? 'INCOME' : 'EXPENSE'] || [];
  const categoryExists = availableCategories.includes(t.category);

  let catOptions = availableCategories
    .map(name => `<option value="${name}" ${name === t.category ? 'selected' : ''}>${name}</option>`)
    .join('');
  if (t.category && !categoryExists) {
    catOptions = `<option value="${t.category}" selected>${t.category} (legacy)</option>` + catOptions;
  }

  const pmOptions = ['Cash','Card','Amex','Venmo','Check','Other']
    .map(m => `<option ${m === t.paymentMethod ? 'selected' : ''}>${m}</option>`).join('');

  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const now = new Date();
  const monthOptions = monthNames.map((m, i) => `<option value="${i+1}" ${i === now.getMonth() ? 'selected' : ''}>${m}</option>`).join('');
  const yearOptions = [now.getFullYear()-1, now.getFullYear(), now.getFullYear()+1]
    .map(y => `<option value="${y}" ${y === now.getFullYear() ? 'selected' : ''}>${y}</option>`).join('');

  openModal(`
    <h2 class="modal-title">Edit ${isIncome ? 'Income' : 'Expense'}</h2>

    <div class="form-group">
      <label class="form-label">Date</label>
      <input type="date" class="form-input" id="txn-date" value="${t.date}">
    </div>

    ${!isIncome ? `
    <div class="form-group" id="txn-recurring-group">
      <label style="display:flex; align-items:center; gap:10px; cursor:pointer; font-size:14px; font-weight:500;">
        <input type="checkbox" id="txn-recurring" onchange="toggleRecurringFields()"
          style="width:18px; height:18px; accent-color:var(--plum); flex-shrink:0;"
          ${t.recurring ? 'checked' : ''}>
        <span>Recurring monthly expense</span>
      </label>
      <div id="txn-usual-payday-section" style="display:${t.recurring ? '' : 'none'}; margin-top:10px;">
        <label class="form-label">Usually paid on day ___ of month (optional)</label>
        <input type="number" class="form-input" id="txn-usual-payday"
          placeholder="e.g. 1" min="1" max="31" inputmode="numeric" style="max-width:120px;"
          value="${t.usualPayDay || ''}">
      </div>
    </div>
    ` : ''}

    <div class="form-group">
      <label class="form-label">Category</label>
      <button type="button" class="category-picker-trigger" id="txn-category-btn" onclick="openTxnCategoryPicker()">${escapeHTML(t.category) || 'Select category...'}</button>
      <input type="hidden" id="txn-category" value="${escapeHTML(t.category) || ''}">
    </div>

    <!-- Vagaro Income Employee Field (shown when category is Vagaro Income and is income) -->
    ${isIncome ? `
    <div id="txn-vagaro-employee-section" class="${(t.category === 'Vagaro Income' || t.category?.includes('Vagaro Income')) ? '' : 'hidden'}">
      <div class="form-group">
        <label class="form-label">Employee</label>
        <button type="button" class="category-picker-trigger" id="txn-vagaro-employee-btn" onclick="openTxnVagaroEmployeePicker()">${escapeHTML(t.employee) || 'Chasity McGill'}</button>
        <input type="hidden" id="txn-vagaro-employee" value="${escapeHTML(t.employee) || 'Chasity McGill'}">
      </div>
    </div>
    ` : ''}

    <!-- Employee Pay Fields (shown when category is Employee Pay) -->
    <div id="txn-employee-pay-section" class="${t.category === 'Employee Pay' ? '' : 'hidden'}">
      <div class="form-group">
        <label class="form-label">Employee</label>
        <button type="button" class="category-picker-trigger" id="txn-employee-btn" onclick="openTxnEmployeePicker()">${escapeHTML(t.employee) || 'Chasity McGill'}</button>
        <input type="hidden" id="txn-employee" value="${escapeHTML(t.employee) || 'Chasity McGill'}">
      </div>
      <div class="form-group">
        <label class="form-label">Type</label>
        <div style="display:flex; gap:12px;">
          <label id="txn-paytype-pay-label" style="display:flex; align-items:center; gap:8px; cursor:pointer; flex:1; padding:12px; background:var(--cream); border-radius:8px; border:2px solid ${(!t.payType || t.payType === 'pay') ? 'var(--gold)' : 'transparent'};">
            <input type="radio" name="txn-paytype" value="pay" ${(!t.payType || t.payType === 'pay') ? 'checked' : ''} style="width:18px; height:18px;" onchange="updateTxnPayTypeStyle()">
            <span style="font-size:14px; font-weight:500;">💰 Pay</span>
          </label>
          <label id="txn-paytype-taxes-label" style="display:flex; align-items:center; gap:8px; cursor:pointer; flex:1; padding:12px; background:var(--cream); border-radius:8px; border:2px solid ${t.payType === 'taxes' ? 'var(--gold)' : 'transparent'};">
            <input type="radio" name="txn-paytype" value="taxes" ${t.payType === 'taxes' ? 'checked' : ''} style="width:18px; height:18px;" onchange="updateTxnPayTypeStyle()">
            <span style="font-size:14px; font-weight:500;">📋 Taxes</span>
          </label>
        </div>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">${isIncome ? 'Service Amount ($)' : 'Amount ($)'}</label>
      <input type="number" class="form-input" id="txn-amount" step="0.01" min="0" inputmode="decimal"
        value="${isIncome ? (t.serviceAmount || '') : (t.amount || '')}">
    </div>

    <div id="txn-payment-section" class="form-group">
      <label class="form-label">Payment Method</label>
      <button type="button" class="category-picker-trigger" id="txn-payment-btn" onclick="openPaymentPicker()">${t.paymentMethod || 'Cash'}</button>
      <input type="hidden" id="txn-payment" value="${t.paymentMethod || 'Cash'}">
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
        <button type="button" class="category-picker-trigger" id="txn-tip-method-btn" onclick="openTipMethodPicker()">${t.tipMethod || 'Cash'}</button>
        <input type="hidden" id="txn-tip-method" value="${t.tipMethod || 'Cash'}">
      </div>
    </div>
    ` : ''}

    ${isIncome ? `
    <div class="form-group">
      <label class="form-label">Client Name (optional)</label>
      <input type="text" class="form-input" id="txn-client" value="${t.clientName || ''}" autocomplete="off">
    </div>
    ` : ''}

    <div class="form-group">
      <label class="form-label">Notes (optional)</label>
      <input type="text" class="form-input" id="txn-notes" value="${t.notes || ''}">
    </div>

    <button class="btn-submit" onclick="updateTransaction('${id}', '${t.type}')">Save Changes</button>
  `);
  if (isIncome) setupClientAutocomplete('txn-client');
}


async function updateTransaction(id, type) {
  const isIncome = type === 'INCOME';

  const category = document.getElementById('txn-category').value;
  const amount   = parseFloat(document.getElementById('txn-amount').value) || 0;
  const notes    = document.getElementById('txn-notes').value.trim();

  if (!category) { alert('Please select a category.'); return; }
  if (amount <= 0) { alert('Please enter an amount greater than zero.'); return; }

  try {
    const date    = document.getElementById('txn-date').value;
    const payment = document.getElementById('txn-payment').value;
    const changes = { date, category, paymentMethod: payment, notes };

    if (isIncome) {
      const tip       = parseFloat(document.getElementById('txn-tip').value) || 0;
      const tipMethod = document.getElementById('txn-tip-method').value;
      const clientName = document.getElementById('txn-client')?.value.trim() || '';
      changes.serviceAmount = amount;
      changes.tipAmount     = tip;
      changes.tipMethod     = tipMethod;
      changes.amount        = amount;
      changes.clientName    = clientName || null;
      
      // Add employee field for Vagaro Income (both old and new formats)
      if (category === 'Vagaro Income' || category?.includes('Vagaro Income')) {
        changes.employee = document.getElementById('txn-vagaro-employee')?.value || 'Chasity McGill';
      } else {
        changes.employee = null;
      }
    } else {
      changes.amount        = amount;
      changes.serviceAmount = 0;
      changes.tipAmount     = 0;
      changes.recurring     = document.getElementById('txn-recurring')?.checked || false;
      changes.usualPayDay   = changes.recurring
        ? (parseInt(document.getElementById('txn-usual-payday')?.value) || null)
        : null;

      // Add employee pay fields if applicable
      if (category === 'Employee Pay') {
        changes.employee = document.getElementById('txn-employee')?.value || 'Chasity McGill';
        changes.payType = document.querySelector('input[name="txn-paytype"]:checked')?.value || 'pay';
      } else {
        // Clear employee fields if category changed away from Employee Pay
        changes.employee = null;
        changes.payType = null;
      }
    }

    await db.transactions.update(id, changes);
    if (date !== state.selectedDate) state.selectedDate = date;

    closeModal();
    showToast('Entry updated ✓');
    
    // If we're on Browse & Search tab, just refresh the results list (preserving filters + scroll)
    const searchContainer = document.getElementById('search-transactions');
    if (searchContainer) {
      const scrollY = document.querySelector('.app-content')?.scrollTop || window.scrollY;
      await renderRecentTransactions();
      requestAnimationFrame(() => {
        const appContent = document.querySelector('.app-content');
        if (appContent) appContent.scrollTop = scrollY;
        else window.scrollTo(0, scrollY);
      });
    } else {
      renderEntriesView();
    }

  } catch (err) {
    console.error('Error updating transaction:', err);
    showToast('Error saving changes');
  }
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
  renderEntriesView();
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
      <button type="button" class="category-picker-trigger placeholder" id="me-category-btn" onclick="openMECategoryPicker()">Select category...</button>
      <input type="hidden" id="me-category" value="">
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
  
  // Get all expense categories
  const allExpenseCategories = [
    ...(state.categories.EXPENSE || []),
    ...(state.categories.DAILY_EXPENSE || []),
    ...(state.categories.MONTHLY_EXPENSE || [])
  ];
  const uniqueCats = [...new Set(allExpenseCategories)].sort();
  const catOptions = uniqueCats
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
      <button type="button" class="category-picker-trigger" id="me-category-btn" onclick="openMECategoryPicker()">${e.category || 'Select category...'}</button>
      <input type="hidden" id="me-category" value="${e.category || ''}">
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
  const searchContainer = document.getElementById('search-transactions');
  if (searchContainer) {
    const scrollY = document.querySelector('.app-content')?.scrollTop || window.scrollY;
    await renderRecentTransactions();
    requestAnimationFrame(() => {
      const appContent = document.querySelector('.app-content');
      if (appContent) appContent.scrollTop = scrollY;
      else window.scrollTo(0, scrollY);
    });
  } else if (state.currentView === 'entries') {
    renderEntriesView();
  } else {
    renderMonthlyView();
  }
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
    { id: 'booth-rent', label: 'Booth Rent' },
    { id: 'pnl',       label: 'P&L' },
    { id: 'employee', label: '👩‍💼 Employee' },
    { id: 'clients',   label: '👤 Clients' },
    { id: 'tax-est',  label: '🧾 Tax Est.' },
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
    <div id="report-export-bar" style="display:none;padding:12px 16px;text-align:center;">
      <div style="display:flex;gap:8px;justify-content:center;">
        <button onclick="printReport()" style="flex:1;max-width:180px;padding:10px 16px;background:var(--plum);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">🖨 Print / PDF</button>
        <button onclick="copyReportText()" style="flex:1;max-width:180px;padding:10px 16px;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">📋 Copy Text</button>
      </div>
    </div>
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
        <div class="report-controls" style="display:flex; gap:8px; align-items:center;">
          <button class="report-btn" onclick="navigateDay(-1)" style="padding:8px 12px;">◄</button>
          <input type="date" class="report-input" id="r-date" value="${state.selectedDate}" style="flex:1;">
          <button class="report-btn" onclick="navigateDay(1)" style="padding:8px 12px;">►</button>
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
            placeholder="Week starting (Monday)" style="flex:1;">
          <button class="report-btn" onclick="navigateWeek(1)" style="padding:8px 12px;">►</button>
          <button class="report-btn" onclick="runWeeklyReport()">View</button>
        </div>
        <div style="margin-top:12px; display:flex; justify-content:center;">
          <label style="display:flex; align-items:center; gap:10px; font-size:14px; color:var(--text); cursor:pointer; background:var(--gold-lighter); padding:10px 16px; border-radius:20px; border:1.5px solid var(--border);">
            <input type="checkbox" id="r-week-personal" onchange="runWeeklyReport()" style="width:20px; height:20px; accent-color:var(--plum);">
            <span style="font-weight:500;">Personal Only</span>
            <span style="font-size:11px; color:var(--text-muted);">(excludes employee)</span>
          </label>
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
        <div class="report-controls" style="display:flex; gap:8px; align-items:center;">
          <button class="report-btn" onclick="navigateMonth(-1)" style="padding:8px 12px;">◄</button>
          <select class="report-select" id="r-month" style="flex:1;">${monthOpts}</select>
          <input type="number" class="report-input" id="r-year" value="${yearNow}" min="2020" max="2099" style="max-width:90px" inputmode="numeric">
          <button class="report-btn" onclick="navigateMonth(1)" style="padding:8px 12px;">►</button>
          <button class="report-btn" onclick="runMonthlyReport()">View</button>
        </div>
        <div style="margin-top:12px; display:flex; justify-content:center;">
          <label style="display:flex; align-items:center; gap:10px; font-size:14px; color:var(--text); cursor:pointer; background:var(--gold-lighter); padding:10px 16px; border-radius:20px; border:1.5px solid var(--border);">
            <input type="checkbox" id="r-month-personal" onchange="runMonthlyReport()" style="width:20px; height:20px; accent-color:var(--plum);">
            <span style="font-weight:500;">Personal Only</span>
            <span style="font-size:11px; color:var(--text-muted);">(excludes employee)</span>
          </label>
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
        <div style="margin-top:12px; display:flex; justify-content:center;">
          <label style="display:flex; align-items:center; gap:10px; font-size:14px; color:var(--text); cursor:pointer; background:var(--gold-lighter); padding:10px 16px; border-radius:20px; border:1.5px solid var(--border);">
            <input type="checkbox" id="r-annual-personal" onchange="runAnnualReport()" style="width:20px; height:20px; accent-color:var(--plum);">
            <span style="font-weight:500;">Personal Only</span>
            <span style="font-size:11px; color:var(--text-muted);">(excludes employee)</span>
          </label>
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

    case 'booth-rent': {
      el.innerHTML = `
        <div class="report-controls">
          <input type="number" class="report-input" id="r-br-year" value="${yearNow}" min="2020" max="2099" style="max-width:100px" inputmode="numeric">
          <button class="report-btn" onclick="runBoothRentReport()">View</button>
        </div>
        <div class="report-body" id="report-output"></div>
      `;
      await runBoothRentReport();
      break;
    }

    case 'pnl': {
      const monthOpts = Array.from({length:12},(_,i)=>
        `<option value="${i+1}" ${i+1===monthNow?'selected':''}>${monthName(i+1)}</option>`).join('');
      el.innerHTML = `
        <div class="report-controls" style="flex-wrap:wrap;gap:8px;">
          <select class="report-input" id="r-pnl-period" style="flex:2;min-width:140px;" onchange="runPnlReport()">
            <option value="monthly">Monthly</option>
            <option value="q1">Q1 (Jan–Mar)</option>
            <option value="q2">Q2 (Apr–Jun)</option>
            <option value="q3">Q3 (Jul–Sep)</option>
            <option value="q4">Q4 (Oct–Dec)</option>
            <option value="ytd">Year to Date</option>
            <option value="range">Date Range</option>
          </select>
          <input type="number" class="report-input" id="r-pnl-year" value="${yearNow}" min="2020" max="2099" style="max-width:80px" inputmode="numeric" onchange="runPnlReport()">
        </div>
        <div id="r-pnl-monthly-controls" class="report-controls" style="gap:8px;">
          <select class="report-input" id="r-pnl-month" style="flex:1;">${monthOpts}</select>
          <button class="report-btn" onclick="runPnlReport()">View</button>
        </div>
        <div id="r-pnl-range-controls" class="report-controls" style="gap:8px;display:none;">
          <input type="date" class="report-input" id="r-pnl-from" style="flex:1;">
          <input type="date" class="report-input" id="r-pnl-to" style="flex:1;">
          <button class="report-btn" onclick="runPnlReport()">View</button>
        </div>
        <div class="report-body" id="report-output"></div>
      `;
      document.getElementById('r-pnl-period').addEventListener('change', function() {
        const p = this.value;
        document.getElementById('r-pnl-monthly-controls').style.display = p === 'monthly' ? '' : 'none';
        document.getElementById('r-pnl-range-controls').style.display = p === 'range' ? '' : 'none';
      });
      await runPnlReport();
      break;
    }

    case 'employee': {
      el.innerHTML = `
        <div class="report-controls" style="gap:8px; flex-wrap:wrap;">
          <select class="report-input" id="r-emp-employee" style="flex:1; min-width:140px;" onchange="runEmployeeReport()">
            ${(state.employees || ['Chasity McGill']).map(e => 
              `<option value="${escapeHTML(e)}">${escapeHTML(e)}</option>`
            ).join('')}
          </select>
          <select class="report-input" id="r-emp-period" style="flex:1; min-width:120px;" onchange="runEmployeeReport()">
            <option value="ytd">Year to Date</option>
            <option value="q1">Q1 (Jan-Mar)</option>
            <option value="q2">Q2 (Apr-Jun)</option>
            <option value="q3">Q3 (Jul-Sep)</option>
            <option value="q4">Q4 (Oct-Dec)</option>
            <option value="last30">Last 30 Days</option>
            <option value="all">All Time</option>
          </select>
          <select class="report-input" id="r-emp-year" style="width:90px;" onchange="runEmployeeReport()">
            ${[2024, 2025, 2026, 2027].map(y => 
              `<option value="${y}" ${y === new Date().getFullYear() ? 'selected' : ''}>${y}</option>`
            ).join('')}
          </select>
        </div>
        <div class="report-body" id="report-output"></div>
      `;
      await runEmployeeReport();
      break;
    }

    case 'clients': {
      el.innerHTML = `
        <div class="report-controls" style="gap:8px;">
          <input type="text" class="report-input" id="r-client-search" placeholder="Search clients…" style="flex:1;" oninput="runClientBook()">
          <select class="report-input" id="r-client-sort" style="max-width:140px;" onchange="runClientBook()">
            <option value="recent">Last Visit</option>
            <option value="spend">Total Spend</option>
            <option value="visits">Most Visits</option>
            <option value="alpha">A → Z</option>
          </select>
        </div>
        <div class="report-body" id="report-output"></div>
      `;
      await runClientBook();
      break;
    }

    case 'tax-est': {
      const taxYearNow = new Date().getFullYear();
      const yearOpts = [taxYearNow, taxYearNow - 1].map(y =>
        `<option value="${y}" ${y === taxYearNow ? 'selected' : ''}>${y}</option>`
      ).join('');
      el.innerHTML = `
        <div class="report-controls" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
          <div style="flex:1;min-width:100px;">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Tax Year</label>
            <select class="report-input" id="r-tax-year" style="width:100%;">${yearOpts}</select>
          </div>
          <div style="flex:2;min-width:160px;">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Filing Status</label>
            <select class="report-input" id="r-tax-filing-status" style="width:100%;">
              <option value="single">Single</option>
              <option value="mfj">Married Filing Jointly</option>
            </select>
          </div>
          <button class="report-btn" onclick="runTaxEstimateReport()">Calculate</button>
        </div>
        <div class="report-body" id="report-output"></div>
      `;
      await runTaxEstimateReport();
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

  // Show export bar for all report types except 'export' and 'clients'
  const exportBar = document.getElementById('report-export-bar');
  if (exportBar) {
    exportBar.style.display = (state.reportType === 'export' || state.reportType === 'clients' || state.reportType === 'tax-est' || state.reportType === 'employee') ? 'none' : 'block';
  }
}

// ---- Employee Report ----
async function runEmployeeReport() {
  const el = document.getElementById('report-output');
  if (!el) return;
  
  const employeeName = document.getElementById('r-emp-employee')?.value || 'Chasity McGill';
  const period = document.getElementById('r-emp-period')?.value || 'ytd';
  const year = parseInt(document.getElementById('r-emp-year')?.value) || new Date().getFullYear();
  
  // Calculate date range based on period
  let startDate, endDate;
  const today = new Date();
  
  switch (period) {
    case 'q1':
      startDate = `${year}-01-01`;
      endDate = `${year}-03-31`;
      break;
    case 'q2':
      startDate = `${year}-04-01`;
      endDate = `${year}-06-30`;
      break;
    case 'q3':
      startDate = `${year}-07-01`;
      endDate = `${year}-09-30`;
      break;
    case 'q4':
      startDate = `${year}-10-01`;
      endDate = `${year}-12-31`;
      break;
    case 'last30':
      endDate = todayStr();
      const d = new Date();
      d.setDate(d.getDate() - 30);
      startDate = d.toISOString().split('T')[0];
      break;
    case 'all':
      startDate = '2020-01-01';
      endDate = '2099-12-31';
      break;
    case 'ytd':
    default:
      startDate = `${year}-01-01`;
      endDate = todayStr();
      break;
  }
  
  // Get all transactions
  const allTxns = await db.transactions.toArray();
  
  // Filter income from this employee
  // NEW: category === 'Vagaro Income' && employee === employeeName
  // LEGACY: category === 'Chasity (Vagaro Income)' (for backward compatibility during migration)
  const legacyCategory = `${employeeName.split(' ')[0]} (Vagaro Income)`;
  const incomeTxns = allTxns.filter(t => 
    t.type === 'INCOME' && 
    t.date >= startDate && 
    t.date <= endDate &&
    (
      // New format: Vagaro Income + employee field
      (t.category === 'Vagaro Income' && t.employee === employeeName) ||
      // Legacy format: Chasity (Vagaro Income)
      t.category === legacyCategory
    )
  );
  
  // Sunday-based week start for Vagaro weekly grouping (local to this report)
  function getWeekStart(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() - d.getDay());
    return d.toISOString().split('T')[0];
  }

  // Calculate income totals
  let cardServices = 0, cashServices = 0, totalTips = 0;
  const weeklyData = {};

  incomeTxns.forEach(t => {
    const weekStart = getWeekStart(t.date);
    if (!weeklyData[weekStart]) {
      weeklyData[weekStart] = { services: 0, tips: 0, pay: 0, taxes: 0 };
    }
    
    const serviceAmt = t.serviceAmount || t.amount || 0;
    weeklyData[weekStart].services += serviceAmt;
    
    if (t.paymentMethod === 'Card') {
      cardServices += serviceAmt;
    } else if (t.paymentMethod === 'Cash') {
      cashServices += serviceAmt;
    } else {
      cardServices += serviceAmt; // Default to card
    }
    
    // Check employeeTips field first (from Vagaro import)
    if (t.employeeTips) {
      totalTips += t.employeeTips;
      weeklyData[weekStart].tips += t.employeeTips;
    }
    // Also extract tips from notes if present: "(Tips: $143.50 kept by Chasity)"
    else {
      const tipMatch = t.notes?.match(/Tips:\s*\$?([\d.]+)/i);
      if (tipMatch) {
        const tipAmt = parseFloat(tipMatch[1]) || 0;
        totalTips += tipAmt;
        weeklyData[weekStart].tips += tipAmt;
      }
    }
    
    // Also check tipAmount field (manual entries)
    if (t.tipAmount) {
      totalTips += t.tipAmount;
      weeklyData[weekStart].tips += t.tipAmount;
    }
  });
  
  const totalServices = cardServices + cashServices;
  
  // Filter expenses for this employee
  const expenseTxns = allTxns.filter(t => 
    t.type === 'EXPENSE' && 
    t.category === 'Employee Pay' &&
    t.date >= startDate && 
    t.date <= endDate &&
    (t.employee === employeeName || (!t.employee && employeeName === 'Chasity McGill'))
  );
  
  let totalPay = 0, totalTaxes = 0;
  let payWeeks = 0, commissionWeeks = 0, hourlyWeeks = 0;
  
  expenseTxns.forEach(t => {
    const weekStart = getWeekStart(t.date);
    if (!weeklyData[weekStart]) {
      weeklyData[weekStart] = { services: 0, tips: 0, pay: 0, taxes: 0 };
    }
    
    const amt = t.amount || 0;
    
    if (t.payType === 'taxes' || (t.notes && t.notes.toLowerCase().includes('tax'))) {
      totalTaxes += amt;
      weeklyData[weekStart].taxes += amt;
    } else {
      totalPay += amt;
      weeklyData[weekStart].pay += amt;
      payWeeks++;
      
      // Estimate commission vs hourly based on if pay is ~50% of services
      // This is a rough heuristic - commission would be close to 50%
      if (weeklyData[weekStart].services > 0) {
        const ratio = weeklyData[weekStart].pay / weeklyData[weekStart].services;
        if (ratio >= 0.45 && ratio <= 0.55) {
          commissionWeeks++;
        } else {
          hourlyWeeks++;
        }
      }
    }
  });
  
  const totalCost = totalPay + totalTaxes;
  const netProfit = totalServices - totalCost;
  const profitMargin = totalServices > 0 ? ((netProfit / totalServices) * 100).toFixed(1) : 0;

  // Sort weeks for display
  const sortedWeeks = Object.keys(weeklyData).sort().reverse();
  const weeksWorked = sortedWeeks.filter(w => weeklyData[w].services > 0 || weeklyData[w].pay > 0).length;

  const BOOTH_RATE = 140;
  const boothRenterNet = BOOTH_RATE * weeksWorked;
  const boothDiff = netProfit - boothRenterNet;
  const employeeIsBetter = boothDiff >= 0;
  
  // Format period label
  const periodLabels = {
    'ytd': `Year to Date ${year}`,
    'q1': `Q1 ${year} (Jan-Mar)`,
    'q2': `Q2 ${year} (Apr-Jun)`,
    'q3': `Q3 ${year} (Jul-Sep)`,
    'q4': `Q4 ${year} (Oct-Dec)`,
    'last30': 'Last 30 Days',
    'all': 'All Time'
  };
  
  el.innerHTML = `
    <div class="report-card" style="margin-bottom:16px;">
      <div style="text-align:center; margin-bottom:20px;">
        <div style="font-size:20px; font-weight:700; color:var(--plum);">${escapeHTML(employeeName)}</div>
        <div style="font-size:13px; color:var(--text-muted);">${periodLabels[period] || period}</div>
      </div>
      
      <!-- Revenue Section -->
      <div style="background:var(--success-bg); padding:16px; border-radius:10px; margin-bottom:12px;">
        <div style="font-weight:600; margin-bottom:12px; color:var(--success);">💰 Service Revenue Generated</div>
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
          <span>💳 Card Services</span>
          <span style="font-weight:600;">${fmt(cardServices)}</span>
        </div>
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
          <span>💵 Cash Services</span>
          <span style="font-weight:600;">${fmt(cashServices)}</span>
        </div>
        <div style="display:flex; justify-content:space-between; font-weight:700; border-top:1px dashed var(--border); padding-top:8px; margin-top:8px; font-size:17px;">
          <span>Total Revenue</span>
          <span style="color:var(--success);">${fmt(totalServices)}</span>
        </div>
      </div>
      
      <!-- Tips Section -->
      <div style="background:var(--gold-lighter); padding:16px; border-radius:10px; margin-bottom:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:600;">💝 Tips Earned</div>
            <div style="font-size:12px; color:var(--text-muted);">Kept 100% by ${escapeHTML(employeeName.split(' ')[0])}</div>
          </div>
          <span style="font-size:18px; font-weight:700;">${fmt(totalTips)}</span>
        </div>
      </div>
      
      <!-- Expenses Section -->
      <div style="background:var(--danger-bg); padding:16px; border-radius:10px; margin-bottom:12px;">
        <div style="font-weight:600; margin-bottom:12px; color:var(--danger);">📤 Salon Expenses</div>
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
          <span>💰 Employee Pay</span>
          <span style="font-weight:600;">${fmt(totalPay)}</span>
        </div>
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
          <span>📋 Employer Taxes</span>
          <span style="font-weight:600;">${fmt(totalTaxes)}</span>
        </div>
        <div style="display:flex; justify-content:space-between; font-weight:700; border-top:1px dashed var(--border); padding-top:8px; margin-top:8px; font-size:17px;">
          <span>Total Cost</span>
          <span style="color:var(--danger);">${fmt(totalCost)}</span>
        </div>
      </div>
      
      <!-- Net Profit -->
      <div style="background:var(--plum); color:#fff; padding:16px; border-radius:10px; margin-bottom:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:600;">Net Profit to Annette (Employee)</div>
            <div style="font-size:12px; opacity:0.8;">${profitMargin}% margin</div>
          </div>
          <span style="font-size:24px; font-weight:700;">${fmt(netProfit)}</span>
        </div>
      </div>

      <!-- Booth Renter Comparison -->
      <div style="background:${employeeIsBetter ? 'var(--success-bg)' : 'var(--danger-bg)'}; padding:16px; border-radius:10px; margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:600; color:${employeeIsBetter ? 'var(--success)' : 'var(--danger)'};">vs. Booth Renter @ $${BOOTH_RATE}/wk</div>
            <div style="font-size:12px; color:${employeeIsBetter ? 'var(--success)' : 'var(--danger)'};">
              ${employeeIsBetter
                ? `Employee earns ${fmt(boothDiff)} more`
                : `Booth renter would earn ${fmt(Math.abs(boothDiff))} more`}
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:18px; font-weight:700; color:${employeeIsBetter ? 'var(--success)' : 'var(--danger)'};">${fmt(boothRenterNet)}</div>
            <div style="font-size:11px; color:var(--text-muted);">${weeksWorked} wks × $${BOOTH_RATE}</div>
          </div>
        </div>
      </div>

      <!-- Stats Grid -->
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:16px;">
        <div style="background:var(--cream); padding:12px; border-radius:8px; text-align:center;">
          <div style="font-size:22px; font-weight:700; color:var(--plum);">${weeksWorked}</div>
          <div style="font-size:12px; color:var(--text-muted);">Weeks Worked</div>
        </div>
        <div style="background:var(--cream); padding:12px; border-radius:8px; text-align:center;">
          <div style="font-size:22px; font-weight:700; color:var(--plum);">${fmt(weeksWorked > 0 ? netProfit / weeksWorked : 0)}</div>
          <div style="font-size:12px; color:var(--text-muted);">Avg Weekly Profit</div>
        </div>
        <div style="background:var(--cream); padding:12px; border-radius:8px; text-align:center;">
          <div style="font-size:22px; font-weight:700; color:var(--gold-dark);">${fmt(weeksWorked > 0 ? totalTips / weeksWorked : 0)}</div>
          <div style="font-size:12px; color:var(--text-muted);">Avg Weekly Tips</div>
        </div>
        <div style="background:var(--cream); padding:12px; border-radius:8px; text-align:center;">
          <div style="font-size:22px; font-weight:700; color:var(--success);">${fmt(weeksWorked > 0 ? totalServices / weeksWorked : 0)}</div>
          <div style="font-size:12px; color:var(--text-muted);">Avg Weekly Revenue</div>
        </div>
      </div>
      
      ${sortedWeeks.length > 0 ? `
        <!-- Weekly Breakdown -->
        <div style="margin-top:20px;">
          <div style="font-weight:600; margin-bottom:12px;">Weekly Breakdown</div>
          <div style="max-height:300px; overflow-y:auto;">
            ${sortedWeeks.slice(0, 20).map(week => {
              const w = weeklyData[week];
              const weekNet = w.services - w.pay - w.taxes;
              if (w.services === 0 && w.pay === 0) return '';
              return `
                <div style="display:flex; justify-content:space-between; padding:10px; background:var(--cream); border-radius:6px; margin-bottom:6px; font-size:13px;">
                  <div>
                    <div style="font-weight:500;">Week of ${formatDateShort(week)}</div>
                    <div style="font-size:11px; color:var(--text-muted);">
                      Rev: ${fmt(w.services)} · Pay: ${fmt(w.pay)}${w.taxes > 0 ? ` · Tax: ${fmt(w.taxes)}` : ''}${w.tips > 0 ? ` · Tips: ${fmt(w.tips)}` : ''}
                    </div>
                  </div>
                  <div style="text-align:right;">
                    <div style="font-weight:600; color:${weekNet >= 0 ? 'var(--success)' : 'var(--danger)'};">${fmt(weekNet)}</div>
                    <div style="font-size:11px; color:var(--text-muted);">net</div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

// ---- Client Book ----
async function runClientBook() {
  const el = document.getElementById('report-output');
  if (!el) return;

  const search = (document.getElementById('r-client-search')?.value || '').trim().toLowerCase();
  const sortBy = document.getElementById('r-client-sort')?.value || 'recent';

  const allTxns = await db.transactions.toArray();

  // Employee categories to exclude
  const employeeCategories = ['Vagaro Income', 'Chasity (Vagaro Income)'];

  // Build client map from all income transactions with clientName
  const clientMap = {};
  allTxns.filter(t => t.type === 'INCOME' && t.clientName && t.clientName.trim() && !employeeCategories.includes(t.category)).forEach(t => {
    const name = t.clientName.trim();
    // Normalize key: lowercase for grouping, keep original for display
    const key = name.toLowerCase();
    if (!clientMap[key]) {
      clientMap[key] = {
        name: name, // Keep first-seen casing
        visits: [],
        totalSpend: 0,
        services: {},
      };
    }
    const ticket = (t.serviceAmount || 0) + (t.tipAmount || 0);
    clientMap[key].visits.push({
      date: t.date,
      category: t.category,
      serviceAmount: t.serviceAmount || 0,
      tipAmount: t.tipAmount || 0,
      total: ticket,
    });
    clientMap[key].totalSpend += ticket;
    // Track service frequency
    if (t.category) {
      clientMap[key].services[t.category] = (clientMap[key].services[t.category] || 0) + 1;
    }
  });

  // Convert to array and compute stats
  let clients = Object.values(clientMap).map(c => {
    c.visits.sort((a, b) => b.date.localeCompare(a.date)); // newest first
    const lastVisit = c.visits[0]?.date || '';
    const daysSince = lastVisit ? Math.floor((new Date() - new Date(lastVisit + 'T12:00:00')) / 86400000) : 999;
    const avgTicket = c.visits.length > 0 ? c.totalSpend / c.visits.length : 0;
    const topService = Object.entries(c.services).sort((a, b) => b[1] - a[1])[0];

    return {
      name: c.name,
      visitCount: c.visits.length,
      totalSpend: c.totalSpend,
      avgTicket,
      lastVisit,
      daysSince,
      topService: topService ? topService[0] : '—',
      visits: c.visits,
    };
  });

  // Filter by search
  if (search) {
    clients = clients.filter(c => c.name.toLowerCase().includes(search));
  }

  // Sort
  switch (sortBy) {
    case 'recent':  clients.sort((a, b) => a.daysSince - b.daysSince); break;
    case 'spend':   clients.sort((a, b) => b.totalSpend - a.totalSpend); break;
    case 'visits':  clients.sort((a, b) => b.visitCount - a.visitCount); break;
    case 'alpha':   clients.sort((a, b) => a.name.localeCompare(b.name)); break;
  }

  if (clients.length === 0) {
    el.innerHTML = `
      <div style="text-align:center;padding:40px 20px;color:var(--text-muted);">
        <div style="font-size:40px;margin-bottom:12px;">👤</div>
        <div style="font-size:15px;font-weight:500;margin-bottom:6px;">${search ? 'No clients match your search' : 'No client data yet'}</div>
        <div style="font-size:13px;">Add client names when entering income to build your client book.</div>
      </div>
    `;
    return;
  }

  // Summary stats
  const totalClients = clients.length;
  const avgSpendAll = clients.reduce((s, c) => s + c.totalSpend, 0) / totalClients;
  const avgVisitsAll = clients.reduce((s, c) => s + c.visitCount, 0) / totalClients;
  const overdue = clients.filter(c => c.daysSince >= 28).length;

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;">
      <div style="background:var(--bg-card);border-radius:10px;padding:12px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
        <div style="font-size:22px;font-weight:700;color:var(--plum);">${totalClients}</div>
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);font-weight:600;">Total Clients</div>
      </div>
      <div style="background:var(--bg-card);border-radius:10px;padding:12px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
        <div style="font-size:22px;font-weight:700;color:var(--success);">${fmt(avgSpendAll)}</div>
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);font-weight:600;">Avg Lifetime Spend</div>
      </div>
      <div style="background:var(--bg-card);border-radius:10px;padding:12px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
        <div style="font-size:22px;font-weight:700;">${avgVisitsAll.toFixed(1)}</div>
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);font-weight:600;">Avg Visits</div>
      </div>
      <div style="background:var(--bg-card);border-radius:10px;padding:12px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
        <div style="font-size:22px;font-weight:700;color:${overdue > 0 ? 'var(--danger)' : 'var(--success)'};">${overdue}</div>
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);font-weight:600;">Overdue (4+ wks)</div>
      </div>
    </div>

    ${clients.map(c => {
      const lastVisitLabel = c.daysSince === 0 ? 'Today' :
        c.daysSince === 1 ? 'Yesterday' :
        c.daysSince < 7 ? `${c.daysSince} days ago` :
        c.daysSince < 30 ? `${Math.floor(c.daysSince / 7)} wk${Math.floor(c.daysSince/7)>1?'s':''} ago` :
        `${Math.floor(c.daysSince / 30)} mo${Math.floor(c.daysSince/30)>1?'s':''} ago`;
      const overdueFlag = c.daysSince >= 28;
      const safeId = c.name.replace(/[^a-zA-Z0-9]/g,'_');

      return `
      <div class="client-card" style="background:var(--bg-card);border-radius:12px;padding:14px 16px;margin-bottom:8px;box-shadow:0 1px 3px rgba(0,0,0,0.04);cursor:pointer;" onclick="toggleClientDetail('client-${safeId}')">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:15px;font-weight:600;color:var(--text);">${escapeHTML(c.name)}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">
              ${c.visitCount} visit${c.visitCount !== 1 ? 's' : ''} · ${escapeHTML(c.topService)} · ${lastVisitLabel}
              ${overdueFlag ? '<span style="color:var(--danger);font-weight:600;"> ⏰</span>' : ''}
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:16px;font-weight:700;color:var(--success);">${fmt(c.totalSpend)}</div>
            <div style="font-size:11px;color:var(--text-muted);">${fmt(c.avgTicket)} avg</div>
          </div>
        </div>
        <div id="client-${safeId}" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border-light);">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);font-weight:600;margin-bottom:8px;">Visit History</div>
          ${c.visits.slice(0, 10).map(v => `
            <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;border-bottom:1px solid var(--border-light);">
              <div>
                <span style="color:var(--text);">${formatDateShort(v.date)}</span>
                <span style="color:var(--text-muted);margin-left:6px;">${escapeHTML(v.category)}</span>
              </div>
              <div style="font-weight:600;color:var(--success);">${fmt(v.total)}${v.tipAmount > 0 ? ` <span style="font-weight:400;font-size:11px;color:var(--gold);">(${fmt(v.tipAmount)} tip)</span>` : ''}</div>
            </div>
          `).join('')}
          ${c.visits.length > 10 ? `<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:6px 0;">+ ${c.visits.length - 10} more visits</div>` : ''}
        </div>
      </div>`;
    }).join('')}
  `;
}

function toggleClientDetail(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// ---- Report Export Functions ----
function printReport() {
  const reportEl = document.getElementById('report-output');
  if (!reportEl || !reportEl.innerHTML.trim()) { showToast('No report to print'); return; }

  // Clone and clean up for print
  const clone = reportEl.cloneNode(true);

  // Remove any canvas elements (pie charts won't render in print)
  clone.querySelectorAll('canvas').forEach(c => {
    const placeholder = document.createElement('div');
    placeholder.textContent = '[Chart — see app for visual]';
    placeholder.style.cssText = 'text-align:center;padding:12px;color:#999;font-style:italic;';
    c.replaceWith(placeholder);
  });

  // Remove delete buttons, edit icons
  clone.querySelectorAll('button, .chip-delete').forEach(b => b.remove());

  const printWin = window.open('', '_blank');
  if (!printWin) { showToast('Please allow popups to print'); return; }

  const bizName = document.getElementById('biz-name')?.value || 'The Mane Frame';
  const printDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  printWin.document.write(`<!DOCTYPE html>
<html><head><title>${bizName} Report</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #222; max-width: 700px; margin: 0 auto; padding: 32px 24px;
    font-size: 13px; line-height: 1.5;
  }

  /* Header */
  .print-header {
    text-align: center; border-bottom: 2px solid #5D3854; padding-bottom: 16px; margin-bottom: 24px;
  }
  .print-header h1 { font-size: 22px; font-weight: 700; color: #5D3854; margin-bottom: 2px; }
  .print-header .print-date { font-size: 11px; color: #888; }

  /* Section titles */
  .report-section-title {
    font-size: 16px; font-weight: 700; color: #333; margin: 20px 0 10px; padding-bottom: 4px;
    border-bottom: 1px solid #ddd;
  }

  /* Stat grids */
  .report-stat-grid {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 12px 0 20px;
  }
  .report-stat {
    text-align: center; padding: 10px 8px; border: 1px solid #e0e0e0; border-radius: 6px;
    background: #fafafa; page-break-inside: avoid;
  }
  .report-stat-label { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: #888; font-weight: 600; margin-bottom: 2px; }
  .report-stat-value { font-size: 18px; font-weight: 700; }
  .report-stat-value.green { color: #2D7A4C; }
  .report-stat-value.gold { color: #B8860B; }
  .report-stat-value.red { color: #C13838; }
  .report-stat-value.plum { color: #5D3854; }

  /* White cards */
  .report-white-card {
    border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin: 16px 0;
    page-break-inside: avoid;
  }
  .report-white-card .report-section-title { margin-top: 0; border-bottom: none; }

  /* Row items */
  .report-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 8px 0; border-bottom: 1px solid #eee;
  }
  .report-row:last-child { border-bottom: none; }
  .report-row-label { font-size: 13px; font-weight: 500; }
  .report-row-sub { font-size: 11px; color: #888; }
  .report-row-value { font-size: 14px; font-weight: 600; }
  .report-row-value.income { color: #2D7A4C; }
  .report-row-value.expense { color: #C13838; }

  /* Comparison cards */
  .comparison-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 16px 0; }
  .comparison-card {
    text-align: center; padding: 12px; border: 1px solid #e0e0e0; border-radius: 6px;
    page-break-inside: avoid;
  }
  .comparison-label { font-size: 10px; text-transform: uppercase; color: #888; font-weight: 600; }
  .comparison-percent { font-size: 20px; font-weight: 700; }
  .comparison-amount { font-size: 12px; color: #888; }

  /* Tables (P&L etc) */
  table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  th { text-align: left; padding: 8px 6px; font-size: 11px; color: #888; font-weight: 600;
       border-bottom: 2px solid #5D3854; text-transform: uppercase; letter-spacing: .5px; }
  td { padding: 6px; font-size: 13px; border-bottom: 1px solid #eee; }
  th:not(:first-child), td:not(:first-child) { text-align: right; }

  /* Pie chart area */
  .pie-chart-wrap { text-align: center; padding: 8px; }

  /* Booth rent cards */
  [style*="border-radius:16px"], [style*="border-radius: 16px"] { border: 1px solid #e0e0e0 !important; }

  /* Utility overrides for inline styles */
  [style*="background:var("] { background: #fafafa !important; }
  [style*="color:var(--success)"] { color: #2D7A4C !important; }
  [style*="color:var(--danger)"] { color: #C13838 !important; }
  [style*="color:var(--plum)"] { color: #5D3854 !important; }
  [style*="color:var(--gold)"] { color: #B8860B !important; }
  [style*="color:var(--text-muted)"] { color: #888 !important; }
  [style*="color:var(--text)"] { color: #222 !important; }
  [style*="border-left:3px"] { border-left: 3px solid #ccc !important; }

  hr { border: none; border-top: 1px solid #ddd; margin: 8px 0; }

  @media print {
    body { padding: 16px; }
    .print-header { margin-bottom: 16px; padding-bottom: 12px; }
    .report-white-card, .report-stat, .comparison-card { break-inside: avoid; }
  }
</style>
</head><body>
  <div class="print-header">
    <h1>${bizName}</h1>
    <div class="print-date">Printed ${printDate}</div>
  </div>
  ${clone.innerHTML}
</body></html>`);
  printWin.document.close();
  setTimeout(() => { printWin.print(); }, 400);
}

function copyReportText() {
  const reportEl = document.getElementById('report-output');
  if (!reportEl || !reportEl.innerHTML.trim()) { showToast('No report to copy'); return; }

  // Extract readable text from tables and content
  const clone = reportEl.cloneNode(true);

  // Convert tables to text-friendly format
  clone.querySelectorAll('table').forEach(table => {
    let text = '';
    table.querySelectorAll('tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('td, th'));
      const line = cells.map(c => c.textContent.trim()).filter(Boolean).join('  |  ');
      if (line) text += line + '\n';
    });
    const pre = document.createElement('pre');
    pre.textContent = text;
    table.replaceWith(pre);
  });

  const textContent = clone.textContent
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  navigator.clipboard.writeText(textContent).then(() => {
    showToast('Report copied to clipboard ✓');
  }).catch(() => {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = textContent;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Report copied to clipboard ✓');
  });
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

function navigateDay(direction) {
  // direction: -1 for previous day, +1 for next day
  const currentDate = document.getElementById('r-date')?.value || state.selectedDate;
  const newDate = addDays(currentDate, direction);
  
  // Update the date input
  const dateInput = document.getElementById('r-date');
  if (dateInput) {
    dateInput.value = newDate;
  }
  
  // Update state and run report
  state.selectedDate = newDate;
  runDailyReport();
}

function navigateMonth(direction) {
  // direction: -1 for previous month, +1 for next month
  const currentMonth = parseInt(document.getElementById('r-month')?.value) || state.selectedMonth;
  const currentYear = parseInt(document.getElementById('r-year')?.value) || state.selectedYear;
  
  let newMonth = currentMonth + direction;
  let newYear = currentYear;
  
  // Handle year wrapping
  if (newMonth < 1) {
    newMonth = 12;
    newYear--;
  } else if (newMonth > 12) {
    newMonth = 1;
    newYear++;
  }
  
  // Update the inputs
  const monthSelect = document.getElementById('r-month');
  const yearInput = document.getElementById('r-year');
  if (monthSelect) monthSelect.value = newMonth;
  if (yearInput) yearInput.value = newYear;
  
  // Update state and run report
  state.selectedMonth = newMonth;
  state.selectedYear = newYear;
  runMonthlyReport();
}

async function runWeeklyReport() {
  const pickedDate = document.getElementById('r-week-date')?.value || state.selectedDate;
  const weekStart  = getWeekStart(pickedDate);
  const personalOnly = document.getElementById('r-week-personal')?.checked || false;
  
  // Categories to exclude when "Personal Only" is checked
  const employeeCategories = ['Vagaro Income', 'Chasity (Vagaro Income)', 'Employee Pay'];
  
  // Update the date picker to show the Monday (start of week)
  const dateInput = document.getElementById('r-week-date');
  if (dateInput && dateInput.value !== weekStart) {
    dateInput.value = weekStart;
  }

  let weeklyIncome = 0, weeklyTips = 0, weeklyExp = 0, weeklyClients = 0, weeklyHours = 0;
  const rows = [];

  for (let i = 0; i < 7; i++) {
    const d    = addDays(weekStart, i);
    let txns = await db.transactions.where('date').equals(d).toArray();
    
    // Filter out employee categories if personal only
    if (personalOnly) {
      txns = txns.filter(t => !employeeCategories.includes(t.category));
    }
    
    const sum  = await db.dailySummary.where('date').equals(d).first();
    const inc  = txns.filter(t=>t.type==='INCOME').reduce((s,t)=>s+(t.serviceAmount||0),0);
    const tips = txns.filter(t=>t.type==='INCOME').reduce((s,t)=>s+(t.tipAmount||0),0);
    const exp  = txns.filter(t=>t.type==='EXPENSE').reduce((s,t)=>s+(t.amount||0),0);
    const cls  = sum ? sum.clientsSeen : 0;
    const hrs  = sum ? (sum.hoursWorked || 0) : 0;
    weeklyIncome  += inc;
    weeklyTips    += tips;
    weeklyExp     += exp;
    weeklyClients += cls;
    weeklyHours   += hrs;
    if (txns.length > 0 || sum) {
      rows.push({ d, inc, tips, exp, cls, hrs, net: inc+tips-exp });
    }
  }
  
  // Calculate comparison stats
  let comparisonHTML = '';
  const isCurrentWeek = getWeekStart(todayStr()) === weekStart;
  
  if (isCurrentWeek) {
    let allTxns = await db.transactions.toArray();
    
    // Filter for personal only comparison too
    if (personalOnly) {
      allTxns = allTxns.filter(t => !employeeCategories.includes(t.category));
    }
    
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

  const personalLabel = personalOnly ? '<div style="text-align:center;font-size:12px;color:var(--plum);margin-bottom:8px;font-weight:500;">✨ Personal Performance Only</div>' : '';

  document.getElementById('report-output').innerHTML = `
    ${personalLabel}
    <div class="report-section-title">Week of ${formatDateShort(weekStart)}</div>
    <div class="report-stat-grid">
      <div class="report-stat"><div class="report-stat-label">Total Income</div><div class="report-stat-value green">${fmt(weeklyIncome)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Tips</div><div class="report-stat-value gold">${fmt(weeklyTips)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Expenses</div><div class="report-stat-value red">${fmt(weeklyExp)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Net</div><div class="report-stat-value plum">${fmt(weeklyIncome+weeklyTips-weeklyExp)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Clients</div><div class="report-stat-value">${weeklyClients}</div></div>
      <div class="report-stat"><div class="report-stat-label">Hours</div><div class="report-stat-value">${weeklyHours}</div></div>
      <div class="report-stat"><div class="report-stat-label">Avg/Client</div><div class="report-stat-value">${weeklyClients>0?fmt((weeklyIncome+weeklyTips)/weeklyClients):'—'}</div></div>
      <div class="report-stat"><div class="report-stat-label">$/Hour</div><div class="report-stat-value">${weeklyHours>0?fmt((weeklyIncome+weeklyTips)/weeklyHours):'—'}</div></div>
    </div>
    ${comparisonHTML}
    ${rows.length > 0 ? `
    <div class="report-white-card">
      <div class="report-section-title">Daily Breakdown</div>
      ${rows.map(r=>`
        <div class="report-row">
          <div>
            <div class="report-row-label">${formatDateShort(r.d)}</div>
            <div class="report-row-sub">${r.cls} clients · ${r.hrs}h</div>
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
  const personalOnly = document.getElementById('r-month-personal')?.checked || false;
  
  // Categories to exclude when "Personal Only" is checked
  const employeeCategories = ['Vagaro Income', 'Chasity (Vagaro Income)', 'Employee Pay'];

  const monthStr = `${year}-${String(month).padStart(2,'0')}`;
  let allTxns  = await db.transactions.toArray();
  
  // Filter out employee categories if personal only
  if (personalOnly) {
    allTxns = allTxns.filter(t => !employeeCategories.includes(t.category));
  }
  
  const txns     = allTxns.filter(t => t.date && t.date.startsWith(monthStr));

  const sums     = await db.dailySummary.toArray();

  const income   = txns.filter(t => t.type === 'INCOME');
  let dExpense = txns.filter(t => t.type === 'EXPENSE' && !t.recurring);
  let mExps    = txns.filter(t => t.type === 'EXPENSE' && t.recurring);

  // Filter employee categories if personal only
  if (personalOnly) {
    dExpense = dExpense.filter(t => !employeeCategories.includes(t.category));
    mExps    = mExps.filter(t => !employeeCategories.includes(t.category));
  }

  const svcTotal  = income.reduce((s,t)=>s+(t.serviceAmount||0),0);
  const tipTotal  = income.reduce((s,t)=>s+(t.tipAmount||0),0);
  const dExpTotal = dExpense.reduce((s,t)=>s+(t.amount||0),0);
  const mExpTotal = mExps.reduce((s,e)=>s+(e.amount||0),0);
  const totalExp  = dExpTotal + mExpTotal;

  const allRentPmts = await db.rentPayments.toArray();
  const monthRent   = allRentPmts.filter(p => p.datePaid && p.datePaid.startsWith(monthStr));
  const rentTotal   = monthRent.reduce((s,p)=>s+(p.amount||0),0);
  const renters     = await db.renters.where('status').equals('active').toArray();
  const expectedRent = renters.reduce((s,r)=>s+getCurrentRate(r),0) * 4;

  // Net profit calculation: Services + Tips + Booth Rent (income from renters) - Expenses
  const net       = svcTotal + tipTotal + rentTotal - totalExp;
  const totalIncome = svcTotal + tipTotal + rentTotal;

  const monthSums    = sums.filter(s => s.date && s.date.startsWith(monthStr));
  const totalClients = monthSums.reduce((s,d)=>s+(d.clientsSeen||0),0);
  const totalHours   = monthSums.reduce((s,d)=>s+(d.hoursWorked||0),0);

  const personalLabel = personalOnly ? '<div style="text-align:center;font-size:12px;color:var(--plum);margin-bottom:8px;font-weight:500;">✨ Personal Performance Only</div>' : '';

  document.getElementById('report-output').innerHTML = `
    ${personalLabel}
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
          <div class="report-stat">
            <div class="report-stat-label">Avg/Client</div>
            <div class="report-stat-value">${totalClients > 0 ? fmt((svcTotal + tipTotal) / totalClients) : '—'}</div>
          </div>
          <div class="report-stat">
            <div class="report-stat-label">$/Hour</div>
            <div class="report-stat-value">${totalHours > 0 ? fmt((svcTotal + tipTotal) / totalHours) : '—'}</div>
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
      <div class="report-section-title">Recurring Monthly Expenses</div>
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
  const personalOnly = document.getElementById('r-annual-personal')?.checked || false;
  
  // Categories to exclude when "Personal Only" is checked
  const employeeCategories = ['Vagaro Income', 'Chasity (Vagaro Income)', 'Employee Pay'];

  let allTxns = await db.transactions.toArray();
  const allSums = await db.dailySummary.toArray();
  const allRentPmts = await db.rentPayments.toArray();

  // Filter out employee categories if personal only
  if (personalOnly) {
    allTxns = allTxns.filter(t => !employeeCategories.includes(t.category));
  }

  let yearIncome=0, yearTips=0, yearExp=0, yearClients=0, yearRent=0;
  const rows = [];

  for (let m = 1; m <= 12; m++) {
    const ms    = `${year}-${String(m).padStart(2,'0')}`;
    const txns  = allTxns.filter(t => t.date?.startsWith(ms));
    const inc   = txns.filter(t=>t.type==='INCOME').reduce((s,t)=>s+(t.serviceAmount||0),0);
    const tips  = txns.filter(t=>t.type==='INCOME').reduce((s,t)=>s+(t.tipAmount||0),0);
    const dExp  = txns.filter(t=>t.type==='EXPENSE' && !t.recurring).reduce((s,t)=>s+(t.amount||0),0);
    const mExp  = txns.filter(t=>t.type==='EXPENSE' && t.recurring).reduce((s,t)=>s+(t.amount||0),0);
    const rent  = allRentPmts.filter(p=>p.datePaid?.startsWith(ms)).reduce((s,p)=>s+(p.amount||0),0);
    const cls   = allSums.filter(s=>s.date?.startsWith(ms)).reduce((s,d)=>s+(d.clientsSeen||0),0);
    yearIncome  += inc;
    yearTips    += tips;
    yearExp     += dExp + mExp;
    yearClients += cls;
    yearRent    += rent;
    rows.push({ m, inc, tips, rent, dExp, mExp, cls, net: inc+tips+rent-dExp-mExp });
  }

  const personalLabel = personalOnly ? '<div style="text-align:center;font-size:12px;color:var(--plum);margin-bottom:8px;font-weight:500;">✨ Personal Performance Only</div>' : '';

  document.getElementById('report-output').innerHTML = `
    ${personalLabel}
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
    if (!e.month || !e.year) return false;
    // Build a proper date string from the year + month fields
    const monthDate = `${e.year}-${String(e.month).padStart(2,'0')}-01`;
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

// ---- Booth Rent Report ----
async function runBoothRentReport() {
  const year = parseInt(document.getElementById('r-br-year')?.value) || new Date().getFullYear();

  const allRenters  = await db.renters.toArray();
  const allPayments = await db.rentPayments.toArray();

  // Filter payments to selected year
  const yearPayments = allPayments.filter(p => p.datePaid && p.datePaid.startsWith(String(year)));

  // Build per-renter stats
  const renterStats = allRenters.map(r => {
    const pmts = yearPayments.filter(p => p.renterId === r.id);
    const totalPaid = pmts.reduce((s, p) => s + (p.amount || 0), 0);
    const onTime = pmts.filter(p => getRentStatus(p.weekStart, p.datePaid) === 'ontime').length;
    const late   = pmts.filter(p => getRentStatus(p.weekStart, p.datePaid) === 'late').length;
    const total  = pmts.length;
    const onTimePct = total > 0 ? Math.round((onTime / total) * 100) : 0;

    // Monthly breakdown
    const months = {};
    for (let m = 1; m <= 12; m++) {
      const ms = `${year}-${String(m).padStart(2, '0')}`;
      const mPmts = pmts.filter(p => p.datePaid.startsWith(ms));
      months[m] = {
        paid: mPmts.reduce((s, p) => s + (p.amount || 0), 0),
        count: mPmts.length,
        onTime: mPmts.filter(p => getRentStatus(p.weekStart, p.datePaid) === 'ontime').length,
        late: mPmts.filter(p => getRentStatus(p.weekStart, p.datePaid) === 'late').length,
      };
    }

    // Average days to pay (from week start Monday to datePaid)
    let totalDays = 0;
    pmts.forEach(p => {
      const ws = new Date(p.weekStart + 'T12:00:00');
      const pd = new Date(p.datePaid + 'T12:00:00');
      totalDays += Math.round((pd - ws) / 86400000);
    });
    const avgDaysToPay = total > 0 ? (totalDays / total).toFixed(1) : '—';

    // Longest on-time streak
    const sorted = [...pmts].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    let maxStreak = 0, curStreak = 0, currentStreak = 0;
    sorted.forEach((p, i) => {
      if (getRentStatus(p.weekStart, p.datePaid) === 'ontime') {
        curStreak++;
        if (curStreak > maxStreak) maxStreak = curStreak;
        if (i === sorted.length - 1) currentStreak = curStreak;
      } else {
        curStreak = 0;
        if (i === sorted.length - 1) currentStreak = 0;
      }
    });

    // Expected weeks: count rent weeks from Jan 1 (or renter start if later) to today (or Dec 31 if past year)
    // A renter owes rent for every week where the Saturday due date falls in the range.
    // If startDate is clearly wrong (after first payment), use the earlier date.
    const firstPaymentDate = pmts.length > 0
      ? pmts.reduce((earliest, p) => (!earliest || p.weekStart < earliest) ? p.weekStart : earliest, null)
      : null;
    const rStart = r.startDate || `${year}-01-01`;
    // Use whichever is earlier: startDate or first payment week — covers renters added late to the app
    const effectiveStart = firstPaymentDate && firstPaymentDate < rStart ? firstPaymentDate : rStart;
    const rangeStart = effectiveStart > `${year}-01-01` ? effectiveStart : `${year}-01-01`;
    const currentWS = getWeekStart(todayStr());
    const lastCompletedWS = addDays(currentWS, -7);
    const rangeEnd = `${year}-12-31` < lastCompletedWS ? `${year}-12-31` : lastCompletedWS;
    let expectedWeeks = 0;
    let cursor = getWeekStart(rangeStart);
    while (cursor <= rangeEnd) {
      expectedWeeks++;
      cursor = addDays(cursor, 7);
    }
    const expectedAmt = (() => {
      let total = 0;
      let cursor = getWeekStart(rangeStart);
      while (cursor <= rangeEnd) {
        total += getRateForWeek(r, cursor);
        cursor = addDays(cursor, 7);
      }
      return total;
    })();
    const outstanding = Math.max(0, expectedAmt - totalPaid);
    const overpaid = Math.max(0, totalPaid - expectedAmt);

    return {
      id: r.id, name: r.name, booth: r.booth, rate: getCurrentRate(r),
      status: r.status, startDate: r.startDate,
      totalPaid, onTime, late, total, onTimePct, months,
      avgDaysToPay, maxStreak, currentStreak,
      expectedWeeks, expectedAmt, outstanding, overpaid,
    };
  });

  // Grand totals
  const grandPaid     = renterStats.reduce((s, r) => s + r.totalPaid, 0);
  const grandExpected = renterStats.reduce((s, r) => s + r.expectedAmt, 0);
  const grandOutstanding = renterStats.reduce((s, r) => s + r.outstanding, 0);
  const grandOnTime   = renterStats.reduce((s, r) => s + r.onTime, 0);
  const grandLate     = renterStats.reduce((s, r) => s + r.late, 0);
  const grandTotal    = renterStats.reduce((s, r) => s + r.total, 0);
  const grandOnTimePct = grandTotal > 0 ? Math.round((grandOnTime / grandTotal) * 100) : 0;

  // Month short names for table headers
  const mShort = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Determine which months have data (for compact table)
  const activeMo = [];
  for (let m = 1; m <= 12; m++) {
    if (renterStats.some(r => r.months[m].count > 0)) activeMo.push(m);
  }
  if (activeMo.length === 0) activeMo.push(new Date().getMonth() + 1);

  const el = document.getElementById('report-output');
  el.innerHTML = `
    <div class="report-section-title">${year} Booth Rent Summary</div>

    <div class="report-stat-grid">
      <div class="report-stat"><div class="report-stat-label">Expected YTD</div><div class="report-stat-value">${fmt(grandExpected)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Collected</div><div class="report-stat-value green">${fmt(grandPaid)}</div></div>
      <div class="report-stat"><div class="report-stat-label">${grandOutstanding > 0 ? 'Outstanding' : 'All Collected'}</div><div class="report-stat-value ${grandOutstanding > 0 ? 'red' : 'green'}">${grandOutstanding > 0 ? fmt(grandOutstanding) : '✓'}</div></div>
      <div class="report-stat"><div class="report-stat-label">On Time</div><div class="report-stat-value green">${grandOnTime} of ${grandTotal}</div></div>
      <div class="report-stat"><div class="report-stat-label">Late</div><div class="report-stat-value ${grandLate > 0 ? 'red' : 'green'}">${grandLate}</div></div>
      <div class="report-stat"><div class="report-stat-label">On-Time Rate</div><div class="report-stat-value ${grandOnTimePct >= 90 ? 'green' : grandOnTimePct >= 75 ? 'gold' : 'red'}">${grandOnTimePct}%</div></div>
    </div>

    ${renterStats.filter(r => r.total > 0 || r.status === 'active').map(r => `
      <div class="report-white-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <div>
            <div class="report-section-title" style="margin-bottom:2px;">${r.name}${r.booth ? ` <span style="font-weight:400;color:var(--text-muted);font-size:12px;">Booth ${r.booth}</span>` : ''}</div>
            <div style="font-size:12px;color:var(--text-muted);">${fmt(r.rate)}/week · ${r.status === 'active' ? '🟢 Active' : '⚪ Inactive'}${r.startDate ? ` · Since ${formatDateDisplay(r.startDate)}` : ''}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:20px;font-weight:700;color:var(--success);">${fmt(r.totalPaid)}</div>
            <div style="font-size:11px;color:var(--text-muted);">of ${fmt(r.expectedAmt)} expected</div>
            ${r.outstanding > 0 ? `<div style="font-size:12px;font-weight:600;color:var(--danger);">Outstanding: ${fmt(r.outstanding)}</div>` : ''}
            ${r.overpaid > 0 ? `<div style="font-size:12px;font-weight:600;color:var(--success);">Ahead: +${fmt(r.overpaid)}</div>` : ''}
          </div>
        </div>

        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">
          <div style="flex:1;min-width:70px;background:var(--bg-input);border-radius:8px;padding:8px;text-align:center;">
            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;">On-Time</div>
            <div style="font-size:16px;font-weight:700;color:${r.onTimePct >= 90 ? 'var(--success)' : r.onTimePct >= 75 ? 'var(--gold)' : 'var(--danger)'};">${r.onTimePct}%</div>
            <div style="font-size:10px;color:var(--text-muted);">${r.onTime} of ${r.total}</div>
          </div>
          <div style="flex:1;min-width:70px;background:var(--bg-input);border-radius:8px;padding:8px;text-align:center;">
            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;">Late</div>
            <div style="font-size:16px;font-weight:700;color:${r.late > 0 ? 'var(--danger)' : 'var(--success)'};">${r.late}</div>
            <div style="font-size:10px;color:var(--text-muted);">payment${r.late !== 1 ? 's' : ''}</div>
          </div>
          <div style="flex:1;min-width:70px;background:var(--bg-input);border-radius:8px;padding:8px;text-align:center;">
            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;">Avg Days</div>
            <div style="font-size:16px;font-weight:700;">${r.avgDaysToPay}</div>
            <div style="font-size:10px;color:var(--text-muted);">to pay</div>
          </div>
          <div style="flex:1;min-width:70px;background:var(--bg-input);border-radius:8px;padding:8px;text-align:center;">
            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;">Balance</div>
            <div style="font-size:16px;font-weight:700;color:${r.outstanding > 0 ? 'var(--danger)' : 'var(--success)'};">${r.outstanding > 0 ? fmt(r.outstanding) : '✓'}</div>
            <div style="font-size:10px;color:var(--text-muted);">${r.outstanding > 0 ? 'outstanding' : 'current'}</div>
          </div>
          <div style="flex:1;min-width:70px;background:var(--bg-input);border-radius:8px;padding:8px;text-align:center;">
            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;">Streak</div>
            <div style="font-size:16px;font-weight:700;color:var(--success);">${r.currentStreak}</div>
            <div style="font-size:10px;color:var(--text-muted);">current on-time</div>
          </div>
        </div>

        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead>
              <tr style="border-bottom:2px solid var(--plum);">
                <th style="text-align:left;padding:6px 4px;color:var(--text-muted);font-size:10px;text-transform:uppercase;">Month</th>
                ${activeMo.map(m => `<th style="text-align:center;padding:6px 4px;color:var(--text-muted);font-size:10px;">${mShort[m]}</th>`).join('')}
                <th style="text-align:right;padding:6px 4px;color:var(--text-muted);font-size:10px;text-transform:uppercase;">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style="padding:6px 4px;font-weight:500;">Paid</td>
                ${activeMo.map(m => {
                  const md = r.months[m];
                  return `<td style="text-align:center;padding:6px 4px;color:${md.paid > 0 ? 'var(--success)' : 'var(--text-muted)'};">${md.paid > 0 ? fmt(md.paid) : '—'}</td>`;
                }).join('')}
                <td style="text-align:right;padding:6px 4px;font-weight:700;color:var(--success);">${fmt(r.totalPaid)}</td>
              </tr>
              <tr style="border-top:1px solid var(--bg-input);">
                <td style="padding:6px 4px;font-weight:500;">Weeks</td>
                ${activeMo.map(m => {
                  const md = r.months[m];
                  return `<td style="text-align:center;padding:6px 4px;">${md.count > 0 ? md.count : '—'}</td>`;
                }).join('')}
                <td style="text-align:right;padding:6px 4px;font-weight:700;">${r.total}</td>
              </tr>
              <tr style="border-top:1px solid var(--bg-input);">
                <td style="padding:6px 4px;font-weight:500;">On Time</td>
                ${activeMo.map(m => {
                  const md = r.months[m];
                  if (md.count === 0) return '<td style="text-align:center;padding:6px 4px;color:var(--text-muted);">—</td>';
                  const pct = Math.round((md.onTime / md.count) * 100);
                  return `<td style="text-align:center;padding:6px 4px;color:${pct >= 90 ? 'var(--success)' : pct >= 75 ? 'var(--gold)' : 'var(--danger)'};">${pct}%</td>`;
                }).join('')}
                <td style="text-align:right;padding:6px 4px;font-weight:700;color:${r.onTimePct >= 90 ? 'var(--success)' : 'var(--danger)'};">${r.onTimePct}%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `).join('')}

    ${renterStats.filter(r => r.total > 0 || r.status === 'active').length === 0 ? `
      <p style="color:var(--text-muted);text-align:center;padding:30px 0;">No booth rent data for ${year}.</p>
    ` : ''}
  `;
}

// ---- P&L REPORT ----
async function runPnlReport() {
  const el = document.getElementById('report-output');
  if (!el) return;

  const period = document.getElementById('r-pnl-period')?.value || 'monthly';
  const year   = parseInt(document.getElementById('r-pnl-year')?.value) || new Date().getFullYear();
  const month  = parseInt(document.getElementById('r-pnl-month')?.value) || new Date().getMonth() + 1;
  const pad = n => String(n).padStart(2,'0');

  // Compute period date range
  let pStart, pEnd, pLabel;
  switch (period) {
    case 'q1': pStart=`${year}-01-01`; pEnd=`${year}-03-31`; pLabel=`Q1 ${year}`; break;
    case 'q2': pStart=`${year}-04-01`; pEnd=`${year}-06-30`; pLabel=`Q2 ${year}`; break;
    case 'q3': pStart=`${year}-07-01`; pEnd=`${year}-09-30`; pLabel=`Q3 ${year}`; break;
    case 'q4': pStart=`${year}-10-01`; pEnd=`${year}-12-31`; pLabel=`Q4 ${year}`; break;
    case 'ytd': pStart=`${year}-01-01`; pEnd=todayStr(); pLabel=`YTD ${year}`; break;
    case 'range': {
      pStart = document.getElementById('r-pnl-from')?.value;
      pEnd   = document.getElementById('r-pnl-to')?.value;
      if (!pStart || !pEnd) { el.innerHTML='<p style="color:var(--text-muted);padding:20px;">Select a date range above.</p>'; return; }
      pLabel = `${pStart} — ${pEnd}`;
      break;
    }
    default: {
      const ms = `${year}-${pad(month)}`;
      pStart=`${ms}-01`; pEnd=`${ms}-31`; pLabel=`${monthName(month)} ${year}`;
    }
  }
  const showYtd = period !== 'ytd';
  const ytdEnd  = todayStr();
  const cols = showYtd ? 5 : 3;

  const [allTxns, allRentPmts] = await Promise.all([
    db.transactions.toArray(),
    db.rentPayments.toArray()
  ]);

  const directCats = state.directCostCategories || [];
  const isDirect = cat => directCats.includes(cat);

  const periodTxns = allTxns.filter(t => t.date >= pStart && t.date <= pEnd);
  const ytdTxns    = allTxns.filter(t => t.date >= `${year}-01-01` && t.date <= ytdEnd);

  const mExpInRange = (s, e) => allTxns.filter(t => t.type === 'EXPENSE' && t.recurring && t.date >= s && t.date <= e);
  const periodMExp = mExpInRange(pStart, pEnd);
  const ytdMExp    = mExpInRange(`${year}-01-01`, ytdEnd);

  // Revenue
  const revenueLines = {};
  const addRev = (txns, col) => txns.filter(t => t.type === 'INCOME').forEach(t => {
    const key = t.category || 'Other';
    if (!revenueLines[key]) revenueLines[key] = { p: 0, ytd: 0 };
    revenueLines[key][col] += (t.serviceAmount || 0);
  });
  addRev(periodTxns, 'p'); addRev(ytdTxns, 'ytd');

  const pTips   = periodTxns.filter(t => t.type==='INCOME').reduce((s,t) => s+(t.tipAmount||0), 0);
  const ytdTips = ytdTxns.filter(t => t.type==='INCOME').reduce((s,t) => s+(t.tipAmount||0), 0);
  const pRent   = allRentPmts.filter(p => p.datePaid >= pStart && p.datePaid <= pEnd).reduce((s,p) => s+(p.amount||0), 0);
  const ytdRent = allRentPmts.filter(p => p.datePaid >= `${year}-01-01` && p.datePaid <= ytdEnd).reduce((s,p) => s+(p.amount||0), 0);

  const pServiceTotal   = Object.values(revenueLines).reduce((s,r) => s+r.p, 0);
  const ytdServiceTotal = Object.values(revenueLines).reduce((s,r) => s+r.ytd, 0);
  const pGross   = pServiceTotal + pTips + pRent;
  const ytdGross = ytdServiceTotal + ytdTips + ytdRent;

  // Expenses
  const directLines = {}, overheadLines = {};
  const addExp = (txns, mexp, col) => {
    txns.filter(t => t.type === 'EXPENSE').forEach(t => {
      const cat = t.category || 'Other';
      const b = isDirect(cat) ? directLines : overheadLines;
      if (!b[cat]) b[cat] = { p: 0, ytd: 0 };
      b[cat][col] += (t.amount || 0);
    });
    mexp.forEach(e => {
      const cat = e.category || 'Other';
      const b = isDirect(cat) ? directLines : overheadLines;
      if (!b[cat]) b[cat] = { p: 0, ytd: 0 };
      b[cat][col] += (e.amount || 0);
    });
  };
  addExp(periodTxns, [], 'p');
  addExp(ytdTxns,   [], 'ytd');

  const pDirect   = Object.values(directLines).reduce((s,r) => s+r.p, 0);
  const ytdDirect = Object.values(directLines).reduce((s,r) => s+r.ytd, 0);
  const pOverhead   = Object.values(overheadLines).reduce((s,r) => s+r.p, 0);
  const ytdOverhead = Object.values(overheadLines).reduce((s,r) => s+r.ytd, 0);
  const pNet   = pGross - pDirect - pOverhead;
  const ytdNet = ytdGross - ytdDirect - ytdOverhead;
  const pGrossProfit   = pGross - pDirect;
  const ytdGrossProfit = ytdGross - ytdDirect;

  const pctOf = (val, total) => total > 0 ? `${((val/total)*100).toFixed(1)}%` : '—';
  const ytdCells = (val, base) => showYtd
    ? `<td style="padding:6px 4px;text-align:right;font-size:13px;">${fmt(val)}</td><td style="padding:6px 4px;text-align:right;font-size:11px;color:var(--text-muted);">${pctOf(val,base)}</td>`
    : '';

  const row = (label, pVal, yVal) => `
    <tr style="border-bottom:1px solid var(--border-light);">
      <td style="padding:6px 0;font-size:13px;padding-left:12px;">${label}</td>
      <td style="padding:6px 4px;text-align:right;font-size:13px;">${fmt(pVal)}</td>
      <td style="padding:6px 4px;text-align:right;font-size:11px;color:var(--text-muted);">${pctOf(pVal,pGross)}</td>
      ${ytdCells(yVal, ytdGross)}
    </tr>`;

  const dividerRow = `<tr><td colspan="${cols}" style="padding:0;"><hr style="border:none;border-top:2px solid var(--border-light);margin:4px 0;"></td></tr>`;

  const subtotalRow = (label, pVal, yVal, color) => `
    <tr style="font-weight:700;${color?'color:'+color+';':''}">
      <td style="padding:8px 0;font-size:14px;">${label}</td>
      <td style="padding:8px 4px;text-align:right;font-size:14px;">${fmt(pVal)}</td>
      <td style="padding:8px 4px;text-align:right;font-size:12px;color:var(--text-muted);">${pctOf(pVal,pGross)}</td>
      ${showYtd ? `<td style="padding:8px 4px;text-align:right;font-size:14px;">${fmt(yVal)}</td><td style="padding:8px 4px;text-align:right;font-size:12px;color:var(--text-muted);">${pctOf(yVal,ytdGross)}</td>` : ''}
    </tr>`;

  const sortedRevenue  = Object.entries(revenueLines).sort((a,b) => b[1].p - a[1].p);
  const sortedDirect   = Object.entries(directLines).sort((a,b) => b[1].p - a[1].p);
  const sortedOverhead = Object.entries(overheadLines).sort((a,b) => b[1].p - a[1].p);

  el.innerHTML = `
    <div class="report-section-title">${pLabel} — Profit & Loss</div>
    <div style="overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;margin-top:8px;">
      <thead>
        <tr style="border-bottom:2px solid var(--plum);">
          <th style="text-align:left;padding:8px 0;font-size:12px;color:var(--text-muted);font-weight:600;"></th>
          <th style="text-align:right;padding:8px 4px;font-size:12px;color:var(--text-muted);font-weight:600;">${pLabel}</th>
          <th style="text-align:right;padding:8px 4px;font-size:11px;color:var(--text-muted);font-weight:600;">%</th>
          ${showYtd ? `<th style="text-align:right;padding:8px 4px;font-size:12px;color:var(--text-muted);font-weight:600;">YTD</th><th style="text-align:right;padding:8px 4px;font-size:11px;color:var(--text-muted);font-weight:600;">%</th>` : ''}
        </tr>
      </thead>
      <tbody>
        <tr><td colspan="${cols}" style="padding:10px 0 4px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--plum);">Revenue</td></tr>
        ${sortedRevenue.map(([cat,v]) => row(cat, v.p, v.ytd)).join('')}
        ${pTips > 0 || ytdTips > 0 ? row('Tips', pTips, ytdTips) : ''}
        ${pRent > 0 || ytdRent > 0 ? row('Booth Rent Collected', pRent, ytdRent) : ''}
        ${dividerRow}
        ${subtotalRow('Total Revenue', pGross, ytdGross, 'var(--success)')}

        <tr><td colspan="${cols}" style="padding:14px 0 4px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--danger);">Cost of Goods / Direct Costs</td></tr>
        ${sortedDirect.length > 0 ? sortedDirect.map(([cat,v]) => row(cat, v.p, v.ytd)).join('') : `<tr><td colspan="${cols}" style="padding:6px 12px;font-size:13px;color:var(--text-muted);font-style:italic;">None this period</td></tr>`}
        ${dividerRow}
        ${subtotalRow('Total Direct Costs', pDirect, ytdDirect, 'var(--danger)')}
        ${subtotalRow('Gross Profit', pGrossProfit, ytdGrossProfit, pGrossProfit>=0?'var(--success)':'var(--danger)')}

        <tr><td colspan="${cols}" style="padding:14px 0 4px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--gold);">Operating Expenses</td></tr>
        ${sortedOverhead.length > 0 ? sortedOverhead.map(([cat,v]) => row(cat, v.p, v.ytd)).join('') : `<tr><td colspan="${cols}" style="padding:6px 12px;font-size:13px;color:var(--text-muted);font-style:italic;">None this period</td></tr>`}
        ${dividerRow}
        ${subtotalRow('Total Operating Expenses', pOverhead, ytdOverhead, 'var(--danger)')}

        <tr><td colspan="${cols}" style="padding:0;"><hr style="border:none;border-top:3px double var(--plum);margin:8px 0;"></td></tr>
        <tr style="font-weight:800;font-size:16px;">
          <td style="padding:10px 0;color:var(--text);">Net Income</td>
          <td style="padding:10px 4px;text-align:right;color:${pNet>=0?'var(--success)':'var(--danger)'};">${fmt(pNet)}</td>
          <td style="padding:10px 4px;text-align:right;font-size:13px;color:var(--text-muted);">${pctOf(pNet,pGross)}</td>
          ${showYtd ? `<td style="padding:10px 4px;text-align:right;color:${ytdNet>=0?'var(--success)':'var(--danger)'};">${fmt(ytdNet)}</td><td style="padding:10px 4px;text-align:right;font-size:13px;color:var(--text-muted);">${pctOf(ytdNet,ytdGross)}</td>` : ''}
        </tr>
      </tbody>
    </table>
    </div>

    <div style="margin-top:20px;padding:16px;background:var(--bg-input);border-radius:12px;">
      <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Key Metrics — ${pLabel}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <div style="font-size:11px;color:var(--text-muted);">Gross Margin</div>
          <div style="font-size:18px;font-weight:700;color:${pGrossProfit/pGross>=0.7?'var(--success)':'var(--gold)'};">${pctOf(pGrossProfit,pGross)}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted);">Net Margin</div>
          <div style="font-size:18px;font-weight:700;color:${pNet>=0?'var(--success)':'var(--danger)'};">${pctOf(pNet,pGross)}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted);">Services Revenue</div>
          <div style="font-size:18px;font-weight:700;color:var(--plum);">${pctOf(pServiceTotal+pTips,pGross)}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted);">Booth Rent Revenue</div>
          <div style="font-size:18px;font-weight:700;color:var(--plum);">${pctOf(pRent,pGross)}</div>
        </div>
      </div>
    </div>

    <div style="margin-top:12px;font-size:11px;color:var(--text-muted);line-height:1.5;">
      Expense categories are tagged as <strong>Direct</strong> or <strong>Overhead</strong> in Settings → Expense Categories.
    </div>
  `;
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
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:1.4;">Tap <span style="background:var(--danger);color:#fff;border-radius:4px;font-size:9px;padding:1px 5px;font-weight:600;">Direct</span> / <span style="background:var(--gold);color:#fff;border-radius:4px;font-size:9px;padding:1px 5px;font-weight:600;">Overhead</span> to toggle for P&L report</div>
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

    <!-- Employee Management -->
    <div class="settings-section">
      <div class="settings-label">Employees</div>
      <div class="card" style="margin-bottom: 8px;">
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:1.4;">Employees for payroll tracking. Use with "Employee Pay" expense entries.</div>
        <div id="employee-list"></div>
        <div class="add-category-row">
          <input type="text" class="add-category-input" id="new-employee" placeholder="Add employee name…">
          <button class="btn-add-chip" onclick="addEmployee()">+ Add</button>
        </div>
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
        <button class="btn-secondary" style="width:100%;margin-top:8px;background:var(--plum);color:white;" onclick="triggerImportHistoryPicker()">
          📥 Import Historical Transactions
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

  if (!document.getElementById('import-history-input')) {
    const impInp = document.createElement('input');
    impInp.type = 'file';
    impInp.id   = 'import-history-input';
    impInp.accept = '.csv';
    impInp.style.display = 'none';
    impInp.addEventListener('change', e => importHistoryCSV(e.target.files[0]));
    document.body.appendChild(impInp);
  }

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
      `<span class="category-chip">${escapeHTML(name)}
        <button class="chip-delete" onclick="deleteCategory('INCOME','${name.replace(/'/g,"\\'")}')">×</button>
      </span>`
    ).join('');
  }
  
  // Unified expense categories - sorted alphabetically
  const expenseEl = document.getElementById('all-exp-cats');
  if (expenseEl) {
    const sortedExpenses = [...(state.categories.EXPENSE || [])].sort();
    const directCats = state.directCostCategories || [];
    
    expenseEl.innerHTML = sortedExpenses.map(name => {
      const isDirect = directCats.includes(name);
      const tagColor = isDirect ? 'var(--danger)' : 'var(--gold)';
      const tagLabel = isDirect ? 'Direct' : 'Overhead';
      const escapedName = name.replace(/'/g, "\\'");
      return `<span class="category-chip" style="display:inline-flex;align-items:center;gap:4px;">${escapeHTML(name)}
        <button onclick="toggleExpenseType('${escapedName}')" style="background:${tagColor};color:#fff;border:none;border-radius:4px;font-size:9px;padding:1px 5px;cursor:pointer;font-weight:600;" title="Click to toggle">${tagLabel}</button>
        <button class="chip-delete" onclick="deleteCategory('EXPENSE','${escapedName}')">×</button>
      </span>`;
    }).join('');
  }
  
  // Employee list
  const employeeEl = document.getElementById('employee-list');
  if (employeeEl) {
    const sortedEmployees = [...(state.employees || ['Chasity McGill'])].sort();
    employeeEl.innerHTML = sortedEmployees.map(name => {
      const escapedName = name.replace(/'/g, "\\'");
      return `<span class="category-chip" style="background:var(--plum);color:#fff;">${escapeHTML(name)}
        <button class="chip-delete" onclick="deleteEmployee('${escapedName}')" style="color:#fff;">×</button>
      </span>`;
    }).join('');
  }
}

async function addEmployee() {
  const input = document.getElementById('new-employee');
  const name = input?.value.trim();
  
  if (!name) return;
  if (state.employees.includes(name)) {
    showToast('Employee already exists');
    return;
  }
  
  state.employees.push(name);
  await saveEmployees();
  
  input.value = '';
  loadCategoryChips();
  showToast('Employee added ✓');
}

async function deleteEmployee(name) {
  if (!confirm(`Remove ${name} from employee list?`)) return;
  
  const idx = state.employees.indexOf(name);
  if (idx >= 0) {
    state.employees.splice(idx, 1);
    await saveEmployees();
    loadCategoryChips();
    showToast('Employee removed');
  }
}

async function loadDirectCostCategories() {
  const doc = await db.settings.get('directCostCategories');
  if (doc && doc.value) {
    try {
      state.directCostCategories = JSON.parse(doc.value);
    } catch(e) {
      state.directCostCategories = [];
    }
  } else {
    // Auto-guess defaults on first run
    const keywords = ['supplies', 'products', 'tools', 'equipment'];
    const allExp = state.categories.EXPENSE || [];
    state.directCostCategories = allExp.filter(cat => keywords.some(k => cat.toLowerCase().includes(k)));
    await db.settings.put({ key: 'directCostCategories', value: JSON.stringify(state.directCostCategories) });
  }
}

async function toggleExpenseType(name) {
  if (!state.directCostCategories) state.directCostCategories = [];
  const idx = state.directCostCategories.indexOf(name);
  if (idx >= 0) {
    state.directCostCategories.splice(idx, 1);
  } else {
    state.directCostCategories.push(name);
  }
  await db.settings.put({ key: 'directCostCategories', value: JSON.stringify(state.directCostCategories) });
  loadCategoryChips();
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
      
          
      // Give renderEntriesView a moment to complete
      // (navigate is sync but calls async renderEntriesView)
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

// Rate history helpers
// rateHistory is an array of { rate, effectiveDate } sorted by effectiveDate asc
// Falls back to r.weeklyRate if no rateHistory exists (backward compat)
function getRateForWeek(r, weekStart) {
  const hist = r.rateHistory;
  if (!hist || hist.length === 0) return r.weeklyRate || 0;
  // Find the most recent rate effective on or before weekStart
  let rate = hist[0].rate; // default to earliest rate
  for (const entry of hist) {
    if (entry.effectiveDate <= weekStart) {
      rate = entry.rate;
    } else {
      break;
    }
  }
  return rate;
}

function getCurrentRate(r) {
  return getRateForWeek(r, todayStr());
}

function sortRateHistory(hist) {
  return (hist || []).slice().sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}

// Migrate a renter's flat weeklyRate to rateHistory format if needed
function ensureRateHistory(r) {
  if (!r.rateHistory || r.rateHistory.length === 0) {
    r.rateHistory = [{ rate: r.weeklyRate || 0, effectiveDate: r.startDate || '2024-01-01' }];
  }
  r.rateHistory = sortRateHistory(r.rateHistory);
  // Keep weeklyRate in sync with current rate for backward compat
  r.weeklyRate = getCurrentRate(r);
  return r;
}

function formatWeekRange(ws) {
  const end = addDays(ws, 6);
  const s   = new Date(ws  + 'T12:00:00');
  const e   = new Date(end + 'T12:00:00');
  const opts = { month: 'short', day: 'numeric' };
  return s.toLocaleDateString('en-US', opts) + ' – ' + e.toLocaleDateString('en-US', opts);
}

function getRentStatus(weekStart, datePaid) {
  if (!datePaid) return 'unpaid';
  // Due date is Saturday, but "on time" includes 3-day grace period (through Tuesday)
  const due  = new Date(getWeekDue(weekStart) + 'T23:59:59');
  due.setDate(due.getDate() + 3); // Add 3 day grace period
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
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0=Sun, 6=Sat
    const currentWS = getWeekStart(todayStr());
    // Default to previous week unless it's Saturday (rent due day) or Sunday
    if (dayOfWeek === 6 || dayOfWeek === 0) {
      state.rentersWeekStart = currentWS;
    } else {
      state.rentersWeekStart = prevWeekStart(currentWS);
    }
  }

  const ws       = state.rentersWeekStart;
  const weekDue  = getWeekDue(ws);
  const renters  = await db.renters.where('status').equals('active').toArray();
  const payments = await db.rentPayments.where('weekStart').equals(ws).toArray();

  const payMap = {};
  payments.forEach(p => { payMap[p.renterId] = p; });

  const expectedTotal  = renters.reduce((s, r) => s + getRateForWeek(r, state.renterWeekStart), 0);
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
              <div class="renter-name">${escapeHTML(r.name)}${r.booth ? ` <span class="renter-booth">Booth ${escapeHTML(r.booth)}</span>` : ''}</div>
              <div class="renter-meta">
                ${p
                  ? `Paid ${formatDateDisplay(p.datePaid)} · ${escapeHTML(p.paymentMethod)} · <span class="${statusClass}">${statusLabel}</span>`
                  : `<span class="${statusClass}">Not yet paid</span> · Due ${fmt(getRateForWeek(r, state.renterWeekStart))}`}
              </div>
              ${p && p.notes && p.notes.includes('catch-up') ? `<div style="font-size:10px;color:var(--plum);margin-top:2px;">↳ ${escapeHTML(p.notes)}</div>` : ''}
            </div>
            <div class="renter-amount">
              <div style="font-weight:700;color:${p ? 'var(--success)' : 'var(--text-muted)'}">${p ? fmt(p.amount) : fmt(getRateForWeek(r, state.renterWeekStart))}</div>
              ${!p ? `<button class="renter-pay-btn" onclick="event.stopPropagation();openLogPaymentModal('${r.id}')">Log Payment</button>`
                   : `<button class="renter-pay-btn" style="background:var(--bg-card);color:var(--text-muted);font-size:10px;padding:2px 8px;" onclick="event.stopPropagation();openEditRentPayment('${p.id}','${r.id}')">Edit</button>`}
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
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:14px;">${escapeHTML(r.name)} · Week of ${formatWeekRange(state.rentersWeekStart)}</p>

      <label class="form-label">Amount Paid ($)</label>
      <input type="number" inputmode="decimal" class="form-input" id="rp-amount"
        value="${getRateForWeek(r, state.renterWeekStart) || 140}" step="0.01" min="0">

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

  const r = await db.renters.get(renterId);
  ensureRateHistory(r);
  const ws = state.rentersWeekStart;
  const weekRate = getRateForWeek(r, ws);

  // If amount is more than 1 week's rate, offer to fill missed weeks
  if (amount > weekRate * 1.01) { // small tolerance for rounding
    openCatchUpModal(renterId, amount, datePaid, method, notes);
    return;
  }

  // Normal single-week payment
  const existing = await db.rentPayments
    .where('renterId').equals(renterId)
    .filter(p => p.weekStart === ws)
    .first();

  if (existing) {
    await db.rentPayments.update(existing.id, { amount, datePaid, paymentMethod: method, notes });
  } else {
    await db.rentPayments.add({
      renterId, weekStart: ws, amount, datePaid, paymentMethod: method, notes,
    });
  }

  closeModal();
  showToast('Payment saved ✓');
  renderRentersView();
}

async function openCatchUpModal(renterId, totalAmount, datePaid, method, notes) {
  const r = await db.renters.get(renterId);
  ensureRateHistory(r);
  const allPmts = await db.rentPayments.where('renterId').equals(renterId).toArray();
  const paidWeeks = new Set(allPmts.map(p => p.weekStart));

  // Find unpaid AND underpaid weeks going back up to 16 weeks, plus current week
  const unpaidWeeks = [];
  const ws = state.rentersWeekStart;
  for (let i = 0; i < 16; i++) {
    const weekStart = addDays(ws, -(i * 7));
    // Don't go before renter's start date
    if (r.startDate && weekStart < getWeekStart(r.startDate)) break;
    const rate = getRateForWeek(r, weekStart);
    const existingPmt = allPmts.find(p => p.weekStart === weekStart);
    if (!existingPmt) {
      // Fully unpaid
      unpaidWeeks.push({ weekStart, rate, amountDue: rate, paid: 0, status: 'unpaid' });
    } else if (existingPmt.amount < rate - 0.01) {
      // Underpaid — still owes the difference
      const stillOwes = rate - existingPmt.amount;
      unpaidWeeks.push({ weekStart, rate, amountDue: stillOwes, paid: existingPmt.amount, status: 'partial' });
    }
  }

  if (unpaidWeeks.length === 0) {
    // No missed or short weeks — just log as a single payment on current week
    await db.rentPayments.add({
      renterId, weekStart: ws, amount: totalAmount, datePaid, paymentMethod: method, notes,
    });
    closeModal();
    showToast('Payment saved ✓');
    renderRentersView();
    return;
  }

  // Auto-select: current week first, then oldest unpaid/underpaid weeks
  let remaining = totalAmount;
  const selections = [];
  const currentWS = state.rentersWeekStart;
  
  // Current week first
  const currentWeekEntry = unpaidWeeks.find(w => w.weekStart === currentWS);
  if (currentWeekEntry && remaining >= currentWeekEntry.amountDue) {
    selections.push(currentWeekEntry.weekStart);
    remaining -= currentWeekEntry.amountDue;
  }
  
  // Then oldest unpaid/underpaid weeks
  const oldestFirst = [...unpaidWeeks].reverse().filter(w => w.weekStart !== currentWS);
  for (const week of oldestFirst) {
    if (remaining >= week.amountDue) {
      selections.push(week.weekStart);
      remaining -= week.amountDue;
    }
  }
  // If there's a remainder, also select the next week for partial
  if (remaining > 0.01) {
    const nextUnpaid = oldestFirst.find(w => !selections.includes(w.weekStart));
    if (nextUnpaid) selections.push(nextUnpaid.weekStart);
  }

  const weeksHTML = unpaidWeeks.map(w => {
    const checked = selections.includes(w.weekStart) ? 'checked' : '';
    const label = formatWeekRange(w.weekStart);
    const statusLabel = w.weekStart === ws ? 'Current week'
      : w.status === 'partial' ? `Partial — ${fmt(w.paid)} of ${fmt(w.rate)} paid`
      : 'Unpaid';
    const statusColor = w.status === 'partial' ? 'color:var(--plum);' : '';
    return `
      <label style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg-input, #f9f6f6);border-radius:8px;margin-bottom:6px;cursor:pointer;">
        <input type="checkbox" class="catchup-week" value="${w.weekStart}" data-rate="${w.amountDue}" data-fullrate="${w.rate}" data-status="${w.status}" ${checked}
          onchange="updateCatchUpSummary('${renterId}', ${totalAmount})"
          style="width:20px;height:20px;accent-color:var(--plum);">
        <div style="flex:1;">
          <div style="font-size:14px;font-weight:500;">${label}</div>
          <div style="font-size:12px;${statusColor}color:var(--text-muted);">${statusLabel}</div>
        </div>
        <div style="font-weight:600;font-size:14px;">${fmt(w.amountDue)}</div>
      </label>
    `;
  }).join('');

  openModal(`
    <h2 class="modal-title">Apply Catch-Up Payment</h2>
    <p style="color:var(--text-muted);font-size:13px;margin-bottom:4px;">${r.name} paid <strong>${fmt(totalAmount)}</strong></p>
    <p style="color:var(--text-muted);font-size:12px;margin-bottom:14px;">Select which weeks to apply this to:</p>

    <div id="catchup-weeks" style="margin-bottom:12px;">
      ${weeksHTML}
    </div>

    <div id="catchup-summary" style="background:rgba(93,56,84,0.06);border-radius:8px;padding:12px;margin-bottom:14px;font-size:13px;">
    </div>

    <input type="hidden" id="catchup-date" value="${datePaid}">
    <input type="hidden" id="catchup-method" value="${method}">
    <input type="hidden" id="catchup-notes" value="${notes}">

    <button class="btn-primary" style="width:100%;" onclick="saveCatchUpPayment('${renterId}', ${totalAmount})">Apply Payment</button>
  `);

  updateCatchUpSummary(renterId, totalAmount);
}

function updateCatchUpSummary(renterId, totalAmount) {
  const checks = document.querySelectorAll('.catchup-week:checked');
  let fullWeeksCost = 0;
  checks.forEach(cb => { fullWeeksCost += parseFloat(cb.dataset.rate); });

  const summaryEl = document.getElementById('catchup-summary');
  if (!summaryEl) return;

  let html = `<div style="display:flex;justify-content:space-between;margin-bottom:4px;">
    <span>Total payment:</span><strong>${fmt(totalAmount)}</strong>
  </div>
  <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
    <span>${checks.length} week${checks.length !== 1 ? 's' : ''} selected:</span><strong>${fmt(fullWeeksCost)}</strong>
  </div>`;

  if (totalAmount >= fullWeeksCost) {
    html += `<div style="color:var(--success);font-weight:600;text-align:center;">Covers all ${checks.length} weeks ✓</div>`;
  } else {
    const shortBy = fullWeeksCost - totalAmount;
    html += `<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">
      Current week paid in full, then ${fmt(totalAmount - (checks.length > 0 ? parseFloat(checks[0]?.dataset.rate || 0) : 0))} applied to oldest unpaid weeks
    </div>
    <div style="font-size:11px;color:var(--danger);margin-top:2px;">
      ${fmt(shortBy)} short of full coverage — last week gets partial payment
    </div>`;
  }

  summaryEl.innerHTML = html;
}

async function saveCatchUpPayment(renterId, totalAmount) {
  const checks = document.querySelectorAll('.catchup-week:checked');
  if (checks.length === 0) { showToast('Select at least one week'); return; }

  const datePaid = document.getElementById('catchup-date').value;
  const method = document.getElementById('catchup-method').value;
  const userNotes = document.getElementById('catchup-notes').value;

  let allocated = 0;
  const weeks = [];
  checks.forEach(cb => {
    weeks.push({
      weekStart: cb.value,
      amountDue: parseFloat(cb.dataset.rate), // This is amountDue (could be partial)
      fullRate: parseFloat(cb.dataset.fullrate || cb.dataset.rate),
      status: cb.dataset.status || 'unpaid',
    });
    allocated += parseFloat(cb.dataset.rate);
  });

  const remainder = totalAmount - allocated;

  // Allocation order: current week first, then oldest unpaid/underpaid weeks
  const currentWS = state.rentersWeekStart;
  const currentWeek = weeks.find(w => w.weekStart === currentWS);
  const otherWeeks = weeks.filter(w => w.weekStart !== currentWS).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const orderedWeeks = currentWeek ? [currentWeek, ...otherWeeks] : otherWeeks;

  // Build catch-up tag for notes
  const paidDateFmt = formatDateDisplay(datePaid);
  const catchUpTag = `${fmt(totalAmount)} catch-up paid ${paidDateFmt} (${weeks.length} wks)`;

  try {
    let remaining = totalAmount;
    for (let i = 0; i < orderedWeeks.length; i++) {
      const w = orderedWeeks[i];
      let payAmount;
      if (remaining >= w.amountDue) {
        payAmount = w.amountDue;
      } else {
        payAmount = remaining; // Partial
      }
      remaining -= payAmount;
      if (payAmount <= 0) break;

      const notesParts = [catchUpTag];
      if (userNotes) notesParts.push(userNotes);
      const finalNotes = notesParts.join(' · ');

      const existing = await db.rentPayments
        .where('renterId').equals(renterId)
        .filter(p => p.weekStart === w.weekStart)
        .first();

      if (existing) {
        // Top up existing partial payment
        const newAmount = existing.amount + payAmount;
        await db.rentPayments.update(existing.id, {
          amount: newAmount, datePaid, paymentMethod: method,
          notes: finalNotes,
        });
      } else {
        await db.rentPayments.add({
          renterId, weekStart: w.weekStart, amount: payAmount, datePaid,
          paymentMethod: method, notes: finalNotes,
        });
      }
    }

    closeModal();
    showToast(`${weeks.length} week${weeks.length > 1 ? 's' : ''} recorded ✓`);
    renderRentersView();
  } catch (err) {
    console.error('Catch-up payment error:', err);
    showToast('Error saving payments');
  }
}

async function openEditRentPayment(paymentId, renterId) {
  const p = await db.rentPayments.get(paymentId);
  if (!p) return;
  const r = await db.renters.get(renterId);
  const renterName = r ? r.name : 'Renter';

  openModal(`
    <h2 class="modal-title">Edit Rent Payment</h2>
    <p style="color:var(--text-muted);font-size:13px;margin-bottom:14px;">${renterName} · Week of ${formatWeekRange(p.weekStart)}</p>

    <label class="form-label">Amount Paid ($)</label>
    <input type="number" inputmode="decimal" class="form-input" id="erp-amount"
      value="${p.amount || 0}" step="0.01" min="0">

    <label class="form-label">Date Paid</label>
    <input type="date" class="form-input" id="erp-date" value="${p.datePaid || ''}">

    <label class="form-label">Payment Method</label>
    <select class="form-select" id="erp-method">
      ${['Cash','Venmo','Card','Check','Other'].map(m =>
        `<option${m === p.paymentMethod ? ' selected' : ''}>${m}</option>`
      ).join('')}
    </select>

    <label class="form-label">Notes (optional)</label>
    <input type="text" class="form-input" id="erp-notes" value="${p.notes || ''}" placeholder="Any notes…">

    <button class="btn-primary" style="width:100%;margin-top:8px;" onclick="updateRentPayment('${paymentId}')">Save Changes</button>
    <button class="btn-danger-sm" style="width:100%;margin-top:8px;" onclick="deleteRentPayment('${paymentId}')">Delete Payment</button>
  `);
}

async function updateRentPayment(paymentId) {
  const amount    = parseFloat(document.getElementById('erp-amount').value);
  const datePaid  = document.getElementById('erp-date').value;
  const method    = document.getElementById('erp-method').value;
  const notes     = document.getElementById('erp-notes').value.trim();

  if (!amount || !datePaid) { showToast('Please fill in amount and date'); return; }

  await db.rentPayments.update(paymentId, { amount, datePaid, paymentMethod: method, notes });
  closeModal();
  showToast('Payment updated ✓');
  renderRentersView();
}

async function deleteRentPayment(paymentId) {
  if (!confirm('Delete this rent payment?')) return;
  await db.rentPayments.delete(paymentId);
  closeModal();
  showToast('Payment deleted');
  renderRentersView();
}

function openRenterDetail(renterId, histYear) {
  db.renters.get(renterId).then(async r => {
    if (!r) return;

    const payments = await db.rentPayments.where('renterId').equals(renterId).toArray();
    const payByWeek = {};
    payments.forEach(p => { payByWeek[p.weekStart] = p; });

    ensureRateHistory(r);
    const curRate = getCurrentRate(r);

    const today = new Date();
    const curYear = today.getFullYear();
    const startYear = r.startDate ? parseInt(r.startDate.substring(0, 4)) : curYear;
    const selectedYear = histYear || curYear;

    // Generate all weeks in range
    const yearStart   = new Date(`${selectedYear}-01-01T12:00:00`);
    const yearEnd     = new Date(`${selectedYear}-12-31T23:59:59`);
    const renterStart = new Date((r.startDate || `${selectedYear}-01-01`) + 'T12:00:00');
    const rangeStart  = renterStart > yearStart ? renterStart : yearStart;
    const rangeEnd    = today < yearEnd ? today : yearEnd;

    const weeks = [];
    let d = new Date(rangeStart);
    const dow = d.getDay();
    d.setDate(d.getDate() + (dow === 0 ? 1 : dow === 1 ? 0 : 8 - dow));
    while (d <= rangeEnd) {
      weeks.push(d.toISOString().split('T')[0]);
      d = new Date(d);
      d.setDate(d.getDate() + 7);
    }
    weeks.reverse();

    // Stats
    let totalExpected = 0, totalPaid = 0, onTimeCount = 0, lateCount = 0, missedCount = 0;
    weeks.forEach(ws => {
      const rate = getRateForWeek(r, ws);
      const p = payByWeek[ws];
      totalExpected += rate;
      if (p) {
        totalPaid += p.amount;
        getRentStatus(ws, p.datePaid) === 'ontime' ? onTimeCount++ : lateCount++;
      } else { missedCount++; }
    });
    const outstanding = Math.max(0, totalExpected - totalPaid);
    const paidWeeks   = onTimeCount + lateCount;
    const onTimeRate  = paidWeeks > 0 ? Math.round((onTimeCount / paidWeeks) * 100) : 0;

    // Year filter tabs
    const yearTabs = [];
    for (let y = curYear; y >= startYear; y--) {
      const active = y === selectedYear;
      yearTabs.push(`<button onclick="openRenterDetail('${renterId}',${y})" style="padding:5px 12px;border-radius:20px;border:1px solid ${active ? 'var(--plum)' : 'var(--border-light)'};cursor:pointer;font-size:12px;font-weight:600;background:${active ? 'var(--plum)' : 'transparent'};color:${active ? '#fff' : 'var(--text-muted)'};">${y}</button>`);
    }

    // Week rows
    const rows = weeks.map(ws => {
      const rate = getRateForWeek(r, ws);
      const p    = payByWeek[ws];
      if (p) {
        const status   = getRentStatus(ws, p.datePaid);
        const isShort  = p.amount < rate * 0.99;
        const icon     = status === 'ontime' ? '✅' : '⚠️';
        const sColor   = status === 'ontime' ? 'var(--success)' : '#e07b39';
        const aColor   = isShort ? '#e07b39' : 'var(--success)';
        const shortTxt = isShort ? `<div style="font-size:10px;color:#e07b39;">short ${fmt(rate - p.amount)}</div>` : '';
        const catchUp  = p.notes && p.notes.includes('catch-up') ? `<div style="font-size:10px;color:var(--plum);">↳ ${p.notes}</div>` : '';
        return `<div class="renter-history-row" onclick="openEditRentPayment('${p.id}','${renterId}')" style="cursor:pointer;">
          <span style="font-size:16px;">${icon}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;font-weight:500;">${formatWeekRange(ws)}</div>
            <div style="font-size:11px;color:var(--text-muted);">Paid ${formatDateDisplay(p.datePaid)} · ${p.paymentMethod}</div>
            ${catchUp}
          </div>
          <div style="text-align:right;">
            <div style="font-weight:700;color:${aColor};font-size:13px;">${fmt(p.amount)}</div>
            ${shortTxt}
            <div style="font-size:10px;color:${sColor};">${status === 'ontime' ? 'On Time' : 'Late'}</div>
          </div>
          <div style="font-size:14px;color:var(--text-muted);margin-left:4px;">✎</div>
        </div>`;
      } else {
        return `<div class="renter-history-row" style="opacity:0.85;">
          <span style="font-size:16px;">❌</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;font-weight:500;">${formatWeekRange(ws)}</div>
            <div style="font-size:11px;color:var(--text-muted);">No payment recorded</div>
          </div>
          <div style="text-align:right;">
            <div style="font-weight:700;color:var(--danger);font-size:13px;">−${fmt(rate)}</div>
            <div style="font-size:10px;color:var(--danger);">Missing</div>
          </div>
        </div>`;
      }
    }).join('');

    openModal(`
      <h2 class="modal-title">${escapeHTML(r.name)}</h2>
      <div style="display:flex;gap:10px;margin-bottom:12px;font-size:13px;color:var(--text-muted);flex-wrap:wrap;">
        ${r.booth ? `<span>Booth ${escapeHTML(r.booth)}</span>` : ''}
        <span>${fmt(curRate)}/week</span>
        <span>Since ${r.startDate ? formatDateDisplay(r.startDate) : '—'}</span>
      </div>

      <div style="display:flex;gap:8px;margin-bottom:14px;">
        <button class="btn-secondary" style="flex:1;" onclick="openLogPaymentModal('${r.id}');closeModal()">+ Log Payment</button>
        <button class="btn-secondary" style="flex:1;" onclick="openEditRenterModal('${r.id}')">Edit Profile</button>
        <button class="btn-danger-sm" onclick="deactivateRenter('${r.id}')">Deactivate</button>
      </div>

      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;">${yearTabs.join('')}</div>

      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:14px;">
        <div style="background:var(--cream);border-radius:10px;padding:10px;">
          <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Expected</div>
          <div style="font-size:15px;font-weight:700;">${fmt(totalExpected)}</div>
        </div>
        <div style="background:var(--cream);border-radius:10px;padding:10px;">
          <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Collected</div>
          <div style="font-size:15px;font-weight:700;color:var(--success);">${fmt(totalPaid)}</div>
        </div>
        <div style="background:var(--cream);border-radius:10px;padding:10px;">
          <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Outstanding</div>
          <div style="font-size:15px;font-weight:700;color:${outstanding > 0 ? 'var(--danger)' : 'var(--success)'};">${outstanding > 0 ? fmt(outstanding) : '✓ All Paid'}</div>
        </div>
        <div style="background:var(--cream);border-radius:10px;padding:10px;">
          <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">On-Time Rate</div>
          <div style="font-size:15px;font-weight:700;">${onTimeRate}%</div>
        </div>
      </div>

      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:8px;">
        ${selectedYear} · ${weeks.length} weeks · ${missedCount} missing
      </div>
      ${rows || '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:16px 0;">No weeks in this period</p>'}
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
    rateHistory: [{ rate: rate || 140, effectiveDate: start || todayStr() }],
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
    ensureRateHistory(r);
    
    const rateHistoryHTML = r.rateHistory.map((entry, idx) => `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:${idx === r.rateHistory.length - 1 ? 'rgba(93,56,84,0.08)' : 'var(--bg-input, #f9f6f6)'};border-radius:8px;margin-bottom:6px;">
        <div style="flex:1;">
          <span style="font-weight:600;font-size:14px;color:var(--text);">${fmt(entry.rate)}/wk</span>
          <span style="font-size:12px;color:var(--text-muted);margin-left:8px;">starting ${formatDateDisplay(entry.effectiveDate)}</span>
          ${idx === r.rateHistory.length - 1 ? '<span style="font-size:10px;background:var(--plum);color:#fff;padding:1px 6px;border-radius:4px;margin-left:6px;">Current</span>' : ''}
        </div>
        ${r.rateHistory.length > 1 ? `<button onclick="removeRateEntry('${renterId}', ${idx})" style="background:none;border:none;color:var(--danger);font-size:18px;cursor:pointer;padding:4px;">✕</button>` : ''}
      </div>
    `).join('');

    openModal(`
      <h2 class="modal-title">Edit Renter</h2>

      <label class="form-label">Name</label>
      <input type="text" class="form-input" id="er-name" value="${r.name}">

      <label class="form-label">Booth #</label>
      <input type="text" class="form-input" id="er-booth" value="${r.booth || ''}">

      <label class="form-label" style="margin-bottom:6px;">Weekly Rate</label>
      <div id="er-rate-history">
        ${rateHistoryHTML}
      </div>
      <div id="er-add-rate-form" style="display:none;margin-bottom:8px;">
        <div style="display:flex;gap:8px;align-items:end;">
          <div style="flex:1;">
            <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:3px;">New Rate ($)</label>
            <input type="number" inputmode="decimal" class="form-input" id="er-new-rate" placeholder="0.00" step="0.01" min="0" style="padding:8px;">
          </div>
          <div style="flex:1;">
            <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:3px;">Effective Date</label>
            <input type="date" class="form-input" id="er-new-rate-date" value="${todayStr()}" style="padding:8px;">
          </div>
          <button onclick="addRateEntry('${r.id}')" style="background:var(--plum);color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;white-space:nowrap;">Add</button>
        </div>
      </div>
      <button onclick="document.getElementById('er-add-rate-form').style.display='block';this.style.display='none';" class="btn-secondary" style="width:100%;padding:8px;font-size:12px;margin-bottom:12px;" id="er-show-rate-btn">+ Add Rate Change</button>

      <label class="form-label">Start Date</label>
      <input type="date" class="form-input" id="er-start" value="${r.startDate || ''}">

      <label class="form-label">Notes</label>
      <input type="text" class="form-input" id="er-notes" value="${r.notes || ''}">

      <button class="btn-primary" style="width:100%;margin-top:8px;" onclick="saveEditRenter('${r.id}')">Save Changes</button>
    `);
  });
}

async function addRateEntry(renterId) {
  const newRate = parseFloat(document.getElementById('er-new-rate').value);
  const newDate = document.getElementById('er-new-rate-date').value;
  if (!newRate || newRate <= 0) { showToast('Enter a valid rate'); return; }
  if (!newDate) { showToast('Enter an effective date'); return; }

  const r = await db.renters.get(renterId);
  ensureRateHistory(r);
  
  // Check for duplicate date
  if (r.rateHistory.some(e => e.effectiveDate === newDate)) {
    showToast('A rate already exists for that date'); return;
  }

  r.rateHistory.push({ rate: newRate, effectiveDate: newDate });
  r.rateHistory = sortRateHistory(r.rateHistory);
  r.weeklyRate = getCurrentRate(r);

  await db.renters.update(renterId, { rateHistory: r.rateHistory, weeklyRate: r.weeklyRate });
  showToast('Rate added ✓');
  openEditRenterModal(renterId); // Refresh modal
}

async function removeRateEntry(renterId, idx) {
  const r = await db.renters.get(renterId);
  ensureRateHistory(r);
  if (r.rateHistory.length <= 1) { showToast('Must have at least one rate'); return; }
  
  r.rateHistory.splice(idx, 1);
  r.rateHistory = sortRateHistory(r.rateHistory);
  r.weeklyRate = getCurrentRate(r);

  await db.renters.update(renterId, { rateHistory: r.rateHistory, weeklyRate: r.weeklyRate });
  showToast('Rate removed');
  openEditRenterModal(renterId); // Refresh modal
}

async function saveEditRenter(renterId) {
  const name  = document.getElementById('er-name').value.trim();
  const booth = document.getElementById('er-booth').value.trim();
  const startDate = document.getElementById('er-start').value || null;
  const notes = document.getElementById('er-notes').value.trim();

  if (!name) { showToast('Name is required'); return; }

  // Rate history is managed by addRateEntry/removeRateEntry — just read current state
  const r = await db.renters.get(renterId);
  ensureRateHistory(r);
  const weeklyRate = getCurrentRate(r);

  await db.renters.update(renterId, { name, booth: booth || null, weeklyRate, startDate, notes });
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

function triggerImportHistoryPicker() {
  document.getElementById('import-history-input').value = '';
  document.getElementById('import-history-input').click();
}

// ─────────────────────────────────────────────────────────────────
// ROLLBACK HELPER — saves a full snapshot before any import
// Returns a snapshot object; pass to rollbackImport() to undo
// ─────────────────────────────────────────────────────────────────
// IMPORT SAFETY NET
//
// Three-layer protection:
//   1. snapshotBeforeImport()     — captures full pre-import state
//   2. rollbackImport(manifest)   — deletes every added record and
//                                   restores any dailySummary rows
//                                   that were bumped (not just new)
//   3. window._lastImportRollback — plain serialisable object that
//                                   survives spread/JSON so the
//                                   manual Undo button always works
//
// Firestore IDs live inside the manifest object (not as custom
// array properties) so they are never silently lost.
// ─────────────────────────────────────────────────────────────────
// IMPORT SAFETY NET
//
// db is a pure Firestore wrapper — no IndexedDB/Dexie.
// Every add() returns a Firestore string doc ID.
// Rollback deletes those specific doc IDs from Firestore.
//
// manifest (built during import, stored on window for manual undo):
// {
//   addedTxIds:       string[]  — Firestore transaction doc IDs added
//   addedSumIds:      string[]  — Firestore dailySummary doc IDs added
//   bumpedSumEntries: { id: string, previousClientsSeen: number }[]
// }
// ─────────────────────────────────────────────────────────────────

async function rollbackImport(manifest) {
  const errors = [];

  // Delete added transactions one at a time (db.delete is reliable)
  for (const id of manifest.addedTxIds) {
    try { await db.transactions.delete(id); }
    catch(e) { errors.push('tx delete ' + id + ': ' + e.message); }
  }

  // Delete added dailySummary rows
  for (const id of manifest.addedSumIds) {
    try { await db.dailySummary.delete(id); }
    catch(e) { errors.push('sum delete ' + id + ': ' + e.message); }
  }

  // Restore dailySummary rows whose clientsSeen count we bumped
  for (const entry of manifest.bumpedSumEntries) {
    try { await db.dailySummary.update(entry.id, { clientsSeen: entry.previousClientsSeen }); }
    catch(e) { errors.push('sum restore ' + entry.id + ': ' + e.message); }
  }

  if (errors.length > 0) {
    console.error('Rollback errors:', errors);
    throw new Error(errors.join('; '));
  }
}

// ─────────────────────────────────────────────────────────────────
// MAIN IMPORT FUNCTION
// ─────────────────────────────────────────────────────────────────
async function importHistoryCSV(file) {
  if (!file) return;

  const confirmed = confirm(
    '📥 Import Historical Transactions\n\n' +
    'This will ADD records to the existing database.\n\n' +
    '• Duplicate detection is ON — existing records are skipped\n' +
    '• Auto-rollback fires if anything fails mid-import\n' +
    '• Manual Undo button stays live on the success screen\n\n' +
    'Continue?'
  );
  if (!confirmed) return;

  openModal(`
    <h2 class="modal-title">📥 Importing Transactions</h2>
    <div style="text-align:center; padding:24px 16px;">
      <div style="font-size:40px; margin-bottom:12px;">⏳</div>
      <div style="font-size:15px; font-weight:600; margin-bottom:4px;" id="import-progress-text">Reading file...</div>
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:16px;" id="import-progress-sub">Please wait</div>
      <div style="width:100%; background:var(--border); border-radius:4px; height:10px; overflow:hidden;">
        <div id="import-progress-bar" style="width:0%; height:100%; background:var(--plum); transition:width 0.4s;"></div>
      </div>
    </div>
  `);

  const setProgress = (pct, msg, sub='') => {
    const bar   = document.getElementById('import-progress-bar');
    const text  = document.getElementById('import-progress-text');
    const subEl = document.getElementById('import-progress-sub');
    if (bar)   bar.style.width   = pct + '%';
    if (text)  text.textContent  = msg;
    if (subEl) subEl.textContent = sub;
  };

  // Every write goes through manifest — rollback uses these IDs surgically
  const manifest = {
    addedTxIds:       [],   // Firestore doc IDs of transactions added
    addedSumIds:      [],   // Firestore doc IDs of dailySummary rows added
    bumpedSumEntries: [],   // { id, previousClientsSeen } rows we updated
  };

  try {
    // ── Step 1: Parse CSV ──
    setProgress(8, 'Reading CSV...', file.name);
    const text    = await file.text();
    const lines   = text.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));

    const parseCSVLine = (line) => {
      const cols = [];
      let cur = '', inQ = false;
      for (const ch of line) {
        if (ch === '"') { inQ = !inQ; }
        else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
        else { cur += ch; }
      }
      cols.push(cur.trim());
      return cols;
    };

    const csvRows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      if (cols.length < 3) continue;
      const row = {};
      headers.forEach((h, idx) => { row[h] = cols[idx] || ''; });
      csvRows.push(row);
    }
    setProgress(18, `Parsed ${csvRows.length} rows`, 'Checking for duplicates...');

    // ── Step 2: Three-key deduplication against existing data ──
    // Key A: date + cents + paymentMethod  — same tx, different name
    // Key B: date + cents + clientName     — same tx, different method
    // Key C: date + paymentMethod + name   — same tx, slightly different amount
    const existing = await db.transactions.toArray();
    const normName = s => (s || '').toLowerCase().replace(/[^a-z]/g, '');

    const seenA = new Set(existing.map(t =>
      `${t.date}_${Math.round((t.serviceAmount||0)*100)}_${(t.paymentMethod||'').toLowerCase()}`
    ));
    const seenB = new Set(existing.map(t =>
      `${t.date}_${Math.round((t.serviceAmount||0)*100)}_${normName(t.notes)}`
    ));
    const seenC = new Set(existing.map(t =>
      `${t.date}_${(t.paymentMethod||'').toLowerCase()}_${normName(t.notes)}`
    ));

    let skipped = 0, needsAmount = 0;
    const toAdd = [];

    for (const row of csvRows) {
      const date          = (row.date          || '').trim();
      const category      = (row.category      || "Women's haircut").trim();
      const serviceAmount = parseFloat(row.serviceAmount) || 0;
      const tipAmount     = parseFloat(row.tipAmount)     || 0;
      const paymentMethod = (row.paymentMethod || 'Cash').trim();
      const notes         = (row.notes         || '').trim();
      const type          = (row.type          || 'INCOME').trim();

      if (!date) continue;
      if (paymentMethod.toLowerCase() === 'cash' && serviceAmount === 0) needsAmount++;

      const cents = Math.round(serviceAmount * 100);
      const pm    = paymentMethod.toLowerCase();
      const nn    = normName(notes);
      const kA    = `${date}_${cents}_${pm}`;
      const kB    = `${date}_${cents}_${nn}`;
      const kC    = `${date}_${pm}_${nn}`;

      if (seenA.has(kA) || seenB.has(kB) || seenC.has(kC)) { skipped++; continue; }

      // Register in all three sets to block intra-CSV duplication too
      seenA.add(kA); seenB.add(kB); seenC.add(kC);
      toAdd.push({ date, type, category, serviceAmount, tipAmount,
                   amount: serviceAmount, paymentMethod, notes });
    }

    setProgress(28, `${toAdd.length} new records to import`, `${skipped} duplicates skipped`);
    if (toAdd.length === 0) {
      closeModal();
      showToast(`Nothing new to import — ${skipped} duplicates found`);
      return;
    }

    // ── Step 3: Write transactions — collect each Firestore ID for rollback ──
    setProgress(35, 'Writing transactions...', `0 / ${toAdd.length}`);
    for (let i = 0; i < toAdd.length; i++) {
      const newId = await db.transactions.add(toAdd[i]);
      manifest.addedTxIds.push(newId);
      if (i % 10 === 0) {
        setProgress(
          35 + Math.round((i / toAdd.length) * 40),
          'Writing transactions...',
          `${i} / ${toAdd.length}`
        );
      }
    }
    setProgress(76, `${toAdd.length} transactions written`, 'Updating daily client counts...');

    // ── Step 4: Upsert dailySummary client counts ──
    // Count rows per date across the full CSV (including skipped dupes,
    // so the number reflects actual clients seen that day)
    const clientsPerDate = {};
    for (const row of csvRows) {
      const d = (row.date || '').trim();
      if (d) clientsPerDate[d] = (clientsPerDate[d] || 0) + 1;
    }

    for (const [date, count] of Object.entries(clientsPerDate)) {
      const existing = await db.dailySummary.where('date').equals(date).first();
      if (existing) {
        if (count > (existing.clientsSeen || 0)) {
          manifest.bumpedSumEntries.push({
            id: existing.id,
            previousClientsSeen: existing.clientsSeen || 0,
          });
          await db.dailySummary.update(existing.id, { clientsSeen: count });
        }
        // if existing count is already >= imported count, leave it alone
      } else {
        const newId = await db.dailySummary.add({ date, clientsSeen: count, hoursWorked: 0 });
        manifest.addedSumIds.push(newId);
      }
    }

    setProgress(100, 'Done!', '');
    await new Promise(r => setTimeout(r, 400));
    closeModal();

    // Store manifest as plain JSON-safe object for manual undo
    window._lastImportRollback = {
      manifest: JSON.parse(JSON.stringify(manifest)),
      count: toAdd.length,
    };

    openModal(`
      <h2 class="modal-title">✅ Import Complete</h2>
      <div style="padding:12px 0 16px; text-align:center;">
        <div style="font-size:36px; margin-bottom:10px;">🎉</div>
        <div style="font-size:22px; font-weight:700; color:var(--plum); margin-bottom:4px;">${toAdd.length}</div>
        <div style="font-size:14px; color:var(--text-muted); margin-bottom:16px;">transactions imported</div>
        <div style="display:flex; gap:10px; justify-content:center; font-size:13px; margin-bottom:20px; flex-wrap:wrap;">
          <div style="background:var(--bg-secondary); border-radius:8px; padding:10px 14px; text-align:center;">
            <div style="font-weight:700;">${skipped}</div>
            <div style="color:var(--text-muted); font-size:11px;">duplicates skipped</div>
          </div>
          <div style="background:var(--bg-secondary); border-radius:8px; padding:10px 14px; text-align:center;">
            <div style="font-weight:700;">${needsAmount}</div>
            <div style="color:var(--text-muted); font-size:11px;">cash $0 entries</div>
          </div>
          <div style="background:var(--bg-secondary); border-radius:8px; padding:10px 14px; text-align:center;">
            <div style="font-weight:700;">${Object.keys(clientsPerDate).length}</div>
            <div style="color:var(--text-muted); font-size:11px;">days updated</div>
          </div>
        </div>
      </div>
      ${needsAmount > 0 ? `
      <div style="background:#FFF8E1; border:1px solid #F9A825; border-radius:8px; padding:10px 12px; font-size:12px; color:#5D4037; margin-bottom:12px;">
        <strong>⚠️ ${needsAmount} cash entries have $0</strong> — find them on the Entries screen
        (look for "ENTER AMOUNT" in the notes) and tap each one to fill in the actual amount.
      </div>` : ''}
      <div style="background:#E8F5E9; border:1px solid #2D7A4C; border-radius:8px; padding:10px 12px; font-size:12px; color:#1B5E20; margin-bottom:16px;">
        <strong>🛡️ Full rollback available</strong> — tap "Undo Import" below to remove every
        record just added. This option disappears when you navigate away.
      </div>
      <button class="btn-submit" style="width:100%; margin-bottom:10px;"
        onclick="closeModal(); navigate('entries')">
        Go to Entries →
      </button>
      <button class="btn-secondary" style="width:100%; color:#C13838; border-color:#C13838;"
        onclick="undoLastImport()">
        ↩ Undo Import (remove all ${toAdd.length} records)
      </button>
    `);

  } catch(err) {
    console.error('Import error:', err);
    if (manifest.addedTxIds.length > 0 || manifest.addedSumIds.length > 0 ||
        manifest.bumpedSumEntries.length > 0) {
      try {
        setProgress(0, 'Import failed — rolling back...', 'Removing partial writes');
        await rollbackImport(manifest);
        closeModal();
        showToast('Import failed — all changes rolled back. Nothing was modified.');
      } catch(rbErr) {
        console.error('Rollback also encountered errors:', rbErr);
        closeModal();
        showToast('Import failed and rollback had issues — restore from your backup file.');
      }
    } else {
      closeModal();
      showToast('Import failed before any data was written: ' + err.message);
    }
  }
}

// Called from the success modal "Undo Import" button
async function undoLastImport() {
  const data = window._lastImportRollback;
  if (!data) { showToast('Nothing to undo'); return; }

  const confirmed = confirm(
    `↩ Undo Import\n\nThis will remove all ${data.count} imported transactions and restore ` +
    `any daily client counts that were changed.\n\nContinue?`
  );
  if (!confirmed) return;

  closeModal();
  showToast('Rolling back import...');

  try {
    await rollbackImport(data.manifest);
    window._lastImportRollback = null;
    showToast(`✓ Rolled back — ${data.count} records removed, all counts restored`);
    if (state.currentView === 'entries') renderEntriesView();
  } catch(err) {
    console.error('Undo error:', err);
    showToast('Undo encountered issues — check console. Some records may need manual cleanup.');
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

// Duplicate entry confirmation dialog
function confirmDuplicateEntry(message) {
  return new Promise((resolve) => {
    openModal(`
      <h2 class="modal-title" style="color:var(--gold-dark);">⚠️ Possible Duplicate</h2>
      <div style="font-size:15px;line-height:1.6;color:var(--text);margin:16px 0;">${message}</div>
      <div style="display:flex;gap:8px;margin-top:24px;">
        <button class="btn-secondary" style="flex:1;" onclick="window._dupeResolve(false)">Cancel</button>
        <button class="btn-submit" style="flex:1;" onclick="window._dupeResolve(true)">Yes, Add It</button>
      </div>
    `);
    window._dupeResolve = (result) => {
      closeModal();
      delete window._dupeResolve;
      resolve(result);
    };
  });
}

// Add swipe-down gesture to close modal
let modalTouchStart = null;
// ----------------------------------------------------------------
// AI ASK — Natural language queries
// ----------------------------------------------------------------

function injectAskButton() {
  // Remove if already exists
  if (document.getElementById('ai-ask-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'ai-ask-btn';
  btn.innerHTML = '✨';
  btn.title = 'Ask anything about your business';
  btn.style.cssText = `
    position:fixed; bottom:80px; right:16px; z-index:900;
    width:52px; height:52px; border-radius:50%; border:none;
    background:linear-gradient(135deg, #5D3854, #8B6B82); color:#fff;
    font-size:24px; cursor:pointer; box-shadow:0 4px 16px rgba(93,56,84,0.4);
    display:flex; align-items:center; justify-content:center;
    transition: transform 0.2s, box-shadow 0.2s;
  `;
  btn.onmousedown = () => { btn.style.transform = 'scale(0.92)'; };
  btn.onmouseup = () => { btn.style.transform = 'scale(1)'; };
  btn.onclick = openAskOverlay;
  document.body.appendChild(btn);
}

function openAskOverlay() {
  if (document.getElementById('ai-ask-overlay')) {
    document.getElementById('ai-ask-overlay').style.display = 'flex';
    document.getElementById('ai-ask-input')?.focus();
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = 'ai-ask-overlay';
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:1000; background:var(--bg, #f5f0f0);
    display:flex; flex-direction:column;
  `;
  overlay.innerHTML = `
    <div style="display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border-light, #e0d6d6);background:var(--bg-card, #fff);">
      <button onclick="closeAskOverlay()" style="background:none;border:none;font-size:24px;color:var(--text-muted, #999);cursor:pointer;padding:4px 12px 4px 0;">←</button>
      <div style="flex:1;font-size:17px;font-weight:700;color:var(--text, #333);">✨ Ask Mane Frame</div>
      <button onclick="exportAiChat()" id="ai-export-btn" style="background:none;border:none;font-size:20px;color:var(--text-muted, #999);cursor:pointer;padding:4px 8px;" title="Export chat">📤</button>
    </div>
    <div id="ai-chat-messages" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;">
      <div style="background:var(--bg-card, #fff);border-radius:12px;padding:14px 16px;max-width:85%;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
        <div style="font-size:14px;color:var(--text, #333);line-height:1.5;">
          Ask me anything about your business! For example:
        </div>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">
          <button class="ai-suggestion" onclick="askSuggestion(this)" style="text-align:left;background:rgba(93,56,84,0.06);border:1px solid rgba(93,56,84,0.15);border-radius:8px;padding:8px 12px;font-size:13px;color:var(--plum, #5D3854);cursor:pointer;">How did I do last month?</button>
          <button class="ai-suggestion" onclick="askSuggestion(this)" style="text-align:left;background:rgba(93,56,84,0.06);border:1px solid rgba(93,56,84,0.15);border-radius:8px;padding:8px 12px;font-size:13px;color:var(--plum, #5D3854);cursor:pointer;">Who are my top clients?</button>
          <button class="ai-suggestion" onclick="askSuggestion(this)" style="text-align:left;background:rgba(93,56,84,0.06);border:1px solid rgba(93,56,84,0.15);border-radius:8px;padding:8px 12px;font-size:13px;color:var(--plum, #5D3854);cursor:pointer;">What should I focus on to grow revenue?</button>
        </div>
      </div>
    </div>
    <div style="padding:12px 16px;border-top:1px solid var(--border-light, #e0d6d6);background:var(--bg-card, #fff);display:flex;gap:8px;">
      <input type="text" id="ai-ask-input" placeholder="Ask about your business…"
        style="flex:1;padding:12px 16px;border:1px solid var(--border, #ccc);border-radius:24px;font-size:14px;outline:none;background:var(--bg-input, #f9f6f6);"
        onkeydown="if(event.key==='Enter')sendAskQuery()">
      <button onclick="sendAskQuery()" style="background:var(--plum, #5D3854);color:#fff;border:none;border-radius:50%;width:44px;height:44px;font-size:18px;cursor:pointer;flex-shrink:0;">→</button>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('ai-ask-input')?.focus();
}

function closeAskOverlay() {
  const overlay = document.getElementById('ai-ask-overlay');
  if (overlay) overlay.remove();
  window._aiChatHistory = null;
}

function exportAiChat() {
  const history = window._aiChatHistory;
  if (!history || history.length === 0) {
    alert('No conversation to export yet. Ask a question first!');
    return;
  }

  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  let text = `Mane Frame AI Chat Export\n${date} at ${time}\n${'─'.repeat(40)}\n\n`;
  history.forEach(msg => {
    const label = msg.role === 'user' ? 'You' : 'Mane Frame AI';
    text += `${label}:\n${msg.content}\n\n`;
  });

  // Show action sheet
  const sheet = document.createElement('div');
  sheet.id = 'ai-export-sheet';
  sheet.style.cssText = `position:fixed;inset:0;z-index:2000;display:flex;flex-direction:column;justify-content:flex-end;background:rgba(0,0,0,0.4);`;
  sheet.innerHTML = `
    <div style="background:var(--bg-card,#fff);border-radius:16px 16px 0 0;padding:8px 0 32px;">
      <div style="text-align:center;padding:12px 16px 8px;font-size:13px;color:var(--text-muted,#999);font-weight:600;letter-spacing:0.5px;">EXPORT CHAT</div>
      <button onclick="aiExportCopy()" style="width:100%;padding:16px 20px;background:none;border:none;border-top:1px solid var(--border-light,#eee);text-align:left;font-size:16px;color:var(--text,#333);cursor:pointer;">📋  Copy to Clipboard</button>
      <button onclick="aiExportDownload()" style="width:100%;padding:16px 20px;background:none;border:none;border-top:1px solid var(--border-light,#eee);text-align:left;font-size:16px;color:var(--text,#333);cursor:pointer;">⬇️  Download as Text File</button>
      <button onclick="aiExportEmail()" style="width:100%;padding:16px 20px;background:none;border:none;border-top:1px solid var(--border-light,#eee);text-align:left;font-size:16px;color:var(--text,#333);cursor:pointer;">✉️  Send via Email</button>
      <button onclick="document.getElementById('ai-export-sheet').remove()" style="width:100%;padding:16px 20px;background:none;border:none;border-top:1px solid var(--border-light,#eee);text-align:center;font-size:16px;color:var(--danger,#C13838);cursor:pointer;font-weight:600;">Cancel</button>
    </div>
  `;
  document.body.appendChild(sheet);
  sheet.addEventListener('click', e => { if (e.target === sheet) sheet.remove(); });
  window._aiExportText = text;
}

function aiExportCopy() {
  document.getElementById('ai-export-sheet')?.remove();
  navigator.clipboard.writeText(window._aiExportText || '').then(() => {
    const btn = document.getElementById('ai-export-btn');
    if (btn) { btn.textContent = '✅'; setTimeout(() => { btn.textContent = '📤'; }, 2000); }
  }).catch(() => alert('Could not copy. Try downloading instead.'));
}

function aiExportDownload() {
  document.getElementById('ai-export-sheet')?.remove();
  const blob = new Blob([window._aiExportText || ''], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mane-frame-chat-${new Date().toISOString().split('T')[0]}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function aiExportEmail() {
  document.getElementById('ai-export-sheet')?.remove();
  const subject = encodeURIComponent(`Mane Frame AI Chat – ${new Date().toLocaleDateString()}`);
  const body = encodeURIComponent(window._aiExportText || '');
  window.location.href = `mailto:?subject=${subject}&body=${body}`;
}

function askSuggestion(btn) {
  const input = document.getElementById('ai-ask-input');
  if (input) {
    input.value = btn.textContent;
    sendAskQuery();
  }
}

async function gatherBusinessSnapshot() {
  const allTxns = await db.transactions.toArray();
  const allSums = await db.dailySummary.toArray();
  const allRenters = await db.renters.toArray();
  const allRentPmts = await db.rentPayments.toArray();

  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;
  const yearStr = String(curYear);
  const employeeCategories = ['Vagaro Income', 'Chasity (Vagaro Income)'];

  // Monthly summaries for last 6 months
  const monthlySummaries = [];
  for (let i = 0; i < 6; i++) {
    let m = curMonth - i;
    let y = curYear;
    while (m <= 0) { m += 12; y--; }
    const ms = `${y}-${String(m).padStart(2,'0')}`;
    const mTxns = allTxns.filter(t => t.date?.startsWith(ms));
    const mIncome = mTxns.filter(t => t.type === 'INCOME');
    const mExpenses    = mTxns.filter(t => t.type === 'EXPENSE');
    const mMonthlyExp  = mExpenses.filter(t => t.recurring);

    const services = mIncome.filter(t => !employeeCategories.includes(t.category))
      .reduce((s,t) => s + (t.serviceAmount||0), 0);
    const tips = mIncome.filter(t => !employeeCategories.includes(t.category))
      .reduce((s,t) => s + (t.tipAmount||0), 0);
    const employeeInc = mIncome.filter(t => employeeCategories.includes(t.category))
      .reduce((s,t) => s + (t.serviceAmount||0) + (t.tipAmount||0), 0);
    const dailyExp   = mExpenses.filter(t => !t.recurring).reduce((s,t) => s + (t.amount||0), 0);
    const monthlyExp = mMonthlyExp.reduce((s,t) => s + (t.amount||0), 0);
    const rentCollected = allRentPmts.filter(p => p.datePaid?.startsWith(ms))
      .reduce((s,p) => s + (p.amount||0), 0);

    const mSums = allSums.filter(s => s.date?.startsWith(ms));
    const clients = mSums.reduce((s,d) => s + (d.clientsSeen||0), 0);
    const incomeEntries = mIncome.filter(t => !employeeCategories.includes(t.category)).length;
    const uniqueClients = new Set(mIncome.filter(t => t.clientName?.trim() && !employeeCategories.includes(t.category)).map(t => t.clientName.trim().toLowerCase())).size;

    monthlySummaries.push({
      month: monthName(m), year: y,
      services, tips, employeeIncome: employeeInc,
      dailyExpenses: dailyExp, monthlyExpenses: monthlyExp,
      totalIncome: services + tips + employeeInc + rentCollected,
      totalExpenses: dailyExp + monthlyExp,
      netProfit: services + tips + employeeInc + rentCollected - dailyExp - monthlyExp,
      rentCollected, clients, incomeEntries, uniqueClients,
    });
  }

  // Top expense categories this year
  const expByCat = {};
  allTxns.filter(t => t.date?.startsWith(yearStr) && t.type === 'EXPENSE').forEach(t => {
    expByCat[t.category] = (expByCat[t.category] || 0) + (t.amount || 0);
  });
  const topExpenses = Object.entries(expByCat).sort((a,b) => b[1] - a[1]).slice(0, 10)
    .map(([cat, amt]) => `${cat}: $${amt.toFixed(2)}`);

  // Income by service category this year
  const incByCat = {};
  allTxns.filter(t => t.date?.startsWith(yearStr) && t.type === 'INCOME' && !employeeCategories.includes(t.category)).forEach(t => {
    incByCat[t.category] = (incByCat[t.category] || 0) + (t.serviceAmount||0) + (t.tipAmount||0);
  });
  const topServices = Object.entries(incByCat).sort((a,b) => b[1] - a[1]).slice(0, 8)
    .map(([cat, amt]) => `${cat}: $${amt.toFixed(2)}`);

  // Client summary
  const clientMap = {};
  allTxns.filter(t => t.type === 'INCOME' && t.clientName?.trim() && !employeeCategories.includes(t.category)).forEach(t => {
    const key = t.clientName.trim().toLowerCase();
    if (!clientMap[key]) clientMap[key] = { name: t.clientName.trim(), visits: 0, spend: 0, lastVisit: '' };
    clientMap[key].visits++;
    clientMap[key].spend += (t.serviceAmount||0) + (t.tipAmount||0);
    if (t.date > clientMap[key].lastVisit) clientMap[key].lastVisit = t.date;
  });
  const clientList = Object.values(clientMap).sort((a,b) => b.spend - a.spend).slice(0, 15)
    .map(c => `${c.name}: ${c.visits} visits, $${c.spend.toFixed(2)} total, last visit ${c.lastVisit}`);

  // Employee performance (YTD)
  const employees = state.employees || ['Chasity McGill'];
  const empYearStart = `${curYear}-01-01`;
  const empYearEnd = todayStr();

  function getEmpWeekStart(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() - d.getDay());
    return d.toISOString().split('T')[0];
  }

  const employeeSnapshots = employees.map(empName => {
    const legacyCat = `${empName.split(' ')[0]} (Vagaro Income)`;
    const empIncomeTxns = allTxns.filter(t =>
      t.type === 'INCOME' &&
      t.date >= empYearStart && t.date <= empYearEnd &&
      ((t.category === 'Vagaro Income' && t.employee === empName) || t.category === legacyCat)
    );
    const empExpenseTxns = allTxns.filter(t =>
      t.type === 'EXPENSE' &&
      t.category === 'Employee Pay' &&
      t.date >= empYearStart && t.date <= empYearEnd &&
      (t.employee === empName || (!t.employee && empName === 'Chasity McGill'))
    );

    let empServices = 0, empTips = 0, empPay = 0, empTaxes = 0;
    const empWeeks = {};

    empIncomeTxns.forEach(t => {
      const ws = getEmpWeekStart(t.date);
      if (!empWeeks[ws]) empWeeks[ws] = { services: 0, tips: 0, pay: 0, taxes: 0 };
      const svc = t.serviceAmount || t.amount || 0;
      empServices += svc;
      empWeeks[ws].services += svc;
      const tips = t.employeeTips || parseFloat(t.notes?.match(/Tips:\s*\$?([\d.]+)/i)?.[1] || 0) || t.tipAmount || 0;
      empTips += tips;
      empWeeks[ws].tips += tips;
    });

    empExpenseTxns.forEach(t => {
      const ws = getEmpWeekStart(t.date);
      if (!empWeeks[ws]) empWeeks[ws] = { services: 0, tips: 0, pay: 0, taxes: 0 };
      const amt = t.amount || 0;
      if (t.payType === 'taxes' || t.notes?.toLowerCase().includes('tax')) {
        empTaxes += amt;
        empWeeks[ws].taxes += amt;
      } else {
        empPay += amt;
        empWeeks[ws].pay += amt;
      }
    });

    const empTotalCost = empPay + empTaxes;
    const empNetProfit = empServices - empTotalCost;
    const empMargin = empServices > 0 ? ((empNetProfit / empServices) * 100).toFixed(1) : 0;
    const weeksWorked = Object.values(empWeeks).filter(w => w.services > 0 || w.pay > 0).length;
    const avgWeeklyRevenue = weeksWorked > 0 ? (empServices / weeksWorked).toFixed(0) : 0;
    const avgWeeklyPay = weeksWorked > 0 ? (empTotalCost / weeksWorked).toFixed(0) : 0;
    const avgWeeklyNet = weeksWorked > 0 ? (empNetProfit / weeksWorked).toFixed(0) : 0;
    const BOOTH_RATE = 140;
    const boothNet = BOOTH_RATE * weeksWorked;
    const boothDiff = empNetProfit - boothNet;

    return `- ${empName}: Revenue $${empServices.toFixed(0)}, Tips $${empTips.toFixed(0)} (kept by employee), Pay $${empPay.toFixed(0)}, Taxes $${empTaxes.toFixed(0)}, Total Cost $${empTotalCost.toFixed(0)}, Net Profit $${empNetProfit.toFixed(0)}, Margin ${empMargin}%, Weeks Worked ${weeksWorked}, Avg/Week: Revenue $${avgWeeklyRevenue} | Cost $${avgWeeklyPay} | Net $${avgWeeklyNet} | Booth renter equivalent (${weeksWorked}wks × $${BOOTH_RATE}) = $${boothNet.toFixed(0)} (employee ${boothDiff >= 0 ? 'earns' : 'costs'} $${Math.abs(boothDiff).toFixed(0)} ${boothDiff >= 0 ? 'more' : 'less'} than booth renter would)`;
  });

  // Booth renters with payment history
  const activeRenters = allRenters.filter(r => r.status === 'active');
  const totalWeeklyRent = activeRenters.reduce((s, r) => s + getCurrentRate(r), 0);
  const renterInfo = activeRenters.map(r => {
    const currentRate = getCurrentRate(r);
    const pmts = allRentPmts.filter(p => p.renterId === r.id).sort((a,b) => b.weekStart.localeCompare(a.weekStart));
    const totalPaid = pmts.reduce((s,p) => s + (p.amount || 0), 0);
    const lastPaid = pmts.length > 0 ? pmts[0].datePaid : 'never';

    // Check last 8 weeks for on-time pattern
    let onTime = 0;
    let late = 0;
    let missed = 0;
    const recentWeeks = [];
    for (let i = 0; i < 8; i++) {
      const ws = addDays(getWeekStart(todayStr()), -(i * 7));
      const pmt = pmts.find(p => p.weekStart === ws);
      if (pmt) {
        // Consider "on time" if paid within 2 days of week start
        const wsDate = new Date(ws + 'T12:00:00');
        const paidDate = new Date(pmt.datePaid + 'T12:00:00');
        const daysLate = Math.floor((paidDate - wsDate) / 86400000);
        if (daysLate <= 2) { onTime++; recentWeeks.push('on-time'); }
        else { late++; recentWeeks.push(`late(${daysLate}d)`); }
      } else {
        missed++;
        recentWeeks.push('missed');
      }
    }
    return `- ${r.name}: Current rate $${currentRate}/week, ${pmts.length} payments ($${totalPaid.toFixed(0)} total), last paid ${lastPaid}, last 8 weeks: ${onTime} on-time, ${late} late, ${missed} missed`;
  });

  return `
BUSINESS SNAPSHOT (as of ${now.toLocaleDateString()}):
Owner: Annette | Business: Hair Salon ("Mane Frame")
Employees: ${employees.join(', ')} (income tracked via "Vagaro Income" category with employee field)

EMPLOYEE PERFORMANCE (${curYear} YTD):
${employeeSnapshots.join('\n') || 'No employee data'}
Note: Net Profit = Revenue generated by employee minus their pay and employer taxes. Tips are kept by the employee and not included in salon profit calculations. To estimate profitability of adding another employee, use the avg weekly revenue and cost figures above scaled by expected weeks worked.

MONTHLY PERFORMANCE (last 6 months):
${monthlySummaries.map(m => `${m.month} ${m.year}: Income $${m.totalIncome.toFixed(0)} (Services $${m.services.toFixed(0)}, Tips $${m.tips.toFixed(0)}, Employee $${m.employeeIncome.toFixed(0)}, Rent $${m.rentCollected.toFixed(0)}) | Expenses $${m.totalExpenses.toFixed(0)} (Daily $${m.dailyExpenses.toFixed(0)}, Monthly $${m.monthlyExpenses.toFixed(0)}) | Net $${m.netProfit.toFixed(0)} | Clients logged: ${m.clients}, Income entries: ${m.incomeEntries}, Unique named clients: ${m.uniqueClients}`).join('\n')}

TOP INCOME CATEGORIES (YTD):
${topServices.join('\n')}

TOP EXPENSE CATEGORIES (YTD):
${topExpenses.join('\n')}

BOOTH RENTERS (${activeRenters.length} active, total weekly rent: $${totalWeeklyRent}):
${renterInfo.join('\n') || 'None'}

CLIENT BOOK (top ${clientList.length} by spend):
${clientList.join('\n') || 'No client names tracked yet'}
`.trim();
}

async function sendAskQuery() {
  const input = document.getElementById('ai-ask-input');
  const question = input?.value.trim();
  if (!question) return;

  const messagesEl = document.getElementById('ai-chat-messages');

  // Add user message
  messagesEl.innerHTML += `
    <div style="align-self:flex-end;background:var(--plum, #5D3854);color:#fff;border-radius:12px;padding:10px 14px;max-width:85%;font-size:14px;line-height:1.4;">
      ${question}
    </div>
  `;

  // Clear input
  input.value = '';

  // Add loading indicator
  const loadingId = 'ai-loading-' + Date.now();
  messagesEl.innerHTML += `
    <div id="${loadingId}" style="background:var(--bg-card, #fff);border-radius:12px;padding:14px 16px;max-width:85%;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
      <div style="font-size:14px;color:var(--text-muted, #999);">Thinking…</div>
    </div>
  `;
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    if (!window._aiChatHistory) window._aiChatHistory = [];
    const snapshot = window._aiChatHistory.length === 0 ? await gatherBusinessSnapshot() : '';
    console.log('Snapshot length:', snapshot ? snapshot.length : 0);

    // Call Firebase Cloud Function - pass history WITHOUT current message
    const askAI = firebase.functions().httpsCallable('askAI');
    const result = await askAI({ question, snapshot, history: [...window._aiChatHistory] });
    const answer = result.data.answer || 'Sorry, I couldn\'t process that question.';

    // NOW add to history after the call
    window._aiChatHistory.push({ role: 'user', content: question });
    window._aiChatHistory.push({ role: 'assistant', content: answer });
    
    // Trim history if too long
    if (window._aiChatHistory.length > 10) {
      window._aiChatHistory = window._aiChatHistory.slice(-10);
    }

    // Replace loading with answer
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) {
      loadingEl.innerHTML = `
        <div style="font-size:14px;color:var(--text, #333);line-height:1.6;white-space:pre-wrap;">${answer}</div>
      `;
    }
  } catch (error) {
    console.error('AI Ask error:', error);
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) {
      loadingEl.innerHTML = `
        <div style="font-size:14px;color:var(--danger, #C13838);line-height:1.5;">
          Couldn't get a response. ${error.message || 'Please try again.'}
        </div>
      `;
    }
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

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

async function migrateMonthlyExpensesToTransactions() {
  const FLAG_KEY = 'mf_monthly_migrated_v1';
  if (localStorage.getItem(FLAG_KEY)) return;

  const all = await db.monthlyExpenses.toArray();
  if (all.length === 0) {
    localStorage.setItem(FLAG_KEY, '1');
    return;
  }

  const records = all.map(e => {
    const lastDay = new Date(e.year, e.month, 0).getDate();
    const date = `${e.year}-${String(e.month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
    return {
      date,
      type: 'EXPENSE',
      category:            e.category,
      amount:              e.amount,
      notes:               e.notes || '',
      paymentMethod:       '',
      serviceAmount:       0,
      tipAmount:           0,
      recurring:           true,
      usualPayDay:         null,
      migratedFromMonthly: true,
    };
  });

  await db.transactions.bulkAdd(records);
  localStorage.setItem(FLAG_KEY, '1');
  console.log(`Migrated ${records.length} monthly expenses to transactions.`);
}

async function checkRecurringExpenseReminders() {
  const today = todayStr();
  const todayDay   = parseInt(today.split('-')[2]);
  const monthPrefix = today.slice(0, 7); // "YYYY-MM"

  const all = await db.transactions.toArray();
  const recurring = all.filter(t => t.type === 'EXPENSE' && t.recurring && t.usualPayDay);
  if (recurring.length === 0) return;

  // Build a map of category → earliest usualPayDay found
  const categoryMap = {};
  recurring.forEach(t => {
    if (!categoryMap[t.category]) categoryMap[t.category] = t.usualPayDay;
  });

  const reminders = [];
  for (const [category, payDay] of Object.entries(categoryMap)) {
    if (todayDay < payDay) continue; // not yet due this month
    const paidThisMonth = all.some(t =>
      t.type === 'EXPENSE' &&
      t.category === category &&
      t.date.startsWith(monthPrefix)
    );
    if (!paidThisMonth) reminders.push(category);
  }

  if (reminders.length === 0) return;

  // Stagger toasts so they don't stack on top of each other
  reminders.forEach((cat, i) => {
    setTimeout(() => showToast(`Reminder: Did you add "${cat}" this month?`), i * 2500);
  });
}

// Called after Firebase confirms the user is signed in.
let _appBooted = false;

async function bootApp() {
  if (_appBooted) return;
  _appBooted = true;

  await migrateMonthlyExpensesToTransactions();

  await loadCategories();
  await loadEmployees();
  await loadDirectCostCategories();
  await updateRentersTabVisibility();
  injectAskButton();

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

  // Fire-and-forget reminder check — runs after UI is visible
  setTimeout(() => checkRecurringExpenseReminders(), 2000);
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

// ----------------------------------------------------------------
// QUARTERLY TAX ESTIMATE REPORT
// ----------------------------------------------------------------

async function runTaxEstimateReport() {
  const year = parseInt(document.getElementById('r-tax-year')?.value) || new Date().getFullYear();
  const filingStatus = document.getElementById('r-tax-filing-status')?.value || 'single';
  const el = document.getElementById('report-output');
  if (!el) return;

  el.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-muted);">Calculating...</div>';

  const yearStr = String(year);
  const allTxns     = await db.transactions.toArray();
  const allRentPmts = await db.rentPayments.toArray();

  const ytdTxns = allTxns.filter(t => t.date?.startsWith(yearStr));

  const ytdServices = ytdTxns.filter(t => t.type === 'INCOME')
    .reduce((s, t) => s + (t.serviceAmount || 0) + (t.tipAmount || 0), 0);
  const ytdRent = allRentPmts.filter(p => p.datePaid?.startsWith(yearStr))
    .reduce((s, p) => s + (p.amount || 0), 0);
  const ytdGrossRevenue = ytdServices + ytdRent;

  const ytdTotalExp = ytdTxns.filter(t => t.type === 'EXPENSE')
    .reduce((s, t) => s + (t.amount || 0), 0);
  const ytdNetIncome = ytdGrossRevenue - ytdTotalExp;

  const today = new Date();
  const monthsElapsed = year < today.getFullYear() ? 12 : today.getMonth() + 1;
  const projectedAnnualNet = monthsElapsed > 0 ? (ytdNetIncome / monthsElapsed) * 12 : 0;

  // 2025 IRS tax brackets
  const taxData = {
    single: {
      stdDeduction: 15000,
      brackets: [
        { rate: 0.10, upTo: 11925 },
        { rate: 0.12, upTo: 48475 },
        { rate: 0.22, upTo: 103350 },
        { rate: 0.24, upTo: 197300 },
        { rate: 0.32, upTo: 250525 },
        { rate: 0.35, upTo: 626350 },
        { rate: 0.37, upTo: Infinity },
      ],
    },
    mfj: {
      stdDeduction: 30000,
      brackets: [
        { rate: 0.10, upTo: 23850 },
        { rate: 0.12, upTo: 96950 },
        { rate: 0.22, upTo: 206700 },
        { rate: 0.24, upTo: 394600 },
        { rate: 0.32, upTo: 501050 },
        { rate: 0.35, upTo: 751600 },
        { rate: 0.37, upTo: Infinity },
      ],
    },
  };

  function calcFederalTax(taxableIncome, status) {
    if (taxableIncome <= 0) return 0;
    const bkts = taxData[status].brackets;
    let tax = 0, prev = 0;
    for (const { rate, upTo } of bkts) {
      const chunk = Math.min(taxableIncome, upTo) - prev;
      if (chunk <= 0) break;
      tax += chunk * rate;
      prev = upTo;
      if (taxableIncome <= upTo) break;
    }
    return tax;
  }

  function calcTaxes(netIncome) {
    if (netIncome <= 0) return { seTax: 0, federalTax: 0, totalTax: 0, effectiveRate: 0, seDeduction: 0, taxableIncome: 0 };
    const seTax        = netIncome * 0.9235 * 0.153;
    const seDeduction  = seTax * 0.5;
    const stdDeduction = taxData[filingStatus].stdDeduction;
    const taxableIncome = Math.max(0, netIncome - seDeduction - stdDeduction);
    const federalTax    = calcFederalTax(taxableIncome, filingStatus);
    const totalTax      = seTax + federalTax;
    const effectiveRate = (totalTax / netIncome) * 100;
    return { seTax, federalTax, totalTax, effectiveRate, seDeduction, taxableIncome };
  }

  const projectedTaxes = calcTaxes(Math.max(0, projectedAnnualNet));

  // IRS quarterly periods (Q2 is only Apr–May per IRS schedule)
  const quarters = [
    { q: 1, label: 'Q1', period: 'Jan – Mar', due: `Apr 15, ${year}`,     months: [1,2,3] },
    { q: 2, label: 'Q2', period: 'Apr – May', due: `Jun 16, ${year}`,     months: [4,5] },
    { q: 3, label: 'Q3', period: 'Jun – Aug', due: `Sep 15, ${year}`,     months: [6,7,8] },
    { q: 4, label: 'Q4', period: 'Sep – Dec', due: `Jan 15, ${year + 1}`, months: [9,10,11,12] },
  ];

  const currentMonth = today.getMonth() + 1;
  const currentQ = currentMonth <= 3 ? 1 : currentMonth <= 5 ? 2 : currentMonth <= 8 ? 3 : 4;

  const quarterNetIncome = quarters.map(({ months }) => {
    const qTxns = allTxns.filter(t => {
      if (!t.date?.startsWith(yearStr)) return false;
      const m = parseInt(t.date.split('-')[1]);
      return months.includes(m);
    });
    const qInc  = qTxns.filter(t => t.type === 'INCOME').reduce((s, t) => s + (t.serviceAmount || 0) + (t.tipAmount || 0), 0);
    const qRent = allRentPmts.filter(p => {
      if (!p.datePaid?.startsWith(yearStr)) return false;
      return months.includes(parseInt(p.datePaid.split('-')[1]));
    }).reduce((s, p) => s + (p.amount || 0), 0);
    const qTotalExp = qTxns.filter(t => t.type === 'EXPENSE').reduce((s, t) => s + (t.amount || 0), 0);
    return (qInc + qRent) - qTotalExp;
  });

  const qPayment = projectedTaxes.totalTax / 4;
  const filingLabel = filingStatus === 'single' ? 'Single, $15,000 std. deduction' : 'Married Filing Jointly, $30,000 std. deduction';

  el.innerHTML = `
    <div class="report-section-title">${year} Quarterly Tax Estimate</div>

    <div style="background:var(--gold-lighter);border:1.5px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px;">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:10px;">YTD Income Summary</div>
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:14px;">
        <span style="color:var(--text-muted);">Gross Revenue</span>
        <span style="font-weight:600;">${fmt(ytdGrossRevenue)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:14px;">
        <span style="color:var(--text-muted);">Total Expenses</span>
        <span style="font-weight:600;color:var(--danger);">− ${fmt(ytdTotalExp)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding-top:8px;border-top:1px solid var(--border);font-size:16px;font-weight:700;">
        <span>Net Income (YTD)</span>
        <span style="color:${ytdNetIncome >= 0 ? 'var(--success)' : 'var(--danger)'};">${fmt(ytdNetIncome)}</span>
      </div>
    </div>

    <div style="border:1.5px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px;">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:10px;">
        Full-Year Projection (${monthsElapsed === 12 ? 'Final' : `based on ${monthsElapsed} mo.`})
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:14px;">
        <span style="color:var(--text-muted);">Projected Net Income</span>
        <span style="font-weight:600;">${fmt(projectedAnnualNet)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:14px;">
        <span style="color:var(--text-muted);">Self-Employment Tax (15.3%)</span>
        <span style="font-weight:600;color:var(--danger);">${fmt(projectedTaxes.seTax)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:14px;">
        <span style="color:var(--text-muted);">Federal Income Tax</span>
        <span style="font-weight:600;color:var(--danger);">${fmt(projectedTaxes.federalTax)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding-top:8px;border-top:1px solid var(--border);font-size:16px;font-weight:700;">
        <span>Est. Total Annual Tax</span>
        <span style="color:var(--danger);">${fmt(projectedTaxes.totalTax)}</span>
      </div>
      <div style="text-align:right;margin-top:4px;font-size:12px;color:var(--text-muted);">
        Effective rate: ${projectedTaxes.effectiveRate.toFixed(1)}%
      </div>
    </div>

    <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:8px;padding:0 2px;">
      Quarterly Payment Schedule
    </div>
    <div style="display:grid;gap:8px;margin-bottom:16px;">
      ${quarters.map(({ q, label, period, due }, i) => {
        const isCurrentQ = q === currentQ && year === today.getFullYear();
        const isPast = year < today.getFullYear() || (year === today.getFullYear() && q < currentQ);
        const qNet = quarterNetIncome[i];
        return `
          <div style="border:${isCurrentQ ? '2px solid var(--plum)' : '1.5px solid var(--border)'};border-radius:12px;padding:14px;background:${isCurrentQ ? 'rgba(92,61,78,0.05)' : ''};">
            <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:6px;">
              <div>
                <span style="font-size:13px;font-weight:700;color:${isCurrentQ ? 'var(--plum)' : 'var(--text)'};">${label} ${period}</span>
                ${isCurrentQ ? '<span style="margin-left:6px;font-size:10px;font-weight:700;background:var(--plum);color:#fff;padding:2px 6px;border-radius:10px;">CURRENT</span>' : ''}
              </div>
              <div style="text-align:right;">
                <div style="font-size:18px;font-weight:800;color:var(--danger);">${fmt(qPayment)}</div>
                <div style="font-size:11px;color:var(--text-muted);">est. payment</div>
              </div>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);">
              <span>Net this quarter: <strong style="color:${qNet >= 0 ? 'var(--success)' : 'var(--danger)'};">${fmt(qNet)}</strong></span>
              <span>Due: <strong style="color:${isPast ? 'var(--text-muted)' : 'var(--text)'};">${due}</strong></span>
            </div>
          </div>
        `;
      }).join('')}
    </div>

    <div style="background:var(--gold-lighter);border-radius:10px;padding:14px;font-size:12px;color:var(--text-muted);line-height:1.6;">
      <strong style="color:var(--text);">How is this calculated?</strong><br>
      Uses 2025 IRS tax brackets (${filingLabel}). Self-employment tax = net × 92.35% × 15.3%.
      Half of SE tax is deducted before federal tax is applied. Quarterly payments = projected annual tax ÷ 4.<br><br>
      <strong style="color:var(--text);">⚠️ Estimate only</strong> — not tax advice. Consult a tax professional for your actual filings.
    </div>
  `;
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
