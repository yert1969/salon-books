// ================================================================
//  MANE FRAME DESKTOP — Main Application Logic
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
const auth = firebase.auth();
const firestore = firebase.firestore();

firestore.enablePersistence({ synchronizeTabs: true }).catch(err => {
  console.warn('Firestore persistence:', err.code);
});

// ----------------------------------------------------------------
// 2. AUTH & DB SHIM
// ----------------------------------------------------------------

let currentUser = null;

function userCol(name) {
  if (!currentUser) throw new Error('Not authenticated');
  return firestore.collection('users').doc(currentUser.uid).collection(name);
}

function docToObj(doc) {
  if (!doc.exists) return undefined;
  return { ...doc.data(), id: doc.id };
}

function snapToArr(snap) {
  return snap.docs.map(d => ({ ...d.data(), id: d.id }));
}

function makeTable(colName) {
  const col = () => userCol(colName);
  return {
    async toArray() { return snapToArr(await col().get()); },
    async get(id) { return docToObj(await col().doc(String(id)).get()); },
    async add(data) { return (await col().add(data)).id; },
    async update(id, changes) { await col().doc(String(id)).update(changes); },
    async delete(id) { await col().doc(String(id)).delete(); },
    async clear() {
      const snap = await col().get();
      const batch = firestore.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    },
    async bulkAdd(records) {
      for (let i = 0; i < records.length; i += 499) {
        const batch = firestore.batch();
        records.slice(i, i + 499).forEach(r => batch.set(col().doc(), r));
        await batch.commit();
      }
    },
    where(field) {
      return {
        equals(value) {
          const q = col().where(field, '==', value);
          return {
            async toArray() { return snapToArr(await q.get()); },
            async first() {
              const snap = await q.limit(1).get();
              return snap.empty ? undefined : docToObj(snap.docs[0]);
            },
            filter(fn) {
              return { async first() { return snapToArr(await q.get()).find(fn); } };
            },
            reverse() {
              return {
                limit(n) {
                  return {
                    async toArray() {
                      try {
                        return snapToArr(await q.orderBy('weekStart', 'desc').limit(n).get());
                      } catch(_) {
                        return snapToArr(await q.get()).sort((a,b) => b.weekStart > a.weekStart ? 1 : -1).slice(0, n);
                      }
                    }
                  };
                }
              };
            }
          };
        }
      };
    }
  };
}

const settingsTable = {
  async get(key) {
    try {
      const doc = await userCol('settings').doc(key).get();
      return doc.exists ? { key: doc.id, ...doc.data() } : undefined;
    } catch(_) { return undefined; }
  },
  async put(obj) {
    if (obj.key === 'categories') return;
    await userCol('settings').doc(obj.key).set(obj);
  },
  async delete(key) { await userCol('settings').doc(key).delete(); },
  async toArray() { return (await userCol('settings').get()).docs.map(d => ({ key: d.id, ...d.data() })); },
  async clear() {
    const snap = await userCol('settings').get();
    const batch = firestore.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  },
  async bulkAdd(records) {
    const batch = firestore.batch();
    records.forEach(r => batch.set(userCol('settings').doc(r.key), r));
    await batch.commit();
  }
};

const db = {
  transactions: makeTable('transactions'),
  dailySummary: makeTable('dailySummary'),
  monthlyExpenses: makeTable('monthlyExpenses'),
  renters: makeTable('renters'),
  rentPayments: makeTable('rentPayments'),
  settings: settingsTable,
  async transaction(_mode, ...args) { return args[args.length - 1](); }
};


// ----------------------------------------------------------------
// 3. AUTH FUNCTIONS
// ----------------------------------------------------------------

async function signInWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    await auth.signInWithPopup(provider);
  } catch (err) {
    if (err.code !== 'auth/popup-closed-by-user') {
      showToast('Sign-in failed');
      console.error(err);
    }
  }
}

async function signOutUser() {
  if (!confirm('Sign out of Mane Frame?')) return;
  _appBooted = false;
  await auth.signOut();
}

// ----------------------------------------------------------------
// 4. APP STATE
// ----------------------------------------------------------------

const state = {
  currentView: 'dashboard',
  selectedDate: todayStr(),
  selectedMonth: new Date().getMonth() + 1,
  selectedYear: new Date().getFullYear(),
  reportType: 'daily',
  entriesViewMode: 'daily',
  rentersWeekStart: null,
  showRentersTab: false,
  categories: { INCOME: [], EXPENSE: [] },
  transactionsToShow: 30,
  dashboardMonth: new Date().getMonth() + 1,
  dashboardYear: new Date().getFullYear(),
  clientSort: 'total',
  // Comparison report state
  compareMonth: new Date().getMonth(),
  compareYear: new Date().getFullYear(),
  range1Start: `${new Date().getFullYear()}-01-01`,
  range1End: todayStr(),
  range2Start: `${new Date().getFullYear() - 1}-01-01`,
  range2End: `${new Date().getFullYear() - 1}-12-31`,
  yoyYear1: new Date().getFullYear() - 1,
  yoyYear2: new Date().getFullYear(),
  // Clients report state
  clientsReportSort: 'total',
  clientsReportMonth: null, // null = all time
  clientsReportShowAll: false,
  // Category report state
  catReportFrom: `${new Date().getFullYear()}-01-01`,
  catReportTo: todayStr(),
  // Booth rent report state
  boothRentYear: new Date().getFullYear(),
  // Direct cost categories (for P&L)
  directCostCategories: [],
};

// ----------------------------------------------------------------
// 5. UTILITY FUNCTIONS
// ----------------------------------------------------------------

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
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
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split('T')[0];
}

function formatWeekRange(weekStart) {
  const end = addDays(weekStart, 6);
  const s = new Date(weekStart + 'T12:00:00');
  const e = new Date(end + 'T12:00:00');
  return `${s.toLocaleDateString('en-US', {month:'short',day:'numeric'})} – ${e.toLocaleDateString('en-US', {month:'short',day:'numeric'})}`;
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 2500);
}


// ----------------------------------------------------------------
// 6. MODAL SYSTEM
// ----------------------------------------------------------------

function openModal(content) {
  document.getElementById('modal-content').innerHTML = content;
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('modal').classList.add('hidden');
}

async function confirmDialog(message, title = 'Confirm') {
  return new Promise(resolve => {
    openModal(`
      <h2 class="modal-title">${title}</h2>
      <p style="margin-bottom:24px;color:var(--text);line-height:1.6;">${message}</p>
      <div style="display:flex;gap:12px;">
        <button class="btn-secondary" style="flex:1;" onclick="closeModal();window._confirmResolve(false)">Cancel</button>
        <button class="btn-danger" style="flex:1;" onclick="closeModal();window._confirmResolve(true)">Confirm</button>
      </div>
    `);
    window._confirmResolve = resolve;
  });
}

// ----------------------------------------------------------------
// 7. NAVIGATION
// ----------------------------------------------------------------

function navigate(view) {
  state.currentView = view;
  
  // Update nav items
  document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));
  const navBtn = document.getElementById(`nav-${view}`);
  if (navBtn) navBtn.classList.add('active');
  
  // Update page title
  const titles = {
    dashboard: ['Dashboard', 'Overview of your salon business'],
    entries: ['Entries', 'Track income and expenses'],
    renters: ['Booth Renters', 'Manage booth rental payments'],
    clients: ['Clients', 'View client history and insights'],
    reports: ['Reports', 'Generate business reports'],
    settings: ['Settings', 'Manage your preferences']
  };
  
  const [title, subtitle] = titles[view] || ['Mane Frame', ''];
  document.getElementById('page-title').textContent = title;
  document.getElementById('page-subtitle').textContent = subtitle;
  
  // Hide renters nav if not enabled
  const rentersNav = document.getElementById('nav-renters');
  if (rentersNav) {
    rentersNav.style.display = state.showRentersTab ? 'flex' : 'none';
  }
  
  // Render the view
  renderView(view);
}

async function renderView(view) {
  const content = document.getElementById('app-content');
  content.innerHTML = '<div class="flex items-center justify-center" style="padding:60px;"><div class="loading-spinner"></div></div>';
  
  try {
    switch(view) {
      case 'dashboard': await renderDashboard(); break;
      case 'entries': await renderEntriesView(); break;
      case 'renters': await renderRentersView(); break;
      case 'clients': await renderClientsView(); break;
      case 'reports': await renderReportsView(); break;
      case 'settings': await renderSettingsView(); break;
      default: await renderDashboard();
    }
  } catch(err) {
    console.error('Render error:', err);
    content.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">Error loading view</div><div class="empty-text">${err.message}</div></div>`;
  }
}


// ----------------------------------------------------------------
// 8. CATEGORIES
// ----------------------------------------------------------------

const DEFAULT_CATEGORIES = {
  INCOME: ['Haircut', 'Color', 'Highlights', 'Balayage', 'Blowout', 'Treatment', 'Extensions', 'Styling', 'Other Service'],
  EXPENSE: ['Supplies', 'Products', 'Tools', 'Rent', 'Utilities', 'Insurance', 'Marketing', 'Education', 'Software', 'Other']
};

async function loadCategories() {
  let loaded = false;
  
  // Try to load from Firebase first (where mobile app stores them)
  try {
    const fbDoc = await firestore
      .collection('users')
      .doc(currentUser.uid)
      .collection('settings')
      .doc('categories')
      .get();
    
    if (fbDoc.exists) {
      const data = fbDoc.data();
      if (data && (data.INCOME || data.EXPENSE)) {
        state.categories = {
          INCOME: data.INCOME || [],
          EXPENSE: data.EXPENSE || []
        };
        loaded = true;
        console.log('✓ Loaded categories from Firebase:', state.categories.INCOME.length, 'income,', state.categories.EXPENSE.length, 'expense');
      }
    }
  } catch(e) {
    console.log('Firebase categories not available:', e.message);
  }
  
  // Fall back to local settings if Firebase didn't work
  if (!loaded) {
    // Try 'categories' key first (what mobile uses locally)
    let doc = await db.settings.get('categories');
    if (!doc) {
      doc = await db.settings.get('categoriesV2');
    }
    
    if (doc && doc.value) {
      try {
        state.categories = JSON.parse(doc.value);
        loaded = true;
      } catch(e) {
        console.log('Failed to parse local categories');
      }
    }
  }
  
  // Use defaults if nothing loaded
  if (!loaded) {
    state.categories = { ...DEFAULT_CATEGORIES };
  }
  
  // Ensure arrays exist
  if (!state.categories.INCOME || !state.categories.INCOME.length) {
    state.categories.INCOME = [...DEFAULT_CATEGORIES.INCOME];
  }
  if (!state.categories.EXPENSE || !state.categories.EXPENSE.length) {
    state.categories.EXPENSE = [...DEFAULT_CATEGORIES.EXPENSE];
  }
}

async function saveCategories() {
  // Save locally
  await db.settings.put({ key: 'categories', value: JSON.stringify(state.categories) });
  
  // Also sync to Firebase (so mobile app sees changes)
  try {
    await firestore
      .collection('users')
      .doc(currentUser.uid)
      .collection('settings')
      .doc('categories')
      .set(state.categories);
  } catch(e) {
    console.error('Failed to sync categories to Firebase:', e);
  }
}

function categoryOptions(type) {
  const cats = type === 'INCOME' ? state.categories.INCOME : state.categories.EXPENSE;
  return [...cats].sort((a, b) => a.localeCompare(b)).map(name => `<option value="${name}">${name}</option>`).join('');
}

// ----------------------------------------------------------------
// 9. RENTER RATE HELPERS
// ----------------------------------------------------------------

function ensureRateHistory(renter) {
  if (!renter.rateHistory || renter.rateHistory.length === 0) {
    renter.rateHistory = [{ rate: renter.weeklyRate || 140, effectiveDate: renter.startDate || '2024-01-01' }];
  }
}

function sortRateHistory(history) {
  return [...history].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}

function getCurrentRate(renter) {
  ensureRateHistory(renter);
  const today = todayStr();
  const sorted = sortRateHistory(renter.rateHistory);
  let rate = sorted[0].rate;
  for (const entry of sorted) {
    if (entry.effectiveDate <= today) rate = entry.rate;
  }
  return rate;
}

function getRateForWeek(renter, weekStart) {
  ensureRateHistory(renter);
  const sorted = sortRateHistory(renter.rateHistory);
  let rate = sorted[0].rate;
  for (const entry of sorted) {
    if (entry.effectiveDate <= weekStart) rate = entry.rate;
  }
  return rate;
}

function getRentStatus(weekStart, datePaid) {
  if (!datePaid) return 'unpaid';
  // Due date is Saturday (5 days after Monday week start)
  // "On time" = paid by Tuesday after due date (Saturday + 3 days = 8 days after Monday)
  const ws = new Date(weekStart + 'T12:00:00');
  const pd = new Date(datePaid + 'T12:00:00');
  const days = Math.floor((pd - ws) / 86400000);
  return days <= 8 ? 'ontime' : 'late';  // Saturday (5) + 3 grace days = 8
}

async function updateRentersTabVisibility() {
  const override = await db.settings.get('showRentersTab');
  if (override && override.value !== undefined) {
    state.showRentersTab = override.value === 'true';
  } else {
    const renters = await db.renters.toArray();
    state.showRentersTab = renters.filter(r => r.status === 'active').length > 0;
  }
}


// ----------------------------------------------------------------
// 10. SMART INSIGHTS ENGINE
// ----------------------------------------------------------------

// Track shown insights to avoid repetition (stored in localStorage)
function getShownInsights() {
  try {
    const data = JSON.parse(localStorage.getItem('mf_shown_insights') || '{}');
    // Clean up entries older than 3 days
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
  // Consider "recent" as within last 24 hours
  return Date.now() - data[key] < 24 * 60 * 60 * 1000;
}

async function generateSmartInsights(allTxns, allMExp, allRenters, allRentPmts) {
  const insights = [];
  const now = new Date();
  const today = todayStr();
  const dayOfWeek = now.getDay(); // 0=Sun, 6=Sat
  const dayOfMonth = now.getDate();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastMonth = `${now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()}-${String(now.getMonth() === 0 ? 12 : now.getMonth()).padStart(2, '0')}`;
  const thisYear = String(now.getFullYear());
  const lastYear = String(now.getFullYear() - 1);
  
  // Helper to calculate income for a period
  const incomeFor = (txns) => txns.filter(t => t.type === 'INCOME').reduce((s,t) => s + (t.serviceAmount||0) + (t.tipAmount||0), 0);
  const expenseFor = (txns, mExp) => {
    const daily = txns.filter(t => t.type === 'EXPENSE').reduce((s,t) => s + (t.amount||0), 0);
    const monthly = mExp.reduce((s,e) => s + (e.amount||0), 0);
    return daily + monthly;
  };
  
  // This month vs last month pace
  const thisMonthTxns = allTxns.filter(t => t.date?.startsWith(thisMonth));
  const lastMonthTxns = allTxns.filter(t => t.date?.startsWith(lastMonth));
  const thisMonthIncome = incomeFor(thisMonthTxns);
  const lastMonthIncome = incomeFor(lastMonthTxns);
  
  // Same point last month comparison
  const lastMonthSameDay = `${lastMonth}-${String(dayOfMonth).padStart(2, '0')}`;
  const lastMonthToDate = allTxns.filter(t => t.date?.startsWith(lastMonth) && t.date <= lastMonthSameDay);
  const lastMonthPace = incomeFor(lastMonthToDate);
  
  if (lastMonthPace > 0 && dayOfMonth >= 5) {
    const paceChange = Math.round(((thisMonthIncome - lastMonthPace) / lastMonthPace) * 100);
    if (Math.abs(paceChange) >= 10) {
      const key = `pace_${thisMonth}`;
      insights.push({
        key,
        priority: Math.abs(paceChange) >= 20 ? 95 : 70,
        icon: paceChange > 0 ? '📈' : '📉',
        type: paceChange > 0 ? 'success' : 'warning',
        text: paceChange > 0 
          ? `You're ${paceChange}% ahead of last month's pace! Keep it up.`
          : `Income is ${Math.abs(paceChange)}% behind last month's pace. ${7 - dayOfWeek} days left this week to catch up.`
      });
    }
  }
  
  // Yesterday was exceptional
  const yesterday = addDays(today, -1);
  const yesterdayIncome = incomeFor(allTxns.filter(t => t.date === yesterday));
  const thisMonthDays = thisMonthTxns.reduce((acc, t) => {
    if (!acc[t.date]) acc[t.date] = 0;
    if (t.type === 'INCOME') acc[t.date] += (t.serviceAmount||0) + (t.tipAmount||0);
    return acc;
  }, {});
  const dailyIncomes = Object.values(thisMonthDays);
  const avgDaily = dailyIncomes.length > 0 ? dailyIncomes.reduce((a,b) => a+b, 0) / dailyIncomes.length : 0;
  
  if (yesterdayIncome > avgDaily * 1.5 && yesterdayIncome > 200) {
    const key = `best_day_${yesterday}`;
    insights.push({
      key,
      priority: 85,
      icon: '🌟',
      type: 'success',
      text: `Yesterday (${fmt(yesterdayIncome)}) was ${Math.round((yesterdayIncome/avgDaily - 1) * 100)}% above your daily average!`
    });
  }
  
  // Clients who haven't visited in a while
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
    const key = `overdue_clients_${thisMonth}`;
    insights.push({
      key,
      priority: overdueClients.length >= 5 ? 80 : 60,
      icon: '👋',
      type: 'info',
      text: `${overdueClients.length} regular client${overdueClients.length > 1 ? 's haven\'t' : ' hasn\'t'} visited in 45+ days. A quick text could bring them back!`
    });
  }
  
  // Booth rent outstanding
  const activeRenters = allRenters.filter(r => r.status === 'active');
  if (activeRenters.length > 0) {
    const currentWS = getWeekStart(today);
    const lastWS = addDays(currentWS, -7);
    let outstanding = 0;
    let overdueCount = 0;
    
    activeRenters.forEach(r => {
      ensureRateHistory(r);
      const rate = getRateForWeek(r, lastWS);
      const pmt = allRentPmts.find(p => p.renterId === r.id && p.weekStart === lastWS);
      if (!pmt || pmt.amount < rate) {
        outstanding += rate - (pmt?.amount || 0);
        overdueCount++;
      }
    });
    
    if (overdueCount > 0) {
      const key = `rent_overdue_${lastWS}`;
      insights.push({
        key,
        priority: 90,
        icon: '🏠',
        type: 'warning',
        text: `${overdueCount} booth renter${overdueCount > 1 ? 's are' : ' is'} behind on last week's rent (${fmt(outstanding)} outstanding).`
      });
    }
  }
  
  // Week comparison (show mid-week)
  if (dayOfWeek >= 3 && dayOfWeek <= 5) {
    const thisWeekStart = getWeekStart(today);
    const lastWeekStart = addDays(thisWeekStart, -7);
    const thisWeekIncome = incomeFor(allTxns.filter(t => t.date >= thisWeekStart && t.date <= today));
    const lastWeekSamePoint = incomeFor(allTxns.filter(t => t.date >= lastWeekStart && t.date < addDays(lastWeekStart, dayOfWeek)));
    
    if (lastWeekSamePoint > 0) {
      const weekChange = Math.round(((thisWeekIncome - lastWeekSamePoint) / lastWeekSamePoint) * 100);
      if (Math.abs(weekChange) >= 15) {
        const key = `week_pace_${thisWeekStart}`;
        insights.push({
          key,
          priority: 65,
          icon: weekChange > 0 ? '💪' : '⚡',
          type: weekChange > 0 ? 'success' : 'info',
          text: weekChange > 0 
            ? `This week is ${weekChange}% ahead of last week so far (${fmt(thisWeekIncome)} vs ${fmt(lastWeekSamePoint)}).`
            : `This week is running ${Math.abs(weekChange)}% behind last week. ${6 - dayOfWeek} days to catch up!`
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
    const key = `milestone_${lastMilestone}_${thisYear}`;
    insights.push({
      key,
      priority: 88,
      icon: '🎉',
      type: 'success',
      text: `You just passed ${fmt(lastMilestone)} in income this year! ${nextMilestone ? `Next milestone: ${fmt(nextMilestone)}` : ''}`
    });
  }
  
  // YoY comparison (good for end of month)
  if (dayOfMonth >= 25) {
    const lastYearSameMonth = `${now.getFullYear() - 1}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const lastYearIncome = incomeFor(allTxns.filter(t => t.date?.startsWith(lastYearSameMonth)));
    
    if (lastYearIncome > 0) {
      const yoyChange = Math.round(((thisMonthIncome - lastYearIncome) / lastYearIncome) * 100);
      if (Math.abs(yoyChange) >= 10) {
        const key = `yoy_${thisMonth}`;
        insights.push({
          key,
          priority: 75,
          icon: yoyChange > 0 ? '📊' : '📉',
          type: yoyChange > 0 ? 'success' : 'info',
          text: yoyChange > 0
            ? `This ${monthName(now.getMonth() + 1)} is ${yoyChange}% better than last year!`
            : `This ${monthName(now.getMonth() + 1)} is ${Math.abs(yoyChange)}% behind last year. ${30 - dayOfMonth} days left.`
        });
      }
    }
  }
  
  // Slowest day of week pattern
  const dayTotals = [0,0,0,0,0,0,0];
  const dayCounts = [0,0,0,0,0,0,0];
  allTxns.filter(t => t.type === 'INCOME' && t.date >= addDays(today, -60)).forEach(t => {
    const d = new Date(t.date + 'T12:00:00').getDay();
    dayTotals[d] += (t.serviceAmount||0) + (t.tipAmount||0);
    dayCounts[d]++;
  });
  const dayAvgs = dayTotals.map((total, i) => dayCounts[i] > 0 ? total / dayCounts[i] : 0);
  const overallAvg = dayAvgs.filter(a => a > 0).reduce((a,b) => a+b, 0) / dayAvgs.filter(a => a > 0).length || 0;
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  
  const slowestDay = dayAvgs.reduce((min, avg, i) => avg > 0 && avg < min.avg ? {day: i, avg} : min, {day: -1, avg: Infinity});
  if (slowestDay.day >= 0 && slowestDay.avg < overallAvg * 0.6 && overallAvg > 0) {
    const key = `slow_day_pattern`;
    insights.push({
      key,
      priority: 50,
      icon: '💡',
      type: 'info',
      text: `${dayNames[slowestDay.day]}s tend to be slow (${Math.round((1 - slowestDay.avg/overallAvg) * 100)}% below average). Consider a mid-week promo?`
    });
  }
  
  // Top client shoutout (occasional)
  const clientTotals = {};
  allTxns.filter(t => t.type === 'INCOME' && t.clientName && t.date >= addDays(today, -90)).forEach(t => {
    const name = t.clientName.trim();
    clientTotals[name] = (clientTotals[name] || 0) + (t.serviceAmount||0) + (t.tipAmount||0);
  });
  const topClient = Object.entries(clientTotals).sort((a,b) => b[1] - a[1])[0];
  if (topClient && topClient[1] > 500) {
    const key = `top_client_${thisMonth}`;
    insights.push({
      key,
      priority: 40,
      icon: '⭐',
      type: 'info',
      text: `${topClient[0]} is your top client this quarter (${fmt(topClient[1])}). VIP treatment pays off!`
    });
  }
  
  // Filter out recently shown, sort by priority, take top 2-3
  const filtered = insights.filter(i => !wasRecentlyShown(i.key));
  filtered.sort((a, b) => b.priority - a.priority);
  
  // Take 2-3 insights
  const selected = filtered.slice(0, Math.min(3, Math.max(2, filtered.length)));
  
  // Mark as shown
  selected.forEach(i => markInsightShown(i.key));
  
  return selected;
}

// ----------------------------------------------------------------
// 11. DASHBOARD VIEW
// ----------------------------------------------------------------

async function renderDashboard() {
  const content = document.getElementById('app-content');
  
  const viewMonth = state.dashboardMonth;
  const viewYear = state.dashboardYear;
  const monthStr = `${viewYear}-${String(viewMonth).padStart(2,'0')}`;
  const now = new Date();
  const isCurrentMonth = viewYear === now.getFullYear() && viewMonth === now.getMonth() + 1;
  
  // Fetch all data
  const [allTxns, allMExp, allRenters, allRentPmts, allSums] = await Promise.all([
    db.transactions.toArray(),
    db.monthlyExpenses.toArray(),
    db.renters.toArray(),
    db.rentPayments.toArray(),
    db.dailySummary.toArray()
  ]);
  
  // Month calculations
  const mTxns = allTxns.filter(t => t.date?.startsWith(monthStr));
  const mIncome = mTxns.filter(t => t.type === 'INCOME');
  const mExpenses = mTxns.filter(t => t.type === 'EXPENSE');
  const mMonthlyExp = allMExp.filter(e => e.year === viewYear && e.month === viewMonth);
  
  const mtdServices = mIncome.reduce((s,t) => s + (t.serviceAmount||0), 0);
  const mtdTips = mIncome.reduce((s,t) => s + (t.tipAmount||0), 0);
  const mtdIncome = mtdServices + mtdTips;
  const mtdDailyExp = mExpenses.reduce((s,t) => s + (t.amount||0), 0);
  const mtdMonthlyExp = mMonthlyExp.reduce((s,e) => s + (e.amount||0), 0);
  const mtdExpenses = mtdDailyExp + mtdMonthlyExp;
  const mtdNet = mtdIncome - mtdExpenses;
  const mtdMargin = mtdIncome > 0 ? Math.round((mtdNet / mtdIncome) * 100) : 0;
  
  // YTD calculations
  const yearStr = String(viewYear);
  const ytdIncome = allTxns.filter(t => t.date?.startsWith(yearStr) && t.type === 'INCOME')
    .reduce((s,t) => s + (t.serviceAmount||0) + (t.tipAmount||0), 0);
  const ytdDailyExp = allTxns.filter(t => t.date?.startsWith(yearStr) && t.type === 'EXPENSE')
    .reduce((s,t) => s + (t.amount||0), 0);
  const ytdMonthlyExp = allMExp.filter(e => e.year === viewYear).reduce((s,e) => s + (e.amount||0), 0);
  const ytdExpenses = ytdDailyExp + ytdMonthlyExp;
  
  // Week pace
  const today = todayStr();
  const weekStart = getWeekStart(today);
  const dayOfWeek = new Date().getDay();
  const dayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  
  const thisWeekDays = [0,0,0,0,0,0,0];
  const lastWeekDays = [0,0,0,0,0,0,0];
  const lastWeekStart = addDays(weekStart, -7);
  
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    const ld = addDays(lastWeekStart, i);
    thisWeekDays[i] = allTxns.filter(t => t.date === d && t.type === 'INCOME')
      .reduce((s,t) => s + (t.serviceAmount||0) + (t.tipAmount||0), 0);
    lastWeekDays[i] = allTxns.filter(t => t.date === ld && t.type === 'INCOME')
      .reduce((s,t) => s + (t.serviceAmount||0) + (t.tipAmount||0), 0);
  }
  
  const thisWeekTotal = thisWeekDays.reduce((a,b) => a+b, 0);
  const lastWeekTotal = lastWeekDays.reduce((a,b) => a+b, 0);
  const lastWeekSamePoint = lastWeekDays.slice(0, dayIndex + 1).reduce((a,b) => a+b, 0);
  const weekPaceChange = lastWeekSamePoint > 0 ? Math.round(((thisWeekTotal - lastWeekSamePoint) / lastWeekSamePoint) * 100) : 0;
  const maxDayVal = Math.max(...thisWeekDays, ...lastWeekDays, 1);
  const dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  
  // Booth rent for prior week (rent is due Saturday for the previous week)
  const activeRenters = allRenters.filter(r => r.status === 'active');
  const rentWeekStart = lastWeekStart; // Use last week, not current week
  let rentExpected = 0;
  let rentCollected = 0;
  activeRenters.forEach(r => {
    rentExpected += getRateForWeek(r, rentWeekStart);
    const pmt = allRentPmts.find(p => p.renterId === r.id && p.weekStart === rentWeekStart);
    if (pmt) rentCollected += pmt.amount || 0;
  });
  const rentOutstanding = Math.max(0, rentExpected - rentCollected);
  
  // Generate smart insights (only on current month view)
  let insightsHTML = '';
  if (isCurrentMonth) {
    const insights = await generateSmartInsights(allTxns, allMExp, allRenters, allRentPmts);
    if (insights.length > 0) {
      const insightItems = insights.map(i => {
        const bgColor = i.type === 'success' ? 'rgba(46, 125, 50, 0.08)' 
          : i.type === 'warning' ? 'rgba(230, 126, 34, 0.08)' 
          : 'rgba(92, 61, 78, 0.06)';
        const borderColor = i.type === 'success' ? 'var(--success)' 
          : i.type === 'warning' ? 'var(--gold-dark)' 
          : 'var(--plum)';
        return `
          <div style="display:flex;gap:12px;padding:12px;background:${bgColor};border-left:3px solid ${borderColor};border-radius:0 8px 8px 0;">
            <span style="font-size:20px;">${i.icon}</span>
            <span style="font-size:14px;line-height:1.5;color:var(--text);">${i.text}</span>
          </div>
        `;
      }).join('');
      
      insightsHTML = `
        <div class="card" style="margin-bottom:24px;">
          <div class="card-title" style="margin-bottom:16px;display:flex;align-items:center;gap:8px;">
            <span>✨</span> Smart Insights
          </div>
          <div style="display:flex;flex-direction:column;gap:10px;">
            ${insightItems}
          </div>
        </div>
      `;
    }
  }
  
  // Build HTML
  let html = `
    <!-- Month Navigation -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
      <button class="btn-icon" onclick="dashboardNav(-1)">‹</button>
      <h2 style="font-family:var(--font-display);font-size:22px;font-weight:600;color:var(--text);">
        ${monthName(viewMonth)} ${viewYear}
      </h2>
      <button class="btn-icon" onclick="dashboardNav(1)" ${isCurrentMonth ? 'disabled style="opacity:0.3"' : ''}>›</button>
    </div>
    
    ${insightsHTML}
    
    <!-- Key Stats -->
    <div class="grid-4" style="margin-bottom:24px;">
      <div class="stat-card">
        <div class="stat-label">${isCurrentMonth ? 'Month to Date' : 'Total Income'}</div>
        <div class="stat-value success">${fmt(mtdIncome)}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Services + Tips</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${isCurrentMonth ? 'MTD Expenses' : 'Total Expenses'}</div>
        <div class="stat-value danger">${fmt(mtdExpenses)}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Daily + Monthly</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${isCurrentMonth ? 'Net Profit MTD' : 'Net Profit'}</div>
        <div class="stat-value plum">${fmt(mtdNet)}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">${mtdMargin}% margin</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">YTD Income</div>
        <div class="stat-value">${fmt(ytdIncome)}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">${viewYear}</div>
      </div>
    </div>
  `;
  
  // Week Pace Chart
  html += `
    <div class="grid-2" style="margin-bottom:24px;">
      <div class="pace-chart">
        <div class="card-title" style="margin-bottom:16px;">This Week's Pace</div>
        <div class="pace-header">
          <div class="pace-value">${fmt(thisWeekTotal)}</div>
          ${lastWeekSamePoint > 0 ? `
            <div class="pace-change" style="background:${weekPaceChange >= 0 ? 'var(--success-bg)' : 'var(--danger-bg)'};color:${weekPaceChange >= 0 ? 'var(--success)' : 'var(--danger)'};">
              ${weekPaceChange >= 0 ? '↑' : '↓'} ${Math.abs(weekPaceChange)}%
            </div>
          ` : ''}
        </div>
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:20px;">
          vs ${fmt(lastWeekSamePoint)} last week ${lastWeekTotal > lastWeekSamePoint ? `(${fmt(lastWeekTotal)} final)` : ''}
        </div>
        <div class="pace-bars">
          ${dayNames.map((d, i) => {
            const thisH = Math.round((thisWeekDays[i] / maxDayVal) * 100);
            const lastH = Math.round((lastWeekDays[i] / maxDayVal) * 100);
            const isFuture = i > dayIndex;
            return `
              <div class="pace-bar-group">
                <div class="pace-bar-wrapper">
                  <div class="pace-bar previous" style="height:${lastH}%;opacity:0.4;"></div>
                  <div class="pace-bar current" style="height:${isFuture ? 0 : thisH}%;${isFuture ? 'opacity:0.2;' : ''}"></div>
                </div>
                <div class="pace-day">${d}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
      
      <!-- Booth Rent Status -->
      <div class="card">
        <div class="card-title" style="margin-bottom:16px;">Booth Rent Last Week</div>
        ${activeRenters.length === 0 ? `
          <div class="empty-state" style="padding:20px;">
            <div class="empty-icon">🏠</div>
            <div class="empty-text">No booth renters yet</div>
          </div>
        ` : `
          <div style="display:flex;align-items:baseline;gap:16px;margin-bottom:16px;">
            <div style="font-family:var(--font-display);font-size:32px;font-weight:700;color:var(--success);">${fmt(rentCollected)}</div>
            <div style="font-size:14px;color:var(--text-muted);">of ${fmt(rentExpected)}</div>
          </div>
          <div style="height:8px;background:var(--cream);border-radius:4px;overflow:hidden;margin-bottom:12px;">
            <div style="height:100%;background:var(--success);width:${Math.min(100, Math.round((rentCollected/rentExpected)*100))}%;border-radius:4px;"></div>
          </div>
          <div style="font-size:14px;font-weight:600;color:${rentOutstanding > 0 ? 'var(--danger)' : 'var(--success)'};">
            ${rentOutstanding > 0 ? `${fmt(rentOutstanding)} outstanding` : '✓ All collected'}
          </div>
        `}
      </div>
    </div>
  `;
  
  content.innerHTML = html;
}

function dashboardNav(direction) {
  state.dashboardMonth += direction;
  if (state.dashboardMonth > 12) { state.dashboardMonth = 1; state.dashboardYear++; }
  if (state.dashboardMonth < 1) { state.dashboardMonth = 12; state.dashboardYear--; }
  renderDashboard();
}


// ----------------------------------------------------------------
// 11. ENTRIES VIEW
// ----------------------------------------------------------------

async function renderEntriesView() {
  const content = document.getElementById('app-content');
  
  let html = `
    <div class="entries-layout">
      <div class="entries-main">
        <!-- View Mode Tabs -->
        <div class="view-tabs">
          <button class="view-tab ${state.entriesViewMode === 'daily' ? 'active' : ''}" onclick="switchEntriesView('daily')">Daily</button>
          <button class="view-tab ${state.entriesViewMode === 'monthly' ? 'active' : ''}" onclick="switchEntriesView('monthly')">Monthly</button>
          <button class="view-tab ${state.entriesViewMode === 'all' ? 'active' : ''}" onclick="switchEntriesView('all')">All Entries</button>
        </div>
        
        <div id="entries-content"></div>
      </div>
      
      <div class="entries-sidebar">
        <div class="entry-form" id="entry-form">
          <div class="entry-form-title">Add Entry</div>
          <div id="entry-form-content"></div>
        </div>
      </div>
    </div>
  `;
  
  content.innerHTML = html;
  await renderEntriesContent();
  renderEntryForm();
}

async function renderEntriesContent() {
  const container = document.getElementById('entries-content');
  if (!container) return;
  
  if (state.entriesViewMode === 'daily') {
    await renderDailyEntries(container);
  } else if (state.entriesViewMode === 'monthly') {
    await renderMonthlyEntries(container);
  } else {
    await renderAllEntries(container);
  }
}

async function renderDailyEntries(container) {
  const txns = await db.transactions.where('date').equals(state.selectedDate).toArray();
  const income = txns.filter(t => t.type === 'INCOME');
  const expenses = txns.filter(t => t.type === 'EXPENSE');
  
  const totalIncome = income.reduce((s,t) => s + (t.serviceAmount||0) + (t.tipAmount||0), 0);
  const totalExp = expenses.reduce((s,t) => s + (t.amount||0), 0);
  const net = totalIncome - totalExp;
  const isToday = state.selectedDate === todayStr();
  
  let html = `
    <!-- Date Navigation -->
    <div class="date-nav">
      <button class="date-nav-btn" onclick="changeEntriesDate(-1)">‹</button>
      <div class="date-display">${isToday ? 'Today' : formatDateDisplay(state.selectedDate)}</div>
      <button class="date-nav-btn" onclick="changeEntriesDate(1)">›</button>
    </div>
    
    <!-- Day Summary -->
    <div class="grid-3" style="margin-bottom:24px;">
      <div class="stat-card">
        <div class="stat-label">Income</div>
        <div class="stat-value success">${fmt(totalIncome)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Expenses</div>
        <div class="stat-value danger">${fmt(totalExp)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Net</div>
        <div class="stat-value ${net >= 0 ? 'success' : 'danger'}">${fmt(net)}</div>
      </div>
    </div>
    
    <!-- Transactions -->
    <div class="transaction-list">
  `;
  
  if (income.length > 0) {
    html += `<div class="transaction-group"><div class="transaction-date">Income</div>`;
    income.forEach(t => {
      html += renderTransactionItem(t);
    });
    html += `</div>`;
  }
  
  if (expenses.length > 0) {
    html += `<div class="transaction-group"><div class="transaction-date">Expenses</div>`;
    expenses.forEach(t => {
      html += renderTransactionItem(t);
    });
    html += `</div>`;
  }
  
  if (txns.length === 0) {
    html += `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <div class="empty-title">No entries yet</div>
        <div class="empty-text">Add your first entry using the form</div>
      </div>
    `;
  }
  
  html += `</div>`;
  container.innerHTML = html;
}

async function renderMonthlyEntries(container) {
  const month = state.selectedMonth;
  const year = state.selectedYear;
  const monthlyExp = await db.monthlyExpenses.toArray();
  const expenses = monthlyExp.filter(e => e.year === year && e.month === month);
  const total = expenses.reduce((s,e) => s + (e.amount||0), 0);
  
  let html = `
    <!-- Month Navigation -->
    <div class="date-nav">
      <button class="date-nav-btn" onclick="changeEntriesMonth(-1)">‹</button>
      <div class="date-display">${monthName(month)} ${year}</div>
      <button class="date-nav-btn" onclick="changeEntriesMonth(1)">›</button>
    </div>
    
    <!-- Total -->
    <div class="stat-card" style="margin-bottom:24px;">
      <div class="stat-label">Total Monthly Expenses</div>
      <div class="stat-value danger">${fmt(total)}</div>
    </div>
    
    <!-- Expenses List -->
    <div class="transaction-list">
  `;
  
  if (expenses.length > 0) {
    expenses.forEach(e => {
      html += `
        <div class="transaction-item" onclick="openEditMonthlyExpenseModal('${e.id}')">
          <div class="transaction-icon expense">🏠</div>
          <div class="transaction-details">
            <div class="transaction-category">${e.category}</div>
            <div class="transaction-meta">${e.notes || 'Monthly expense'}</div>
          </div>
          <div class="transaction-amount expense">-${fmt(e.amount)}</div>
          <div class="transaction-actions">
            <button class="action-btn delete" onclick="event.stopPropagation();deleteMonthlyExpense('${e.id}')">×</button>
          </div>
        </div>
      `;
    });
  } else {
    html += `
      <div class="empty-state">
        <div class="empty-icon">🏠</div>
        <div class="empty-title">No monthly expenses</div>
        <div class="empty-text">Add recurring expenses like rent, utilities, etc.</div>
      </div>
    `;
  }
  
  html += `</div>`;
  container.innerHTML = html;
}

async function renderAllEntries(container) {
  let allTransactions = await db.transactions.toArray();
  const allMonthly = await db.monthlyExpenses.toArray();
  
  // Normalize monthly expenses
  allMonthly.forEach(e => {
    allTransactions.push({
      ...e,
      _isMonthly: true,
      type: 'EXPENSE',
      date: `${e.year}-${String(e.month).padStart(2,'0')}-01`,
      amount: e.amount || 0,
    });
  });
  
  // Sort by date descending
  allTransactions.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  
  const toShow = state.transactionsToShow;
  const display = allTransactions.slice(0, toShow);
  const hasMore = allTransactions.length > toShow;
  
  let html = `
    <div style="margin-bottom:16px;font-size:14px;color:var(--text-muted);">
      Showing ${display.length} of ${allTransactions.length} entries
    </div>
    <div class="transaction-list">
  `;
  
  // Group by date
  const grouped = {};
  display.forEach(t => {
    const key = t._isMonthly ? `monthly-${t.year}-${t.month}` : t.date;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(t);
  });
  
  Object.keys(grouped).sort().reverse().forEach(key => {
    const items = grouped[key];
    const isMonthly = key.startsWith('monthly-');
    const label = isMonthly ? `${monthName(items[0].month)} ${items[0].year} — Monthly` : formatDateShort(key);
    
    html += `<div class="transaction-group"><div class="transaction-date">${label}</div>`;
    items.forEach(t => {
      if (t._isMonthly) {
        html += `
          <div class="transaction-item" onclick="openEditMonthlyExpenseModal('${t.id}')">
            <div class="transaction-icon expense">🏠</div>
            <div class="transaction-details">
              <div class="transaction-category">${t.category} <span style="background:var(--plum);color:white;font-size:10px;padding:2px 6px;border-radius:4px;margin-left:6px;">Monthly</span></div>
              <div class="transaction-meta">${t.notes || ''}</div>
            </div>
            <div class="transaction-amount expense">-${fmt(t.amount)}</div>
          </div>
        `;
      } else {
        html += renderTransactionItem(t);
      }
    });
    html += `</div>`;
  });
  
  if (hasMore) {
    html += `
      <button class="btn-secondary" style="width:100%;margin-top:16px;" onclick="loadMoreTransactions()">
        Load More (${allTransactions.length - toShow} remaining)
      </button>
    `;
  }
  
  html += `</div>`;
  container.innerHTML = html;
}

function renderTransactionItem(t) {
  const isIncome = t.type === 'INCOME';
  const amount = isIncome ? (t.serviceAmount||0) + (t.tipAmount||0) : (t.amount||0);
  const tipText = isIncome && t.tipAmount > 0 ? ` (+${fmt(t.tipAmount)} tip)` : '';
  
  return `
    <div class="transaction-item" onclick="openEditTransactionModal('${t.id}')">
      <div class="transaction-icon ${isIncome ? 'income' : 'expense'}">${isIncome ? '💰' : '💸'}</div>
      <div class="transaction-details">
        <div class="transaction-category">${t.category}</div>
        <div class="transaction-meta">${t.clientName || ''}${t.clientName && t.notes ? ' · ' : ''}${t.notes || ''}</div>
      </div>
      <div class="transaction-amount ${isIncome ? 'income' : 'expense'}">${isIncome ? '+' : '-'}${fmt(amount)}${tipText}</div>
      <div class="transaction-actions">
        <button class="action-btn delete" onclick="event.stopPropagation();deleteTransaction('${t.id}')">×</button>
      </div>
    </div>
  `;
}

function switchEntriesView(mode) {
  state.entriesViewMode = mode;
  document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.view-tab:nth-child(${mode === 'daily' ? 1 : mode === 'monthly' ? 2 : 3})`).classList.add('active');
  renderEntriesContent();
  renderEntryForm();
}

function changeEntriesDate(days) {
  state.selectedDate = addDays(state.selectedDate, days);
  renderEntriesContent();
}

function changeEntriesMonth(months) {
  state.selectedMonth += months;
  if (state.selectedMonth > 12) { state.selectedMonth = 1; state.selectedYear++; }
  if (state.selectedMonth < 1) { state.selectedMonth = 12; state.selectedYear--; }
  renderEntriesContent();
}

function loadMoreTransactions() {
  state.transactionsToShow += 30;
  renderEntriesContent();
}


// ----------------------------------------------------------------
// 12. ENTRY FORM
// ----------------------------------------------------------------

function renderEntryForm() {
  const container = document.getElementById('entry-form-content');
  if (!container) return;
  
  const isMonthly = state.entriesViewMode === 'monthly';
  
  if (isMonthly) {
    container.innerHTML = `
      <div class="form-group">
        <label class="form-label">Category</label>
        <select class="form-select" id="entry-category">
          <option value="">Select category...</option>
          ${categoryOptions('EXPENSE')}
        </select>
      </div>
      
      <div class="form-group">
        <label class="form-label">Amount ($)</label>
        <input type="number" class="form-input" id="entry-amount" placeholder="0.00" step="0.01" min="0">
      </div>
      
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Month</label>
          <select class="form-select" id="entry-month">
            ${Array.from({length:12},(_,i) => `<option value="${i+1}" ${i+1===state.selectedMonth?'selected':''}>${monthName(i+1)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Year</label>
          <input type="number" class="form-input" id="entry-year" value="${state.selectedYear}" min="2020" max="2099">
        </div>
      </div>
      
      <div class="form-group">
        <label class="form-label">Notes (optional)</label>
        <input type="text" class="form-input" id="entry-notes" placeholder="e.g. rent increase, quarterly bill...">
      </div>
      
      <button class="btn-primary" onclick="saveMonthlyExpense()">Add Monthly Expense</button>
    `;
  } else {
    container.innerHTML = `
      <div class="form-group">
        <label class="form-label">Type</label>
        <div class="toggle-group">
          <button class="toggle-btn income active" id="type-income" onclick="setEntryType('INCOME')">Income</button>
          <button class="toggle-btn expense" id="type-expense" onclick="setEntryType('EXPENSE')">Expense</button>
        </div>
      </div>
      
      <div class="form-group">
        <label class="form-label">Category</label>
        <select class="form-select" id="entry-category">
          <option value="">Select category...</option>
          ${categoryOptions('INCOME')}
        </select>
      </div>
      
      <div class="form-group" id="client-field">
        <label class="form-label">Client Name (optional)</label>
        <input type="text" class="form-input" id="entry-client" placeholder="Client name...">
      </div>
      
      <div class="form-row" id="income-amounts">
        <div class="form-group">
          <label class="form-label">Service Amount ($)</label>
          <input type="number" class="form-input" id="entry-service" placeholder="0.00" step="0.01" min="0">
        </div>
        <div class="form-group">
          <label class="form-label">Tip ($)</label>
          <input type="number" class="form-input" id="entry-tip" placeholder="0.00" step="0.01" min="0">
        </div>
      </div>
      
      <div class="form-group hidden" id="expense-amount">
        <label class="form-label">Amount ($)</label>
        <input type="number" class="form-input" id="entry-amount" placeholder="0.00" step="0.01" min="0">
      </div>
      
      <div class="form-group">
        <label class="form-label">Date</label>
        <input type="date" class="form-input" id="entry-date" value="${state.selectedDate}">
      </div>
      
      <div class="form-group">
        <label class="form-label">Payment Method</label>
        <select class="form-select" id="entry-payment">
          <option value="Cash">Cash</option>
          <option value="Card">Card</option>
          <option value="Venmo">Venmo</option>
          <option value="Zelle">Zelle</option>
          <option value="Other">Other</option>
        </select>
      </div>
      
      <div class="form-group">
        <label class="form-label">Notes (optional)</label>
        <input type="text" class="form-input" id="entry-notes" placeholder="Any notes...">
      </div>
      
      <button class="btn-primary" onclick="saveEntry()">Add Entry</button>
    `;
  }
}

let currentEntryType = 'INCOME';

function setEntryType(type) {
  currentEntryType = type;
  
  document.getElementById('type-income').classList.toggle('active', type === 'INCOME');
  document.getElementById('type-expense').classList.toggle('active', type === 'EXPENSE');
  
  document.getElementById('client-field').classList.toggle('hidden', type === 'EXPENSE');
  document.getElementById('income-amounts').classList.toggle('hidden', type === 'EXPENSE');
  document.getElementById('expense-amount').classList.toggle('hidden', type === 'INCOME');
  
  // Update category options
  document.getElementById('entry-category').innerHTML = `
    <option value="">Select category...</option>
    ${categoryOptions(type)}
  `;
}

async function saveEntry() {
  const category = document.getElementById('entry-category').value;
  const date = document.getElementById('entry-date').value;
  const payment = document.getElementById('entry-payment').value;
  const notes = document.getElementById('entry-notes').value.trim();
  
  if (!category) { showToast('Please select a category'); return; }
  
  const record = {
    type: currentEntryType,
    category,
    date,
    paymentMethod: payment,
    notes,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  
  if (currentEntryType === 'INCOME') {
    const service = parseFloat(document.getElementById('entry-service').value) || 0;
    const tip = parseFloat(document.getElementById('entry-tip').value) || 0;
    const client = document.getElementById('entry-client').value.trim();
    
    if (service <= 0 && tip <= 0) { showToast('Please enter an amount'); return; }
    
    record.serviceAmount = service;
    record.tipAmount = tip;
    record.amount = service;
    record.clientName = client || null;
  } else {
    const amount = parseFloat(document.getElementById('entry-amount').value) || 0;
    if (amount <= 0) { showToast('Please enter an amount'); return; }
    record.amount = amount;
    record.serviceAmount = 0;
    record.tipAmount = 0;
  }
  
  try {
    await db.transactions.add(record);
    showToast('Entry saved ✓');
    
    // Reset form
    document.getElementById('entry-category').value = '';
    document.getElementById('entry-notes').value = '';
    if (currentEntryType === 'INCOME') {
      document.getElementById('entry-service').value = '';
      document.getElementById('entry-tip').value = '';
      document.getElementById('entry-client').value = '';
    } else {
      document.getElementById('entry-amount').value = '';
    }
    
    // Update date in state and refresh
    state.selectedDate = date;
    await renderEntriesContent();
  } catch(err) {
    console.error('Save error:', err);
    showToast('Error saving entry');
  }
}

async function saveMonthlyExpense() {
  const category = document.getElementById('entry-category').value;
  const amount = parseFloat(document.getElementById('entry-amount').value) || 0;
  const month = parseInt(document.getElementById('entry-month').value);
  const year = parseInt(document.getElementById('entry-year').value);
  const notes = document.getElementById('entry-notes').value.trim();
  
  if (!category) { showToast('Please select a category'); return; }
  if (amount <= 0) { showToast('Please enter an amount'); return; }
  
  try {
    await db.monthlyExpenses.add({
      category, amount, month, year, notes,
      datePaid: todayStr()
    });
    showToast('Monthly expense saved ✓');
    
    // Reset form
    document.getElementById('entry-category').value = '';
    document.getElementById('entry-amount').value = '';
    document.getElementById('entry-notes').value = '';
    
    // Update state and refresh
    state.selectedMonth = month;
    state.selectedYear = year;
    await renderEntriesContent();
  } catch(err) {
    console.error('Save error:', err);
    showToast('Error saving expense');
  }
}


// ----------------------------------------------------------------
// 13. TRANSACTION MODALS
// ----------------------------------------------------------------

async function openEditTransactionModal(id) {
  const t = await db.transactions.get(id);
  if (!t) return;
  
  const isIncome = t.type === 'INCOME';
  
  openModal(`
    <h2 class="modal-title">Edit ${isIncome ? 'Income' : 'Expense'}</h2>
    
    <div class="form-group">
      <label class="form-label">Category</label>
      <select class="form-select" id="edit-category">
        ${(isIncome ? state.categories.INCOME : state.categories.EXPENSE).map(c => 
          `<option value="${c}" ${c === t.category ? 'selected' : ''}>${c}</option>`
        ).join('')}
      </select>
    </div>
    
    ${isIncome ? `
      <div class="form-group">
        <label class="form-label">Client Name</label>
        <input type="text" class="form-input" id="edit-client" value="${t.clientName || ''}">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Service Amount ($)</label>
          <input type="number" class="form-input" id="edit-service" value="${t.serviceAmount || 0}" step="0.01">
        </div>
        <div class="form-group">
          <label class="form-label">Tip ($)</label>
          <input type="number" class="form-input" id="edit-tip" value="${t.tipAmount || 0}" step="0.01">
        </div>
      </div>
    ` : `
      <div class="form-group">
        <label class="form-label">Amount ($)</label>
        <input type="number" class="form-input" id="edit-amount" value="${t.amount || 0}" step="0.01">
      </div>
    `}
    
    <div class="form-group">
      <label class="form-label">Date</label>
      <input type="date" class="form-input" id="edit-date" value="${t.date}">
    </div>
    
    <div class="form-group">
      <label class="form-label">Payment Method</label>
      <select class="form-select" id="edit-payment">
        ${['Cash','Card','Venmo','Zelle','Other'].map(p => 
          `<option value="${p}" ${p === t.paymentMethod ? 'selected' : ''}>${p}</option>`
        ).join('')}
      </select>
    </div>
    
    <div class="form-group">
      <label class="form-label">Notes</label>
      <input type="text" class="form-input" id="edit-notes" value="${t.notes || ''}">
    </div>
    
    <div style="display:flex;gap:12px;margin-top:24px;">
      <button class="btn-secondary" style="flex:1;" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" style="flex:1;" onclick="updateTransaction('${id}', ${isIncome})">Save Changes</button>
    </div>
  `);
}

async function updateTransaction(id, isIncome) {
  const category = document.getElementById('edit-category').value;
  const date = document.getElementById('edit-date').value;
  const payment = document.getElementById('edit-payment').value;
  const notes = document.getElementById('edit-notes').value.trim();
  
  const changes = { category, date, paymentMethod: payment, notes };
  
  if (isIncome) {
    changes.serviceAmount = parseFloat(document.getElementById('edit-service').value) || 0;
    changes.tipAmount = parseFloat(document.getElementById('edit-tip').value) || 0;
    changes.amount = changes.serviceAmount;
    changes.clientName = document.getElementById('edit-client').value.trim() || null;
  } else {
    changes.amount = parseFloat(document.getElementById('edit-amount').value) || 0;
  }
  
  try {
    await db.transactions.update(id, changes);
    closeModal();
    showToast('Entry updated ✓');
    await renderEntriesContent();
  } catch(err) {
    console.error('Update error:', err);
    showToast('Error updating entry');
  }
}

async function deleteTransaction(id) {
  const t = await db.transactions.get(id);
  if (!t) return;
  
  const confirmed = await confirmDialog(
    `Delete this ${t.type === 'INCOME' ? 'income' : 'expense'} entry?\n\n${t.category}: ${fmt(t.type === 'INCOME' ? (t.serviceAmount||0)+(t.tipAmount||0) : t.amount)}`,
    'Confirm Delete'
  );
  
  if (!confirmed) return;
  
  try {
    await db.transactions.delete(id);
    showToast('Entry deleted');
    await renderEntriesContent();
  } catch(err) {
    console.error('Delete error:', err);
    showToast('Error deleting entry');
  }
}

async function openEditMonthlyExpenseModal(id) {
  const e = await db.monthlyExpenses.get(id);
  if (!e) return;
  
  openModal(`
    <h2 class="modal-title">Edit Monthly Expense</h2>
    
    <div class="form-group">
      <label class="form-label">Category</label>
      <select class="form-select" id="edit-category">
        ${state.categories.EXPENSE.map(c => 
          `<option value="${c}" ${c === e.category ? 'selected' : ''}>${c}</option>`
        ).join('')}
      </select>
    </div>
    
    <div class="form-group">
      <label class="form-label">Amount ($)</label>
      <input type="number" class="form-input" id="edit-amount" value="${e.amount || 0}" step="0.01">
    </div>
    
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Month</label>
        <select class="form-select" id="edit-month">
          ${Array.from({length:12},(_,i) => `<option value="${i+1}" ${i+1===e.month?'selected':''}>${monthName(i+1)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Year</label>
        <input type="number" class="form-input" id="edit-year" value="${e.year}" min="2020" max="2099">
      </div>
    </div>
    
    <div class="form-group">
      <label class="form-label">Notes</label>
      <input type="text" class="form-input" id="edit-notes" value="${e.notes || ''}">
    </div>
    
    <div style="display:flex;gap:12px;margin-top:24px;">
      <button class="btn-secondary" style="flex:1;" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" style="flex:1;" onclick="updateMonthlyExpense('${id}')">Save Changes</button>
    </div>
  `);
}

async function updateMonthlyExpense(id) {
  const category = document.getElementById('edit-category').value;
  const amount = parseFloat(document.getElementById('edit-amount').value) || 0;
  const month = parseInt(document.getElementById('edit-month').value);
  const year = parseInt(document.getElementById('edit-year').value);
  const notes = document.getElementById('edit-notes').value.trim();
  
  try {
    await db.monthlyExpenses.update(id, { category, amount, month, year, notes });
    closeModal();
    showToast('Expense updated ✓');
    await renderEntriesContent();
  } catch(err) {
    console.error('Update error:', err);
    showToast('Error updating expense');
  }
}

async function deleteMonthlyExpense(id) {
  const e = await db.monthlyExpenses.get(id);
  if (!e) return;
  
  const confirmed = await confirmDialog(
    `Delete this monthly expense?\n\n${e.category}: ${fmt(e.amount)}`,
    'Confirm Delete'
  );
  
  if (!confirmed) return;
  
  try {
    await db.monthlyExpenses.delete(id);
    showToast('Expense deleted');
    await renderEntriesContent();
  } catch(err) {
    console.error('Delete error:', err);
    showToast('Error deleting expense');
  }
}


// ----------------------------------------------------------------
// 14. RENTERS VIEW
// ----------------------------------------------------------------

async function renderRentersView() {
  const content = document.getElementById('app-content');
  
  const allRenters = await db.renters.toArray();
  const allPayments = await db.rentPayments.toArray();
  const activeRenters = allRenters.filter(r => r.status === 'active');
  
  // Week navigation
  if (!state.rentersWeekStart) {
    state.rentersWeekStart = getWeekStart(todayStr());
  }
  const weekStart = state.rentersWeekStart;
  
  // Calculate totals for current week
  let weekExpected = 0;
  let weekCollected = 0;
  let paidCount = 0;
  
  activeRenters.forEach(r => {
    const rate = getRateForWeek(r, weekStart);
    weekExpected += rate;
    const pmt = allPayments.find(p => p.renterId === r.id && p.weekStart === weekStart);
    if (pmt) {
      weekCollected += pmt.amount || 0;
      paidCount++;
    }
  });
  
  const weekOutstanding = Math.max(0, weekExpected - weekCollected);
  
  let html = `
    <!-- Header -->
    <div class="renters-header">
      <div class="week-nav">
        <button class="date-nav-btn" onclick="changeRentersWeek(-7)">‹</button>
        <div class="week-display">Week of ${formatWeekRange(weekStart)}</div>
        <button class="date-nav-btn" onclick="changeRentersWeek(7)">›</button>
      </div>
      <button class="btn-primary" onclick="openAddRenterModal()">+ Add Renter</button>
    </div>
    
    <!-- Summary Stats -->
    <div class="renters-summary">
      <div class="renter-stat">
        <div class="renter-stat-label">Expected</div>
        <div class="renter-stat-value">${fmt(weekExpected)}</div>
      </div>
      <div class="renter-stat">
        <div class="renter-stat-label">Collected</div>
        <div class="renter-stat-value success">${fmt(weekCollected)}</div>
      </div>
      <div class="renter-stat">
        <div class="renter-stat-label">Outstanding</div>
        <div class="renter-stat-value ${weekOutstanding > 0 ? 'danger' : ''}">${fmt(weekOutstanding)}</div>
      </div>
      <div class="renter-stat">
        <div class="renter-stat-label">Paid</div>
        <div class="renter-stat-value">${paidCount} / ${activeRenters.length}</div>
      </div>
    </div>
    
    <!-- Renters Grid -->
    <div class="renters-grid">
  `;
  
  if (activeRenters.length === 0) {
    html += `
      <div class="empty-state" style="grid-column:1/-1;">
        <div class="empty-icon">🏠</div>
        <div class="empty-title">No booth renters yet</div>
        <div class="empty-text">Add your first booth renter to start tracking payments</div>
      </div>
    `;
  } else {
    activeRenters.forEach(r => {
      ensureRateHistory(r);
      const rate = getRateForWeek(r, weekStart);
      const pmt = allPayments.find(p => p.renterId === r.id && p.weekStart === weekStart);
      const isPaid = !!pmt;
      const status = isPaid ? getRentStatus(weekStart, pmt.datePaid) : 'unpaid';
      
      html += `
        <div class="renter-card" onclick="openRenterDetail('${r.id}')">
          <div class="renter-card-header">
            <div class="renter-avatar">👤</div>
            <div class="renter-info">
              <div class="renter-name">${r.name}</div>
              <div class="renter-booth">${r.booth ? 'Booth ' + r.booth : ''}</div>
            </div>
            <div class="renter-status ${isPaid ? 'paid' : 'unpaid'}">
              ${isPaid ? (status === 'ontime' ? '✓ Paid' : '⚠ Late') : 'Unpaid'}
            </div>
          </div>
          <div class="renter-card-body">
            <div>
              <div class="renter-rate">${fmt(rate)}</div>
              <div class="renter-rate-label">per week</div>
            </div>
            ${!isPaid ? `
              <button class="btn-primary" style="padding:10px 20px;" onclick="event.stopPropagation();openLogPaymentModal('${r.id}')">
                Log Payment
              </button>
            ` : `
              <div style="text-align:right;">
                <div style="font-size:14px;color:var(--success);font-weight:600;">${fmt(pmt.amount)}</div>
                <div style="font-size:12px;color:var(--text-muted);">${formatDateShort(pmt.datePaid)}</div>
              </div>
            `}
          </div>
        </div>
      `;
    });
  }
  
  html += `</div>`;
  content.innerHTML = html;
}

function changeRentersWeek(days) {
  state.rentersWeekStart = addDays(state.rentersWeekStart, days);
  renderRentersView();
}

// Renter Modals
function openAddRenterModal() {
  openModal(`
    <h2 class="modal-title">Add Booth Renter</h2>
    
    <div class="form-group">
      <label class="form-label">Name *</label>
      <input type="text" class="form-input" id="renter-name" placeholder="Full name">
    </div>
    
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Booth #</label>
        <input type="text" class="form-input" id="renter-booth" placeholder="e.g. 1, 2...">
      </div>
      <div class="form-group">
        <label class="form-label">Weekly Rate ($)</label>
        <input type="number" class="form-input" id="renter-rate" value="140" step="0.01">
      </div>
    </div>
    
    <div class="form-group">
      <label class="form-label">Start Date</label>
      <input type="date" class="form-input" id="renter-start" value="${todayStr()}">
    </div>
    
    <div class="form-group">
      <label class="form-label">Notes</label>
      <input type="text" class="form-input" id="renter-notes" placeholder="Any notes...">
    </div>
    
    <button class="btn-primary" style="width:100%;margin-top:16px;" onclick="saveNewRenter()">Add Renter</button>
  `);
}

async function saveNewRenter() {
  const name = document.getElementById('renter-name').value.trim();
  const booth = document.getElementById('renter-booth').value.trim();
  const rate = parseFloat(document.getElementById('renter-rate').value) || 140;
  const start = document.getElementById('renter-start').value;
  const notes = document.getElementById('renter-notes').value.trim();
  
  if (!name) { showToast('Name is required'); return; }
  
  try {
    await db.renters.add({
      name,
      booth: booth || null,
      weeklyRate: rate,
      rateHistory: [{ rate, effectiveDate: start || todayStr() }],
      startDate: start,
      notes,
      status: 'active'
    });
    
    await updateRentersTabVisibility();
    closeModal();
    showToast(`${name} added ✓`);
    navigate('renters');
  } catch(err) {
    console.error('Save error:', err);
    showToast('Error adding renter');
  }
}

function openLogPaymentModal(renterId) {
  const weekStart = state.rentersWeekStart || getWeekStart(todayStr());
  
  openModal(`
    <h2 class="modal-title">Log Rent Payment</h2>
    <p style="color:var(--text-muted);margin-bottom:20px;">Week of ${formatWeekRange(weekStart)}</p>
    
    <div class="form-group">
      <label class="form-label">Amount ($)</label>
      <input type="number" class="form-input" id="payment-amount" value="140" step="0.01">
    </div>
    
    <div class="form-group">
      <label class="form-label">Date Paid</label>
      <input type="date" class="form-input" id="payment-date" value="${todayStr()}">
    </div>
    
    <div class="form-group">
      <label class="form-label">Payment Method</label>
      <select class="form-select" id="payment-method">
        <option value="Cash">Cash</option>
        <option value="Check">Check</option>
        <option value="Venmo">Venmo</option>
        <option value="Zelle">Zelle</option>
        <option value="Other">Other</option>
      </select>
    </div>
    
    <div class="form-group">
      <label class="form-label">Notes</label>
      <input type="text" class="form-input" id="payment-notes" placeholder="Any notes...">
    </div>
    
    <button class="btn-primary" style="width:100%;margin-top:16px;" onclick="saveRentPayment('${renterId}', '${weekStart}')">Save Payment</button>
  `);
}

async function saveRentPayment(renterId, weekStart) {
  const amount = parseFloat(document.getElementById('payment-amount').value) || 0;
  const datePaid = document.getElementById('payment-date').value;
  const method = document.getElementById('payment-method').value;
  const notes = document.getElementById('payment-notes').value.trim();
  
  if (amount <= 0) { showToast('Please enter an amount'); return; }
  
  // Get renter and their weekly rate
  const renter = await db.renters.get(renterId);
  ensureRateHistory(renter);
  const weekRate = getRateForWeek(renter, weekStart);
  
  // If amount is more than 1 week's rate, offer to fill missed weeks
  if (amount > weekRate * 1.01) {
    openCatchUpModal(renterId, amount, datePaid, method, notes);
    return;
  }
  
  // Check for existing payment
  const existing = await db.rentPayments.where('renterId').equals(renterId)
    .filter(p => p.weekStart === weekStart).first();
  
  if (existing) {
    await db.rentPayments.update(existing.id, { amount, datePaid, paymentMethod: method, notes });
  } else {
    await db.rentPayments.add({
      renterId,
      weekStart,
      amount,
      datePaid,
      paymentMethod: method,
      notes
    });
  }
  
  closeModal();
  showToast('Payment logged ✓');
  await renderRentersView();
}

async function openCatchUpModal(renterId, totalAmount, datePaid, method, notes) {
  const r = await db.renters.get(renterId);
  ensureRateHistory(r);
  const allPmts = await db.rentPayments.where('renterId').equals(renterId).toArray();
  const ws = state.rentersWeekStart || getWeekStart(todayStr());
  
  // Find unpaid AND underpaid weeks going back up to 16 weeks
  const unpaidWeeks = [];
  for (let i = 0; i < 16; i++) {
    const weekStart = addDays(ws, -(i * 7));
    if (r.startDate && weekStart < getWeekStart(r.startDate)) break;
    
    const rate = getRateForWeek(r, weekStart);
    const existingPmt = allPmts.find(p => p.weekStart === weekStart);
    
    if (!existingPmt) {
      unpaidWeeks.push({ weekStart, rate, amountDue: rate, paid: 0, status: 'unpaid' });
    } else if (existingPmt.amount < rate - 0.01) {
      const stillOwes = rate - existingPmt.amount;
      unpaidWeeks.push({ weekStart, rate, amountDue: stillOwes, paid: existingPmt.amount, status: 'partial' });
    }
  }
  
  if (unpaidWeeks.length === 0) {
    // No missed weeks — just log as single payment on current week
    await db.rentPayments.add({
      renterId, weekStart: ws, amount: totalAmount, datePaid, paymentMethod: method, notes
    });
    closeModal();
    showToast('Payment logged ✓');
    await renderRentersView();
    return;
  }
  
  // Auto-select: current week first, then oldest unpaid weeks
  let remaining = totalAmount;
  const selections = [];
  
  const currentWeekEntry = unpaidWeeks.find(w => w.weekStart === ws);
  if (currentWeekEntry && remaining >= currentWeekEntry.amountDue) {
    selections.push(currentWeekEntry.weekStart);
    remaining -= currentWeekEntry.amountDue;
  }
  
  const oldestFirst = [...unpaidWeeks].reverse().filter(w => w.weekStart !== ws);
  for (const week of oldestFirst) {
    if (remaining >= week.amountDue) {
      selections.push(week.weekStart);
      remaining -= week.amountDue;
    }
  }
  
  // Store data for later
  window._catchUpData = { renterId, totalAmount, datePaid, method, notes, unpaidWeeks };
  
  const weeksHTML = unpaidWeeks.map(w => {
    const checked = selections.includes(w.weekStart) ? 'checked' : '';
    const label = formatWeekRange(w.weekStart);
    const statusLabel = w.weekStart === ws ? 'Current week'
      : w.status === 'partial' ? `Partial — ${fmt(w.paid)} of ${fmt(w.rate)} paid`
      : 'Unpaid';
    return `
      <label style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--cream);border-radius:8px;margin-bottom:8px;cursor:pointer;">
        <input type="checkbox" class="catchup-week" value="${w.weekStart}" data-rate="${w.amountDue}" ${checked}
          onchange="updateCatchUpSummary()"
          style="width:20px;height:20px;accent-color:var(--plum);">
        <div style="flex:1;">
          <div style="font-weight:500;">${label}</div>
          <div style="font-size:12px;color:var(--text-muted);">${statusLabel}</div>
        </div>
        <div style="font-weight:600;">${fmt(w.amountDue)}</div>
      </label>
    `;
  }).join('');
  
  openModal(`
    <h2 class="modal-title">Apply Catch-Up Payment</h2>
    <p style="color:var(--text-muted);margin-bottom:16px;">
      Payment of <strong>${fmt(totalAmount)}</strong> exceeds weekly rate. Select weeks to apply:
    </p>
    
    <div style="max-height:300px;overflow-y:auto;margin-bottom:16px;">
      ${weeksHTML}
    </div>
    
    <div id="catchup-summary" style="background:var(--cream);border-radius:8px;padding:12px;margin-bottom:16px;">
      <!-- Updated by updateCatchUpSummary -->
    </div>
    
    <button class="btn-primary" style="width:100%;" onclick="saveCatchUpPayments()">Apply Payments</button>
  `);
  
  updateCatchUpSummary();
}

function updateCatchUpSummary() {
  const data = window._catchUpData;
  if (!data) return;
  
  const checks = document.querySelectorAll('.catchup-week:checked');
  let selectedTotal = 0;
  checks.forEach(c => { selectedTotal += parseFloat(c.dataset.rate) || 0; });
  
  const remainder = data.totalAmount - selectedTotal;
  const summaryEl = document.getElementById('catchup-summary');
  
  if (summaryEl) {
    summaryEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
        <span>Payment amount:</span><strong>${fmt(data.totalAmount)}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
        <span>Selected weeks (${checks.length}):</span><strong>${fmt(selectedTotal)}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;color:${remainder > 0.01 ? 'var(--danger)' : remainder < -0.01 ? 'var(--success)' : 'var(--text)'};">
        <span>${remainder > 0.01 ? 'Remainder (credit):' : remainder < -0.01 ? 'Short by:' : 'Balance:'}</span>
        <strong>${fmt(Math.abs(remainder))}</strong>
      </div>
    `;
  }
}

async function saveCatchUpPayments() {
  const data = window._catchUpData;
  if (!data) return;
  
  const checks = document.querySelectorAll('.catchup-week:checked');
  if (checks.length === 0) {
    showToast('Please select at least one week');
    return;
  }
  
  const allPmts = await db.rentPayments.where('renterId').equals(data.renterId).toArray();
  const weekStarts = Array.from(checks).map(c => c.value);
  
  // Build catch-up note
  const catchUpNote = weekStarts.length > 1 
    ? `catch-up: ${weekStarts.length} weeks` 
    : '';
  const finalNotes = [data.notes, catchUpNote].filter(Boolean).join(' • ');
  
  // Create/update payment for each selected week
  for (const weekStart of weekStarts) {
    const weekData = data.unpaidWeeks.find(w => w.weekStart === weekStart);
    if (!weekData) continue;
    
    const existing = allPmts.find(p => p.weekStart === weekStart);
    const newAmount = existing ? existing.amount + weekData.amountDue : weekData.amountDue;
    
    if (existing) {
      await db.rentPayments.update(existing.id, {
        amount: newAmount,
        datePaid: data.datePaid,
        paymentMethod: data.method,
        notes: finalNotes
      });
    } else {
      await db.rentPayments.add({
        renterId: data.renterId,
        weekStart,
        amount: weekData.amountDue,
        datePaid: data.datePaid,
        paymentMethod: data.method,
        notes: finalNotes
      });
    }
  }
  
  window._catchUpData = null;
  closeModal();
  showToast(`${checks.length} week${checks.length > 1 ? 's' : ''} logged ✓`);
  await renderRentersView();
}

async function openRenterDetail(renterId) {
  const r = await db.renters.get(renterId);
  if (!r) return;
  
  const payments = await db.rentPayments.where('renterId').equals(renterId).toArray();
  payments.sort((a,b) => b.weekStart.localeCompare(a.weekStart));
  
  ensureRateHistory(r);
  const curRate = getCurrentRate(r);
  
  const historyHTML = payments.length === 0 
    ? '<p style="color:var(--text-muted);text-align:center;padding:20px;">No payment history yet</p>'
    : payments.slice(0, 10).map(p => {
        const status = getRentStatus(p.weekStart, p.datePaid);
        return `
          <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border-light);">
            <div style="font-size:20px;">${status === 'ontime' ? '✅' : '⚠️'}</div>
            <div style="flex:1;">
              <div style="font-weight:500;">${formatWeekRange(p.weekStart)}</div>
              <div style="font-size:12px;color:var(--text-muted);">Paid ${formatDateShort(p.datePaid)} · ${p.paymentMethod}</div>
            </div>
            <div style="text-align:right;">
              <div style="font-weight:600;color:var(--success);">${fmt(p.amount)}</div>
              <div style="font-size:11px;color:${status === 'ontime' ? 'var(--success)' : 'var(--danger)'};">${status === 'ontime' ? 'On Time' : 'Late'}</div>
            </div>
          </div>
        `;
      }).join('');
  
  openModal(`
    <h2 class="modal-title">${r.name}</h2>
    <div style="display:flex;gap:16px;margin-bottom:20px;color:var(--text-muted);font-size:14px;">
      ${r.booth ? `<span>Booth ${r.booth}</span>` : ''}
      <span>${fmt(curRate)}/week</span>
      <span>Since ${r.startDate ? formatDateShort(r.startDate) : 'N/A'}</span>
    </div>
    
    <div style="display:flex;gap:12px;margin-bottom:24px;">
      <button class="btn-secondary" style="flex:1;" onclick="openLogPaymentModal('${r.id}');closeModal()">+ Log Payment</button>
      <button class="btn-secondary" style="flex:1;" onclick="openEditRenterModal('${r.id}')">Edit Profile</button>
    </div>
    
    <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:12px;">Payment History</div>
    ${historyHTML}
  `);
}

async function openEditRenterModal(renterId) {
  const r = await db.renters.get(renterId);
  if (!r) return;
  ensureRateHistory(r);
  
  openModal(`
    <h2 class="modal-title">Edit Renter</h2>
    
    <div class="form-group">
      <label class="form-label">Name</label>
      <input type="text" class="form-input" id="edit-renter-name" value="${r.name}">
    </div>
    
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Booth #</label>
        <input type="text" class="form-input" id="edit-renter-booth" value="${r.booth || ''}">
      </div>
      <div class="form-group">
        <label class="form-label">Current Rate ($)</label>
        <input type="number" class="form-input" id="edit-renter-rate" value="${getCurrentRate(r)}" step="0.01">
      </div>
    </div>
    
    <div class="form-group">
      <label class="form-label">Start Date</label>
      <input type="date" class="form-input" id="edit-renter-start" value="${r.startDate || ''}">
    </div>
    
    <div class="form-group">
      <label class="form-label">Notes</label>
      <input type="text" class="form-input" id="edit-renter-notes" value="${r.notes || ''}">
    </div>
    
    <div style="display:flex;gap:12px;margin-top:24px;">
      <button class="btn-danger" style="flex:1;" onclick="deactivateRenter('${r.id}')">Deactivate</button>
      <button class="btn-primary" style="flex:1;" onclick="saveEditRenter('${r.id}')">Save Changes</button>
    </div>
  `);
}

async function saveEditRenter(renterId) {
  const name = document.getElementById('edit-renter-name').value.trim();
  const booth = document.getElementById('edit-renter-booth').value.trim();
  const rate = parseFloat(document.getElementById('edit-renter-rate').value) || 140;
  const start = document.getElementById('edit-renter-start').value;
  const notes = document.getElementById('edit-renter-notes').value.trim();
  
  if (!name) { showToast('Name is required'); return; }
  
  const r = await db.renters.get(renterId);
  ensureRateHistory(r);
  
  // Update rate if changed
  const currentRate = getCurrentRate(r);
  if (rate !== currentRate) {
    r.rateHistory.push({ rate, effectiveDate: todayStr() });
  }
  
  try {
    await db.renters.update(renterId, {
      name,
      booth: booth || null,
      weeklyRate: rate,
      rateHistory: r.rateHistory,
      startDate: start,
      notes
    });
    
    closeModal();
    showToast('Renter updated ✓');
    await renderRentersView();
  } catch(err) {
    console.error('Update error:', err);
    showToast('Error updating renter');
  }
}

async function deactivateRenter(renterId) {
  const r = await db.renters.get(renterId);
  if (!r) return;
  
  const confirmed = await confirmDialog(
    `Deactivate ${r.name}? They will be hidden but payment history is preserved.`,
    'Confirm Deactivate'
  );
  
  if (!confirmed) return;
  
  try {
    await db.renters.update(renterId, { status: 'inactive' });
    closeModal();
    showToast(`${r.name} deactivated`);
    await renderRentersView();
  } catch(err) {
    console.error('Deactivate error:', err);
    showToast('Error deactivating renter');
  }
}


// ----------------------------------------------------------------
// 15. CLIENTS VIEW
// ----------------------------------------------------------------

async function renderClientsView() {
  const content = document.getElementById('app-content');
  const txns = await db.transactions.toArray();
  const incomes = txns.filter(t => t.type === 'INCOME' && t.clientName);
  
  // Build client stats
  const clients = {};
  incomes.forEach(t => {
    const name = t.clientName.trim();
    if (!name) return;
    if (!clients[name]) {
      clients[name] = { name, total: 0, visits: 0, tips: 0, lastVisit: null, services: {} };
    }
    const c = clients[name];
    c.total += (t.serviceAmount || 0) + (t.tipAmount || 0);
    c.tips += t.tipAmount || 0;
    c.visits++;
    if (!c.lastVisit || t.date > c.lastVisit) c.lastVisit = t.date;
    c.services[t.category] = (c.services[t.category] || 0) + 1;
  });
  
  let clientList = Object.values(clients);
  
  // Sort based on current sort setting
  const sortBy = state.clientSort || 'total';
  switch(sortBy) {
    case 'total': clientList.sort((a, b) => b.total - a.total); break;
    case 'visits': clientList.sort((a, b) => b.visits - a.visits); break;
    case 'firstName': clientList.sort((a, b) => a.name.localeCompare(b.name)); break;
    case 'lastName': 
      clientList.sort((a, b) => {
        const aLast = a.name.split(' ').pop() || a.name;
        const bLast = b.name.split(' ').pop() || b.name;
        return aLast.localeCompare(bLast);
      }); 
      break;
    case 'recent': clientList.sort((a, b) => (b.lastVisit || '').localeCompare(a.lastVisit || '')); break;
  }
  
  const today = todayStr();
  
  let html = `
    <div class="clients-controls">
      <div class="search-input-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <input type="text" class="search-input" id="client-search" placeholder="Search clients..." oninput="filterClients()">
      </div>
      <div style="display:flex;align-items:center;gap:12px;">
        <label style="font-size:13px;color:var(--text-muted);">Sort by:</label>
        <select class="form-select" style="width:150px;padding:8px 12px;" onchange="state.clientSort=this.value;renderClientsView()">
          <option value="total" ${sortBy === 'total' ? 'selected' : ''}>Total Spent</option>
          <option value="visits" ${sortBy === 'visits' ? 'selected' : ''}>Number of Visits</option>
          <option value="firstName" ${sortBy === 'firstName' ? 'selected' : ''}>First Name</option>
          <option value="lastName" ${sortBy === 'lastName' ? 'selected' : ''}>Last Name</option>
          <option value="recent" ${sortBy === 'recent' ? 'selected' : ''}>Most Recent</option>
        </select>
        <span style="color:var(--text-muted);font-size:14px;">${clientList.length} clients</span>
      </div>
    </div>
    <div class="clients-grid" id="clients-grid">
  `;
  
  if (clientList.length === 0) {
    html += `
      <div class="empty-state" style="grid-column:1/-1;">
        <div class="empty-icon">👥</div>
        <div class="empty-title">No clients yet</div>
        <div class="empty-text">Add client names to your income entries to track them here</div>
      </div>
    `;
  } else {
    clientList.forEach(c => {
      const avgTicket = c.visits > 0 ? c.total / c.visits : 0;
      const topService = Object.entries(c.services).sort((a,b) => b[1] - a[1])[0];
      const daysSince = c.lastVisit ? Math.floor((new Date(today) - new Date(c.lastVisit)) / 86400000) : 999;
      const isOverdue = daysSince > 60;
      
      html += `
        <div class="client-card" data-name="${c.name.toLowerCase()}" onclick="openClientDetail('${c.name.replace(/'/g, "\\'")}')">
          <div class="client-header">
            <div class="client-avatar">${c.name.charAt(0).toUpperCase()}</div>
            <div class="client-info">
              <div class="client-name">${c.name} ${isOverdue ? '<span style="color:var(--danger);font-size:11px;">⚠ Overdue</span>' : ''}</div>
              <div class="client-meta">${topService ? topService[0] : 'Various services'}</div>
            </div>
          </div>
          <div class="client-stats">
            <div class="client-stat">
              <div class="client-stat-value">${fmt(c.total)}</div>
              <div class="client-stat-label">Total Spent</div>
            </div>
            <div class="client-stat">
              <div class="client-stat-value">${c.visits}</div>
              <div class="client-stat-label">Visits</div>
            </div>
            <div class="client-stat">
              <div class="client-stat-value">${fmt(avgTicket)}</div>
              <div class="client-stat-label">Avg Ticket</div>
            </div>
          </div>
        </div>
      `;
    });
  }
  
  html += `</div>`;
  content.innerHTML = html;
}

function filterClients() {
  const query = document.getElementById('client-search').value.toLowerCase();
  document.querySelectorAll('.client-card').forEach(card => {
    const name = card.dataset.name || '';
    card.style.display = name.includes(query) ? '' : 'none';
  });
}

async function openClientDetail(clientName) {
  const txns = await db.transactions.toArray();
  const visits = txns.filter(t => t.type === 'INCOME' && t.clientName === clientName);
  visits.sort((a, b) => b.date.localeCompare(a.date));
  
  const total = visits.reduce((s, t) => s + (t.serviceAmount || 0) + (t.tipAmount || 0), 0);
  const tips = visits.reduce((s, t) => s + (t.tipAmount || 0), 0);
  const avgTicket = visits.length > 0 ? total / visits.length : 0;
  
  const historyHTML = visits.slice(0, 15).map(t => `
    <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border-light);">
      <div style="flex:1;">
        <div style="font-weight:500;">${t.category}</div>
        <div style="font-size:12px;color:var(--text-muted);">${formatDateShort(t.date)}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-weight:600;color:var(--success);">${fmt((t.serviceAmount||0) + (t.tipAmount||0))}</div>
        ${t.tipAmount > 0 ? `<div style="font-size:11px;color:var(--text-muted);">+${fmt(t.tipAmount)} tip</div>` : ''}
      </div>
    </div>
  `).join('');
  
  openModal(`
    <h2 class="modal-title">${clientName}</h2>
    
    <div class="grid-3" style="margin-bottom:24px;">
      <div class="report-stat">
        <div class="report-stat-label">Total Spent</div>
        <div class="report-stat-value green">${fmt(total)}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Visits</div>
        <div class="report-stat-value">${visits.length}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Avg Ticket</div>
        <div class="report-stat-value">${fmt(avgTicket)}</div>
      </div>
    </div>
    
    <div style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--text-muted);margin-bottom:12px;">Visit History</div>
    ${historyHTML}
    ${visits.length > 15 ? `<p style="text-align:center;color:var(--text-muted);padding:12px;">+ ${visits.length - 15} more visits</p>` : ''}
  `);
}

// ----------------------------------------------------------------
// 16. REPORTS VIEW
// ----------------------------------------------------------------

async function renderReportsView() {
  const content = document.getElementById('app-content');
  
  const reportTypes = [
    { id: 'daily', label: 'Daily' },
    { id: 'weekly', label: 'Weekly' },
    { id: 'monthly', label: 'Monthly' },
    { id: 'monthcompare', label: 'Month Compare' },
    { id: 'daterange', label: 'Date Range' },
    { id: 'annual', label: 'Annual' },
    { id: 'yoy', label: 'Year vs Year' },
    { id: 'category', label: 'By Category' },
    { id: 'pnl', label: 'P&L' },
    { id: 'boothrent', label: 'Booth Rent' },
    { id: 'clients', label: 'Clients' },
    { id: 'export', label: '📥 Export' },
  ];
  
  let html = `
    <div class="reports-nav">
      ${reportTypes.map(r => `
        <button class="report-tab ${state.reportType === r.id ? 'active' : ''}" onclick="switchReport('${r.id}')">${r.label}</button>
      `).join('')}
    </div>
    <div class="report-controls" id="report-controls"></div>
    <div class="report-output" id="report-output"></div>
  `;
  
  content.innerHTML = html;
  await renderReport(state.reportType);
}

function switchReport(type) {
  state.reportType = type;
  document.querySelectorAll('.report-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.report-tab[onclick="switchReport('${type}')"]`).classList.add('active');
  renderReport(type);
}

async function renderReport(type) {
  const output = document.getElementById('report-output');
  const controls = document.getElementById('report-controls');
  
  output.innerHTML = '<div class="flex items-center justify-center" style="padding:60px;"><div class="loading-spinner"></div></div>';
  
  switch(type) {
    case 'daily': await renderDailyReport(output, controls); break;
    case 'weekly': await renderWeeklyReport(output, controls); break;
    case 'monthly': await renderMonthlyReport(output, controls); break;
    case 'monthcompare': await renderMonthCompareReport(output, controls); break;
    case 'daterange': await renderDateRangeReport(output, controls); break;
    case 'annual': await renderAnnualReport(output, controls); break;
    case 'yoy': await renderYOYReport(output, controls); break;
    case 'category': await renderCategoryReport(output, controls); break;
    case 'pnl': await renderPnLReport(output, controls); break;
    case 'boothrent': await renderBoothRentReport(output, controls); break;
    case 'clients': await renderClientsReport(output, controls); break;
    case 'export': await renderExportReport(output, controls); break;
    default: output.innerHTML = '<p>Select a report type</p>';
  }
}

async function renderDailyReport(output, controls) {
  controls.innerHTML = `
    <input type="date" class="form-input" id="report-date" value="${state.selectedDate}" onchange="state.selectedDate=this.value;renderReport('daily')" style="width:200px;">
  `;
  
  const txns = await db.transactions.where('date').equals(state.selectedDate).toArray();
  const income = txns.filter(t => t.type === 'INCOME');
  const expenses = txns.filter(t => t.type === 'EXPENSE');
  
  const totalServices = income.reduce((s, t) => s + (t.serviceAmount || 0), 0);
  const totalTips = income.reduce((s, t) => s + (t.tipAmount || 0), 0);
  const totalIncome = totalServices + totalTips;
  const totalExpenses = expenses.reduce((s, t) => s + (t.amount || 0), 0);
  const net = totalIncome - totalExpenses;
  const clientCount = new Set(income.map(t => t.clientName).filter(Boolean)).size;
  
  output.innerHTML = `
    <h3 style="font-family:var(--font-display);font-size:20px;margin-bottom:20px;">${formatDateDisplay(state.selectedDate)}</h3>
    
    <div class="report-stat-grid">
      <div class="report-stat">
        <div class="report-stat-label">Services</div>
        <div class="report-stat-value green">${fmt(totalServices)}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Tips</div>
        <div class="report-stat-value green">${fmt(totalTips)}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Expenses</div>
        <div class="report-stat-value red">${fmt(totalExpenses)}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Net</div>
        <div class="report-stat-value ${net >= 0 ? 'green' : 'red'}">${fmt(net)}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Clients</div>
        <div class="report-stat-value">${clientCount}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Transactions</div>
        <div class="report-stat-value">${txns.length}</div>
      </div>
    </div>
    
    ${income.length > 0 ? `
      <div class="report-section-title" style="margin-top:24px;">Income Breakdown</div>
      ${income.map(t => `
        <div class="report-row">
          <div>
            <div class="report-row-label">${t.category}</div>
            <div class="report-row-sub">${t.clientName || ''} ${t.notes ? '· ' + t.notes : ''}</div>
          </div>
          <div class="report-row-value income">+${fmt((t.serviceAmount||0) + (t.tipAmount||0))}</div>
        </div>
      `).join('')}
    ` : ''}
    
    ${expenses.length > 0 ? `
      <div class="report-section-title" style="margin-top:24px;">Expenses</div>
      ${expenses.map(t => `
        <div class="report-row">
          <div>
            <div class="report-row-label">${t.category}</div>
            <div class="report-row-sub">${t.notes || ''}</div>
          </div>
          <div class="report-row-value expense">-${fmt(t.amount)}</div>
        </div>
      `).join('')}
    ` : ''}
  `;
}

async function renderWeeklyReport(output, controls) {
  const weekStart = state.rentersWeekStart || getWeekStart(todayStr());
  
  controls.innerHTML = `
    <button class="btn-icon" onclick="state.rentersWeekStart=addDays('${weekStart}',-7);renderReport('weekly')">‹</button>
    <span style="font-weight:600;min-width:200px;text-align:center;">${formatWeekRange(weekStart)}</span>
    <button class="btn-icon" onclick="state.rentersWeekStart=addDays('${weekStart}',7);renderReport('weekly')">›</button>
  `;
  
  const allTxns = await db.transactions.toArray();
  const weekEnd = addDays(weekStart, 6);
  const txns = allTxns.filter(t => t.date >= weekStart && t.date <= weekEnd);
  
  const income = txns.filter(t => t.type === 'INCOME');
  const expenses = txns.filter(t => t.type === 'EXPENSE');
  const totalIncome = income.reduce((s, t) => s + (t.serviceAmount || 0) + (t.tipAmount || 0), 0);
  const totalExpenses = expenses.reduce((s, t) => s + (t.amount || 0), 0);
  const net = totalIncome - totalExpenses;
  
  // Day by day breakdown
  let dayRows = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    const dayIncome = allTxns.filter(t => t.date === d && t.type === 'INCOME')
      .reduce((s, t) => s + (t.serviceAmount || 0) + (t.tipAmount || 0), 0);
    const dayExp = allTxns.filter(t => t.date === d && t.type === 'EXPENSE')
      .reduce((s, t) => s + (t.amount || 0), 0);
    dayRows += `
      <div class="report-row">
        <div class="report-row-label">${formatDateShort(d)}</div>
        <div style="display:flex;gap:24px;">
          <span style="color:var(--success);">${fmt(dayIncome)}</span>
          <span style="color:var(--danger);">${fmt(dayExp)}</span>
        </div>
      </div>
    `;
  }
  
  output.innerHTML = `
    <div class="report-stat-grid">
      <div class="report-stat">
        <div class="report-stat-label">Total Income</div>
        <div class="report-stat-value green">${fmt(totalIncome)}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Total Expenses</div>
        <div class="report-stat-value red">${fmt(totalExpenses)}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Net Profit</div>
        <div class="report-stat-value ${net >= 0 ? 'green' : 'red'}">${fmt(net)}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Clients</div>
        <div class="report-stat-value">${new Set(income.map(t => t.clientName).filter(Boolean)).size}</div>
      </div>
    </div>
    
    <div class="report-section-title" style="margin-top:24px;">Daily Breakdown</div>
    ${dayRows}
  `;
}

async function renderMonthlyReport(output, controls) {
  const m = state.selectedMonth;
  const y = state.selectedYear;
  const monthStr = `${y}-${String(m).padStart(2, '0')}`;
  
  controls.innerHTML = `
    <button class="btn-icon" onclick="state.selectedMonth--;if(state.selectedMonth<1){state.selectedMonth=12;state.selectedYear--;}renderReport('monthly')">‹</button>
    <span style="font-weight:600;min-width:180px;text-align:center;">${monthName(m)} ${y}</span>
    <button class="btn-icon" onclick="state.selectedMonth++;if(state.selectedMonth>12){state.selectedMonth=1;state.selectedYear++;}renderReport('monthly')">›</button>
  `;
  
  const [allTxns, allMExp] = await Promise.all([
    db.transactions.toArray(),
    db.monthlyExpenses.toArray()
  ]);
  
  const txns = allTxns.filter(t => t.date && t.date.startsWith(monthStr));
  const mExp = allMExp.filter(e => e.year === y && e.month === m);
  
  const income = txns.filter(t => t.type === 'INCOME');
  const dailyExp = txns.filter(t => t.type === 'EXPENSE');
  
  const totalServices = income.reduce((s, t) => s + (t.serviceAmount || 0), 0);
  const totalTips = income.reduce((s, t) => s + (t.tipAmount || 0), 0);
  const totalIncome = totalServices + totalTips;
  const totalDailyExp = dailyExp.reduce((s, t) => s + (t.amount || 0), 0);
  const totalMonthlyExp = mExp.reduce((s, e) => s + (e.amount || 0), 0);
  const totalExpenses = totalDailyExp + totalMonthlyExp;
  const net = totalIncome - totalExpenses;
  
  output.innerHTML = `
    <div class="report-stat-grid">
      <div class="report-stat">
        <div class="report-stat-label">Services</div>
        <div class="report-stat-value green">${fmt(totalServices)}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Tips</div>
        <div class="report-stat-value green">${fmt(totalTips)}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Daily Expenses</div>
        <div class="report-stat-value red">${fmt(totalDailyExp)}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Monthly Expenses</div>
        <div class="report-stat-value red">${fmt(totalMonthlyExp)}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Net Profit</div>
        <div class="report-stat-value ${net >= 0 ? 'green' : 'red'}">${fmt(net)}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Margin</div>
        <div class="report-stat-value">${totalIncome > 0 ? Math.round((net / totalIncome) * 100) : 0}%</div>
      </div>
    </div>
  `;
}

async function renderAnnualReport(output, controls) {
  const y = state.selectedYear;
  
  controls.innerHTML = `
    <button class="btn-icon" onclick="state.selectedYear--;renderReport('annual')">‹</button>
    <span style="font-weight:600;min-width:100px;text-align:center;">${y}</span>
    <button class="btn-icon" onclick="state.selectedYear++;renderReport('annual')">›</button>
  `;
  
  const [allTxns, allMExp] = await Promise.all([
    db.transactions.toArray(),
    db.monthlyExpenses.toArray()
  ]);
  
  let rows = '';
  let yearIncome = 0, yearExp = 0;
  
  for (let m = 1; m <= 12; m++) {
    const monthStr = `${y}-${String(m).padStart(2, '0')}`;
    const txns = allTxns.filter(t => t.date && t.date.startsWith(monthStr));
    const mExp = allMExp.filter(e => e.year === y && e.month === m);
    
    const inc = txns.filter(t => t.type === 'INCOME').reduce((s, t) => s + (t.serviceAmount || 0) + (t.tipAmount || 0), 0);
    const exp = txns.filter(t => t.type === 'EXPENSE').reduce((s, t) => s + (t.amount || 0), 0) + mExp.reduce((s, e) => s + (e.amount || 0), 0);
    const net = inc - exp;
    
    yearIncome += inc;
    yearExp += exp;
    
    rows += `
      <tr>
        <td>${monthName(m)}</td>
        <td style="color:var(--success);">${fmt(inc)}</td>
        <td style="color:var(--danger);">${fmt(exp)}</td>
        <td style="color:${net >= 0 ? 'var(--success)' : 'var(--danger)'};">${fmt(net)}</td>
      </tr>
    `;
  }
  
  const yearNet = yearIncome - yearExp;
  
  output.innerHTML = `
    <div class="report-stat-grid" style="margin-bottom:24px;">
      <div class="report-stat">
        <div class="report-stat-label">Total Income</div>
        <div class="report-stat-value green">${fmt(yearIncome)}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Total Expenses</div>
        <div class="report-stat-value red">${fmt(yearExp)}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Net Profit</div>
        <div class="report-stat-value ${yearNet >= 0 ? 'green' : 'red'}">${fmt(yearNet)}</div>
      </div>
    </div>
    
    <table class="data-table">
      <thead>
        <tr><th style="text-align:left;">Month</th><th>Income</th><th>Expenses</th><th>Net</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function renderCategoryReport(output, controls) {
  controls.innerHTML = `
    <div style="display:flex;align-items:center;gap:16px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-weight:600;">From:</span>
        <input type="date" class="form-input" style="width:150px;" value="${state.catReportFrom}" onchange="state.catReportFrom=this.value;renderReport('category')">
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-weight:600;">To:</span>
        <input type="date" class="form-input" style="width:150px;" value="${state.catReportTo}" onchange="state.catReportTo=this.value;renderReport('category')">
      </div>
    </div>
  `;
  
  const [allTxns, allMExp] = await Promise.all([
    db.transactions.toArray(),
    db.monthlyExpenses.toArray()
  ]);
  
  const from = state.catReportFrom;
  const to = state.catReportTo;
  
  // Filter transactions by date range
  const txns = allTxns.filter(t => t.date >= from && t.date <= to);
  
  // Filter monthly expenses by date range
  const monthlyExp = allMExp.filter(e => {
    if (!e.month || !e.year) return false;
    const monthDate = `${e.year}-${String(e.month).padStart(2,'0')}-01`;
    return monthDate >= from && monthDate <= to;
  });
  
  // Income by category
  const incCats = {};
  txns.filter(t => t.type === 'INCOME').forEach(t => {
    incCats[t.category] = (incCats[t.category] || 0) + (t.serviceAmount || 0) + (t.tipAmount || 0);
  });
  
  // Expense by category
  const expCats = {};
  txns.filter(t => t.type === 'EXPENSE').forEach(t => {
    expCats[t.category] = (expCats[t.category] || 0) + (t.amount || 0);
  });
  monthlyExp.forEach(e => {
    expCats[e.category] = (expCats[e.category] || 0) + (e.amount || 0);
  });
  
  const incTotal = Object.values(incCats).reduce((a, b) => a + b, 0);
  const expTotal = Object.values(expCats).reduce((a, b) => a + b, 0);
  const hasInc = Object.keys(incCats).length > 0;
  const hasExp = Object.keys(expCats).length > 0;
  
  const sortedInc = Object.entries(incCats).sort((a, b) => b[1] - a[1]);
  const sortedExp = Object.entries(expCats).sort((a, b) => b[1] - a[1]);
  
  const incRows = sortedInc.map(([cat, amt]) => `
    <div class="report-row">
      <div class="report-row-label">${cat}</div>
      <div style="display:flex;gap:16px;align-items:center;">
        <span style="color:var(--text-muted);font-size:13px;">${incTotal > 0 ? Math.round((amt / incTotal) * 100) : 0}%</span>
        <span class="report-row-value income">+${fmt(amt)}</span>
      </div>
    </div>
  `).join('');
  
  const expRows = sortedExp.map(([cat, amt]) => `
    <div class="report-row">
      <div class="report-row-label">${cat}</div>
      <div style="display:flex;gap:16px;align-items:center;">
        <span style="color:var(--text-muted);font-size:13px;">${expTotal > 0 ? Math.round((amt / expTotal) * 100) : 0}%</span>
        <span class="report-row-value expense">-${fmt(amt)}</span>
      </div>
    </div>
  `).join('');
  
  output.innerHTML = `
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:20px;">${formatDateShort(from)} — ${formatDateShort(to)}</div>
    
    <div class="grid-2" style="gap:32px;">
      <div class="card">
        <div class="report-section-title">Income by Category</div>
        <div style="font-size:28px;font-weight:700;color:var(--success);margin-bottom:16px;">${fmt(incTotal)}</div>
        ${hasInc ? `<div class="pie-chart-wrap"><canvas id="pie-income" width="280" height="280"></canvas></div>` : ''}
        ${incRows || '<p style="color:var(--text-muted);">No income data</p>'}
      </div>
      <div class="card">
        <div class="report-section-title">Expenses by Category</div>
        <div style="font-size:28px;font-weight:700;color:var(--danger);margin-bottom:16px;">${fmt(expTotal)}</div>
        ${hasExp ? `<div class="pie-chart-wrap"><canvas id="pie-expense" width="280" height="280"></canvas></div>` : ''}
        ${expRows || '<p style="color:var(--text-muted);">No expense data</p>'}
      </div>
    </div>
  `;
  
  // Draw pie charts after DOM is ready
  if (hasInc) {
    drawPieChart('pie-income', sortedInc.map(([k]) => k), sortedInc.map(([,v]) => v));
  }
  if (hasExp) {
    drawPieChart('pie-expense', sortedExp.map(([k]) => k), sortedExp.map(([,v]) => v));
  }
}

async function renderPnLReport(output, controls) {
  const m = state.selectedMonth;
  const y = state.selectedYear;
  const monthStr = `${y}-${String(m).padStart(2, '0')}`;
  const yearStr = String(y);
  
  controls.innerHTML = `
    <button class="btn-icon" onclick="state.selectedMonth--;if(state.selectedMonth<1){state.selectedMonth=12;state.selectedYear--;}renderReport('pnl')">‹</button>
    <span style="font-weight:600;min-width:180px;text-align:center;">${monthName(m)} ${y}</span>
    <button class="btn-icon" onclick="state.selectedMonth++;if(state.selectedMonth>12){state.selectedMonth=1;state.selectedYear++;}renderReport('pnl')">›</button>
  `;
  
  const [allTxns, allMExp, allRenters, allRentPmts] = await Promise.all([
    db.transactions.toArray(),
    db.monthlyExpenses.toArray(),
    db.renters.toArray(),
    db.rentPayments.toArray()
  ]);
  
  // Load direct cost categories from settings
  const directCatsDoc = await db.settings.get('directCostCategories');
  const directCats = directCatsDoc?.value ? JSON.parse(directCatsDoc.value) : [];
  const isDirect = (cat) => directCats.includes(cat);
  
  const monthTxns = allTxns.filter(t => t.date?.startsWith(monthStr));
  const ytdTxns = allTxns.filter(t => t.date?.startsWith(yearStr));
  
  // Revenue by category
  const revenueLines = {};
  monthTxns.filter(t => t.type === 'INCOME').forEach(t => {
    const key = t.category || 'Other';
    if (!revenueLines[key]) revenueLines[key] = { month: 0, ytd: 0 };
    revenueLines[key].month += (t.serviceAmount || 0);
  });
  ytdTxns.filter(t => t.type === 'INCOME').forEach(t => {
    const key = t.category || 'Other';
    if (!revenueLines[key]) revenueLines[key] = { month: 0, ytd: 0 };
    revenueLines[key].ytd += (t.serviceAmount || 0);
  });
  
  // Tips
  const monthTips = monthTxns.filter(t => t.type === 'INCOME').reduce((s,t) => s + (t.tipAmount || 0), 0);
  const ytdTips = ytdTxns.filter(t => t.type === 'INCOME').reduce((s,t) => s + (t.tipAmount || 0), 0);
  
  // Booth rent
  const monthRent = allRentPmts.filter(p => p.datePaid?.startsWith(monthStr)).reduce((s,p) => s + (p.amount || 0), 0);
  const ytdRent = allRentPmts.filter(p => p.datePaid?.startsWith(yearStr)).reduce((s,p) => s + (p.amount || 0), 0);
  
  const monthServiceTotal = Object.values(revenueLines).reduce((s,r) => s + r.month, 0);
  const ytdServiceTotal = Object.values(revenueLines).reduce((s,r) => s + r.ytd, 0);
  const monthGrossRevenue = monthServiceTotal + monthTips + monthRent;
  const ytdGrossRevenue = ytdServiceTotal + ytdTips + ytdRent;
  
  // Expenses
  const directLines = {};
  const overheadLines = {};
  
  monthTxns.filter(t => t.type === 'EXPENSE').forEach(t => {
    const cat = t.category || 'Other';
    const bucket = isDirect(cat) ? directLines : overheadLines;
    if (!bucket[cat]) bucket[cat] = { month: 0, ytd: 0 };
    bucket[cat].month += (t.amount || 0);
  });
  ytdTxns.filter(t => t.type === 'EXPENSE').forEach(t => {
    const cat = t.category || 'Other';
    const bucket = isDirect(cat) ? directLines : overheadLines;
    if (!bucket[cat]) bucket[cat] = { month: 0, ytd: 0 };
    bucket[cat].ytd += (t.amount || 0);
  });
  
  allMExp.filter(e => e.year === y && e.month === m).forEach(e => {
    const cat = e.category || 'Other';
    const bucket = isDirect(cat) ? directLines : overheadLines;
    if (!bucket[cat]) bucket[cat] = { month: 0, ytd: 0 };
    bucket[cat].month += (e.amount || 0);
  });
  allMExp.filter(e => e.year === y && e.month <= m).forEach(e => {
    const cat = e.category || 'Other';
    const bucket = isDirect(cat) ? directLines : overheadLines;
    if (!bucket[cat]) bucket[cat] = { month: 0, ytd: 0 };
    bucket[cat].ytd += (e.amount || 0);
  });
  
  const monthDirectTotal = Object.values(directLines).reduce((s,r) => s + r.month, 0);
  const ytdDirectTotal = Object.values(directLines).reduce((s,r) => s + r.ytd, 0);
  const monthOverheadTotal = Object.values(overheadLines).reduce((s,r) => s + r.month, 0);
  const ytdOverheadTotal = Object.values(overheadLines).reduce((s,r) => s + r.ytd, 0);
  const monthTotalExpenses = monthDirectTotal + monthOverheadTotal;
  const ytdTotalExpenses = ytdDirectTotal + ytdOverheadTotal;
  
  const monthGrossProfit = monthGrossRevenue - monthDirectTotal;
  const ytdGrossProfit = ytdGrossRevenue - ytdDirectTotal;
  const monthNetIncome = monthGrossRevenue - monthTotalExpenses;
  const ytdNetIncome = ytdGrossRevenue - ytdTotalExpenses;
  
  const pctOf = (val, total) => total > 0 ? `${((val / total) * 100).toFixed(1)}%` : '—';
  
  const row = (label, mVal, yVal, indent = true, color = null) => `
    <tr style="${color ? 'color:' + color + ';' : ''}">
      <td style="padding:8px 0;${indent ? 'padding-left:16px;' : 'font-weight:600;'}">${label}</td>
      <td style="text-align:right;padding:8px;">${fmt(mVal)}</td>
      <td style="text-align:right;padding:8px;color:var(--text-muted);font-size:13px;">${pctOf(mVal, monthGrossRevenue)}</td>
      <td style="text-align:right;padding:8px;">${fmt(yVal)}</td>
      <td style="text-align:right;padding:8px;color:var(--text-muted);font-size:13px;">${pctOf(yVal, ytdGrossRevenue)}</td>
    </tr>`;
  
  const subtotalRow = (label, mVal, yVal, color) => `
    <tr style="font-weight:700;border-top:2px solid var(--border);${color ? 'color:' + color + ';' : ''}">
      <td style="padding:12px 0;">${label}</td>
      <td style="text-align:right;padding:12px;">${fmt(mVal)}</td>
      <td style="text-align:right;padding:12px;font-size:13px;">${pctOf(mVal, monthGrossRevenue)}</td>
      <td style="text-align:right;padding:12px;">${fmt(yVal)}</td>
      <td style="text-align:right;padding:12px;font-size:13px;">${pctOf(yVal, ytdGrossRevenue)}</td>
    </tr>`;
  
  const sortedRevenue = Object.entries(revenueLines).sort((a,b) => b[1].month - a[1].month);
  const sortedDirect = Object.entries(directLines).sort((a,b) => b[1].month - a[1].month);
  const sortedOverhead = Object.entries(overheadLines).sort((a,b) => b[1].month - a[1].month);
  
  output.innerHTML = `
    <div class="report-section-title">${monthName(m)} ${y} — Profit & Loss</div>
    
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:2px solid var(--plum);">
            <th style="text-align:left;padding:12px 0;color:var(--text-muted);font-size:12px;"></th>
            <th style="text-align:right;padding:12px;color:var(--text-muted);font-size:12px;">${monthName(m).substring(0,3)}</th>
            <th style="text-align:right;padding:12px;color:var(--text-muted);font-size:11px;">%</th>
            <th style="text-align:right;padding:12px;color:var(--text-muted);font-size:12px;">YTD</th>
            <th style="text-align:right;padding:12px;color:var(--text-muted);font-size:11px;">%</th>
          </tr>
        </thead>
        <tbody>
          <tr><td colspan="5" style="padding:16px 0 8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--plum);">Revenue</td></tr>
          ${sortedRevenue.map(([cat, v]) => row(cat, v.month, v.ytd)).join('')}
          ${monthTips > 0 || ytdTips > 0 ? row('Tips', monthTips, ytdTips) : ''}
          ${monthRent > 0 || ytdRent > 0 ? row('Booth Rent Collected', monthRent, ytdRent) : ''}
          ${subtotalRow('Total Revenue', monthGrossRevenue, ytdGrossRevenue, 'var(--success)')}
          
          <tr><td colspan="5" style="padding:20px 0 8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--danger);">Cost of Goods / Direct Costs</td></tr>
          ${sortedDirect.length > 0 ? sortedDirect.map(([cat, v]) => row(cat, v.month, v.ytd)).join('') : '<tr><td colspan="5" style="padding:8px 16px;color:var(--text-muted);font-style:italic;">None this period</td></tr>'}
          ${subtotalRow('Total Direct Costs', monthDirectTotal, ytdDirectTotal, 'var(--danger)')}
          ${subtotalRow('Gross Profit', monthGrossProfit, ytdGrossProfit, monthGrossProfit >= 0 ? 'var(--success)' : 'var(--danger)')}
          
          <tr><td colspan="5" style="padding:20px 0 8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--gold-dark);">Operating Expenses</td></tr>
          ${sortedOverhead.length > 0 ? sortedOverhead.map(([cat, v]) => row(cat, v.month, v.ytd)).join('') : '<tr><td colspan="5" style="padding:8px 16px;color:var(--text-muted);font-style:italic;">None this period</td></tr>'}
          ${subtotalRow('Total Operating Expenses', monthOverheadTotal, ytdOverheadTotal, 'var(--danger)')}
          
          <tr style="border-top:3px double var(--plum);font-weight:800;font-size:18px;">
            <td style="padding:16px 0;color:var(--text);">Net Income</td>
            <td style="text-align:right;padding:16px;color:${monthNetIncome >= 0 ? 'var(--success)' : 'var(--danger)'};">${fmt(monthNetIncome)}</td>
            <td style="text-align:right;padding:16px;font-size:14px;color:var(--text-muted);">${pctOf(monthNetIncome, monthGrossRevenue)}</td>
            <td style="text-align:right;padding:16px;color:${ytdNetIncome >= 0 ? 'var(--success)' : 'var(--danger)'};">${fmt(ytdNetIncome)}</td>
            <td style="text-align:right;padding:16px;font-size:14px;color:var(--text-muted);">${pctOf(ytdNetIncome, ytdGrossRevenue)}</td>
          </tr>
        </tbody>
      </table>
    </div>
    
    <div class="card" style="margin-top:24px;background:var(--cream);">
      <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:16px;">Key Metrics</div>
      <div class="grid-4">
        <div style="text-align:center;">
          <div style="font-size:12px;color:var(--text-muted);">Gross Margin</div>
          <div style="font-size:24px;font-weight:700;color:${monthGrossProfit/monthGrossRevenue >= 0.7 ? 'var(--success)' : 'var(--gold-dark)'};">${pctOf(monthGrossProfit, monthGrossRevenue)}</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:12px;color:var(--text-muted);">Net Margin</div>
          <div style="font-size:24px;font-weight:700;color:${monthNetIncome >= 0 ? 'var(--success)' : 'var(--danger)'};">${pctOf(monthNetIncome, monthGrossRevenue)}</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:12px;color:var(--text-muted);">Services Revenue</div>
          <div style="font-size:24px;font-weight:700;color:var(--plum);">${pctOf(monthServiceTotal + monthTips, monthGrossRevenue)}</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:12px;color:var(--text-muted);">Booth Rent Revenue</div>
          <div style="font-size:24px;font-weight:700;color:var(--plum);">${pctOf(monthRent, monthGrossRevenue)}</div>
        </div>
      </div>
    </div>
    
    <div style="margin-top:16px;font-size:12px;color:var(--text-muted);line-height:1.6;">
      💡 <strong>Tip:</strong> Mark expense categories as "Direct" or "Overhead" in Settings → Categories to improve P&L accuracy.
    </div>
  `;
}

async function renderBoothRentReport(output, controls) {
  const year = state.boothRentYear;
  
  controls.innerHTML = `
    <button class="btn-icon" onclick="state.boothRentYear--;renderReport('boothrent')">‹</button>
    <span style="font-weight:600;min-width:100px;text-align:center;">${year}</span>
    <button class="btn-icon" onclick="state.boothRentYear++;renderReport('boothrent')">›</button>
  `;
  
  const [allRenters, allPayments] = await Promise.all([
    db.renters.toArray(),
    db.rentPayments.toArray()
  ]);
  
  if (allRenters.length === 0) {
    output.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🏠</div>
        <div class="empty-title">No booth renters</div>
        <div class="empty-text">Add booth renters to see rent collection reports</div>
      </div>
    `;
    return;
  }
  
  const yearPayments = allPayments.filter(p => p.datePaid?.startsWith(String(year)));
  const mShort = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  
  // Build per-renter stats
  const renterStats = allRenters.map(r => {
    ensureRateHistory(r);
    const pmts = yearPayments.filter(p => p.renterId === r.id);
    const totalPaid = pmts.reduce((s, p) => s + (p.amount || 0), 0);
    const onTime = pmts.filter(p => getRentStatus(p.weekStart, p.datePaid) === 'ontime').length;
    const late = pmts.filter(p => getRentStatus(p.weekStart, p.datePaid) === 'late').length;
    const total = pmts.length;
    const onTimePct = total > 0 ? Math.round((onTime / total) * 100) : 0;
    
    // Monthly breakdown
    const months = {};
    for (let m = 1; m <= 12; m++) {
      const ms = `${year}-${String(m).padStart(2, '0')}`;
      const mPmts = pmts.filter(p => p.datePaid?.startsWith(ms));
      months[m] = {
        paid: mPmts.reduce((s, p) => s + (p.amount || 0), 0),
        count: mPmts.length,
        onTime: mPmts.filter(p => getRentStatus(p.weekStart, p.datePaid) === 'ontime').length,
      };
    }
    
    // Avg days to pay
    let totalDays = 0;
    pmts.forEach(p => {
      const ws = new Date(p.weekStart + 'T12:00:00');
      const pd = new Date(p.datePaid + 'T12:00:00');
      totalDays += Math.round((pd - ws) / 86400000);
    });
    const avgDaysToPay = total > 0 ? (totalDays / total).toFixed(1) : '—';
    
    // Calculate expected
    const firstPmt = pmts.length > 0 ? pmts.reduce((e, p) => (!e || p.weekStart < e) ? p.weekStart : e, null) : null;
    const rStart = r.startDate || `${year}-01-01`;
    const effectiveStart = firstPmt && firstPmt < rStart ? firstPmt : rStart;
    const rangeStart = effectiveStart > `${year}-01-01` ? effectiveStart : `${year}-01-01`;
    const currentWS = getWeekStart(todayStr());
    const lastCompletedWS = addDays(currentWS, -7);
    const rangeEnd = `${year}-12-31` < lastCompletedWS ? `${year}-12-31` : lastCompletedWS;
    
    let expectedAmt = 0;
    let cursor = getWeekStart(rangeStart);
    while (cursor <= rangeEnd) {
      expectedAmt += getRateForWeek(r, cursor);
      cursor = addDays(cursor, 7);
    }
    const outstanding = Math.max(0, expectedAmt - totalPaid);
    
    return { id: r.id, name: r.name, booth: r.booth, rate: getCurrentRate(r), status: r.status,
      totalPaid, onTime, late, total, onTimePct, months, avgDaysToPay, expectedAmt, outstanding };
  });
  
  // Totals
  const grandPaid = renterStats.reduce((s, r) => s + r.totalPaid, 0);
  const grandExpected = renterStats.reduce((s, r) => s + r.expectedAmt, 0);
  const grandOutstanding = renterStats.reduce((s, r) => s + r.outstanding, 0);
  const grandOnTime = renterStats.reduce((s, r) => s + r.onTime, 0);
  const grandLate = renterStats.reduce((s, r) => s + r.late, 0);
  const grandTotal = renterStats.reduce((s, r) => s + r.total, 0);
  const grandOnTimePct = grandTotal > 0 ? Math.round((grandOnTime / grandTotal) * 100) : 0;
  
  // Active months
  const activeMo = [];
  for (let m = 1; m <= 12; m++) {
    if (renterStats.some(r => r.months[m].count > 0)) activeMo.push(m);
  }
  if (activeMo.length === 0) activeMo.push(new Date().getMonth() + 1);
  
  output.innerHTML = `
    <div class="report-section-title">${year} Booth Rent Summary</div>
    
    <div class="report-stat-grid" style="margin-bottom:24px;">
      <div class="report-stat"><div class="report-stat-label">Expected YTD</div><div class="report-stat-value">${fmt(grandExpected)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Collected</div><div class="report-stat-value green">${fmt(grandPaid)}</div></div>
      <div class="report-stat"><div class="report-stat-label">${grandOutstanding > 0 ? 'Outstanding' : 'All Collected'}</div><div class="report-stat-value ${grandOutstanding > 0 ? 'red' : 'green'}">${grandOutstanding > 0 ? fmt(grandOutstanding) : '✓'}</div></div>
      <div class="report-stat"><div class="report-stat-label">On-Time Rate</div><div class="report-stat-value ${grandOnTimePct >= 90 ? 'green' : grandOnTimePct >= 75 ? 'gold' : 'red'}">${grandOnTimePct}%</div></div>
    </div>
    
    ${renterStats.filter(r => r.total > 0 || r.status === 'active').map(r => `
      <div class="card" style="margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
          <div>
            <div style="font-size:18px;font-weight:700;color:var(--text);">${r.name}${r.booth ? ` <span style="font-weight:400;color:var(--text-muted);font-size:13px;">Booth ${r.booth}</span>` : ''}</div>
            <div style="font-size:13px;color:var(--text-muted);">${fmt(r.rate)}/week · ${r.status === 'active' ? '🟢 Active' : '⚪ Inactive'}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:24px;font-weight:700;color:var(--success);">${fmt(r.totalPaid)}</div>
            <div style="font-size:12px;color:var(--text-muted);">of ${fmt(r.expectedAmt)} expected</div>
            ${r.outstanding > 0 ? `<div style="font-size:13px;font-weight:600;color:var(--danger);">Outstanding: ${fmt(r.outstanding)}</div>` : ''}
          </div>
        </div>
        
        <div class="grid-4" style="margin-bottom:16px;">
          <div class="report-stat" style="background:var(--cream);"><div class="report-stat-label">On-Time</div><div class="report-stat-value ${r.onTimePct >= 90 ? 'green' : r.onTimePct >= 75 ? 'gold' : 'red'}">${r.onTimePct}%</div></div>
          <div class="report-stat" style="background:var(--cream);"><div class="report-stat-label">Late</div><div class="report-stat-value ${r.late > 0 ? 'red' : 'green'}">${r.late}</div></div>
          <div class="report-stat" style="background:var(--cream);"><div class="report-stat-label">Avg Days</div><div class="report-stat-value">${r.avgDaysToPay}</div></div>
          <div class="report-stat" style="background:var(--cream);"><div class="report-stat-label">Balance</div><div class="report-stat-value ${r.outstanding > 0 ? 'red' : 'green'}">${r.outstanding > 0 ? fmt(r.outstanding) : '✓'}</div></div>
        </div>
        
        <table class="data-table" style="font-size:13px;">
          <thead>
            <tr><th style="text-align:left;">Month</th>${activeMo.map(m => `<th style="text-align:center;">${mShort[m]}</th>`).join('')}<th style="text-align:right;">Total</th></tr>
          </thead>
          <tbody>
            <tr>
              <td style="text-align:left;">Paid</td>
              ${activeMo.map(m => `<td style="text-align:center;color:${r.months[m].paid > 0 ? 'var(--success)' : 'var(--text-muted)'};">${r.months[m].paid > 0 ? fmt(r.months[m].paid) : '—'}</td>`).join('')}
              <td style="text-align:right;font-weight:700;color:var(--success);">${fmt(r.totalPaid)}</td>
            </tr>
            <tr>
              <td style="text-align:left;">Weeks</td>
              ${activeMo.map(m => `<td style="text-align:center;">${r.months[m].count > 0 ? r.months[m].count : '—'}</td>`).join('')}
              <td style="text-align:right;font-weight:700;">${r.total}</td>
            </tr>
          </tbody>
        </table>
      </div>
    `).join('')}
    
    ${renterStats.filter(r => r.total > 0 || r.status === 'active').length === 0 ? `
      <p style="color:var(--text-muted);text-align:center;padding:30px;">No booth rent data for ${year}.</p>
    ` : ''}
  `;
}

// Month Compare Report
async function renderMonthCompareReport(output, controls) {
  const m1 = state.selectedMonth;
  const y1 = state.selectedYear;
  const m2 = state.compareMonth;
  const y2 = state.compareYear;
  
  controls.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:16px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-weight:600;">Month 1:</span>
        <select class="form-select" style="width:120px;" onchange="state.selectedMonth=parseInt(this.value);renderReport('monthcompare')">
          ${Array.from({length:12},(_,i) => `<option value="${i+1}" ${i+1===m1?'selected':''}>${monthName(i+1)}</option>`).join('')}
        </select>
        <input type="number" class="form-input" style="width:90px;" value="${y1}" onchange="state.selectedYear=parseInt(this.value);renderReport('monthcompare')">
      </div>
      <span style="font-size:18px;">vs</span>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-weight:600;">Month 2:</span>
        <select class="form-select" style="width:120px;" onchange="state.compareMonth=parseInt(this.value);renderReport('monthcompare')">
          ${Array.from({length:12},(_,i) => `<option value="${i+1}" ${i+1===m2?'selected':''}>${monthName(i+1)}</option>`).join('')}
        </select>
        <input type="number" class="form-input" style="width:90px;" value="${y2}" onchange="state.compareYear=parseInt(this.value);renderReport('monthcompare')">
      </div>
    </div>
  `;
  
  const [allTxns, allMExp] = await Promise.all([
    db.transactions.toArray(),
    db.monthlyExpenses.toArray()
  ]);
  
  function getMonthData(month, year) {
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;
    const txns = allTxns.filter(t => t.date?.startsWith(monthStr));
    const mExp = allMExp.filter(e => e.year === year && e.month === month);
    
    const income = txns.filter(t => t.type === 'INCOME').reduce((s, t) => s + (t.serviceAmount || 0) + (t.tipAmount || 0), 0);
    const dailyExp = txns.filter(t => t.type === 'EXPENSE').reduce((s, t) => s + (t.amount || 0), 0);
    const monthlyExp = mExp.reduce((s, e) => s + (e.amount || 0), 0);
    const expenses = dailyExp + monthlyExp;
    const clients = new Set(txns.filter(t => t.type === 'INCOME' && t.clientName).map(t => t.clientName)).size;
    
    return { income, expenses, net: income - expenses, clients, txnCount: txns.length };
  }
  
  const d1 = getMonthData(m1, y1);
  const d2 = getMonthData(m2, y2);
  
  function pctChange(a, b) {
    if (b === 0) return a > 0 ? '+∞' : '0';
    const pct = Math.round(((a - b) / b) * 100);
    return (pct >= 0 ? '+' : '') + pct + '%';
  }
  
  output.innerHTML = `
    <div class="comparison-grid">
      <div class="comparison-card">
        <div class="comparison-label">${monthName(m1)} ${y1}</div>
        <div class="comparison-value" style="color:var(--success);">${fmt(d1.income)}</div>
        <div class="comparison-amount">Income</div>
      </div>
      <div class="comparison-card">
        <div class="comparison-label">${monthName(m2)} ${y2}</div>
        <div class="comparison-value" style="color:var(--success);">${fmt(d2.income)}</div>
        <div class="comparison-amount">Income</div>
      </div>
    </div>
    
    <table class="data-table" style="margin-top:24px;">
      <thead><tr><th style="text-align:left;">Metric</th><th>${monthName(m1)} ${y1}</th><th>${monthName(m2)} ${y2}</th><th>Change</th></tr></thead>
      <tbody>
        <tr><td style="text-align:left;">Income</td><td style="color:var(--success);">${fmt(d1.income)}</td><td style="color:var(--success);">${fmt(d2.income)}</td><td>${pctChange(d1.income, d2.income)}</td></tr>
        <tr><td style="text-align:left;">Expenses</td><td style="color:var(--danger);">${fmt(d1.expenses)}</td><td style="color:var(--danger);">${fmt(d2.expenses)}</td><td>${pctChange(d1.expenses, d2.expenses)}</td></tr>
        <tr><td style="text-align:left;">Net Profit</td><td style="color:${d1.net>=0?'var(--success)':'var(--danger)'};">${fmt(d1.net)}</td><td style="color:${d2.net>=0?'var(--success)':'var(--danger)'};">${fmt(d2.net)}</td><td>${pctChange(d1.net, d2.net)}</td></tr>
        <tr><td style="text-align:left;">Clients</td><td>${d1.clients}</td><td>${d2.clients}</td><td>${pctChange(d1.clients, d2.clients)}</td></tr>
        <tr><td style="text-align:left;">Transactions</td><td>${d1.txnCount}</td><td>${d2.txnCount}</td><td>${pctChange(d1.txnCount, d2.txnCount)}</td></tr>
      </tbody>
    </table>
  `;
}

// Date Range Comparison Report
async function renderDateRangeReport(output, controls) {
  controls.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:16px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-weight:600;">Range 1:</span>
        <input type="date" class="form-input" style="width:150px;" value="${state.range1Start}" onchange="state.range1Start=this.value;renderReport('daterange')">
        <span>to</span>
        <input type="date" class="form-input" style="width:150px;" value="${state.range1End}" onchange="state.range1End=this.value;renderReport('daterange')">
      </div>
      <span style="font-size:18px;">vs</span>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-weight:600;">Range 2:</span>
        <input type="date" class="form-input" style="width:150px;" value="${state.range2Start}" onchange="state.range2Start=this.value;renderReport('daterange')">
        <span>to</span>
        <input type="date" class="form-input" style="width:150px;" value="${state.range2End}" onchange="state.range2End=this.value;renderReport('daterange')">
      </div>
    </div>
  `;
  
  const allTxns = await db.transactions.toArray();
  
  function getRangeData(start, end) {
    const txns = allTxns.filter(t => t.date >= start && t.date <= end);
    const income = txns.filter(t => t.type === 'INCOME').reduce((s, t) => s + (t.serviceAmount || 0) + (t.tipAmount || 0), 0);
    const expenses = txns.filter(t => t.type === 'EXPENSE').reduce((s, t) => s + (t.amount || 0), 0);
    const clients = new Set(txns.filter(t => t.type === 'INCOME' && t.clientName).map(t => t.clientName)).size;
    return { income, expenses, net: income - expenses, clients, txnCount: txns.length };
  }
  
  const d1 = getRangeData(state.range1Start, state.range1End);
  const d2 = getRangeData(state.range2Start, state.range2End);
  
  function pctChange(a, b) {
    if (b === 0) return a > 0 ? '+∞' : '0';
    const pct = Math.round(((a - b) / b) * 100);
    return (pct >= 0 ? '+' : '') + pct + '%';
  }
  
  output.innerHTML = `
    <div class="comparison-grid">
      <div class="comparison-card">
        <div class="comparison-label">Range 1</div>
        <div class="comparison-value" style="color:var(--success);">${fmt(d1.income)}</div>
        <div class="comparison-amount">${formatDateShort(state.range1Start)} – ${formatDateShort(state.range1End)}</div>
      </div>
      <div class="comparison-card">
        <div class="comparison-label">Range 2</div>
        <div class="comparison-value" style="color:var(--success);">${fmt(d2.income)}</div>
        <div class="comparison-amount">${formatDateShort(state.range2Start)} – ${formatDateShort(state.range2End)}</div>
      </div>
    </div>
    
    <table class="data-table" style="margin-top:24px;">
      <thead><tr><th style="text-align:left;">Metric</th><th>Range 1</th><th>Range 2</th><th>Change</th></tr></thead>
      <tbody>
        <tr><td style="text-align:left;">Income</td><td style="color:var(--success);">${fmt(d1.income)}</td><td style="color:var(--success);">${fmt(d2.income)}</td><td>${pctChange(d1.income, d2.income)}</td></tr>
        <tr><td style="text-align:left;">Expenses</td><td style="color:var(--danger);">${fmt(d1.expenses)}</td><td style="color:var(--danger);">${fmt(d2.expenses)}</td><td>${pctChange(d1.expenses, d2.expenses)}</td></tr>
        <tr><td style="text-align:left;">Net Profit</td><td style="color:${d1.net>=0?'var(--success)':'var(--danger)'};">${fmt(d1.net)}</td><td style="color:${d2.net>=0?'var(--success)':'var(--danger)'};">${fmt(d2.net)}</td><td>${pctChange(d1.net, d2.net)}</td></tr>
        <tr><td style="text-align:left;">Clients</td><td>${d1.clients}</td><td>${d2.clients}</td><td>${pctChange(d1.clients, d2.clients)}</td></tr>
      </tbody>
    </table>
  `;
}

// Year over Year Report
async function renderYOYReport(output, controls) {
  controls.innerHTML = `
    <div style="display:flex;align-items:center;gap:16px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-weight:600;">Year 1:</span>
        <input type="number" class="form-input" style="width:100px;" value="${state.yoyYear1}" min="2020" max="2099" onchange="state.yoyYear1=parseInt(this.value);renderReport('yoy')">
      </div>
      <span style="font-size:18px;">vs</span>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-weight:600;">Year 2:</span>
        <input type="number" class="form-input" style="width:100px;" value="${state.yoyYear2}" min="2020" max="2099" onchange="state.yoyYear2=parseInt(this.value);renderReport('yoy')">
      </div>
    </div>
  `;
  
  const [allTxns, allMExp] = await Promise.all([
    db.transactions.toArray(),
    db.monthlyExpenses.toArray()
  ]);
  
  function getYearData(year) {
    const yearStr = String(year);
    const txns = allTxns.filter(t => t.date?.startsWith(yearStr));
    const mExp = allMExp.filter(e => e.year === year);
    
    const income = txns.filter(t => t.type === 'INCOME').reduce((s, t) => s + (t.serviceAmount || 0) + (t.tipAmount || 0), 0);
    const dailyExp = txns.filter(t => t.type === 'EXPENSE').reduce((s, t) => s + (t.amount || 0), 0);
    const monthlyExp = mExp.reduce((s, e) => s + (e.amount || 0), 0);
    const expenses = dailyExp + monthlyExp;
    const clients = new Set(txns.filter(t => t.type === 'INCOME' && t.clientName).map(t => t.clientName)).size;
    
    return { income, expenses, net: income - expenses, clients, txnCount: txns.length };
  }
  
  const d1 = getYearData(state.yoyYear1);
  const d2 = getYearData(state.yoyYear2);
  
  function pctChange(a, b) {
    if (b === 0) return a > 0 ? '+∞' : '0';
    const pct = Math.round(((a - b) / b) * 100);
    return (pct >= 0 ? '+' : '') + pct + '%';
  }
  
  // Monthly breakdown
  let monthRows = '';
  for (let m = 1; m <= 12; m++) {
    const m1Str = `${state.yoyYear1}-${String(m).padStart(2, '0')}`;
    const m2Str = `${state.yoyYear2}-${String(m).padStart(2, '0')}`;
    
    const inc1 = allTxns.filter(t => t.date?.startsWith(m1Str) && t.type === 'INCOME').reduce((s, t) => s + (t.serviceAmount || 0) + (t.tipAmount || 0), 0);
    const inc2 = allTxns.filter(t => t.date?.startsWith(m2Str) && t.type === 'INCOME').reduce((s, t) => s + (t.serviceAmount || 0) + (t.tipAmount || 0), 0);
    
    monthRows += `<tr><td style="text-align:left;">${monthName(m)}</td><td>${fmt(inc1)}</td><td>${fmt(inc2)}</td><td>${pctChange(inc2, inc1)}</td></tr>`;
  }
  
  output.innerHTML = `
    <div class="report-stat-grid" style="margin-bottom:24px;">
      <div class="report-stat">
        <div class="report-stat-label">${state.yoyYear1} Income</div>
        <div class="report-stat-value green">${fmt(d1.income)}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">${state.yoyYear2} Income</div>
        <div class="report-stat-value green">${fmt(d2.income)}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Change</div>
        <div class="report-stat-value">${pctChange(d2.income, d1.income)}</div>
      </div>
    </div>
    
    <table class="data-table">
      <thead><tr><th style="text-align:left;">Month</th><th>${state.yoyYear1}</th><th>${state.yoyYear2}</th><th>Change</th></tr></thead>
      <tbody>
        ${monthRows}
        <tr style="font-weight:700;border-top:2px solid var(--plum);">
          <td style="text-align:left;">TOTAL</td>
          <td>${fmt(d1.income)}</td>
          <td>${fmt(d2.income)}</td>
          <td>${pctChange(d2.income, d1.income)}</td>
        </tr>
      </tbody>
    </table>
  `;
}

// Clients Report
async function renderClientsReport(output, controls) {
  const sortBy = state.clientsReportSort || 'total';
  const filterMonth = state.clientsReportMonth; // null = all time
  const showAll = state.clientsReportShowAll;
  const year = state.selectedYear;
  
  // Build month options
  const monthOpts = `<option value="">All Time</option>` + 
    Array.from({length:12}, (_,i) => `<option value="${i+1}" ${filterMonth === i+1 ? 'selected' : ''}>${monthName(i+1)}</option>`).join('');
  
  controls.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:16px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-weight:600;">Sort:</span>
        <select class="form-select" style="width:150px;" onchange="state.clientsReportSort=this.value;renderReport('clients')">
          <option value="total" ${sortBy === 'total' ? 'selected' : ''}>Total Spent</option>
          <option value="visits" ${sortBy === 'visits' ? 'selected' : ''}>Number of Visits</option>
          <option value="firstName" ${sortBy === 'firstName' ? 'selected' : ''}>First Name</option>
          <option value="lastName" ${sortBy === 'lastName' ? 'selected' : ''}>Last Name</option>
          <option value="recent" ${sortBy === 'recent' ? 'selected' : ''}>Most Recent</option>
          <option value="avgTicket" ${sortBy === 'avgTicket' ? 'selected' : ''}>Avg Ticket</option>
        </select>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-weight:600;">Period:</span>
        <select class="form-select" style="width:120px;" onchange="state.clientsReportMonth=this.value?parseInt(this.value):null;renderReport('clients')">
          ${monthOpts}
        </select>
        <input type="number" class="form-input" style="width:80px;" value="${year}" min="2020" max="2099" onchange="state.selectedYear=parseInt(this.value);renderReport('clients')">
      </div>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
        <input type="checkbox" ${showAll ? 'checked' : ''} onchange="state.clientsReportShowAll=this.checked;renderReport('clients')">
        <span>Show All</span>
      </label>
    </div>
  `;
  
  const txns = await db.transactions.toArray();
  
  // Filter by date if month selected
  let incomes = txns.filter(t => t.type === 'INCOME' && t.clientName);
  if (filterMonth) {
    const monthStr = `${year}-${String(filterMonth).padStart(2, '0')}`;
    incomes = incomes.filter(t => t.date?.startsWith(monthStr));
  }
  
  const clients = {};
  incomes.forEach(t => {
    const name = t.clientName.trim();
    if (!name) return;
    if (!clients[name]) {
      clients[name] = { name, total: 0, visits: 0, tips: 0, lastVisit: null };
    }
    const c = clients[name];
    c.total += (t.serviceAmount || 0) + (t.tipAmount || 0);
    c.tips += t.tipAmount || 0;
    c.visits++;
    if (!c.lastVisit || t.date > c.lastVisit) c.lastVisit = t.date;
  });
  
  let clientList = Object.values(clients);
  
  // Sort
  switch(sortBy) {
    case 'total': clientList.sort((a, b) => b.total - a.total); break;
    case 'visits': clientList.sort((a, b) => b.visits - a.visits); break;
    case 'firstName': clientList.sort((a, b) => a.name.localeCompare(b.name)); break;
    case 'lastName': 
      clientList.sort((a, b) => {
        const aLast = a.name.split(' ').pop() || a.name;
        const bLast = b.name.split(' ').pop() || b.name;
        return aLast.localeCompare(bLast);
      }); 
      break;
    case 'recent': clientList.sort((a, b) => (b.lastVisit || '').localeCompare(a.lastVisit || '')); break;
    case 'avgTicket': clientList.sort((a, b) => (b.total / b.visits) - (a.total / a.visits)); break;
  }
  
  const totalSpent = clientList.reduce((s, c) => s + c.total, 0);
  const totalVisits = clientList.reduce((s, c) => s + c.visits, 0);
  const totalClients = clientList.length;
  
  const displayList = showAll ? clientList : clientList.slice(0, 50);
  
  let rows = displayList.map((c, i) => `
    <tr>
      <td style="text-align:left;">${i + 1}</td>
      <td style="text-align:left;font-weight:500;">${c.name}</td>
      <td>${c.visits}</td>
      <td style="color:var(--success);">${fmt(c.total)}</td>
      <td>${fmt(c.total / c.visits)}</td>
      <td>${fmt(c.tips)}</td>
      <td>${c.lastVisit ? formatDateShort(c.lastVisit) : '-'}</td>
    </tr>
  `).join('');
  
  const periodLabel = filterMonth ? `${monthName(filterMonth)} ${year}` : 'All Time';
  
  output.innerHTML = `
    <div class="report-section-title">Client Report — ${periodLabel}</div>
    
    <div class="report-stat-grid" style="margin-bottom:24px;">
      <div class="report-stat">
        <div class="report-stat-label">Total Clients</div>
        <div class="report-stat-value">${totalClients}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Total Revenue</div>
        <div class="report-stat-value green">${fmt(totalSpent)}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Total Visits</div>
        <div class="report-stat-value">${totalVisits}</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-label">Avg per Client</div>
        <div class="report-stat-value">${totalClients > 0 ? fmt(totalSpent / totalClients) : '$0'}</div>
      </div>
    </div>
    
    ${totalClients === 0 ? `
      <div class="empty-state">
        <div class="empty-icon">👥</div>
        <div class="empty-title">No clients found</div>
        <div class="empty-text">${filterMonth ? 'No clients visited during this period' : 'Add client names to income entries to track them here'}</div>
      </div>
    ` : `
      <table class="data-table">
        <thead><tr>
          <th style="text-align:left;">#</th>
          <th style="text-align:left;">Client</th>
          <th>Visits</th>
          <th>Total Spent</th>
          <th>Avg Ticket</th>
          <th>Tips</th>
          <th>Last Visit</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${!showAll && totalClients > 50 ? `
        <p style="text-align:center;color:var(--text-muted);padding:16px;">
          Showing top 50 of ${totalClients} clients. 
          <a href="#" onclick="state.clientsReportShowAll=true;renderReport('clients');return false;" style="color:var(--plum);font-weight:600;">Show All</a>
        </p>
      ` : ''}
    `}
  `;
}

// Export Report
async function renderExportReport(output, controls) {
  controls.innerHTML = `
    <div style="display:flex;align-items:center;gap:16px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-weight:600;">From:</span>
        <input type="date" class="form-input" style="width:150px;" id="export-from" value="${state.range1Start}">
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-weight:600;">To:</span>
        <input type="date" class="form-input" style="width:150px;" id="export-to" value="${state.range1End}">
      </div>
    </div>
  `;
  
  output.innerHTML = `
    <div style="text-align:center;padding:40px;">
      <div style="font-size:48px;margin-bottom:16px;">📥</div>
      <h3 style="font-family:var(--font-display);font-size:20px;margin-bottom:8px;">Export Transactions</h3>
      <p style="color:var(--text-muted);margin-bottom:24px;">Download your transactions as a CSV file for use in Excel or other spreadsheet software.</p>
      
      <div style="display:flex;gap:16px;justify-content:center;flex-wrap:wrap;">
        <button class="btn-primary" onclick="exportTransactionsCSV()">📊 Export Transactions CSV</button>
        <button class="btn-secondary" onclick="exportClientsCSV()">👥 Export Clients CSV</button>
      </div>
    </div>
  `;
}

async function exportTransactionsCSV() {
  const from = document.getElementById('export-from').value;
  const to = document.getElementById('export-to').value;
  
  const txns = await db.transactions.toArray();
  const filtered = txns.filter(t => t.date >= from && t.date <= to).sort((a, b) => a.date.localeCompare(b.date));
  
  let csv = 'Date,Type,Category,Client,Service Amount,Tip,Total,Payment Method,Notes\n';
  filtered.forEach(t => {
    const total = t.type === 'INCOME' ? (t.serviceAmount || 0) + (t.tipAmount || 0) : (t.amount || 0);
    csv += `${t.date},${t.type},"${t.category || ''}","${t.clientName || ''}",${t.serviceAmount || 0},${t.tipAmount || 0},${total},${t.paymentMethod || ''},"${(t.notes || '').replace(/"/g, '""')}"\n`;
  });
  
  downloadCSV(csv, `transactions-${from}-to-${to}.csv`);
  showToast(`Exported ${filtered.length} transactions`);
}

async function exportClientsCSV() {
  const txns = await db.transactions.toArray();
  const incomes = txns.filter(t => t.type === 'INCOME' && t.clientName);
  
  const clients = {};
  incomes.forEach(t => {
    const name = t.clientName.trim();
    if (!name) return;
    if (!clients[name]) clients[name] = { name, total: 0, visits: 0, tips: 0, lastVisit: null };
    const c = clients[name];
    c.total += (t.serviceAmount || 0) + (t.tipAmount || 0);
    c.tips += t.tipAmount || 0;
    c.visits++;
    if (!c.lastVisit || t.date > c.lastVisit) c.lastVisit = t.date;
  });
  
  const clientList = Object.values(clients).sort((a, b) => b.total - a.total);
  
  let csv = 'Client Name,Total Spent,Visits,Average Ticket,Total Tips,Last Visit\n';
  clientList.forEach(c => {
    csv += `"${c.name}",${c.total.toFixed(2)},${c.visits},${(c.total / c.visits).toFixed(2)},${c.tips.toFixed(2)},${c.lastVisit || ''}\n`;
  });
  
  downloadCSV(csv, `clients-${todayStr()}.csv`);
  showToast(`Exported ${clientList.length} clients`);
}

function downloadCSV(content, filename) {
  const blob = new Blob([content], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ----------------------------------------------------------------
// 17. SETTINGS VIEW
// ----------------------------------------------------------------

async function renderSettingsView() {
  const content = document.getElementById('app-content');
  
  const businessName = (await db.settings.get('businessName'))?.value || 'My Salon';
  const pinEnabled = (await db.settings.get('pinLock'))?.value === 'true';
  const showRentersVal = (await db.settings.get('showRentersTab'))?.value;
  
  content.innerHTML = `
    <div class="settings-layout">
      <div class="settings-nav">
        <button class="settings-nav-item active" onclick="showSettingsSection('general')">General</button>
        <button class="settings-nav-item" onclick="showSettingsSection('categories')">Categories</button>
        <button class="settings-nav-item" onclick="showSettingsSection('security')">Security</button>
        <button class="settings-nav-item" onclick="showSettingsSection('data')">Data & Backup</button>
        <button class="settings-nav-item" onclick="showSettingsSection('usage')">API Usage</button>
      </div>
      
      <div class="settings-content" id="settings-section">
        <!-- General Settings -->
        <div class="settings-section">
          <div class="settings-section-title">General Settings</div>
          
          <div class="settings-item">
            <div>
              <div class="settings-item-label">Business Name</div>
              <div class="settings-item-sub">Displayed in reports and exports</div>
            </div>
            <input type="text" class="form-input" style="width:200px;" id="setting-business-name" value="${businessName}" onchange="saveSetting('businessName', this.value)">
          </div>
          
          <div class="settings-item">
            <div>
              <div class="settings-item-label">Booth Renters Tab</div>
              <div class="settings-item-sub">Auto hides if no active renters</div>
            </div>
            <select class="form-select" style="width:160px;" id="setting-renters-tab" onchange="saveSetting('showRentersTab', this.value);updateRentersTabVisibility();navigate('settings')">
              <option value="auto" ${!showRentersVal || showRentersVal === 'auto' ? 'selected' : ''}>Auto</option>
              <option value="true" ${showRentersVal === 'true' ? 'selected' : ''}>Always Show</option>
              <option value="false" ${showRentersVal === 'false' ? 'selected' : ''}>Always Hide</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  `;
}

function showSettingsSection(section) {
  document.querySelectorAll('.settings-nav-item').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  
  const container = document.getElementById('settings-section');
  
  if (section === 'general') {
    renderSettingsView();
  } else if (section === 'categories') {
    renderCategoriesSettings(container);
  } else if (section === 'security') {
    renderSecuritySettings(container);
  } else if (section === 'data') {
    renderDataSettings(container);
  } else if (section === 'usage') {
    renderUsageSettings(container);
  }
}

function renderCategoriesSettings(container) {
  container.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Income Categories</div>
      <div class="category-chips" id="income-chips">
        ${state.categories.INCOME.map((c, i) => `
          <div class="category-chip">${c}<button class="chip-delete" onclick="deleteCategory('INCOME', ${i})">×</button></div>
        `).join('')}
      </div>
      <div class="add-category-row">
        <input type="text" class="add-category-input" id="add-income-cat" placeholder="New category...">
        <button class="btn-add-chip" onclick="addCategory('INCOME')">Add</button>
      </div>
    </div>
    
    <div class="settings-section" style="margin-top:32px;">
      <div class="settings-section-title">Expense Categories</div>
      <div class="category-chips" id="expense-chips">
        ${state.categories.EXPENSE.map((c, i) => `
          <div class="category-chip">${c}<button class="chip-delete" onclick="deleteCategory('EXPENSE', ${i})">×</button></div>
        `).join('')}
      </div>
      <div class="add-category-row">
        <input type="text" class="add-category-input" id="add-expense-cat" placeholder="New category...">
        <button class="btn-add-chip" onclick="addCategory('EXPENSE')">Add</button>
      </div>
    </div>
  `;
}

async function addCategory(type) {
  const input = document.getElementById(type === 'INCOME' ? 'add-income-cat' : 'add-expense-cat');
  const val = input.value.trim();
  if (!val) return;
  
  if (state.categories[type].includes(val)) {
    showToast('Category already exists');
    return;
  }
  
  state.categories[type].push(val);
  await saveCategories();
  input.value = '';
  showSettingsSection('categories');
  showToast('Category added ✓');
}

async function deleteCategory(type, index) {
  const cat = state.categories[type][index];
  if (!confirm(`Delete "${cat}" category?`)) return;
  
  state.categories[type].splice(index, 1);
  await saveCategories();
  showSettingsSection('categories');
  showToast('Category deleted');
}

async function renderSecuritySettings(container) {
  const pinEnabled = (await db.settings.get('pinLock'))?.value === 'true';
  
  container.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Security</div>
      
      <div class="settings-item">
        <div>
          <div class="settings-item-label">PIN Lock</div>
          <div class="settings-item-sub">Require PIN to access the app</div>
        </div>
        <label class="toggle">
          <input type="checkbox" ${pinEnabled ? 'checked' : ''} onchange="togglePinLock(this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </div>
      
      ${pinEnabled ? `
        <button class="btn-secondary" style="margin-top:16px;" onclick="openChangePinModal()">Change PIN</button>
      ` : ''}
    </div>
  `;
}

async function togglePinLock(enabled) {
  if (enabled) {
    openSetPinModal();
  } else {
    await db.settings.delete('pinLock');
    await db.settings.delete('pinCode');
    showToast('PIN lock disabled');
    showSettingsSection('security');
  }
}

function openSetPinModal() {
  openModal(`
    <h2 class="modal-title">Set PIN</h2>
    <p style="color:var(--text-muted);margin-bottom:20px;">Enter a 4-digit PIN</p>
    
    <div class="form-group">
      <input type="password" class="form-input" id="new-pin" maxlength="4" pattern="[0-9]{4}" placeholder="Enter PIN" style="text-align:center;font-size:24px;letter-spacing:8px;">
    </div>
    <div class="form-group">
      <input type="password" class="form-input" id="confirm-pin" maxlength="4" pattern="[0-9]{4}" placeholder="Confirm PIN" style="text-align:center;font-size:24px;letter-spacing:8px;">
    </div>
    
    <button class="btn-primary" style="width:100%;margin-top:16px;" onclick="saveNewPin()">Set PIN</button>
  `);
}

async function saveNewPin() {
  const pin = document.getElementById('new-pin').value;
  const confirm = document.getElementById('confirm-pin').value;
  
  if (!/^\d{4}$/.test(pin)) {
    showToast('PIN must be 4 digits');
    return;
  }
  if (pin !== confirm) {
    showToast('PINs do not match');
    return;
  }
  
  await db.settings.put({ key: 'pinLock', value: 'true' });
  await db.settings.put({ key: 'pinCode', value: pin });
  closeModal();
  showToast('PIN set successfully');
  showSettingsSection('security');
}

async function renderDataSettings(container) {
  const lastBackup = (await db.settings.get('lastBackupDate'))?.value;
  
  container.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Data Management</div>
      
      <div class="settings-item">
        <div>
          <div class="settings-item-label">Export Backup</div>
          <div class="settings-item-sub">Download all your data as JSON${lastBackup ? ` · Last backup: ${formatDateShort(lastBackup)}` : ''}</div>
        </div>
        <button class="btn-secondary" onclick="exportBackup()">Export</button>
      </div>
      
      <div class="settings-item">
        <div>
          <div class="settings-item-label">Import Backup</div>
          <div class="settings-item-sub">Restore from a backup file (replaces all data)</div>
        </div>
        <button class="btn-secondary" onclick="document.getElementById('import-file').click()">Import</button>
        <input type="file" id="import-file" accept=".json" style="display:none;" onchange="importBackup(this.files[0])">
      </div>
      
      <div class="settings-item" style="border-top:2px solid var(--danger-bg);padding-top:20px;margin-top:20px;">
        <div>
          <div class="settings-item-label" style="color:var(--danger);">Clear All Data</div>
          <div class="settings-item-sub">Permanently delete all transactions and settings</div>
        </div>
        <button class="btn-danger" onclick="clearAllData()">Clear</button>
      </div>
    </div>
  `;
}

async function exportBackup() {
  try {
    const data = {
      exportDate: new Date().toISOString(),
      transactions: await db.transactions.toArray(),
      dailySummary: await db.dailySummary.toArray(),
      monthlyExpenses: await db.monthlyExpenses.toArray(),
      renters: await db.renters.toArray(),
      rentPayments: await db.rentPayments.toArray(),
      settings: await db.settings.toArray(),
      categories: state.categories
    };
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mane-frame-backup-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    await db.settings.put({ key: 'lastBackupDate', value: todayStr() });
    showToast('Backup exported ✓');
  } catch(err) {
    console.error('Export error:', err);
    showToast('Error exporting backup');
  }
}

async function importBackup(file) {
  if (!file) return;
  
  const confirmed = await confirmDialog(
    'This will replace ALL your current data with the backup. This cannot be undone. Continue?',
    'Confirm Import'
  );
  if (!confirmed) return;
  
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    
    // Clear existing data
    await db.transactions.clear();
    await db.dailySummary.clear();
    await db.monthlyExpenses.clear();
    await db.renters.clear();
    await db.rentPayments.clear();
    await db.settings.clear();
    
    // Import new data
    if (data.transactions?.length) await db.transactions.bulkAdd(data.transactions);
    if (data.dailySummary?.length) await db.dailySummary.bulkAdd(data.dailySummary);
    if (data.monthlyExpenses?.length) await db.monthlyExpenses.bulkAdd(data.monthlyExpenses);
    if (data.renters?.length) await db.renters.bulkAdd(data.renters);
    if (data.rentPayments?.length) await db.rentPayments.bulkAdd(data.rentPayments);
    if (data.settings?.length) await db.settings.bulkAdd(data.settings);
    
    if (data.categories) {
      state.categories = data.categories;
      await saveCategories();
    }
    
    showToast('Backup imported ✓');
    await loadCategories();
    await updateRentersTabVisibility();
    navigate('dashboard');
  } catch(err) {
    console.error('Import error:', err);
    showToast('Error importing backup');
  }
}

async function clearAllData() {
  const confirmed = await confirmDialog(
    'This will PERMANENTLY DELETE all your data including transactions, renters, and settings. This cannot be undone!',
    '⚠️ Delete Everything?'
  );
  if (!confirmed) return;
  
  const doubleConfirm = await confirmDialog(
    'Are you absolutely sure? Type "DELETE" in your mind and click confirm.',
    'Final Confirmation'
  );
  if (!doubleConfirm) return;
  
  try {
    await db.transactions.clear();
    await db.dailySummary.clear();
    await db.monthlyExpenses.clear();
    await db.renters.clear();
    await db.rentPayments.clear();
    await db.settings.clear();
    
    state.categories = { ...DEFAULT_CATEGORIES };
    showToast('All data cleared');
    navigate('dashboard');
  } catch(err) {
    console.error('Clear error:', err);
    showToast('Error clearing data');
  }
}

async function saveSetting(key, value) {
  await db.settings.put({ key, value });
  showToast('Setting saved ✓');
}

// ----------------------------------------------------------------
// API USAGE TRACKING
// ----------------------------------------------------------------

// Cost estimates per API call (approximate)
const API_COSTS = {
  'anthropic-sonnet': 0.015,      // ~$0.015 per 1K tokens, avg response ~1K
  'anthropic-search': 0.025,      // Sonnet + web search
  'firebase-function': 0.0000004, // ~$0.40 per million invocations
  'firestore-read': 0.000036,     // $0.036 per 100K reads
  'firestore-write': 0.00018,     // $0.18 per 100K writes
};

function getUsageLog() {
  try {
    return JSON.parse(localStorage.getItem('mf_api_usage') || '[]');
  } catch { return []; }
}

function logApiUsage(type, details = {}) {
  const log = getUsageLog();
  log.push({
    type,
    timestamp: new Date().toISOString(),
    cost: API_COSTS[type] || 0,
    ...details
  });
  // Keep last 1000 entries
  if (log.length > 1000) log.splice(0, log.length - 1000);
  localStorage.setItem('mf_api_usage', JSON.stringify(log));
}

function getUsageStats() {
  const log = getUsageLog();
  const now = new Date();
  const today = todayStr();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastMonth = `${now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()}-${String(now.getMonth() === 0 ? 12 : now.getMonth()).padStart(2, '0')}`;
  
  const stats = {
    today: { calls: 0, cost: 0 },
    thisMonth: { calls: 0, cost: 0 },
    lastMonth: { calls: 0, cost: 0 },
    allTime: { calls: log.length, cost: 0 },
    byType: {}
  };
  
  log.forEach(entry => {
    const date = entry.timestamp?.substring(0, 10) || '';
    const month = entry.timestamp?.substring(0, 7) || '';
    const cost = entry.cost || 0;
    
    stats.allTime.cost += cost;
    
    if (date === today) {
      stats.today.calls++;
      stats.today.cost += cost;
    }
    if (month === thisMonth) {
      stats.thisMonth.calls++;
      stats.thisMonth.cost += cost;
    }
    if (month === lastMonth) {
      stats.lastMonth.calls++;
      stats.lastMonth.cost += cost;
    }
    
    // By type breakdown
    if (!stats.byType[entry.type]) {
      stats.byType[entry.type] = { calls: 0, cost: 0 };
    }
    stats.byType[entry.type].calls++;
    stats.byType[entry.type].cost += cost;
  });
  
  return stats;
}

function getRecentUsage(limit = 20) {
  const log = getUsageLog();
  return log.slice(-limit).reverse();
}

function clearUsageLog() {
  localStorage.removeItem('mf_api_usage');
  showToast('Usage log cleared');
  showSettingsSection('usage');
}

function renderUsageSettings(container) {
  const stats = getUsageStats();
  const recent = getRecentUsage(15);
  
  const formatCost = (cost) => cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`;
  
  const typeLabels = {
    'anthropic-sonnet': 'AI Query',
    'anthropic-search': 'AI Query + Search',
    'firebase-function': 'Cloud Function',
    'firestore-read': 'Database Read',
    'firestore-write': 'Database Write'
  };
  
  const byTypeRows = Object.entries(stats.byType)
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([type, data]) => `
      <tr>
        <td style="text-align:left;">${typeLabels[type] || type}</td>
        <td style="text-align:center;">${data.calls}</td>
        <td style="text-align:right;">${formatCost(data.cost)}</td>
      </tr>
    `).join('');
  
  const recentRows = recent.map(entry => {
    const time = new Date(entry.timestamp);
    const timeStr = time.toLocaleDateString() + ' ' + time.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    return `
      <tr>
        <td style="text-align:left;font-size:12px;color:var(--text-muted);">${timeStr}</td>
        <td style="text-align:left;">${typeLabels[entry.type] || entry.type}</td>
        <td style="text-align:right;">${formatCost(entry.cost)}</td>
      </tr>
    `;
  }).join('');
  
  container.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">API Usage & Costs</div>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:20px;">
        Estimated costs based on typical usage. Actual costs may vary slightly. 
        Check <a href="https://console.anthropic.com" target="_blank" style="color:var(--plum);">Anthropic Console</a> 
        and <a href="https://console.firebase.google.com" target="_blank" style="color:var(--plum);">Firebase Console</a> for exact billing.
      </p>
      
      <div class="grid-4" style="margin-bottom:24px;">
        <div class="stat-card">
          <div class="stat-label">Today</div>
          <div class="stat-value">${stats.today.calls}</div>
          <div style="font-size:12px;color:var(--text-muted);">${formatCost(stats.today.cost)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">This Month</div>
          <div class="stat-value">${stats.thisMonth.calls}</div>
          <div style="font-size:12px;color:var(--text-muted);">${formatCost(stats.thisMonth.cost)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Last Month</div>
          <div class="stat-value">${stats.lastMonth.calls}</div>
          <div style="font-size:12px;color:var(--text-muted);">${formatCost(stats.lastMonth.cost)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">All Time</div>
          <div class="stat-value">${stats.allTime.calls}</div>
          <div style="font-size:12px;color:var(--text-muted);">${formatCost(stats.allTime.cost)}</div>
        </div>
      </div>
      
      ${Object.keys(stats.byType).length > 0 ? `
        <div class="settings-section-title" style="margin-top:24px;">Cost Breakdown by Type</div>
        <table class="data-table" style="margin-bottom:24px;">
          <thead>
            <tr><th style="text-align:left;">Type</th><th style="text-align:center;">Calls</th><th style="text-align:right;">Est. Cost</th></tr>
          </thead>
          <tbody>${byTypeRows}</tbody>
        </table>
      ` : ''}
      
      ${recent.length > 0 ? `
        <div class="settings-section-title" style="margin-top:24px;">Recent Activity</div>
        <table class="data-table" style="margin-bottom:24px;">
          <thead>
            <tr><th style="text-align:left;">Time</th><th style="text-align:left;">Type</th><th style="text-align:right;">Est. Cost</th></tr>
          </thead>
          <tbody>${recentRows}</tbody>
        </table>
      ` : '<p style="color:var(--text-muted);">No API usage recorded yet.</p>'}
      
      <div style="margin-top:24px;padding-top:20px;border-top:1px solid var(--border);">
        <button class="btn-secondary" onclick="clearUsageLog()" style="color:var(--danger);">Clear Usage Log</button>
      </div>
    </div>
  `;
}

// ----------------------------------------------------------------
// 18. AI ASK OVERLAY
// ----------------------------------------------------------------

window._aiChatHistory = [];

// Pool of AI suggestion prompts - rotates randomly each time overlay opens
const AI_SUGGESTIONS = [
  // Business performance
  "How did I do last month?",
  "How's my business doing this year compared to last year?",
  "What was my best month this year?",
  "Am I making more or less than last quarter?",
  "What's my average daily income?",
  
  // Clients
  "Who are my top clients?",
  "Which clients haven't visited in a while?",
  "Who tips the best?",
  "How many new clients did I get this month?",
  "What's my average ticket per client?",
  
  // Services & Categories
  "What's my most profitable service?",
  "Which services bring in the most revenue?",
  "What categories am I spending the most on?",
  "Where are my biggest expenses?",
  
  // Booth rent
  "Show me my booth rent collection status",
  "Are any booth renters behind on payments?",
  "How much booth rent have I collected this year?",
  "Which renter pays most consistently on time?",
  
  // Trends & insights
  "What should I focus on to grow revenue?",
  "What trends do you see in my business?",
  "How can I reduce my expenses?",
  "What day of the week is my busiest?",
  
  // Industry comparisons (will trigger web search)
  "How does my income compare to other salons?",
  "What's the average booth rent rate in my area?",
  "What do other stylists charge for balayage?",
  "What's a typical profit margin for a salon?",
  "How much should I be saving for taxes?",
  
  // Planning & advice
  "Should I raise my prices?",
  "When should I take my next vacation based on slow periods?",
  "What marketing ideas might help grow my client base?",
  "How do I encourage more repeat visits?",
];

function getRandomSuggestions(count = 4) {
  const shuffled = [...AI_SUGGESTIONS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function openAskOverlay() {
  const overlay = document.getElementById('ai-ask-overlay');
  overlay.classList.remove('hidden');
  
  // Reset chat on open
  window._aiChatHistory = [];
  
  // Generate random suggestions
  const suggestions = getRandomSuggestions(4);
  const suggestionsHTML = suggestions.map(s => 
    `<button class="ai-suggestion" onclick="askSuggestion(this)">${s}</button>`
  ).join('');
  
  // Reset messages with new suggestions
  document.getElementById('ai-chat-messages').innerHTML = `
    <div class="ai-welcome">
      <p>Ask me anything about your business! For example:</p>
      <div class="ai-suggestions">${suggestionsHTML}</div>
    </div>
  `;
  
  document.getElementById('ai-ask-input').focus();
}

function closeAskOverlay() {
  document.getElementById('ai-ask-overlay').classList.add('hidden');
}

function askSuggestion(btn) {
  document.getElementById('ai-ask-input').value = btn.textContent;
  sendAskQuery();
}

async function sendAskQuery() {
  const input = document.getElementById('ai-ask-input');
  const question = input.value.trim();
  if (!question) return;
  
  input.value = '';
  
  const messagesDiv = document.getElementById('ai-chat-messages');
  
  // Add user message
  messagesDiv.innerHTML += `<div class="ai-message user">${question}</div>`;
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  
  // Add loading indicator
  const loadingId = 'ai-loading-' + Date.now();
  messagesDiv.innerHTML += `<div class="ai-message assistant" id="${loadingId}"><div class="loading-spinner" style="width:20px;height:20px;"></div></div>`;
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  
  try {
    // Build snapshot on first message
    let snapshot = null;
    if (window._aiChatHistory.length === 0) {
      snapshot = await buildBusinessSnapshot();
    }
    
    // Add to history
    window._aiChatHistory.push({ role: 'user', content: question });
    if (window._aiChatHistory.length > 10) {
      window._aiChatHistory = window._aiChatHistory.slice(-10);
    }
    
    // Call the AI function
    const askAI = firebase.functions().httpsCallable('askAI');
    const result = await askAI({
      question,
      snapshot,
      history: window._aiChatHistory
    });
    
    // Log usage (estimate - includes search if answer mentions external data)
    const answer = result.data?.answer || 'Sorry, I could not process that question.';
    const usedSearch = answer.includes('industry') || answer.includes('According to') || answer.includes('average') && question.toLowerCase().includes('compare');
    logApiUsage(usedSearch ? 'anthropic-search' : 'anthropic-sonnet', { question: question.substring(0, 50) });
    
    // Add to history
    window._aiChatHistory.push({ role: 'assistant', content: answer });
    
    // Replace loading with answer
    document.getElementById(loadingId).innerHTML = answer.replace(/\n/g, '<br>');
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
  } catch(err) {
    console.error('AI error:', err);
    document.getElementById(loadingId).innerHTML = 'Sorry, there was an error processing your question. Please try again.';
  }
}

async function buildBusinessSnapshot() {
  const [txns, mExp, renters, rentPmts] = await Promise.all([
    db.transactions.toArray(),
    db.monthlyExpenses.toArray(),
    db.renters.toArray(),
    db.rentPayments.toArray()
  ]);
  
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  
  // Monthly summaries (last 6 months)
  const monthlySummaries = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const mTxns = txns.filter(t => t.date?.startsWith(monthStr));
    const mMExp = mExp.filter(e => e.year === d.getFullYear() && e.month === d.getMonth() + 1);
    
    const income = mTxns.filter(t => t.type === 'INCOME').reduce((s, t) => s + (t.serviceAmount || 0) + (t.tipAmount || 0), 0);
    const expenses = mTxns.filter(t => t.type === 'EXPENSE').reduce((s, t) => s + (t.amount || 0), 0) + mMExp.reduce((s, e) => s + (e.amount || 0), 0);
    
    monthlySummaries.push({
      month: monthStr,
      income: Math.round(income),
      expenses: Math.round(expenses),
      net: Math.round(income - expenses),
      clientCount: new Set(mTxns.filter(t => t.type === 'INCOME' && t.clientName).map(t => t.clientName)).size
    });
  }
  
  // Top clients
  const clientTotals = {};
  txns.filter(t => t.type === 'INCOME' && t.clientName).forEach(t => {
    clientTotals[t.clientName] = (clientTotals[t.clientName] || 0) + (t.serviceAmount || 0) + (t.tipAmount || 0);
  });
  const topClients = Object.entries(clientTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, total]) => ({ name, total: Math.round(total) }));
  
  // Renter status
  const activeRenters = renters.filter(r => r.status === 'active').map(r => {
    const pmts = rentPmts.filter(p => p.renterId === r.id);
    return {
      name: r.name,
      weeklyRate: getCurrentRate(r),
      totalPaid: pmts.reduce((s, p) => s + (p.amount || 0), 0),
      paymentCount: pmts.length
    };
  });
  
  return {
    currentDate: todayStr(),
    monthlySummaries,
    topClients,
    activeRenters,
    totalTransactions: txns.length
  };
}

// ----------------------------------------------------------------
// 19. PIN SCREEN LOGIC
// ----------------------------------------------------------------

let _pinEntry = '';

function setupPinPad() {
  document.querySelectorAll('.pin-btn[data-num]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (_pinEntry.length >= 4) return;
      _pinEntry += btn.dataset.num;
      updatePinDots();
      if (_pinEntry.length === 4) {
        checkPin();
      }
    });
  });
  
  document.getElementById('pin-back').addEventListener('click', () => {
    _pinEntry = _pinEntry.slice(0, -1);
    updatePinDots();
    document.getElementById('pin-error').classList.add('hidden');
  });
}

function updatePinDots() {
  for (let i = 0; i < 4; i++) {
    document.getElementById(`dot-${i}`).classList.toggle('filled', i < _pinEntry.length);
  }
}

async function checkPin() {
  const stored = (await db.settings.get('pinCode'))?.value;
  if (_pinEntry === stored) {
    document.getElementById('pin-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    await bootApp();
  } else {
    document.getElementById('pin-error').classList.remove('hidden');
    _pinEntry = '';
    updatePinDots();
    // Shake animation
    document.querySelector('.pin-dots').style.animation = 'shake 0.3s';
    setTimeout(() => {
      document.querySelector('.pin-dots').style.animation = '';
    }, 300);
  }
}

// ----------------------------------------------------------------
// 20. APP BOOT
// ----------------------------------------------------------------

let _appBooted = false;

async function bootApp() {
  if (_appBooted) return;
  _appBooted = true;
  
  // Update user info in sidebar
  const user = currentUser;
  if (user) {
    document.getElementById('user-name').textContent = user.displayName || 'User';
    document.getElementById('user-email').textContent = user.email || '';
    document.getElementById('user-avatar').textContent = (user.displayName || user.email || 'U').charAt(0).toUpperCase();
  }
  
  // Load categories
  await loadCategories();
  
  // Check renters tab visibility
  await updateRentersTabVisibility();
  
  // Navigate to dashboard
  navigate('dashboard');
}

// ----------------------------------------------------------------
// PIE CHART HELPER
// ----------------------------------------------------------------

const PIE_COLORS = [
  '#E74C3C', '#3498DB', '#F39C12', '#9B59B6', '#1ABC9C',
  '#E67E22', '#34495E', '#16A085', '#D35400', '#8E44AD',
  '#27AE60', '#2980B9'
];

const _chartInstances = {};

function drawPieChart(canvasId, labels, values) {
  if (typeof Chart === 'undefined') {
    console.warn('Chart.js not loaded');
    return;
  }
  
  if (_chartInstances[canvasId]) {
    _chartInstances[canvasId].destroy();
    delete _chartInstances[canvasId];
  }
  
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  
  _chartInstances[canvasId] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: PIE_COLORS.slice(0, values.length),
        borderColor: '#fff',
        borderWidth: 2,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: '55%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#5C3A4A',
            font: { size: 11, family: "'DM Sans', sans-serif" },
            padding: 12,
            boxWidth: 14,
            boxHeight: 14,
          },
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct = total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) : 0;
              return ` ${ctx.label}: ${fmt(ctx.parsed)} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

// ----------------------------------------------------------------
// 21. AUTH STATE LISTENER
// ----------------------------------------------------------------

auth.onAuthStateChanged(async (user) => {
  if (user) {
    currentUser = user;
    
    // Check for PIN lock
    const pinEnabled = (await db.settings.get('pinLock'))?.value === 'true';
    
    document.getElementById('login-screen').classList.add('hidden');
    
    if (pinEnabled) {
      document.getElementById('pin-screen').classList.remove('hidden');
      setupPinPad();
    } else {
      document.getElementById('app').classList.remove('hidden');
      await bootApp();
    }
  } else {
    currentUser = null;
    _appBooted = false;
    document.getElementById('app').classList.add('hidden');
    document.getElementById('pin-screen').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
  }
});

// Keyboard shortcut for closing modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal();
    closeAskOverlay();
  }
});

console.log('Mane Frame Desktop initialized');
