// ================================================================
//  SALON BOOKS — Main Application Logic
//  Uses Dexie.js (IndexedDB wrapper) for local data storage
// ================================================================

'use strict';

// ----------------------------------------------------------------
// 1. DATABASE SETUP
// ----------------------------------------------------------------

// ================================================================
//  DATABASE SCHEMA
//  v1: initial  v2: added renters  v4: categories moved to settings JSON
// ================================================================

const db = new Dexie('SalonBooks');

db.version(1).stores({
  transactions:    '++id, date, type, category, paymentMethod',
  dailySummary:    '++id, &date',
  monthlyExpenses: '++id, year, month, category',
  categories:      '++id, name, type',
  settings:        'key',
});

db.version(2).stores({
  transactions:    '++id, date, type, category, paymentMethod',
  dailySummary:    '++id, &date',
  monthlyExpenses: '++id, year, month, category',
  categories:      '++id, name, type',
  settings:        'key',
  renters:         '++id, name, status',
  rentPayments:    '++id, renterId, weekStart, datePaid',
});

db.version(3).stores({
  transactions:    '++id, date, type, category, paymentMethod',
  dailySummary:    '++id, &date',
  monthlyExpenses: '++id, year, month, category',
  categories:      '++id, name, type',
  settings:        'key',
  renters:         '++id, name, status',
  rentPayments:    '++id, renterId, weekStart, datePaid',
});

// v4: Migrate categories out of their own table into a single JSON
// blob stored in settings. Categories are configuration data — small,
// always loaded all at once, never queried by index. Storing them as
// individual indexed rows was the wrong design and caused all the
// dropdown bugs. From v4 onward the categories table is unused;
// all reads/writes go through state.categories + settings JSON.
db.version(4).stores({
  transactions:    '++id, date, type, category, paymentMethod',
  dailySummary:    '++id, &date',
  monthlyExpenses: '++id, year, month, category',
  categories:      '++id, name, type',   // kept in schema, no longer used
  settings:        'key',
  renters:         '++id, name, status',
  rentPayments:    '++id, renterId, weekStart, datePaid',
}).upgrade(async tx => {
  // Read whatever categories survived in the old table
  const existing = await tx.table('categories').toArray();
  const catMap = { INCOME: [], DAILY_EXPENSE: [], MONTHLY_EXPENSE: [] };
  existing.forEach(c => {
    if (c.type && catMap[c.type] && !catMap[c.type].includes(c.name)) {
      catMap[c.type].push(c.name);
    }
  });
  // Fill in any missing defaults so nothing is lost
  const defs = _defaultCategoryMap();
  if (catMap.INCOME.length          === 0) catMap.INCOME          = defs.INCOME;
  if (catMap.DAILY_EXPENSE.length   === 0) catMap.DAILY_EXPENSE   = defs.DAILY_EXPENSE;
  if (catMap.MONTHLY_EXPENSE.length === 0) catMap.MONTHLY_EXPENSE = defs.MONTHLY_EXPENSE;
  // Persist as a single JSON string in the settings table
  await tx.table('settings').put({ key: 'categories', value: JSON.stringify(catMap) });
});

// ----------------------------------------------------------------
// 2. APP STATE
// ----------------------------------------------------------------

const state = {
  currentView:       'daily',
  selectedDate:      todayStr(),
  selectedMonth:     new Date().getMonth() + 1,
  selectedYear:      new Date().getFullYear(),
  reportType:        'daily',
  pinBuffer:         '',
  pinEnabled:        false,
  rentersWeekStart:  null,
  // Categories live here in memory after loadCategories() runs at startup.
  // Shape: { INCOME: ['Haircut', 'Color', ...], DAILY_EXPENSE: [...], MONTHLY_EXPENSE: [...] }
  categories:        { INCOME: [], DAILY_EXPENSE: [], MONTHLY_EXPENSE: [] },
};

// ----------------------------------------------------------------
// 3. UTILITY FUNCTIONS
// ----------------------------------------------------------------

// Returns today's date as 'YYYY-MM-DD'
function todayStr() {
  const d = new Date();
  return d.toISOString().split('T')[0];
}

// Format a date string 'YYYY-MM-DD' for display
function formatDateDisplay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00'); // noon avoids timezone issues
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
}

// Format a date string for short display
function formatDateShort(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// Format a currency amount
function fmt(amount) {
  if (amount === null || amount === undefined || isNaN(amount)) return '$0.00';
  return '$' + parseFloat(amount).toFixed(2);
}

// Get month name from number (1-12)
function monthName(num) {
  return new Date(2000, num - 1, 1).toLocaleString('en-US', { month: 'long' });
}

// Add days to a date string
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// Get Monday of the week for a given date
function getWeekStart(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split('T')[0];
}

// Show a brief toast notification at the bottom of the screen
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 2200);
}

// ----------------------------------------------------------------
// 4. CATEGORY MANAGEMENT
// Categories are configuration data — stored as a single JSON blob
// in the settings table and loaded into state.categories at startup.
// Every part of the app reads state.categories synchronously from
// memory. No index queries, no async calls, nothing to break.
// ----------------------------------------------------------------

// The hardcoded defaults — only used if no saved categories exist yet
function _defaultCategoryMap() {
  return {
    INCOME: [
      'Haircut', 'Color', 'Highlights', 'Blowout', 'Treatment',
      'Nails', 'Waxing', 'Retail Product', 'Other Service',
    ],
    DAILY_EXPENSE: [
      'Supplies', 'Products', 'Tools/Equipment', 'Advertising',
      'Education', 'Meals', 'Employee Pay', 'Misc Daily',
    ],
    MONTHLY_EXPENSE: [
      'Rent', 'Electric', 'Water', 'Gas', 'Insurance',
      'Cleaning Service', 'Booking Software', 'Phone',
      'Marketing', 'Misc Monthly',
    ],
  };
}

// Load categories from DB into state. Called at startup and before any modal
// that needs them. Safe to call multiple times — cheap single key-value read.
async function loadCategories() {
  try {
    const saved = await db.settings.get('categories');
    if (saved?.value) {
      const parsed = JSON.parse(saved.value);
      // Merge with defaults so any missing key gets filled in
      state.categories = {
        INCOME:          parsed.INCOME?.length          ? parsed.INCOME          : _defaultCategoryMap().INCOME,
        DAILY_EXPENSE:   parsed.DAILY_EXPENSE?.length   ? parsed.DAILY_EXPENSE   : _defaultCategoryMap().DAILY_EXPENSE,
        MONTHLY_EXPENSE: parsed.MONTHLY_EXPENSE?.length ? parsed.MONTHLY_EXPENSE : _defaultCategoryMap().MONTHLY_EXPENSE,
      };
    } else {
      // Nothing saved yet — write defaults now so next read finds them
      state.categories = _defaultCategoryMap();
      await saveCategories();
    }
  } catch (e) {
    // DB unavailable or JSON corrupt — use defaults in memory, try to save
    console.warn('loadCategories error:', e);
    state.categories = _defaultCategoryMap();
    try { await saveCategories(); } catch (_) { /* best effort */ }
  }
}

// Persist current state.categories back to the DB. Simple and atomic.
async function saveCategories() {
  await db.settings.put({ key: 'categories', value: JSON.stringify(state.categories) });
}

// Return options HTML for a category select element
function categoryOptions(type) {
  return (state.categories[type] || [])
    .map(name => `<option value="${name}">${name}</option>`)
    .join('');
}

// ----------------------------------------------------------------
// 5. NAVIGATION
// ----------------------------------------------------------------

function navigate(view) {
  state.currentView = view;

  // Update nav button active states
  ['daily', 'monthly', 'renters', 'reports', 'settings'].forEach(v => {
    const btn = document.getElementById('nav-' + v);
    if (btn) btn.classList.toggle('active', v === view);
  });

  // Update header title
  const titles = {
    daily:    'Daily Log',
    monthly:  'Monthly Expenses',
    renters:  'Booth Renters',
    reports:  'Reports',
    settings: 'Settings',
  };
  document.getElementById('view-title').textContent = titles[view] || '';

  // Render the appropriate view
  const views = {
    daily:    renderDailyView,
    monthly:  renderMonthlyView,
    renters:  renderRentersView,
    reports:  renderReportsView,
    settings: renderSettingsView,
  };
  if (views[view]) views[view]();
}

// ----------------------------------------------------------------
// 6. DAILY VIEW
// ----------------------------------------------------------------

async function renderDailyView() {
  const content = document.getElementById('app-content');
  const hdr = document.getElementById('header-actions');
  hdr.innerHTML = '';

  // Fetch data for the selected date
  const txns = await db.transactions.where('date').equals(state.selectedDate).toArray();
  const summary = await db.dailySummary.where('date').equals(state.selectedDate).first();

  const income  = txns.filter(t => t.type === 'INCOME');
  const expenses = txns.filter(t => t.type === 'EXPENSE');

  const totalService = income.reduce((s, t) => s + (t.serviceAmount || 0), 0);
  const totalTips    = income.reduce((s, t) => s + (t.tipAmount || 0), 0);
  const totalIncome  = totalService + totalTips;
  const totalExp     = expenses.reduce((s, t) => s + (t.amount || 0), 0);
  const net          = totalIncome - totalExp;

  const isToday = state.selectedDate === todayStr();

  // Check if backup is overdue (> 7 days)
  const lastBackupSetting = await db.settings.get('lastBackup');
  let backupNudge = '';
  if (isToday) {
    const lastBackupDate = lastBackupSetting?.value;
    const daysOverdue = lastBackupDate
      ? Math.floor((new Date() - new Date(lastBackupDate + 'T12:00:00')) / 86400000)
      : 999;
    if (daysOverdue >= 7) {
      backupNudge = `
        <div class="backup-nudge" onclick="navigate('settings')">
          💾 Back up your data — ${daysOverdue >= 999 ? "you haven't backed up yet" : `last backup ${daysOverdue} days ago`}
          <span style="margin-left:6px;opacity:.7;">›</span>
        </div>`;
    }
  }

  content.innerHTML = `
    <!-- Backup nudge (if overdue) -->
    ${backupNudge}

    <!-- Date Navigation Bar -->
    <div class="daily-date-bar">
      <button class="date-nav-btn" onclick="changeDate(-1)">‹</button>
      <div class="current-date" onclick="promptDatePicker()">
        ${formatDateShort(state.selectedDate)}
        ${isToday ? '<small>Today</small>' : ''}
      </div>
      <button class="date-nav-btn" onclick="changeDate(1)">›</button>
    </div>

    <!-- Summary Cards -->
    <div class="summary-section">
      <div class="summary-grid">
        <div class="summary-card income">
          <div class="summary-label">Income</div>
          <div class="summary-value">${fmt(totalService)}</div>
        </div>
        <div class="summary-card expense">
          <div class="summary-label">Expenses</div>
          <div class="summary-value">${fmt(totalExp)}</div>
        </div>
        <div class="summary-card tips">
          <div class="summary-label">Tips</div>
          <div class="summary-value">${fmt(totalTips)}</div>
        </div>
        <div class="summary-card net">
          <div class="summary-label">Net</div>
          <div class="summary-value" style="${net < 0 ? 'color:var(--danger)' : ''}">${fmt(net)}</div>
        </div>
      </div>

      <!-- Clients & Hours Card -->
      <div class="day-meta-card">
        <div class="day-meta-item">
          <span class="day-meta-label">Clients</span>
          <span class="day-meta-value">${summary ? summary.clientsSeen : '—'}</span>
        </div>
        <div class="day-meta-item">
          <span class="day-meta-label">Hours</span>
          <span class="day-meta-value">${summary ? summary.hoursWorked : '—'}</span>
        </div>
        ${summary && income.length > 0 ? `
        <div class="day-meta-item">
          <span class="day-meta-label">Avg/Client</span>
          <span class="day-meta-value">${summary.clientsSeen > 0 ? fmt(totalIncome / summary.clientsSeen) : '—'}</span>
        </div>` : ''}
        <button class="day-meta-edit" onclick="openDaySummaryModal()">Edit</button>
      </div>
    </div>

    <!-- Transaction List -->
    <div class="transactions-section">
      ${income.length > 0 ? `
        <div class="section-label">Income</div>
        ${income.map(t => renderTransactionItem(t)).join('')}
      ` : ''}

      ${expenses.length > 0 ? `
        <div class="section-label" style="margin-top: 12px;">Expenses</div>
        ${expenses.map(t => renderTransactionItem(t)).join('')}
      ` : ''}

      ${txns.length === 0 ? `
        <div class="empty-state">
          <div class="empty-icon">✂️</div>
          <div class="empty-text">No entries yet for this day.<br>Use the buttons below to get started.</div>
        </div>
      ` : ''}
    </div>

    <!-- Add Buttons -->
    <div class="fab-row">
      <button class="fab fab-income" onclick="openAddTransactionModal('INCOME')">
        <span style="font-size:18px">+</span> Add Income
      </button>
      <button class="fab fab-expense" onclick="openAddTransactionModal('EXPENSE')">
        <span style="font-size:18px">+</span> Add Expense
      </button>
    </div>
  `;
}

// Renders a single transaction row
function renderTransactionItem(t) {
  const isIncome = t.type === 'INCOME';
  const dot = isIncome ? '💰' : '📤';
  const pmPill = t.paymentMethod ? `<span class="pill pill-${(t.paymentMethod||'').toLowerCase()}">${t.paymentMethod}</span>` : '';
  return `
    <div class="transaction-item">
      <div class="txn-type-dot ${isIncome ? 'income' : 'expense'}">${dot}</div>
      <div class="txn-body">
        <div class="txn-category">${t.category || 'Uncategorized'}</div>
        <div class="txn-meta">${pmPill} ${t.notes ? `· ${t.notes}` : ''}</div>
      </div>
      <div class="txn-amount-col">
        <div class="txn-amount ${isIncome ? 'income' : 'expense'}">
          ${isIncome ? '+' : '-'}${fmt(isIncome ? t.serviceAmount : t.amount)}
        </div>
        ${isIncome && t.tipAmount > 0 ? `<div class="txn-tip">tip +${fmt(t.tipAmount)} ${t.tipMethod ? '(' + t.tipMethod + ')' : ''}</div>` : ''}
      </div>
      <button class="txn-delete" onclick="deleteTransaction(${t.id})">✕</button>
    </div>
  `;
}

function changeDate(delta) {
  state.selectedDate = addDays(state.selectedDate, delta);
  renderDailyView();
}

// Let user pick a specific date using the native date input
function promptDatePicker() {
  openModal(`
    <h2 class="modal-title">Select Date</h2>
    <div class="form-group">
      <label class="form-label">Date</label>
      <input type="date" class="form-input" id="date-picker-input" value="${state.selectedDate}">
    </div>
    <button class="btn-submit" onclick="pickDate()">Go to Date</button>
  `);
}

function pickDate() {
  const val = document.getElementById('date-picker-input').value;
  if (val) {
    state.selectedDate = val;
    closeModal();
    renderDailyView();
  }
}

async function deleteTransaction(id) {
  if (!confirm('Delete this entry?')) return;
  await db.transactions.delete(id);
  showToast('Entry deleted');
  renderDailyView();
}

// ----------------------------------------------------------------
// 7. ADD TRANSACTION MODAL (Income or Expense)
// ----------------------------------------------------------------

async function openAddTransactionModal(type) {
  await loadCategories();          // always fresh — cheap single-key DB read
  const isIncome = type === 'INCOME';
  const catOptions = categoryOptions(isIncome ? 'INCOME' : 'DAILY_EXPENSE');

  const paymentMethods = ['Cash', 'Card', 'Venmo', 'Zelle', 'Other'];
  const pmOptions = paymentMethods.map(m => `<option value="${m}">${m}</option>`).join('');

  openModal(`
    <h2 class="modal-title">${isIncome ? '+ Add Income' : '+ Add Expense'}</h2>

    <div class="form-group">
      <label class="form-label">Date</label>
      <input type="date" class="form-input" id="txn-date" value="${state.selectedDate}">
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

  const date     = document.getElementById('txn-date').value;
  const category = document.getElementById('txn-category').value;
  const amount   = parseFloat(document.getElementById('txn-amount').value) || 0;
  const payment  = document.getElementById('txn-payment').value;
  const notes    = document.getElementById('txn-notes').value.trim();

  if (!category) { alert('Please select a category.'); return; }
  if (amount <= 0) { alert('Please enter an amount greater than zero.'); return; }

  const record = {
    date,
    type,
    category,
    paymentMethod: payment,
    notes,
  };

  if (isIncome) {
    const tip       = parseFloat(document.getElementById('txn-tip').value) || 0;
    const tipMethod = document.getElementById('txn-tip-method').value;
    record.serviceAmount = amount;
    record.tipAmount     = tip;
    record.tipMethod     = tipMethod;
    record.amount        = amount; // keep amount for easy reporting
  } else {
    record.serviceAmount = 0;
    record.tipAmount     = 0;
    record.amount        = amount;
  }

  await db.transactions.add(record);

  // If date changed from selected date, update state
  if (date !== state.selectedDate) state.selectedDate = date;

  closeModal();
  showToast(isIncome ? 'Income saved ✓' : 'Expense saved ✓');
  renderDailyView();
}

// ----------------------------------------------------------------
// 8. DAY SUMMARY MODAL (clients seen, hours worked)
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
// 9. MONTHLY EXPENSES VIEW
// ----------------------------------------------------------------

async function renderMonthlyView() {
  const content = document.getElementById('app-content');
  document.getElementById('header-actions').innerHTML = '';

  const allExpenses = await db.monthlyExpenses.toArray();
  const expenses = allExpenses.filter(
    e => e.year === state.selectedYear && e.month === state.selectedMonth
  );

  const total = expenses.reduce((s, e) => s + (e.amount || 0), 0);

  const monthOptions = Array.from({length:12}, (_,i) =>
    `<option value="${i+1}" ${i+1 === state.selectedMonth ? 'selected' : ''}>${monthName(i+1)}</option>`
  ).join('');

  const yearNow = new Date().getFullYear();
  const yearOptions = [yearNow-1, yearNow, yearNow+1].map(y =>
    `<option value="${y}" ${y === state.selectedYear ? 'selected' : ''}>${y}</option>`
  ).join('');

  content.innerHTML = `
    <!-- Month/Year Selector -->
    <div class="monthly-header">
      <button class="date-nav-btn" onclick="changeMonth(-1)">‹</button>
      <div>
        <select class="report-select" style="margin-bottom:4px" onchange="state.selectedMonth=parseInt(this.value);renderMonthlyView()">${monthOptions}</select>
        <select class="report-select" onchange="state.selectedYear=parseInt(this.value);renderMonthlyView()">${yearOptions}</select>
      </div>
      <button class="date-nav-btn" onclick="changeMonth(1)">›</button>
    </div>

    <!-- Total Card -->
    <div class="monthly-total-card">
      <div class="monthly-total-label">Total Fixed Expenses — ${monthName(state.selectedMonth)} ${state.selectedYear}</div>
      <div class="monthly-total-value">${fmt(total)}</div>
    </div>

    <!-- Expense List -->
    <div style="padding: 0 16px 8px;">
      <div class="section-label">Expenses</div>
      ${expenses.length === 0 ? `
        <div class="empty-state">
          <div class="empty-icon">🏠</div>
          <div class="empty-text">No monthly expenses logged yet.<br>Tap below to add one.</div>
        </div>
      ` : expenses.map(e => `
        <div class="monthly-expense-item">
          <div style="flex:1">
            <div class="mexp-category">${e.category}</div>
            ${e.notes ? `<div class="mexp-notes">${e.notes}</div>` : ''}
          </div>
          <div class="mexp-amount">${fmt(e.amount)}</div>
          <button class="mexp-delete" onclick="deleteMonthlyExpense(${e.id})">✕</button>
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
  await loadCategories();          // always fresh — cheap single-key DB read
  const catOptions = categoryOptions('MONTHLY_EXPENSE');

  openModal(`
    <h2 class="modal-title">+ Add Monthly Expense</h2>

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
  const month    = parseInt(document.getElementById('me-month').value);
  const year     = parseInt(document.getElementById('me-year').value);
  const category = document.getElementById('me-category').value;
  const amount   = parseFloat(document.getElementById('me-amount').value) || 0;
  const notes    = document.getElementById('me-notes').value.trim();

  if (!category) { alert('Please select a category.'); return; }
  if (amount <= 0) { alert('Please enter an amount greater than zero.'); return; }

  await db.monthlyExpenses.add({ month, year, category, amount, notes });
  state.selectedMonth = month;
  state.selectedYear  = year;

  closeModal();
  showToast('Monthly expense saved ✓');
  renderMonthlyView();
}

async function deleteMonthlyExpense(id) {
  if (!confirm('Delete this expense?')) return;
  await db.monthlyExpenses.delete(id);
  showToast('Expense deleted');
  renderMonthlyView();
}

// ----------------------------------------------------------------
// 10. REPORTS VIEW
// ----------------------------------------------------------------

async function renderReportsView() {
  const content = document.getElementById('app-content');
  document.getElementById('header-actions').innerHTML = '';

  const reportTypes = [
    { id: 'daily',    label: 'Daily' },
    { id: 'weekly',   label: 'Weekly' },
    { id: 'monthly',  label: 'Monthly' },
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

  const yearNow = new Date().getFullYear();

  content.innerHTML = `
    <!-- Report Type Tabs -->
    <div class="report-type-tabs">${tabs}</div>

    <!-- Controls & Body render dynamically -->
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

    // ---- DAILY REPORT ----
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

    // ---- WEEKLY REPORT ----
    case 'weekly': {
      el.innerHTML = `
        <div class="report-controls">
          <input type="date" class="report-input" id="r-week-date" value="${state.selectedDate}"
            placeholder="Pick any day in the week">
          <button class="report-btn" onclick="runWeeklyReport()">View</button>
        </div>
        <div class="report-body" id="report-output"></div>
      `;
      await runWeeklyReport();
      break;
    }

    // ---- MONTHLY REPORT ----
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

    // ---- ANNUAL REPORT ----
    case 'annual': {
      el.innerHTML = `
        <div class="report-controls">
          <input type="number" class="report-input" id="r-annual-year" value="${yearNow}" min="2020" max="2099" inputmode="numeric">
          <button class="report-btn" onclick="runAnnualReport()">View</button>
        </div>
        <div class="report-body" id="report-output"></div>
      `;
      await runAnnualReport();
      break;
    }

    // ---- YEAR OVER YEAR ----
    case 'yoy': {
      el.innerHTML = `
        <div class="report-controls">
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

    // ---- BY CATEGORY ----
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

    // ---- EXPORT CSV ----
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
  const txns  = await db.transactions.where('date').equals(date).toArray();
  const sum   = await db.dailySummary.where('date').equals(date).first();

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
async function runWeeklyReport() {
  const pickedDate = document.getElementById('r-week-date')?.value || state.selectedDate;
  const weekStart  = getWeekStart(pickedDate);

  let weeklyIncome = 0, weeklyTips = 0, weeklyExp = 0, weeklyClients = 0;
  const rows = [];

  for (let i = 0; i < 7; i++) {
    const d     = addDays(weekStart, i);
    const txns  = await db.transactions.where('date').equals(d).toArray();
    const sum   = await db.dailySummary.where('date').equals(d).first();
    const inc   = txns.filter(t=>t.type==='INCOME').reduce((s,t)=>s+(t.serviceAmount||0),0);
    const tips  = txns.filter(t=>t.type==='INCOME').reduce((s,t)=>s+(t.tipAmount||0),0);
    const exp   = txns.filter(t=>t.type==='EXPENSE').reduce((s,t)=>s+(t.amount||0),0);
    const cls   = sum ? sum.clientsSeen : 0;
    weeklyIncome  += inc;
    weeklyTips    += tips;
    weeklyExp     += exp;
    weeklyClients += cls;
    if (txns.length > 0 || sum) {
      rows.push({ d, inc, tips, exp, cls, net: inc+tips-exp });
    }
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

  // Booth rent collected this month
  const allRentPmts = await db.rentPayments.toArray();
  const monthRent   = allRentPmts.filter(p => p.datePaid && p.datePaid.startsWith(monthStr));
  const rentTotal   = monthRent.reduce((s,p)=>s+(p.amount||0),0);
  const renters     = await db.renters.where('status').equals('active').toArray();
  const expectedRent = renters.reduce((s,r)=>s+(r.weeklyRate||0),0) * 4; // approx

  const net       = svcTotal + tipTotal + rentTotal - totalExp;

  const monthSums = sums.filter(s => s.date && s.date.startsWith(monthStr));
  const totalClients = monthSums.reduce((s,d)=>s+(d.clientsSeen||0),0);
  const totalHours   = monthSums.reduce((s,d)=>s+(d.hoursWorked||0),0);

  document.getElementById('report-output').innerHTML = `
    <div class="report-section-title">${monthName(month)} ${year}</div>
    <div class="report-stat-grid">
      <div class="report-stat"><div class="report-stat-label">Services</div><div class="report-stat-value green">${fmt(svcTotal)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Tips</div><div class="report-stat-value gold">${fmt(tipTotal)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Booth Rent</div><div class="report-stat-value green">${fmt(rentTotal)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Daily Exp</div><div class="report-stat-value red">${fmt(dExpTotal)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Monthly Exp</div><div class="report-stat-value red">${fmt(mExpTotal)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Net Profit</div><div class="report-stat-value plum">${fmt(net)}</div></div>
      <div class="report-stat"><div class="report-stat-label">Clients</div><div class="report-stat-value">${totalClients}</div></div>
      <div class="report-stat"><div class="report-stat-label">Hours</div><div class="report-stat-value">${totalHours}</div></div>
    </div>
    ${rentTotal > 0 ? `
    <div class="report-white-card">
      <div class="report-section-title">Booth Rent Collected</div>
      <div class="report-row"><div class="report-row-label">Collected</div><div class="report-row-value income">+${fmt(rentTotal)}</div></div>
      <div class="report-row"><div class="report-row-label">Renters</div><div class="report-row-value">${monthRent.length} payments</div></div>
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
}

// ---- Annual Report ----
async function runAnnualReport() {
  const year = parseInt(document.getElementById('r-annual-year')?.value) || state.selectedYear;

  const allTxns = await db.transactions.toArray();
  const allMExp = await db.monthlyExpenses.where('year').equals(year).toArray();
  const allSums = await db.dailySummary.toArray();
  const allRentPmts = await db.rentPayments.toArray();

  let yearIncome=0, yearTips=0, yearExp=0, yearClients=0, yearRent=0;
  const rows = [];

  for (let m = 1; m <= 12; m++) {
    const ms    = `${year}-${String(m).padStart(2,'0')}`;
    const txns  = allTxns.filter(t => t.date?.startsWith(ms));
    const mExps = allMExp.filter(e => e.month === m);
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

// ---- Year Over Year ----
async function runYOYReport() {
  const y1 = parseInt(document.getElementById('r-yoy-year1')?.value);
  const y2 = parseInt(document.getElementById('r-yoy-year2')?.value);
  if (!y1 || !y2) return;

  async function yearTotals(year) {
    const txns = await db.transactions.toArray();
    const yTxns = txns.filter(t => t.date?.startsWith(String(year)));
    const mExps = await db.monthlyExpenses.where('year').equals(year).toArray();
    const inc  = yTxns.filter(t=>t.type==='INCOME').reduce((s,t)=>s+(t.serviceAmount||0),0);
    const tips = yTxns.filter(t=>t.type==='INCOME').reduce((s,t)=>s+(t.tipAmount||0),0);
    const dExp = yTxns.filter(t=>t.type==='EXPENSE').reduce((s,t)=>s+(t.amount||0),0);
    const mExp = mExps.reduce((s,e)=>s+(e.amount||0),0);
    const sums = await db.dailySummary.toArray();
    const cls  = sums.filter(s=>s.date?.startsWith(String(year))).reduce((s,d)=>s+(d.clientsSeen||0),0);
    return { inc, tips, exp: dExp+mExp, net: inc+tips-dExp-mExp, cls };
  }

  const [a, b] = await Promise.all([yearTotals(y1), yearTotals(y2)]);

  const diff = (v1, v2) => {
    if (v1 === 0) return '';
    const pct = ((v2-v1)/Math.abs(v1)*100).toFixed(1);
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

  const allTxns = await db.transactions.toArray();
  const txns = allTxns.filter(t => t.date >= from && t.date <= to);

  // Group by category
  const incMap = {}, expMap = {};
  txns.filter(t=>t.type==='INCOME').forEach(t => {
    incMap[t.category] = (incMap[t.category]||0) + (t.serviceAmount||0) + (t.tipAmount||0);
  });
  txns.filter(t=>t.type==='EXPENSE').forEach(t => {
    expMap[t.category] = (expMap[t.category]||0) + (t.amount||0);
  });

  const sortDesc = obj => Object.entries(obj).sort((a,b)=>b[1]-a[1]);

  document.getElementById('report-output').innerHTML = `
    <div style="font-size:13px; color:var(--text-muted); padding: 4px 0 12px;">${from} — ${to}</div>
    ${Object.keys(incMap).length > 0 ? `
    <div class="report-white-card">
      <div class="report-section-title">Income by Category</div>
      ${sortDesc(incMap).map(([k,v])=>`
        <div class="report-row">
          <div class="report-row-label">${k}</div>
          <div class="report-row-value income">+${fmt(v)}</div>
        </div>
      `).join('')}
    </div>` : ''}
    ${Object.keys(expMap).length > 0 ? `
    <div class="report-white-card">
      <div class="report-section-title">Expenses by Category</div>
      ${sortDesc(expMap).map(([k,v])=>`
        <div class="report-row">
          <div class="report-row-label">${k}</div>
          <div class="report-row-value expense">-${fmt(v)}</div>
        </div>
      `).join('')}
    </div>` : ''}
    ${Object.keys(incMap).length === 0 && Object.keys(expMap).length === 0
      ? '<p style="color:var(--text-muted);text-align:center;padding:30px 0;">No data for this date range.</p>'
      : ''}
  `;
}

// ----------------------------------------------------------------
// 11. CSV EXPORT
// ----------------------------------------------------------------

async function exportCSV() {
  const from = document.getElementById('r-exp-from')?.value;
  const to   = document.getElementById('r-exp-to')?.value;
  if (!from || !to) { alert('Please select a date range.'); return; }

  const allTxns = await db.transactions.toArray();
  const txns    = allTxns.filter(t => t.date >= from && t.date <= to);
  const mExps   = await db.monthlyExpenses.toArray();

  // Build CSV content
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

  // Add monthly expenses in range
  csv += '\n\nMonthly Expenses:\nYear,Month,Category,Amount,Notes\n';
  mExps.filter(e => {
    const d = `${e.year}-${String(e.month).padStart(2,'0')}-01`;
    return d >= from && d <= to;
  }).forEach(e => {
    csv += `${e.year},${monthName(e.month)},${e.category},${e.amount},"${e.notes||''}"\n`;
  });

  // Add rent payments in range
  const renters  = await db.renters.toArray();
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

  // Create and trigger download
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
// 12. SETTINGS VIEW
// ----------------------------------------------------------------

async function renderSettingsView() {
  const content = document.getElementById('app-content');
  document.getElementById('header-actions').innerHTML = '';

  const bizName = await db.settings.get('businessName');
  const pinSet  = await db.settings.get('pin');
  const pinOn   = await db.settings.get('pinEnabled');

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
      <div class="settings-label">Daily Expense Categories</div>
      <div class="card" style="margin-bottom: 8px;">
        <div id="daily-exp-cats"></div>
        <div class="add-category-row">
          <input type="text" class="add-category-input" id="new-dexp-cat" placeholder="Add category…">
          <button class="btn-add-chip" onclick="addCategory('DAILY_EXPENSE')">+ Add</button>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-label">Monthly Expense Categories</div>
      <div class="card" style="margin-bottom: 8px;">
        <div id="monthly-exp-cats"></div>
        <div class="add-category-row">
          <input type="text" class="add-category-input" id="new-mexp-cat" placeholder="Add category…">
          <button class="btn-add-chip" onclick="addCategory('MONTHLY_EXPENSE')">+ Add</button>
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
      <div class="settings-item" onclick="togglePINLock()">
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

    <!-- Backup & Restore -->
    <div class="settings-section">
      <div class="settings-label">Backup & Restore</div>
      <div class="card" style="margin-bottom:8px;">
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px;line-height:1.5;">
          Back up all your data to a file. Save it to Google Drive, email it to yourself, or store it anywhere safe. Use it to restore on this phone or a new one.
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px;">
          Last backup: <strong style="color:var(--plum);" id="last-backup-display">Loading…</strong>
        </div>
        <button class="btn-primary" style="width:100%;margin-bottom:8px;" onclick="exportBackup()">
          ⬇ Back Up Now
        </button>
        <button class="btn-secondary" style="width:100%;" onclick="triggerRestoreFilePicker()">
          ⬆ Restore from Backup
        </button>
        <div style="font-size:11px;color:var(--danger);margin-top:8px;text-align:center;">
          Restore replaces all current data with the backup file.
        </div>
      </div>
    </div>

    <div style="height: 24px;"></div>
  `;

  // Hidden file input for restore — lives outside modal so it persists
  if (!document.getElementById('restore-file-input')) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.id = 'restore-file-input';
    inp.accept = '.json';
    inp.style.display = 'none';
    inp.addEventListener('change', e => importBackup(e.target.files[0]));
    document.body.appendChild(inp);
  }

  loadCategoryChips();

  // Load last backup date
  const lastBackup = await db.settings.get('lastBackup');
  const el = document.getElementById('last-backup-display');
  if (el) {
    el.textContent = lastBackup?.value
      ? formatDateDisplay(lastBackup.value)
      : 'Never — back up now!';
    if (!lastBackup?.value) el.style.color = 'var(--danger)';
  }
}

async function saveBusinessName() {
  const val = document.getElementById('biz-name').value.trim();
  if (!val) return;
  await db.settings.put({ key: 'businessName', value: val });
  showToast('Business name saved ✓');
}

// Render the category chips in Settings from state.categories (synchronous)
function loadCategoryChips() {
  const map = {
    'income-cats':      'INCOME',
    'daily-exp-cats':   'DAILY_EXPENSE',
    'monthly-exp-cats': 'MONTHLY_EXPENSE',
  };
  for (const [containerId, type] of Object.entries(map)) {
    const el = document.getElementById(containerId);
    if (!el) continue;
    el.innerHTML = (state.categories[type] || []).map(name =>
      `<span class="category-chip">${name}
        <button class="chip-delete" onclick="deleteCategory('${type}','${name.replace(/'/g,"\\'")}')">×</button>
      </span>`
    ).join('');
  }
}

async function addCategory(type) {
  const inputId = { INCOME: 'new-income-cat', DAILY_EXPENSE: 'new-dexp-cat', MONTHLY_EXPENSE: 'new-mexp-cat' }[type];
  const input   = document.getElementById(inputId);
  const name    = input?.value.trim();
  if (!name) return;
  if (state.categories[type].includes(name)) { showToast('Already exists'); return; }
  state.categories[type].push(name);
  await saveCategories();
  input.value = '';
  showToast(`"${name}" added ✓`);
  loadCategoryChips();
}

async function deleteCategory(type, name) {
  if (!confirm(`Remove "${name}"?`)) return;
  state.categories[type] = state.categories[type].filter(n => n !== name);
  await saveCategories();
  loadCategoryChips();
}

// ----------------------------------------------------------------
// 13. PIN SYSTEM
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

// PIN entry logic (used on app load)
let pinBuffer = '';

function initPINPad() {
  document.querySelectorAll('.pin-btn[data-num]').forEach(btn => {
    btn.addEventListener('click', () => enterPin(btn.dataset.num));
  });
  document.getElementById('pin-back')?.addEventListener('click', clearPin);
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
    document.getElementById('pin-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
  } else {
    document.getElementById('pin-error').classList.remove('hidden');
    pinBuffer = '';
    updatePinDots();
  }
}

// ----------------------------------------------------------------
// 13. RENTERS VIEW
// ----------------------------------------------------------------

// Returns Saturday of the week (due date) given the Monday weekStart
function getWeekDue(weekStart) {
  const d = new Date(weekStart + 'T12:00:00');
  d.setDate(d.getDate() + 5); // Mon + 5 = Sat
  return d.toISOString().split('T')[0];
}

// Returns the Monday of next week
function nextWeekStart(weekStart) {
  const d = new Date(weekStart + 'T12:00:00');
  d.setDate(d.getDate() + 7);
  return d.toISOString().split('T')[0];
}

// Returns the Monday of previous week
function prevWeekStart(weekStart) {
  const d = new Date(weekStart + 'T12:00:00');
  d.setDate(d.getDate() - 7);
  return d.toISOString().split('T')[0];
}

// Determine payment status for a rent record
// Due = Saturday; grace = 3 days → late if paid after Tuesday (day 9 of week)
function getRentStatus(weekStart, datePaid) {
  if (!datePaid) return 'unpaid';
  const due  = new Date(getWeekDue(weekStart) + 'T12:00:00');
  const paid = new Date(datePaid + 'T12:00:00');
  const diffDays = Math.floor((paid - due) / 86400000);
  return diffDays <= 3 ? 'ontime' : 'late';
}

// Format a week range for display: "Feb 10 – Feb 16"
function formatWeekRange(weekStart) {
  const start = new Date(weekStart + 'T12:00:00');
  const end   = new Date(weekStart + 'T12:00:00');
  end.setDate(end.getDate() + 6);
  const opts = { month: 'short', day: 'numeric' };
  return start.toLocaleDateString('en-US', opts) + ' – ' + end.toLocaleDateString('en-US', opts);
}

async function renderRentersView() {
  const content = document.getElementById('app-content');
  document.getElementById('header-actions').innerHTML = `
    <button class="header-icon-btn" onclick="openAddRenterModal()" title="Add Renter">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>`;

  // Default week = current week
  if (!state.rentersWeekStart) {
    state.rentersWeekStart = getWeekStart(todayStr());
  }

  const ws      = state.rentersWeekStart;
  const weekDue = getWeekDue(ws);
  const renters = await db.renters.where('status').equals('active').toArray();
  const payments = await db.rentPayments.where('weekStart').equals(ws).toArray();

  // Build payment map: renterId -> payment record
  const payMap = {};
  payments.forEach(p => { payMap[p.renterId] = p; });

  const expectedTotal = renters.reduce((s, r) => s + (r.weeklyRate || 0), 0);
  const collectedTotal = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const outstanding = expectedTotal - collectedTotal;

  const isCurrentWeek = ws === getWeekStart(todayStr());

  content.innerHTML = `
    <!-- Week navigation -->
    <div class="daily-date-bar">
      <button class="date-nav-btn" onclick="rentersChangeWeek(-1)">‹</button>
      <div class="current-date">Week of ${formatWeekRange(ws)}</div>
      <button class="date-nav-btn" onclick="rentersChangeWeek(1)" ${isCurrentWeek ? 'disabled style="opacity:0.3"' : ''}>›</button>
    </div>

    <!-- Summary banner -->
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

    <!-- Due date note -->
    <div class="renters-due-note">Rent due Saturday ${formatDateDisplay(weekDue)}</div>

    <!-- Renter rows -->
    <div id="renter-list">
      ${renters.length === 0 ? `
        <div class="empty-state" style="padding:40px 20px;">
          <div style="font-size:36px;margin-bottom:12px;">👥</div>
          <div style="font-weight:600;color:var(--plum);margin-bottom:6px;">No booth renters yet</div>
          <div style="color:var(--text-muted);font-size:14px;">Tap + to add your first renter</div>
        </div>` :
        renters.map(r => {
          const p = payMap[r.id];
          const status = p ? getRentStatus(ws, p.datePaid) : 'unpaid';
          const statusLabel = { ontime: 'On Time', late: 'Late', unpaid: 'Unpaid' }[status];
          const statusClass = { ontime: 'status-ontime', late: 'status-late', unpaid: 'status-unpaid' }[status];
          const icon = { ontime: '✅', late: '⚠️', unpaid: '○' }[status];
          return `
          <div class="renter-row" onclick="openRenterDetail(${r.id})">
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
              ${!p ? `<button class="renter-pay-btn" onclick="event.stopPropagation();openLogPaymentModal(${r.id})">Log Payment</button>` : ''}
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

// Log a rent payment for a renter this week
function openLogPaymentModal(renterId) {
  db.renters.get(renterId).then(r => {
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

      <button class="btn-primary" style="width:100%;margin-top:8px;" onclick="saveRentPayment(${renterId})">Save Payment</button>
    `);
  });
}

async function saveRentPayment(renterId) {
  const amount = parseFloat(document.getElementById('rp-amount').value);
  const datePaid = document.getElementById('rp-date').value;
  const method = document.getElementById('rp-method').value;
  const notes = document.getElementById('rp-notes').value.trim();

  if (!amount || !datePaid) { showToast('Please fill in amount and date'); return; }

  // Check if payment already exists for this week — update it if so
  const existing = await db.rentPayments
    .where('renterId').equals(renterId)
    .filter(p => p.weekStart === state.rentersWeekStart)
    .first();

  if (existing) {
    await db.rentPayments.update(existing.id, { amount, datePaid, paymentMethod: method, notes });
  } else {
    await db.rentPayments.add({
      renterId,
      weekStart:     state.rentersWeekStart,
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

// View renter's payment history + edit profile
function openRenterDetail(renterId) {
  db.renters.get(renterId).then(async r => {
    const payments = await db.rentPayments
      .where('renterId').equals(renterId)
      .reverse()
      .limit(20)
      .toArray();

    const historyHTML = payments.length === 0
      ? '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:16px 0;">No payment history yet.</p>'
      : payments.map(p => {
          const status = getRentStatus(p.weekStart, p.datePaid);
          const statusClass = { ontime: 'status-ontime', late: 'status-late' }[status];
          const icon = status === 'ontime' ? '✅' : '⚠️';
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
        <button class="btn-secondary" style="flex:1;" onclick="openLogPaymentModal(${r.id});closeModal()">+ Log Payment</button>
        <button class="btn-secondary" style="flex:1;" onclick="openEditRenterModal(${r.id})">Edit Profile</button>
        <button class="btn-danger-sm" onclick="deactivateRenter(${r.id})">Deactivate</button>
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

  closeModal();
  showToast(`${name} added ✓`);
  renderRentersView();
}

function openEditRenterModal(renterId) {
  db.renters.get(renterId).then(r => {
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

      <button class="btn-primary" style="width:100%;margin-top:8px;" onclick="saveEditRenter(${r.id})">Save Changes</button>
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
  if (!confirm(`Deactivate ${r.name}? They will be hidden from the weekly view but their payment history is preserved.`)) return;
  await db.renters.update(renterId, { status: 'inactive' });
  closeModal();
  showToast(`${r.name} deactivated`);
  renderRentersView();
}

// ----------------------------------------------------------------
// 14. BACKUP & RESTORE
// ----------------------------------------------------------------

async function exportBackup() {
  try {
    const backup = {
      exportDate:      todayStr(),
      appVersion:      '4.0',
      businessName:    (await db.settings.get('businessName'))?.value || '',
      // Categories are already in memory as a clean map — save them directly
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
    showToast('Backup saved ✓');
    renderSettingsView();
  } catch (err) {
    showToast('Backup failed — try again');
    console.error(err);
  }
}

async function importBackup(file) {
  if (!file) return;

  const confirmed = confirm(
    '⚠️ Restore from backup?\n\nThis will REPLACE all current data with the backup file. This cannot be undone.\n\nAre you sure?'
  );
  if (!confirmed) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!data.transactions) { showToast('Invalid backup file'); return; }

    // Handle both old-format (categories = array of {id,name,type} rows)
    // and new-format (categories = {INCOME:[...], DAILY_EXPENSE:[...], MONTHLY_EXPENSE:[...]})
    let catMap;
    if (Array.isArray(data.categories)) {
      // Old format — convert to new map
      catMap = { INCOME: [], DAILY_EXPENSE: [], MONTHLY_EXPENSE: [] };
      data.categories.forEach(c => {
        if (c.type && catMap[c.type]) catMap[c.type].push(c.name);
      });
    } else if (data.categories && typeof data.categories === 'object') {
      catMap = data.categories;
    } else {
      catMap = _defaultCategoryMap();
    }

    // Restore transactional data
    await db.transaction('rw',
      db.transactions, db.dailySummary, db.monthlyExpenses,
      db.renters, db.rentPayments, db.settings,
      async () => {
        await db.transactions.clear();
        await db.dailySummary.clear();
        await db.monthlyExpenses.clear();
        await db.settings.clear();
        if (data.renters)      await db.renters.clear();
        if (data.rentPayments) await db.rentPayments.clear();

        const strip = arr => arr.map(({ id, ...rest }) => rest);
        await db.transactions.bulkAdd(strip(data.transactions));
        if (data.dailySummary?.length)    await db.dailySummary.bulkAdd(strip(data.dailySummary));
        if (data.monthlyExpenses?.length) await db.monthlyExpenses.bulkAdd(strip(data.monthlyExpenses));
        if (data.renters?.length)         await db.renters.bulkAdd(strip(data.renters));
        if (data.rentPayments?.length)    await db.rentPayments.bulkAdd(strip(data.rentPayments));

        // Restore settings rows (they use key, not id)
        if (data.settings?.length) await db.settings.bulkAdd(data.settings);
      }
    );

    // Save the categories map and reload into state
    state.categories = catMap;
    await saveCategories();
    await db.settings.put({ key: 'lastBackup', value: todayStr() });

    showToast('Restore complete ✓');
    navigate('daily');

  } catch (err) {
    showToast('Restore failed — file may be corrupt');
    console.error(err);
  }
}

// Trigger the hidden file input for restore
function triggerRestoreFilePicker() {
  const input = document.getElementById('restore-file-input');
  if (input) input.click();
}

// ----------------------------------------------------------------
// 15. MODAL SYSTEM
// ----------------------------------------------------------------

function openModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal').classList.remove('hidden');
  // Focus first input automatically
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

// ----------------------------------------------------------------
// 15. APP INITIALIZATION
// ----------------------------------------------------------------

async function initApp() {
  // Load categories into memory first — all views depend on this
  await loadCategories();

  const pinSetting    = await db.settings.get('pin');
  const pinEnabled    = await db.settings.get('pinEnabled');
  const shouldPinLock = pinSetting && pinEnabled?.value === 'true';

  if (shouldPinLock) {
    // Show PIN screen
    document.getElementById('pin-screen').classList.remove('hidden');
    initPINPad();
  } else {
    // Go straight to app
    document.getElementById('app').classList.remove('hidden');
    navigate('daily');
  }
}

// Register the service worker for offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(reg => {
        // When a new SW takes over, reload the page to get fresh files
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'activated') {
                // New SW is in control — reload to apply updates
                window.location.reload();
              }
            });
          }
        });
      })
      .catch(err => console.log('SW registration skipped:', err));

    // If a SW just took over this session, reload once to get fresh files
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    });
  });
}

// Boot the app when the page loads
window.addEventListener('DOMContentLoaded', () => {
  initApp();
});
