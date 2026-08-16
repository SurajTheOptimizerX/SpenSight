// ============================================================
// SpenSight Dashboard — SPA controller
// State management, full CRUD, interactive charts, time-range
// filtering, carry-over budgets, CSV imports and the streaming
// Cleo AI assistant.
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  const token = getToken();
  if (!token) {
    window.location.href = 'login.html';
    return;
  }

  const user = getStoredUser();
  const $ = (id) => document.getElementById(id);

  // ---------- Global state ----------
  const state = {
    range: 'monthly',
    monthYear: new Date().toISOString().substring(0, 7),
    carryOver: false,
    selectedAccountId: null,
    selectedToAccountId: null,
    selectedCategoryId: null,
    currentTxType: 'expense',
    calcExpression: '0',
    editTxId: null,
    editAccountId: null,
    editCategoryId: null,
    editTxType: 'expense',
    categoryPickerFor: 'add',
    accounts: [],
    categories: [],
    budgets: [],
    transactions: [],
    charts: {},
    csvMode: 'replace',
    confirmAction: null,
  };

  const CURRENCY = '₹';
  const PALETTE = [
    '#3b82f6',
    '#8b5cf6',
    '#ef4444',
    '#10b981',
    '#f59e0b',
    '#ec4899',
    '#06b6d4',
    '#22c55e',
    '#f97316',
    '#84cc16',
    '#a855f7',
    '#e11d48',
    '#64748b',
    '#14b8a6',
    '#d946ef',
  ];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Ignore auto-generated / dummy categories (e.g. "EdgeCat161514") everywhere.
  const EDGE_CATEGORY_RE = /^EdgeCat/i;
  const isEdgeCategory = (name) => EDGE_CATEGORY_RE.test(String(name || ''));

  // ---------- Icon hydration ----------
  function hydrateIcons(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('[data-icon]').forEach((el) => {
      const name = el.getAttribute('data-icon');
      el.innerHTML = SpenIcons.icon(name);
    });
  }

  // ---------- Toasts ----------
  function showToast(message, type = 'success') {
    const container = $('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `${SpenIcons.icon(type === 'success' ? 'CircleCheck' : type === 'error' ? 'AlertTriangle' : 'Bell')}<span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('hide');
      setTimeout(() => toast.remove(), 320);
    }, 3200);
  }

  function escapeHtml(str) {
    return String(str === undefined || str === null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function money(n) {
    const value = parseFloat(n || 0);
    return `${CURRENCY}${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function dateOnly(iso) {
    return iso ? String(iso).substring(0, 10) : '';
  }

  // ---------- Safe expression evaluator (no eval) ----------
  function safeEval(expr) {
    if (!/^[\d+\-*/. ]+$/.test(expr)) return NaN;
    const tokens = expr.match(/\d+\.?\d*|[+\-*/]/g);
    if (!tokens) return NaN;
    const nums = [];
    const ops = [];
    let expectNum = true;
    const precedence = (op) => (op === '*' || op === '/' ? 2 : 1);
    const applyOp = (b, a, op) => {
      if (op === '+') return a + b;
      if (op === '-') return a - b;
      if (op === '*') return a * b;
      if (op === '/') return b === 0 ? NaN : a / b;
      return NaN;
    };
    const popOp = () => {
      const b = nums.pop();
      const a = nums.pop();
      const op = ops.pop();
      nums.push(applyOp(b, a, op));
    };
    for (const t of tokens) {
      if (/^\d/.test(t)) {
        nums.push(parseFloat(t));
        expectNum = false;
      } else if (['+', '-', '*', '/'].includes(t)) {
        if (expectNum) {
          if (t === '-') {
            nums.push(0);
            continue;
          }
          return NaN;
        }
        while (ops.length && precedence(ops[ops.length - 1]) >= precedence(t)) popOp();
        ops.push(t);
        expectNum = true;
      } else {
        return NaN;
      }
    }
    if (expectNum) return NaN;
    while (ops.length) popOp();
    const result = nums[nums.length - 1];
    return typeof result === 'number' && isFinite(result) ? result : NaN;
  }

  // ---------- Auth & navigation ----------
  const displayName = user.name || 'User';
  $('userNameDisplay').textContent = displayName;
  $('brandBadge').innerHTML = SpenIcons.icon('Wallet');
  const mobileUserName = $('mobileUserName');
  if (mobileUserName) mobileUserName.textContent = displayName;
  const drawerWorkspaceName = $('drawerWorkspaceName');
  if (drawerWorkspaceName) drawerWorkspaceName.textContent = `${displayName}'s Workspace`;

  function handleLogout() {
    localStorage.removeItem('spensight_token');
    localStorage.removeItem('spensight_user');
    window.location.href = 'login.html';
  }
  ['logoutBtn', 'logoutBtnDrawer'].forEach((id) => {
    const btn = $(id);
    if (btn) btn.addEventListener('click', handleLogout);
  });

  const monthPicker = $('monthPicker');
  if (monthPicker) monthPicker.value = state.monthYear;

  const navItems = document.querySelectorAll('.nav-item');
  const viewSections = document.querySelectorAll('.view-section');
  const pageTitle = $('pageTitle');

  function getActiveViewId() {
    const activeNav = document.querySelector('.nav-item.active');
    return activeNav ? activeNav.getAttribute('data-target') : 'dashboardView';
  }

  function setActiveView(viewId) {
    navItems.forEach((nav) => nav.classList.toggle('active', nav.getAttribute('data-target') === viewId));
    viewSections.forEach((view) => view.classList.toggle('active-view', view.id === viewId));
    const labels = {
      dashboardView: 'Financial Dashboard',
      recordsView: 'Transaction Records',
      budgetsView: 'Budgets',
      accountsView: 'Accounts',
      categoriesView: 'Categories',
      aiView: 'Cleo AI Copilot',
    };
    if (pageTitle) pageTitle.textContent = labels[viewId] || 'Dashboard';
    // Hide the global FAB in the Cleo view so it never overlaps the chat
    // input deck; reclaim its bottom spacing for the chat on mobile.
    const isAiView = viewId === 'aiView';
    const fab = document.getElementById('floatingAddBtn');
    if (fab) fab.style.display = isAiView ? 'none' : 'flex';
    document.body.classList.toggle('ai-active', isAiView);
    closeSidebar();
    refreshActiveViewData(viewId);
  }

  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      const target = item.getAttribute('data-target');
      if (target) setActiveView(target);
    });
  });

  // Mobile sidebar / drawer
  const sidebar = $('sidebar');
  const backdrop = $('sidebarBackdrop');
  const hamburger = $('hamburgerBtn');
  const mobileHamburger = $('mobileHamburgerBtn');
  const sidebarClose = $('sidebarCloseBtn');
  function openSidebar() {
    if (sidebar) sidebar.classList.add('open');
    if (backdrop) backdrop.classList.add('active');
  }
  function closeSidebar() {
    if (sidebar) sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('active');
  }
  if (mobileHamburger) mobileHamburger.addEventListener('click', openSidebar);
  if (hamburger) hamburger.addEventListener('click', openSidebar);
  if (sidebarClose) sidebarClose.addEventListener('click', closeSidebar);
  if (backdrop) backdrop.addEventListener('click', closeSidebar);

  function refreshActiveViewData(viewId = getActiveViewId()) {
    // Contextual time-filter: only show range chips / month picker / options on
    // views where date-range toggling is relevant (Dashboard, Records, Budgets).
    const filterBar = $('filterHeaderBar');
    if (filterBar) {
      filterBar.style.display =
        viewId === 'dashboardView' || viewId === 'recordsView' || viewId === 'budgetsView' ? 'flex' : 'none';
    }
    loadHeaderTotals();
    if (viewId === 'dashboardView') loadDashboardData();
    if (viewId === 'recordsView') loadAllTransactions();
    if (viewId === 'budgetsView') loadBudgetsData();
    if (viewId === 'accountsView') loadAccountsData();
    if (viewId === 'categoriesView') loadCategoriesData();
  }

  // ---------- Query builder ----------
  function analyticsQuery() {
    const q = `range=${encodeURIComponent(state.range)}`;
    if (state.range === 'yearly') {
      return `${q}&year=${state.monthYear.substring(0, 4)}`;
    }
    return `${q}&month_year=${encodeURIComponent(state.monthYear)}`;
  }

  // view_mode + month_year filter for accounts / transactions / budgets endpoints
  function filterQuery() {
    const q = `view_mode=${encodeURIComponent(state.range)}&month_year=${encodeURIComponent(state.monthYear)}`;
    if (state.range === 'yearly') {
      return `${q}&year=${state.monthYear.substring(0, 4)}`;
    }
    return q;
  }

  // ---------- 1. Header totals (real-time sync) ----------
  async function loadHeaderTotals() {
    try {
      const [res, accountsRes] = await Promise.all([
        apiRequest(`/analytics/summary?${analyticsQuery()}`, 'GET', null, true),
        apiRequest(`/accounts?${filterQuery()}`, 'GET', null, true),
      ]);
      if (accountsRes && accountsRes.summary) {
        $('topAllAccountsBalance').textContent = money(accountsRes.summary.all_accounts_balance);
        $('topExpenseSoFar').textContent = money(res ? res.expense_so_far : accountsRes.summary.expense_so_far);
        $('topIncomeSoFar').textContent = money(res ? res.income_so_far : accountsRes.summary.income_so_far);
      }
    } catch (e) {
      console.error('Header Totals Error:', e);
    }
  }

  // ---------- 2. Dashboard ----------
  async function loadDashboardData() {
    try {
      const [healthRes, insightsRes, breakdown, trends, cashflow] = await Promise.all([
        apiRequest(`/health/score?month_year=${state.monthYear}`, 'GET', null, true),
        apiRequest(`/ai/insights?month_year=${state.monthYear}`, 'GET', null, true),
        apiRequest(`/analytics/breakdown?${analyticsQuery()}`, 'GET', null, true),
        apiRequest(`/analytics/trends?${analyticsQuery()}&months=6`, 'GET', null, true),
        apiRequest(`/analytics/cashflow?${analyticsQuery()}`, 'GET', null, true),
      ]);

      // Health
      if (healthRes && healthRes.health_summary) {
        const summary = healthRes.health_summary;
        const noData = summary.health_score === null || summary.health_score === undefined || healthRes.label === 'No Data';

        if (noData) {
          // No financial data yet: neutral "N/A" instead of a fabricated
          // score (e.g. "45/100 WARNING" for an empty account).
          $('healthScoreDisplay').textContent = 'N/A';
          $('savingsRateDisplay').textContent = '0%';
          const badge = $('healthScoreBadge');
          badge.innerHTML = '<span data-icon="Upload"></span> Upload CSV to calculate';
          badge.className = 'score-badge score-neutral';
          hydrateIcons(badge);
        } else {
          $('healthScoreDisplay').textContent = `${summary.health_score} / 100`;
          $('savingsRateDisplay').textContent = `${summary.savings_rate || 0}%`;
          const badge = $('healthScoreBadge');
          badge.textContent = summary.overall_status || 'Healthy';
          badge.className = `score-badge score-${(summary.overall_status || 'healthy').toLowerCase()}`;
          hydrateIcons(badge);
        }
      }

      // Insights / alerts
      renderAlerts(insightsRes, $('aiAlertsContainer'), $('activeInsightsDisplay'));

      // Cash flow widgets
      if (cashflow) {
        $('cashflowRatioDisplay').textContent =
          cashflow.cashflow_ratio >= 999 ? 'No Income' : cashflow.cashflow_ratio.toFixed(2);
        $('netSoFarDisplay').textContent = money(cashflow.net_so_far);
      }

      // Charts
      renderCategoryChart(breakdown);
      renderTrendChart(trends);
      renderCashflowChart(cashflow);

      // Recent transactions
      const txnRes = await apiRequest(`/transactions?${filterQuery()}&limit=50`, 'GET', null, true);
      state.transactions = txnRes && txnRes.transactions ? txnRes.transactions : [];
      renderTransactionTable($('transactionTableBody'), state.transactions.slice(0, 10));
    } catch (error) {
      console.error('Dashboard Data Error:', error);
    }
  }

  function renderAlerts(insightsRes, container, countDisplay) {
    if (!container) return;
    container.innerHTML = '';
    const insights = insightsRes && insightsRes.insights ? insightsRes.insights : [];
    if (countDisplay) countDisplay.textContent = `${insights.length} Alert${insights.length === 1 ? '' : 's'}`;

    if (insights.length === 0) {
      container.innerHTML = `<div class="empty-state"><span data-icon="ShieldCheck"></span><p style="font-size: 13px;">No alerts triggered for this period.</p></div>`;
    } else {
      insights.slice(0, 6).forEach((alert) => {
        const severity = alert.severity || 'low';
        const div = document.createElement('div');
        div.className = `alert-card alert-${severity}`;
        div.innerHTML = `
          <strong><span data-icon="${severity === 'high' ? 'AlertTriangle' : severity === 'medium' ? 'Bell' : 'Check'}"></span> ${escapeHtml(alert.title)}</strong>
          <p style="color: #94a3b8; margin-top: 6px; line-height: 1.5;">${escapeHtml(alert.message)}</p>`;
        container.appendChild(div);
      });
    }
    hydrateIcons(container);
  }

  // ---------- Charts ----------
  function renderCategoryChart(breakdown) {
    const canvas = $('categoryChart');
    const legend = $('categoryLegend');
    if (!canvas) return;
    if (state.charts.category) state.charts.category.destroy();

    const cats = breakdown && breakdown.categories ? breakdown.categories.filter((c) => c.type === 'expense') : [];
    const labels = cats.length ? cats.map((c) => c.category) : ['No Data'];
    const values = cats.length ? cats.map((c) => c.amount) : [1];
    const colors = cats.length
      ? cats.map((c) => c.color_code || PALETTE[cats.indexOf(c) % PALETTE.length])
      : ['#3b82f6'];

    state.charts.category = new Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data: values, backgroundColor: colors, borderColor: '#0f172a', borderWidth: 3 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(17,24,39,0.95)',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
            titleColor: '#f8fafc',
            bodyColor: '#94a3b8',
            callbacks: {
              label: (ctx) => ` ${ctx.label}: ${money(ctx.parsed)}`,
              afterLabel: (ctx) => {
                const total = values.reduce((s, v) => s + v, 0);
                const pct = total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) : 0;
                return ` ${pct}% of spend`;
              },
            },
          },
        },
      },
    });

    // Legend with percentages
    if (legend) {
      legend.innerHTML = '';
      const total = values.reduce((s, v) => s + v, 0);
      cats.forEach((c, i) => {
        const pct = total > 0 ? ((c.amount / total) * 100).toFixed(1) : 0;
        const item = document.createElement('div');
        item.className = 'chart-legend-item';
        item.innerHTML = `
          <span style="display: flex; align-items: center; gap: 8px;">
            <span class="chart-legend-dot" style="background: ${escapeHtml(colors[i])};"></span>
            <span data-icon="${escapeHtml(c.icon_name || 'Tag')}"></span> ${escapeHtml(c.category)}
          </span>
          <span style="font-weight: 700;">${money(c.amount)} <span style="color: var(--text-muted); font-weight: 600;">(${pct}%)</span></span>`;
        legend.appendChild(item);
      });
      hydrateIcons(legend);
    }
  }

  function renderTrendChart(trends) {
    const canvas = $('trendChart');
    if (!canvas) return;
    if (state.charts.trend) state.charts.trend.destroy();

    const data = trends && trends.trend ? trends.trend : [];
    const labels = data.map((d) => {
      if (state.range === 'monthly') {
        const [y, m] = d.bucket.split('-');
        return `${MONTHS[parseInt(m, 10) - 1]} '${y.substring(2)}`;
      }
      if (state.range === 'yearly') return d.bucket;
      return d.bucket;
    });

    state.charts.trend = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Expense',
            data: data.map((d) => d.expense),
            borderColor: '#ef4444',
            backgroundColor: 'rgba(239,68,68,0.12)',
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            pointHoverRadius: 5,
            borderWidth: 2,
          },
          {
            label: 'Income',
            data: data.map((d) => d.income),
            borderColor: '#10b981',
            backgroundColor: 'rgba(16,185,129,0.08)',
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            pointHoverRadius: 5,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#94a3b8', usePointStyle: true, boxWidth: 8 } },
          tooltip: {
            backgroundColor: 'rgba(17,24,39,0.95)',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
            callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${money(ctx.parsed.y)}` },
          },
        },
        scales: {
          x: { ticks: { color: '#64748b', maxTicksLimit: 8 }, grid: { color: 'rgba(255,255,255,0.04)' } },
          y: {
            ticks: { color: '#64748b', callback: (v) => `${CURRENCY}${v}` },
            grid: { color: 'rgba(255,255,255,0.04)' },
          },
        },
      },
    });
  }

  function renderCashflowChart(cashflow) {
    const canvas = $('cashflowChart');
    if (!canvas) return;
    if (state.charts.cashflow) state.charts.cashflow.destroy();

    const income = cashflow ? cashflow.income_so_far : 0;
    const expense = cashflow ? cashflow.expense_so_far : 0;

    state.charts.cashflow = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: ['Income', 'Expense'],
        datasets: [
          {
            data: [income, expense],
            backgroundColor: ['rgba(16,185,129,0.75)', 'rgba(239,68,68,0.75)'],
            hoverBackgroundColor: ['#10b981', '#ef4444'],
            borderRadius: 10,
            barThickness: 44,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(17,24,39,0.95)',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
            callbacks: { label: (ctx) => ` ${ctx.label}: ${money(ctx.parsed.y)}` },
          },
        },
        scales: {
          x: { ticks: { color: '#94a3b8' }, grid: { display: false } },
          y: {
            ticks: { color: '#64748b', callback: (v) => `${CURRENCY}${v}` },
            grid: { color: 'rgba(255,255,255,0.04)' },
          },
        },
      },
    });
  }

  // ---------- 3. Records ----------
  async function loadAllTransactions() {
    const tbody = $('allTransactionsTable');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">Loading ledger...</td></tr>`;

    try {
      const txnRes = await apiRequest(`/transactions?${filterQuery()}`, 'GET', null, true);
      const txs = txnRes && txnRes.transactions ? txnRes.transactions : [];
      state.transactions = txs;
      renderTransactionTable(tbody, txs);
    } catch (error) {
      tbody.innerHTML =
        '<tr><td colspan="7" style="text-align: center; color: var(--accent-red);">Error loading ledger transactions.</td></tr>';
    }
  }

  function renderTransactionTable(tbody, txs) {
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!txs || txs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><span data-icon="Receipt"></span><p style="font-size: 13px;">No transactions yet. Tap the + button to add your first entry.</p></div></td></tr>`;
      hydrateIcons(tbody);
      return;
    }

    txs.forEach((txn) => {
      const isIncome = txn.type === 'income';
      const isTransfer = txn.type === 'transfer';
      const amountClass = isIncome ? 'txn-amount-positive' : isTransfer ? 'txn-amount-transfer' : 'txn-amount-negative';
      const amountPrefix = isIncome ? '+' : isTransfer ? '↔' : '−';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="white-space: nowrap;">${dateOnly(txn.transaction_date)}</td>
        <td style="max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(txn.description)}</td>
        <td><span style="display: inline-flex; align-items: center; gap: 6px; background: rgba(59,130,246,0.12); color: #3b82f6; padding: 4px 10px; border-radius: 20px; font-size: 12px;"><span data-icon="${escapeHtml(txn.category_icon || 'Tag')}"></span> ${escapeHtml(txn.category_name || 'General')}</span></td>
        <td style="color: var(--text-muted); font-size: 13px;">${escapeHtml(txn.account_name || 'Cash')}${isTransfer && txn.to_account_name ? ` → ${escapeHtml(txn.to_account_name)}` : ''}</td>
        <td class="${amountClass}">${amountPrefix}${money(txn.amount)}</td>
        <td>
          <div class="txn-actions">
            <button class="btn btn-ghost btn-sm edit-txn-btn" data-id="${escapeHtml(txn.id)}" style="width: auto; padding: 6px 10px;"><span data-icon="Pencil"></span></button>
            <button class="btn btn-danger btn-sm delete-txn-btn" data-id="${escapeHtml(txn.id)}" style="width: auto; padding: 6px 10px;"><span data-icon="Trash2"></span></button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    hydrateIcons(tbody);

    tbody.querySelectorAll('.delete-txn-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        openConfirm('Delete this transaction? This will also restore your account balance.', async () => {
          try {
            await apiRequest(`/transactions/${id}`, 'DELETE', null, true);
            showToast('Transaction deleted.');
            refreshActiveViewData();
          } catch (err) {
            showToast(err.message || 'Failed to delete.', 'error');
          }
        });
      });
    });

    tbody.querySelectorAll('.edit-txn-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.getAttribute('data-id'), 10);
        const txn = (state.transactions || []).find((t) => t.id === id);
        if (txn) openEditTxnModal(txn);
      });
    });
  }

  // ---------- Confirm modal ----------
  function openConfirm(message, action) {
    const modal = $('confirmModal');
    $('confirmMessage').textContent = message;
    state.confirmAction = action;
    modal.classList.add('active');
  }

  $('confirmCancelBtn').addEventListener('click', () => $('confirmModal').classList.remove('active'));
  $('closeConfirmModalBtn').addEventListener('click', () => $('confirmModal').classList.remove('active'));
  $('confirmOkBtn').addEventListener('click', async () => {
    const action = state.confirmAction;
    $('confirmModal').classList.remove('active');
    state.confirmAction = null;
    if (action) await action();
  });

  // ---------- Edit Transaction modal ----------
  const editTxnModal = $('editTxnModal');

  function toDateInputValue(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso ? String(iso).substring(0, 10) : '';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  function resetEditTxn() {
    state.editTxId = null;
    state.editAccountId = null;
    state.editCategoryId = null;
    state.editTxType = 'expense';
    if ($('editAmountInput')) $('editAmountInput').value = '';
    if ($('editDateInput')) $('editDateInput').value = toDateInputValue(new Date().toISOString());
    if ($('editNotesInput')) $('editNotesInput').value = '';
    if ($('editAccountLabel')) $('editAccountLabel').textContent = 'Select Account';
    if ($('editCategoryLabel')) $('editCategoryLabel').textContent = 'Select Category';
    document.querySelectorAll('#editTxnModal .type-tab').forEach((t) => {
      t.classList.toggle('active', t.getAttribute('data-edittype') === 'expense');
    });
    if ($('editPickerCategoryBtn')) $('editPickerCategoryBtn').style.display = 'flex';
  }

  function openEditTxnModal(txn) {
    if (!editTxnModal) return;
    state.editTxId = txn.id;
    state.editAccountId = txn.account_id || null;
    state.editCategoryId = txn.category_id || null;
    state.editTxType = txn.type || 'expense';

    if ($('editAmountInput')) $('editAmountInput').value = txn.amount;
    if ($('editDateInput')) $('editDateInput').value = toDateInputValue(txn.transaction_date);
    if ($('editNotesInput')) $('editNotesInput').value = txn.description || '';
    if ($('editAccountLabel')) $('editAccountLabel').textContent = txn.account_name || 'Select Account';
    if ($('editCategoryLabel')) {
      $('editCategoryLabel').textContent =
        state.editCategoryId && txn.category_name ? txn.category_name : 'Select Category';
    }

    document.querySelectorAll('#editTxnModal .type-tab').forEach((t) => {
      t.classList.toggle('active', t.getAttribute('data-edittype') === state.editTxType);
    });
    const isTransfer = state.editTxType === 'transfer';
    if ($('editPickerCategoryBtn')) $('editPickerCategoryBtn').style.display = isTransfer ? 'none' : 'flex';
    if ($('editPickerAccountBtn')) $('editPickerAccountBtn').style.flex = '1';

    editTxnModal.classList.add('active');
  }

  const closeEditTxnBtn = $('closeEditTxnBtn');
  if (closeEditTxnBtn)
    closeEditTxnBtn.addEventListener('click', () => {
      if (editTxnModal) editTxnModal.classList.remove('active');
      resetEditTxn();
    });

  document.querySelectorAll('#editTxnModal .type-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#editTxnModal .type-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.editTxType = tab.getAttribute('data-edittype');
      const isTransfer = state.editTxType === 'transfer';
      if (isTransfer) {
        state.editCategoryId = null;
        if ($('editCategoryLabel')) $('editCategoryLabel').textContent = 'Select Category';
      }
      if ($('editPickerCategoryBtn')) $('editPickerCategoryBtn').style.display = isTransfer ? 'none' : 'flex';
    });
  });

  const saveEditTxnBtn = $('saveEditTxnBtn');
  if (saveEditTxnBtn) {
    saveEditTxnBtn.addEventListener('click', async () => {
      try {
        const amount = parseFloat($('editAmountInput').value);
        if (isNaN(amount) || amount <= 0) {
          showToast('Please enter a valid amount greater than 0.', 'error');
          return;
        }
        const date = $('editDateInput').value;
        const payload = {
          amount,
          type: state.editTxType,
          account_id: state.editAccountId,
          category_id: state.editTxType === 'transfer' ? null : state.editCategoryId,
          description: $('editNotesInput') ? $('editNotesInput').value.trim() : '',
          notes: $('editNotesInput') ? $('editNotesInput').value.trim() : '',
          date: date ? new Date(date).toISOString() : undefined,
        };

        saveEditTxnBtn.disabled = true;
        await apiRequest(`/transactions/${state.editTxId}`, 'PUT', payload, true);
        saveEditTxnBtn.disabled = false;

        showToast('Transaction updated.');
        editTxnModal.classList.remove('active');
        resetEditTxn();
        refreshActiveViewData();
      } catch (err) {
        saveEditTxnBtn.disabled = false;
        showToast(err.message || 'Failed to update transaction.', 'error');
      }
    });
  }

  // ---------- 4. Budgets ----------
  async function loadBudgetsData() {
    const budgetedContainer = $('budgetedCategoriesList');
    const unbudgetedContainer = $('unbudgetedCategoriesList');
    if (!budgetedContainer || !unbudgetedContainer) return;

    try {
      const res = await apiRequest(`/budgets?${filterQuery()}&carry_over=${state.carryOver}`, 'GET', null, true);
      budgetedContainer.innerHTML = '';
      unbudgetedContainer.innerHTML = '';
      state.budgets = res && res.budgets ? res.budgets : [];

      let totalBudget = 0;
      let totalSpent = 0;

      state.budgets.forEach((b) => {
        if (isEdgeCategory(b.category_name)) return;
        const limit = parseFloat(b.effective_limit || b.limit_amount || 0);
        const spent = parseFloat(b.total_spent || 0);
        const pct = Math.min(100, Math.round((spent / limit) * 100));

        if (limit > 0) {
          totalBudget += limit;
          totalSpent += spent;
          const isOver = spent > limit;
          const isWarn = !isOver && pct >= 80;
          const barClass = isOver ? 'over' : isWarn ? 'warning' : '';

          const div = document.createElement('div');
          div.className = 'budget-card budget-card-static';
          div.innerHTML = `
            <div class="budget-card-head">
              <div class="budget-card-title">
                <div class="category-circle-icon" style="background: ${escapeHtml(b.color_code || '#3b82f6')}22; color: ${escapeHtml(b.color_code || '#3b82f6')};">
                  <span data-icon="${escapeHtml(b.icon_name || 'Tag')}"></span>
                </div>
                <div class="budget-card-name">
                  <strong>${escapeHtml(b.category_name)}${b.carried_over > 0 ? ` <span style="color: var(--accent-green); font-size: 11px; font-weight: 600;">(+${money(b.carried_over)} carried)</span>` : ''}</strong>
                </div>
              </div>
            </div>
            <div class="budget-bar-bg">
              <div class="budget-bar-fill ${barClass}" style="width: ${pct}%;"></div>
            </div>
            <div class="budget-card-actions">
              <span class="budget-card-amount" style="color: ${isOver ? '#ef4444' : isWarn ? '#f59e0b' : '#10b981'};">${money(spent)} / ${money(limit)}</span>
              <span class="budget-static-badge"><span data-icon="Lock"></span> Budget set</span>
            </div>
            <div class="budget-inline-actions">
              <button class="btn btn-ghost btn-sm edit-budget-btn" data-id="${escapeHtml(b.budget_id)}" data-name="${escapeHtml(b.category_name)}" data-limit="${escapeHtml(limit)}"><span data-icon="Pencil"></span> Edit</button>
              <button class="btn btn-danger btn-sm remove-budget-btn" data-id="${escapeHtml(b.budget_id)}" data-name="${escapeHtml(b.category_name)}"><span data-icon="Trash2"></span> Remove</button>
            </div>
          `;
          budgetedContainer.appendChild(div);
        } else {
          const div = document.createElement('div');
          div.className = 'budget-card';
          div.innerHTML = `
            <div class="budget-card-head">
              <div class="budget-card-title">
                <div class="category-circle-icon" style="background: ${escapeHtml(b.color_code || '#3b82f6')}22; color: ${escapeHtml(b.color_code || '#3b82f6')};">
                  <span data-icon="${escapeHtml(b.icon_name || 'Tag')}"></span>
                </div>
                <div class="budget-card-name">
                  <strong>${escapeHtml(b.category_name)}</strong>
                </div>
              </div>
              <button class="btn btn-ghost btn-sm set-budget-btn" data-id="${escapeHtml(b.category_id)}" data-name="${escapeHtml(b.category_name)}"><span data-icon="Target"></span> SET BUDGET</button>
            </div>
          `;
          unbudgetedContainer.appendChild(div);
        }
      });

      hydrateIcons(budgetedContainer);
      hydrateIcons(unbudgetedContainer);

      $('totalBudgetDisplay').textContent = money(totalBudget);
      $('totalSpentDisplay').textContent = money(totalSpent);

      document.querySelectorAll('.set-budget-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const catId = btn.getAttribute('data-id');
          const catName = btn.getAttribute('data-name');

          // Strictly ADD-only: never open a prompt to modify an existing budget.
          const alreadySet = state.budgets.some(
            (b) => String(b.category_id) === catId && parseFloat(b.effective_limit || b.limit_amount || 0) > 0
          );
          if (alreadySet) {
            showToast(`A budget is already set for ${catName} this month.`, 'info');
            return;
          }

          const input = window.prompt(`Set monthly budget limit for ${catName} (${CURRENCY}):`);
          if (input === null) return;
          const limit = parseFloat(input);
          if (isNaN(limit) || limit <= 0) {
            showToast('Please enter a valid positive number.', 'error');
            return;
          }
          apiRequest(
            '/budgets',
            'POST',
            { category_id: parseInt(catId, 10), limit_amount: limit, month_year: state.monthYear },
            true
          )
            .then(() => {
              showToast(`Budget saved for ${catName}.`);
              loadBudgetsData();
            })
            .catch((err) => showToast(err.message || 'Failed to save budget.', 'error'));
        });
      });

      document.querySelectorAll('.edit-budget-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-id');
          const catName = btn.getAttribute('data-name');
          const currentLimit = btn.getAttribute('data-limit');
          if (!id) return;

          const input = window.prompt(`Update monthly budget limit for ${catName} (${CURRENCY}):`, currentLimit);
          if (input === null) return;
          const limit = parseFloat(input);
          if (isNaN(limit) || limit <= 0) {
            showToast('Please enter a valid positive number.', 'error');
            return;
          }
          apiRequest(`/budgets/${id}`, 'PUT', { limit_amount: limit }, true)
            .then(() => {
              showToast(`Budget updated for ${catName}.`);
              loadBudgetsData();
            })
            .catch((err) => showToast(err.message || 'Failed to update budget.', 'error'));
        });
      });

      document.querySelectorAll('.remove-budget-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-id');
          const catName = btn.getAttribute('data-name');
          if (!id) return;

          openConfirm(`Remove the budget for ${catName}? It will move back to "Not Budgeted This Month".`, async () => {
            try {
              await apiRequest(`/budgets/${id}`, 'DELETE', null, true);
              showToast(`Budget removed for ${catName}.`);
              loadBudgetsData();
            } catch (err) {
              showToast(err.message || 'Failed to remove budget.', 'error');
            }
          });
        });
      });
    } catch (e) {
      console.error('Load Budgets Error:', e);
    }
  }

  const copyPastBtn = $('copyPastBudgetsBtn');
  if (copyPastBtn) {
    copyPastBtn.addEventListener('click', async () => {
      try {
        const res = await apiRequest('/budgets/copy-past', 'POST', { target_month: state.monthYear }, true);
        showToast(res.message || 'Budgets copied!');
        loadBudgetsData();
      } catch (err) {
        showToast(err.message || 'No past budgets found.', 'info');
      }
    });
  }

  // Carry-over toggle
  const carryOverToggle = $('carryOverToggle');
  async function loadCarryOver() {
    try {
      const res = await apiRequest('/budgets/carry-over', 'GET', null, true);
      state.carryOver = !!res.carry_over;
      if (carryOverToggle) carryOverToggle.classList.toggle('on', state.carryOver);
    } catch (e) {
      console.error('Carry-over load error:', e);
    }
  }
  if (carryOverToggle) {
    carryOverToggle.addEventListener('click', async () => {
      state.carryOver = !state.carryOver;
      carryOverToggle.classList.toggle('on', state.carryOver);
      try {
        await apiRequest('/budgets/carry-over', 'PUT', { carry_over: state.carryOver }, true);
        showToast(state.carryOver ? 'Carry-over enabled — unused budget rolls forward.' : 'Carry-over disabled.');
        loadBudgetsData();
      } catch (err) {
        state.carryOver = !state.carryOver;
        carryOverToggle.classList.toggle('on', state.carryOver);
        showToast(err.message || 'Failed to update preference.', 'error');
      }
    });
  }

  // ---------- 5. Accounts ----------
  async function loadAccountsData() {
    const container = $('accountsListContainer');
    if (!container) return;

    try {
      const res = await apiRequest(`/accounts?${filterQuery()}`, 'GET', null, true);
      const accounts = res && res.accounts ? res.accounts : [];
      state.accounts = accounts;
      container.innerHTML = '';

      if (accounts.length === 0) {
        container.innerHTML =
          '<div class="empty-state"><span data-icon="Wallet"></span><p>No accounts yet. Add one below.</p></div>';
        hydrateIcons(container);
        return;
      }

      accounts.forEach((acc) => {
        const div = document.createElement('div');
        div.className = 'category-row-item';
        const balance = parseFloat(acc.balance || 0);
        div.innerHTML = `
          <div style="display: flex; align-items: center; gap: 14px;">
            <div class="category-circle-icon" style="background: ${escapeHtml(acc.color_code || '#3b82f6')}22; color: ${escapeHtml(acc.color_code || '#3b82f6')};">
              <span data-icon="${escapeHtml(acc.icon_name || 'Wallet')}"></span>
            </div>
            <div>
              <strong style="font-size: 15px;">${escapeHtml(acc.name)}</strong>
              <p style="font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 4px;"><span data-icon="${acc.type === 'Card' ? 'CreditCard' : acc.type === 'Savings' ? 'PiggyBank' : 'Wallet'}"></span> ${escapeHtml(acc.type)}</p>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 12px;">
            <div style="font-size: 18px; font-weight: 800; color: ${balance < 0 ? '#ef4444' : '#10b981'};">${money(balance)}</div>
            <button class="btn btn-danger btn-sm delete-account-btn" data-id="${escapeHtml(acc.id)}" data-name="${escapeHtml(acc.name)}"><span data-icon="Trash2"></span></button>
          </div>
        `;
        container.appendChild(div);
      });

      hydrateIcons(container);

      container.querySelectorAll('.delete-account-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-id');
          const name = btn.getAttribute('data-name');
          openConfirm(
            `Delete account "${name}"? Its transaction history will be kept (they move to no account).`,
            async () => {
              try {
                await apiRequest(`/accounts/${id}`, 'DELETE', null, true);
                showToast(`Account "${name}" deleted.`);
                loadAccountsData();
              } catch (err) {
                showToast(err.message || 'Failed to delete account.', 'error');
              }
            }
          );
        });
      });
    } catch (err) {
      console.error('Load Accounts Error:', err);
    }
  }

  // Add account modal
  const addAccountBtn = $('addAccountBtn');
  const addAccountModal = $('addAccountModal');
  if (addAccountBtn && addAccountModal) {
    addAccountBtn.addEventListener('click', () => addAccountModal.classList.add('active'));
    $('closeAddAccountModalBtn').addEventListener('click', () => addAccountModal.classList.remove('active'));
    $('saveAccountBtn').addEventListener('click', async () => {
      const name = $('newAccountName').value.trim();
      const type = $('newAccountType').value;
      const balance = parseFloat($('newAccountBalance').value || '0');
      const color = $('newAccountColor').value;

      if (!name) {
        showToast('Account name is required.', 'error');
        return;
      }

      try {
        await apiRequest(
          '/accounts',
          'POST',
          {
            name,
            type,
            balance,
            color_code: color,
            icon_name: type === 'Card' ? 'CreditCard' : type === 'Savings' ? 'PiggyBank' : 'Wallet',
          },
          true
        );
        showToast(`Account "${name}" created.`);
        addAccountModal.classList.remove('active');
        $('newAccountName').value = '';
        $('newAccountBalance').value = '';
        loadAccountsData();
        loadHeaderTotals();
      } catch (err) {
        showToast(err.message || 'Failed to create account.', 'error');
      }
    });
  }

  // ---------- 6. Categories ----------
  async function loadCategoriesData() {
    const incContainer = $('incomeCategoryList');
    const expContainer = $('expenseCategoryList');
    if (!incContainer || !expContainer) return;

    try {
      const categories = await apiRequest('/categories', 'GET', null, true);
      state.categories = (Array.isArray(categories) ? categories : []).filter((c) => !isEdgeCategory(c.name));
      incContainer.innerHTML = '';
      expContainer.innerHTML = '';

      state.categories.forEach((cat) => {
        if (isEdgeCategory(cat.name)) return;
        const div = document.createElement('div');
        div.className = 'category-row-item';
        div.innerHTML = `
          <div style="display: flex; align-items: center; gap: 12px;">
            <div class="category-circle-icon" style="background: ${escapeHtml(cat.color_code || '#3b82f6')}22; color: ${escapeHtml(cat.color_code || '#3b82f6')};">
              <span data-icon="${escapeHtml(cat.icon_name || 'Tag')}"></span>
            </div>
            <span style="font-size: 14px; font-weight: 600;">${escapeHtml(cat.name)}</span>
          </div>
          ${cat.name !== 'Uncategorized' ? `<button class="btn btn-danger btn-sm delete-cat-btn" data-id="${escapeHtml(cat.id)}" data-name="${escapeHtml(cat.name)}"><span data-icon="Trash2"></span></button>` : ''}
        `;
        if (cat.type === 'income') incContainer.appendChild(div);
        else expContainer.appendChild(div);
      });

      hydrateIcons(incContainer);
      hydrateIcons(expContainer);

      document.querySelectorAll('.delete-cat-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-id');
          const name = btn.getAttribute('data-name');
          openConfirm(`Delete category "${name}"? Existing transactions will fall back to Uncategorized.`, async () => {
            try {
              await apiRequest(`/categories/${id}`, 'DELETE', null, true);
              showToast(`Category "${name}" deleted.`);
              loadCategoriesData();
            } catch (err) {
              showToast(err.message || 'Failed to delete category.', 'error');
            }
          });
        });
      });
    } catch (e) {
      console.error('Load Categories Error:', e);
    }
  }

  // Add category modal
  const addCategoryModal = $('addCategoryModal');
  document.querySelectorAll('.add-category-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('newCategoryType').value = btn.getAttribute('data-type') || 'expense';
      addCategoryModal.classList.add('active');
    });
  });
  $('closeAddCategoryModalBtn').addEventListener('click', () => addCategoryModal.classList.remove('active'));
  $('saveCategoryBtn').addEventListener('click', async () => {
    const name = $('newCategoryName').value.trim();
    const type = $('newCategoryType').value;
    const color = $('newCategoryColor').value;
    if (!name) {
      showToast('Category name is required.', 'error');
      return;
    }
    try {
      await apiRequest('/categories', 'POST', { name, type, color_code: color }, true);
      showToast(`Category "${name}" created.`);
      addCategoryModal.classList.remove('active');
      $('newCategoryName').value = '';
      loadCategoriesData();
      loadDashboardData();
    } catch (err) {
      showToast(err.message || 'Failed to create category.', 'error');
    }
  });

  // ---------- 7. Quick-add picker modals ----------
  const pickerAccountBtn = $('pickerAccountBtn');
  const pickerCategoryBtn = $('pickerCategoryBtn');
  const pickerToAccountBtn = $('pickerToAccountBtn');
  const accountModal = $('accountModal');
  const categoryModal = $('categoryModal');
  let pickerMode = 'source';

  function openAccountPicker(mode) {
    pickerMode = mode;
    const container = $('accountPickerContainer');
    container.innerHTML = '<p style="color: #94a3b8; font-size: 13px;">Loading accounts...</p>';
    accountModal.classList.add('active');

    const accounts = state.accounts;
    container.innerHTML = '';

    if (accounts.length === 0) {
      container.innerHTML = '<p style="color: #94a3b8; font-size: 13px;">No accounts found. Create one first.</p>';
      return;
    }

    accounts.forEach((acc) => {
      const div = document.createElement('div');
      div.className = 'category-row-item';
      div.style.cursor = 'pointer';
      div.innerHTML = `
        <div style="display: flex; align-items: center; gap: 10px;">
          <div class="category-circle-icon" style="background: ${escapeHtml(acc.color_code || '#3b82f6')}22; color: ${escapeHtml(acc.color_code || '#3b82f6')};"><span data-icon="${escapeHtml(acc.icon_name || 'Wallet')}"></span></div>
          <strong style="font-size: 14px;">${escapeHtml(acc.name)}</strong>
        </div>
        <span style="color: #10b981; font-weight: 700;">${money(acc.balance)}</span>
      `;
      div.addEventListener('click', () => {
        if (pickerMode === 'source') {
          state.selectedAccountId = acc.id;
          const label = $('selectedAccountLabel');
          if (label) label.textContent = acc.name;
        } else if (pickerMode === 'edit-source') {
          state.editAccountId = acc.id;
          const label = $('editAccountLabel');
          if (label) label.textContent = acc.name;
        } else {
          state.selectedToAccountId = acc.id;
          const label = $('selectedToAccountLabel');
          if (label) label.textContent = acc.name;
        }
        accountModal.classList.remove('active');
      });
      container.appendChild(div);
    });
    hydrateIcons(container);
  }

  if (pickerAccountBtn && accountModal) {
    pickerAccountBtn.addEventListener('click', () => openAccountPicker('source'));
    $('closeAccountModalBtn').addEventListener('click', () => accountModal.classList.remove('active'));
  }

  const editPickerAccountBtn = $('editPickerAccountBtn');
  if (editPickerAccountBtn && accountModal) {
    editPickerAccountBtn.addEventListener('click', () => openAccountPicker('edit-source'));
  }

  if (pickerToAccountBtn) {
    pickerToAccountBtn.addEventListener('click', () => openAccountPicker('destination'));
  }

  async function openCategoryPicker(forMode) {
    const container = $('categoryPickerContainer');
    if (!container || !categoryModal) return;
    state.categoryPickerFor = forMode === 'edit' ? 'edit' : 'add';
    container.innerHTML = '<p style="color: #94a3b8; font-size: 13px;">Loading categories...</p>';
    categoryModal.classList.add('active');

    try {
      const categories = state.categories.length
        ? state.categories
        : (await apiRequest('/categories', 'GET', null, true)).filter((c) => !isEdgeCategory(c.name));

      container.innerHTML = '';
      const txType = state.categoryPickerFor === 'edit' ? state.editTxType : state.currentTxType;
      const filtered =
        txType === 'income'
          ? categories.filter((c) => c.type === 'income')
          : categories.filter((c) => c.type === 'expense');

      if (filtered.length === 0) {
        container.innerHTML =
          '<p style="color: #94a3b8; font-size: 13px; grid-column: 1 / -1;">No matching categories. Add one from the Categories view.</p>';
        return;
      }

      filtered.forEach((cat) => {
        const div = document.createElement('div');
        div.className = 'category-icon-card';
        div.innerHTML = `
          <div class="category-circle-icon" style="background: ${escapeHtml(cat.color_code || '#3b82f6')}22; color: ${escapeHtml(cat.color_code || '#3b82f6')};">
            <span data-icon="${escapeHtml(cat.icon_name || 'Tag')}"></span>
          </div>
          <span style="font-size: 12px; font-weight: 600;">${escapeHtml(cat.name)}</span>
        `;
        div.addEventListener('click', () => {
          if (state.categoryPickerFor === 'edit') {
            state.editCategoryId = cat.id;
            const label = $('editCategoryLabel');
            if (label) label.textContent = cat.name;
          } else {
            state.selectedCategoryId = cat.id;
            const label = $('selectedCategoryLabel');
            if (label) label.textContent = cat.name;
          }
          categoryModal.classList.remove('active');
        });
        container.appendChild(div);
      });
      hydrateIcons(container);
    } catch (e) {
      container.innerHTML = '<p style="color: var(--accent-red); font-size: 13px;">Failed to load categories.</p>';
    }
  }

  if (pickerCategoryBtn && categoryModal) {
    pickerCategoryBtn.addEventListener('click', () => openCategoryPicker('add'));
    $('closeCategoryModalBtn').addEventListener('click', () => categoryModal.classList.remove('active'));
  }

  const editPickerCategoryBtn = $('editPickerCategoryBtn');
  if (editPickerCategoryBtn && categoryModal) {
    editPickerCategoryBtn.addEventListener('click', () => openCategoryPicker('edit'));
  }

  // ---------- 8. Calculator & Quick-add ----------
  const fab = $('floatingAddBtn');
  const modal = $('quickAddModal');
  const calcDisplay = $('calcDisplay');

  function resetQuickAdd() {
    state.calcExpression = '0';
    state.selectedAccountId = null;
    state.selectedToAccountId = null;
    state.selectedCategoryId = null;
    state.currentTxType = 'expense';
    if (calcDisplay) calcDisplay.textContent = '0';
    if ($('txNotesInput')) $('txNotesInput').value = '';
    if ($('txDateInput')) $('txDateInput').value = new Date().toISOString().substring(0, 10);
    if ($('selectedAccountLabel')) $('selectedAccountLabel').textContent = 'Select Account';
    if ($('selectedToAccountLabel')) $('selectedToAccountLabel').textContent = 'To Account';
    if ($('selectedCategoryLabel')) $('selectedCategoryLabel').textContent = 'Select Category';
    document.querySelectorAll('.type-tab').forEach((t) => {
      t.classList.toggle('active', t.getAttribute('data-type') === 'expense');
    });
    updateTransferUI();
  }

  function updateTransferUI() {
    const isTransfer = state.currentTxType === 'transfer';
    if (pickerToAccountBtn) pickerToAccountBtn.style.display = isTransfer ? 'flex' : 'none';
    if (pickerCategoryBtn) pickerCategoryBtn.style.display = isTransfer ? 'none' : 'flex';
    if (pickerAccountBtn) {
      if (isTransfer) pickerAccountBtn.style.width = '100%';
      pickerAccountBtn.style.flex = isTransfer ? '1' : '1';
    }
  }

  if (fab && modal) {
    fab.addEventListener('click', () => {
      resetQuickAdd();
      modal.classList.add('active');
    });

    $('closeModalBtn').addEventListener('click', () => modal.classList.remove('active'));
  }

  document.querySelectorAll('.type-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.type-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.currentTxType = tab.getAttribute('data-type');
      state.selectedCategoryId = null;
      if ($('selectedCategoryLabel')) $('selectedCategoryLabel').textContent = 'Select Category';
      updateTransferUI();
    });
  });

  document.querySelectorAll('.calc-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-key');

      if (key === '=') {
        const result = safeEval(state.calcExpression);
        state.calcExpression = isNaN(result) ? 'Error' : String(result);
      } else {
        if (state.calcExpression === '0' || state.calcExpression === 'Error') {
          state.calcExpression = key;
        } else {
          state.calcExpression += key;
        }
      }
      if (calcDisplay) calcDisplay.textContent = state.calcExpression;
    });
  });

  const saveBtn = $('saveTransactionBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      try {
        const finalAmount = safeEval(state.calcExpression);
        if (isNaN(finalAmount) || finalAmount <= 0) {
          showToast('Please enter a valid amount greater than 0.', 'error');
          return;
        }

        const notes = $('txNotesInput') ? $('txNotesInput').value.trim() : '';
        const date = $('txDateInput') ? $('txDateInput').value : new Date().toISOString();

        const payload = {
          amount: finalAmount,
          type: state.currentTxType,
          category_id: state.selectedCategoryId,
          account_id: state.selectedAccountId,
          to_account_id: state.selectedToAccountId,
          notes,
          date: date ? new Date(date).toISOString() : new Date().toISOString(),
        };

        if (state.currentTxType === 'transfer' && !state.selectedToAccountId) {
          showToast('Select a destination account for the transfer.', 'error');
          return;
        }

        saveBtn.disabled = true;
        await apiRequest('/transactions', 'POST', payload, true);
        saveBtn.disabled = false;

        showToast('Transaction recorded successfully!');
        modal.classList.remove('active');
        resetQuickAdd();
        refreshActiveViewData();
      } catch (err) {
        saveBtn.disabled = false;
        showToast(err.message || 'Failed to record transaction.', 'error');
      }
    });
  }

  // ---------- 9. Cleo AI Chat (SSE streaming) ----------
  const aiChatForm = $('aiChatForm');
  const aiChatInput = $('aiChatInput');
  const aiChatBox = $('aiChatBox');
  let isStreaming = false;

  if (aiChatForm && aiChatInput && aiChatBox) {
    aiChatForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isStreaming) return;
      const promptText = aiChatInput.value.trim();
      if (!promptText) return;

      const userMsg = document.createElement('div');
      userMsg.className = 'chat-bubble-user';
      userMsg.textContent = promptText;
      aiChatBox.appendChild(userMsg);
      aiChatInput.value = '';
      aiChatBox.scrollTop = aiChatBox.scrollHeight;

      const assistantMsg = document.createElement('div');
      assistantMsg.className = 'chat-bubble-ai';
      const typing = document.createElement('div');
      typing.className = 'chat-typing';
      typing.innerHTML = '<span></span><span></span><span></span>';
      assistantMsg.appendChild(typing);
      aiChatBox.appendChild(assistantMsg);
      aiChatBox.scrollTop = aiChatBox.scrollHeight;

      isStreaming = true;
      let fullText = '';
      const controller = new AbortController();
      const chatTimeout = setTimeout(() => controller.abort(), 60000);

      const streamPrompt = async () => {
        const response = await fetch(`${window.SPENSIGHT_API_BASE || '/api'}/ai/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ prompt: promptText }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || 'AI response error');
        }
        if (!response.body) throw new Error('Streaming not supported.');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';

          for (const part of parts) {
            const lines = part.split('\n');
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const dataStr = line.replace('data: ', '').trim();
              if (dataStr === '[DONE]') continue;
              try {
                const parsed = JSON.parse(dataStr);
                if (parsed.error) throw new Error(parsed.error);
                if (parsed.token) {
                  typing.remove();
                  assistantMsg.textContent = fullText;
                  fullText += parsed.token;
                  assistantMsg.textContent = fullText;
                  aiChatBox.scrollTop = aiChatBox.scrollHeight;
                }
              } catch (e) {
                /* skip malformed keep-alives */
              }
            }
          }
        }
      };

      try {
        try {
          await streamPrompt();
        } catch (err) {
          if (!controller.signal.aborted) {
            // One retry for transient network / server failures
            await streamPrompt();
          } else {
            throw err;
          }
        }
      } catch (err) {
        typing.remove();
        if (controller.signal.aborted) {
          assistantMsg.textContent = 'Cleo took too long to respond. Please try again.';
        } else {
          assistantMsg.textContent = 'Sorry, I ran into an error processing your query. Please try again.';
        }
        console.error('AI chat error:', err);
      } finally {
        clearTimeout(chatTimeout);
        isStreaming = false;
        if (!fullText && !assistantMsg.textContent.includes('Sorry')) {
          assistantMsg.textContent = 'Cleo seems quiet today. Try another question.';
        }
        aiChatBox.scrollTop = aiChatBox.scrollHeight;
      }
    });
  }

  // ---------- 10. CSV Upload ----------
  const dropzone = $('dropzone');
  const csvFileInput = $('csvFileInput');
  const updateStatementBtn = $('updateStatementBtn');
  const clearCsvBtn = $('clearCsvBtn');
  const csvModeHint = $('csvModeHint');

  async function handleCsvFile(file) {
    if (!file) return;
    const statusParagraph = dropzone.querySelector('p');
    const originalText = statusParagraph ? statusParagraph.textContent : '';

    try {
      if (statusParagraph) statusParagraph.textContent = 'Uploading and auto-categorizing transactions...';
      const result = await apiUpload('/transactions/upload-csv', file, 'statement', { mode: state.csvMode });
      showToast(result.message || 'Bank statement uploaded! Processing in background.', 'info');
      setTimeout(() => refreshActiveViewData(), 500);
    } catch (error) {
      showToast(error.message || 'CSV upload failed.', 'error');
    } finally {
      if (statusParagraph) statusParagraph.textContent = originalText;
      if (csvFileInput) csvFileInput.value = '';
    }
  }

  async function doClearCsv() {
    try {
      const result = await apiRequest('/transactions/imported-csv', 'DELETE', null, true);
      showToast((result && result.message) || 'Imported CSV data successfully cleared.', 'success');
      refreshActiveViewData();
    } catch (error) {
      showToast(error.message || 'Failed to clear imported CSV data.', 'error');
    }
  }

  if (updateStatementBtn) {
    updateStatementBtn.addEventListener('click', () => {
      if (csvFileInput) csvFileInput.click();
    });
  }

  if (clearCsvBtn) {
    clearCsvBtn.addEventListener('click', () => {
      openConfirm(
        'Are you sure you want to delete all transactions imported from the CSV statement? Manual transactions will remain untouched.',
        doClearCsv
      );
    });
  }

  const csvModeButtons = document.querySelectorAll('.csv-mode-btn');
  csvModeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.csvMode = btn.getAttribute('data-csv-mode');
      csvModeButtons.forEach((b) => b.classList.toggle('active', b === btn));
      if (csvModeHint) {
        csvModeHint.textContent =
          state.csvMode === 'replace'
            ? 'Replace: previously imported CSV data will be removed before importing.'
            : 'Merge: duplicates (by date, description and amount) will be skipped.';
      }
    });
  });

  if (dropzone && csvFileInput) {
    dropzone.addEventListener('click', () => csvFileInput.click());
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) handleCsvFile(e.dataTransfer.files[0]);
    });
    csvFileInput.addEventListener('change', () => {
      if (csvFileInput.files.length > 0) handleCsvFile(csvFileInput.files[0]);
    });
  }

  // ---------- 11. Range filtering ----------
  const rangeChips = $('rangeChips');
  if (rangeChips) {
    rangeChips.querySelectorAll('.range-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        state.range = chip.getAttribute('data-range');
        rangeChips.querySelectorAll('.range-chip').forEach((c) => {
          const isActive = c === chip;
          c.classList.toggle('active', isActive);
          c.classList.toggle('active-filter', isActive);
        });
        refreshActiveViewData();
      });
    });
  }

  if (monthPicker) {
    monthPicker.addEventListener('change', () => {
      state.monthYear = monthPicker.value || state.monthYear;
      refreshActiveViewData();
    });
  }

  // Modal background click to close
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.remove('active');
    });
  });

  // ---------- Initial execution ----------
  (async function init() {
    hydrateIcons(document);
    await Promise.all([loadCarryOver(), loadAccountsData(), loadCategoriesData()]);
    setActiveView('dashboardView');
  })();
});
