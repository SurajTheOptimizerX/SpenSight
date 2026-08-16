// ============================================================
// SpenSight Insights Overview — page controller
// Fetches the month-parametric insights payload from
// /api/insights/overview and renders every section: spending
// personality, category heatmap, overrun prediction, financial
// health gauge, weekly pace, highlights and flagged expenses.
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  const token = getToken();
  if (!token) {
    window.location.href = 'login.html';
    return;
  }

  const user = getStoredUser();
  const $ = (id) => document.getElementById(id);

  const CURRENCY = '₹';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  let currentData = null;
  let flaggedExpanded = false;
  let gaugeChart = null;

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

  // ---------- Formatters ----------
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
    return `${CURRENCY}${value.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  }

  function money2(n) {
    const value = parseFloat(n || 0);
    return `${CURRENCY}${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function fmtDay(iso) {
    if (!iso) return '';
    const [, m, d] = String(iso).substring(0, 10).split('-');
    if (!m || !d) return iso;
    return `${parseInt(d, 10)} ${MONTHS[parseInt(m, 10) - 1]}`;
  }

  // ---------- Setup ----------
  const displayName = user.name || 'User';
  $('userNameDisplay').textContent = displayName;
  $('brandBadge').innerHTML = SpenIcons.icon('Wallet');
  const mobileUserName = $('mobileUserName');
  if (mobileUserName) mobileUserName.textContent = displayName;
  const drawerWorkspaceName = $('drawerWorkspaceName');
  if (drawerWorkspaceName) drawerWorkspaceName.textContent = `${displayName}'s Workspace`;
  hydrateIcons(document);

  const currentMonth = new Date().toISOString().substring(0, 7);
  const monthPicker = $('monthPicker');
  monthPicker.value = currentMonth;

  function handleLogout() {
    localStorage.removeItem('spensight_token');
    localStorage.removeItem('spensight_user');
    window.location.href = 'login.html';
  }
  ['logoutBtn', 'logoutBtnDrawer'].forEach((id) => {
    const btn = $(id);
    if (btn) btn.addEventListener('click', handleLogout);
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

  monthPicker.addEventListener('change', () => loadOverview(monthPicker.value));

  const downloadBtn = $('downloadReportBtn');
  if (downloadBtn) downloadBtn.addEventListener('click', downloadReport);

  const showMoreBtn = $('showMoreBtn');
  if (showMoreBtn) {
    showMoreBtn.addEventListener('click', () => {
      flaggedExpanded = !flaggedExpanded;
      const list = $('flaggedList');
      list.style.maxHeight = flaggedExpanded ? 'none' : '300px';
      const label = $('showMoreLabel');
      label.textContent = flaggedExpanded ? 'Show less' : 'Show more';
      showMoreBtn.querySelector('[data-icon]').innerHTML = SpenIcons.icon(
        flaggedExpanded ? 'ChevronUp' : 'ChevronDown'
      );
    });
  }

  // ---------- Data loading ----------
  async function loadOverview(monthYear) {
    const errorBox = $('insightsError');
    errorBox.style.display = 'none';
    try {
      const data = await apiRequest(
        `/insights/overview?month_year=${encodeURIComponent(monthYear)}`,
        'GET',
        null,
        true
      );
      currentData = data;
      renderAll(data);
    } catch (err) {
      errorBox.style.display = 'flex';
      $('insightsErrorMsg').textContent = err.message || 'Please try again.';
    }
  }

  function renderAll(data) {
    renderBanner(data);
    renderPersonality(data.spending_personality);
    renderHeatmap(data.category_heatmap);
    renderOverrun(data.overrun_prediction);
    renderHealth(data.financial_health);
    renderPace(data.pace_tracker);
    renderHighlights(data.highlights);
    renderFlagged(data.flagged_expenses);
    flaggedExpanded = false;
    $('flaggedList').style.maxHeight = '300px';
    const label = $('showMoreLabel');
    if (label) label.textContent = 'Show more';
    const iconEl = showMoreBtn ? showMoreBtn.querySelector('[data-icon]') : null;
    if (iconEl) iconEl.innerHTML = SpenIcons.icon('ChevronDown');
  }

  // ---------- Banner ----------
  function renderBanner(data) {
    const s = data.summary || {};
    const headline =
      s.expense > 0
        ? `You've spent ${money(s.expense)} this month`
        : 'Nothing recorded yet — this month is a blank canvas';
    $('bannerHeadline').textContent = headline;
    $('bannerSubtitle').textContent =
      `Across ${s.transaction_count || 0} transactions, with ${money(s.income)} income and a ${s.savings_rate || 0}% savings rate.`;

    const net = (s.income || 0) - (s.expense || 0);
    const netClass = net >= 0 ? 'insights-stat-green' : 'insights-stat-red';
    $('bannerStats').innerHTML = `
      <div class="insights-banner-stat"><span class="insights-stat-blue">${money(s.income || 0)}</span><span class="insights-banner-stat-label">INCOME</span></div>
      <div class="insights-banner-stat"><span class="insights-stat-red">${money(s.expense || 0)}</span><span class="insights-banner-stat-label">SPENT</span></div>
      <div class="insights-banner-stat"><span class="${netClass}">${money(net)}</span><span class="insights-banner-stat-label">NET</span></div>
    `;
  }

  // ---------- Personality ----------
  function renderPersonality(p) {
    if (!p) return;
    $('personalityTitle').textContent = p.title || 'No data';
    $('personalityTagline').textContent = p.tagline || '';
    $('personalityDesc').textContent = p.description || '';
    $('personalityMeta').innerHTML = p.top_category
      ? `<span class="insights-persona-chip"><span data-icon="Trophy"></span> Top: ${escapeHtml(p.top_category)}</span>
         <span class="insights-persona-chip"><span data-icon="PieChart"></span> ${p.top_share || 0}% of spend</span>
         <span class="insights-persona-chip"><span data-icon="Tag"></span> ${p.active_categories || 0} categories</span>`
      : '';
    hydrateIcons($('personalityMeta'));
  }

  // ---------- Heatmap ----------
  function heatTag(status) {
    return status === 'Over' ? 'insights-tag-red' : status === 'Watch' ? 'insights-tag-amber' : 'insights-tag-green';
  }

  function heatBarColor(status) {
    return status === 'Over' ? 'var(--accent-red)' : status === 'Watch' ? 'var(--accent-amber)' : 'var(--accent-green)';
  }

  function renderHeatmap(hm) {
    const container = $('heatmapContainer');
    const items = (hm && hm.items) || [];
    if (items.length === 0) {
      container.innerHTML = `<div class="empty-state" style="padding: 20px 0;"><span data-icon="PieChart"></span><p>No spending this month. Add transactions to see your category heatmap.</p></div>`;
      hydrateIcons(container);
      return;
    }

    container.innerHTML = items
      .map((item) => {
        const barWidth = item.pct === null ? 0 : Math.min(100, item.pct);
        const limitText = item.budgeted ? `of ${money(item.limit)}` : 'no budget';
        const spentText = item.spent > 0 ? money(item.spent) : '—';
        return `
        <div class="insights-heat-row">
          <div class="insights-heat-head">
            <span class="insights-heat-dot" style="background: ${escapeHtml(item.color_code)};"></span>
            <span class="insights-heat-name">${escapeHtml(item.category_name)}</span>
            <span class="${heatTag(item.status)}">${escapeHtml(item.status)}</span>
          </div>
          <div class="insights-heat-bar-bg"><div class="insights-heat-bar-fill" style="width: ${barWidth}%; background: ${heatBarColor(item.status)};"></div></div>
          <div class="insights-heat-sub">${spentText} ${limitText}${item.pct !== null ? ` · ${item.pct}%` : ''}</div>
        </div>`;
      })
      .join('');
    hydrateIcons(container);
  }

  // ---------- Overrun prediction ----------
  function overrunTag(status) {
    if (status === 'over') return 'insights-tag-red';
    if (status === 'watch') return 'insights-tag-amber';
    if (status === 'no_budget') return 'insights-tag-muted';
    return 'insights-tag-green';
  }

  function overrunLabel(status) {
    if (status === 'over') return 'Over budget';
    if (status === 'watch') return 'Watch zone';
    if (status === 'no_budget') return 'No budgets set';
    return 'On track';
  }

  function renderOverrun(o) {
    if (!o) return;
    const badge = $('overrunStatus');
    badge.className = `insights-status-pill ${overrunTag(o.status)}`;
    badge.innerHTML = `${SpenIcons.icon(o.status === 'over' ? 'AlertTriangle' : o.status === 'watch' ? 'Activity' : o.status === 'no_budget' ? 'Target' : 'CircleCheck')} ${overrunLabel(o.status)}`;
    $('overrunMessage').textContent = o.message || '';
    $('overrunBudget').textContent = money(o.total_budget);
    $('overrunProjected').textContent = money(o.projected_spend);
    const deltaEl = $('overrunDelta');
    deltaEl.textContent = `${o.delta > 0 ? '+' : ''}${money(o.delta)}`;
    deltaEl.style.color = o.delta > 0 ? 'var(--accent-red)' : 'var(--accent-green)';

    const cats = $('overrunCats');
    if (!o.overrun_categories || o.overrun_categories.length === 0) {
      cats.innerHTML = '';
    } else {
      cats.innerHTML = o.overrun_categories
        .map(
          (c) => `
        <div class="insights-overrun-cat">
          <span class="insights-heat-dot" style="background: ${escapeHtml(c.color_code)};"></span>
          <span class="insights-heat-name" style="flex: 1;">${escapeHtml(c.category_name)}</span>
          <span class="${c.projected_pct >= 100 ? 'insights-tag-red' : c.projected_pct >= 80 ? 'insights-tag-amber' : 'insights-tag-green'}">
            ${c.pct}% now → ${c.projected_pct}% projected
          </span>
        </div>`
        )
        .join('');
    }
  }

  // ---------- Health gauge ----------
  function healthColor(score) {
    if (score >= 70) return '#10b981';
    if (score >= 40) return '#f59e0b';
    return '#ef4444';
  }

  function renderHealth(h) {
    if (!h) return;

    if (h.score === null || h.score === undefined) {
      // No financial data yet: neutral "N/A" instead of a fabricated 0/100.
      $('healthScoreNumber').textContent = 'N/A';
      const statusEl = $('healthScoreStatus');
      statusEl.className = 'score-badge score-neutral';
      statusEl.innerHTML = `${SpenIcons.icon('Upload')} Upload CSV to calculate`;
      $('healthSavingsRate').textContent = '0%';
      if (gaugeChart) {
        gaugeChart.destroy();
        gaugeChart = null;
      }
      $('healthBreakdownList').innerHTML = '';
      return;
    }

    const score = h.score;
    $('healthScoreNumber').textContent = `${score}/100`;

    const statusEl = $('healthScoreStatus');
    statusEl.className = `score-badge ${score >= 70 ? 'score-healthy' : score >= 40 ? 'score-warning' : 'score-critical'}`;
    statusEl.innerHTML = `${SpenIcons.icon(score >= 70 ? 'Sparkles' : score >= 40 ? 'Activity' : 'AlertTriangle')} ${escapeHtml(h.status || 'Healthy')}`;

    $('healthSavingsRate').textContent = `${h.savings_rate || 0}%`;

    const color = healthColor(score);
    if (gaugeChart) {
      gaugeChart.destroy();
      gaugeChart = null;
    }
    const ctx = $('healthGaugeCanvas');
    if (ctx && typeof Chart !== 'undefined') {
      gaugeChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          datasets: [
            {
              data: [score, 100 - score],
              backgroundColor: [color, 'rgba(255,255,255,0.06)'],
              borderWidth: 0,
              circumference: 360,
            },
          ],
        },
        options: {
          responsive: false,
          cutout: '78%',
          rotation: -90,
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
        },
      });
    }

    const list = $('healthBreakdownList');
    const subs = (h.sub_scores || [])
      .map(
        (s) => `
      <div class="insights-subscore">
        <div class="insights-subscore-head">
          <span>${escapeHtml(s.label)}</span>
          <span class="${healthTag(s.tag)}">${escapeHtml(s.tag)}</span>
        </div>
        <div class="insights-heat-bar-bg"><div class="insights-heat-bar-fill" style="width: ${Math.min(100, s.score)}%; background: ${healthColor(s.score)};"></div></div>
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">${s.score}/100</div>
      </div>`
      )
      .join('');
    list.innerHTML = subs || '<p style="color: var(--text-muted); font-size: 13px;">No breakdown available.</p>';
  }

  function healthTag(tag) {
    return tag === 'Well' ? 'insights-tag-green' : tag === 'Risk' ? 'insights-tag-red' : 'insights-tag-amber';
  }

  // ---------- Pace tracker ----------
  function renderPace(pace) {
    if (!pace) return;
    $('paceThisWeek').textContent = `${money(pace.this_week_daily_avg)}/day`;
    $('paceLastWeek').textContent = `${money(pace.last_week_daily_avg)}/day`;

    const changeEl = $('paceChange');
    if (pace.change_pct === null) {
      changeEl.textContent = '--';
      changeEl.style.color = 'var(--text-muted)';
    } else if (pace.change_pct < 0) {
      changeEl.innerHTML = `${SpenIcons.icon('ArrowDown')} ${Math.abs(pace.change_pct).toFixed(1)}%`;
      changeEl.style.color = 'var(--accent-green)';
    } else if (pace.change_pct > 0) {
      changeEl.innerHTML = `${SpenIcons.icon('ArrowUp')} ${pace.change_pct.toFixed(1)}%`;
      changeEl.style.color = 'var(--accent-red)';
    } else {
      changeEl.textContent = '0%';
      changeEl.style.color = 'var(--text-muted)';
    }
    hydrateIcons(changeEl);

    const topDays = $('paceTopDays');
    if (!pace.top_days || pace.top_days.length === 0) {
      topDays.innerHTML = '<span style="font-size: 12px; color: var(--text-muted);">No spend days yet</span>';
    } else {
      topDays.innerHTML = pace.top_days
        .map(
          (d, i) => `
        <span class="insights-day-chip ${i === 0 ? 'insights-day-chip-top' : ''}">
          <span>${fmtDay(d.date)}</span>
          <strong>${money(d.amount)}</strong>
        </span>`
        )
        .join('');
    }

    const insights = $('paceInsights');
    insights.innerHTML = (pace.insights || [])
      .map(
        (i) => `
      <div class="insights-context-row"><span data-icon="Lightbulb" style="color: var(--accent-amber);"></span><span>${escapeHtml(i)}</span></div>`
      )
      .join('');
    hydrateIcons(insights);
  }

  // ---------- Highlights ----------
  function renderHighlights(h) {
    const container = $('highlightsContainer');
    if (!h) {
      container.innerHTML = '';
      return;
    }
    const cards = [];

    if (h.biggest_expense) {
      const b = h.biggest_expense;
      cards.push(`
        <div class="insights-highlight-card">
          <span class="insights-highlight-icon" style="background: rgba(239,68,68,0.12); color: var(--accent-red);"><span data-icon="Flame"></span></span>
          <div>
            <div class="insights-highlight-label">BIGGEST EXPENSE</div>
            <div class="insights-highlight-value">${money2(b.amount)}</div>
            <div class="insights-highlight-sub">${escapeHtml(b.description || '')} · ${escapeHtml(b.category || '')} · ${fmtDay(b.date)}</div>
          </div>
        </div>`);
    }

    if (h.highest_spending_day) {
      const d = h.highest_spending_day;
      cards.push(`
        <div class="insights-highlight-card">
          <span class="insights-highlight-icon" style="background: rgba(245,158,11,0.12); color: var(--accent-amber);"><span data-icon="Calendar"></span></span>
          <div>
            <div class="insights-highlight-label">HIGHEST SPENDING DAY</div>
            <div class="insights-highlight-value">${money2(d.amount)}</div>
            <div class="insights-highlight-sub">${fmtDay(d.date)} was your most expensive day</div>
          </div>
        </div>`);
    }

    if (h.longest_no_spend_streak) {
      const s = h.longest_no_spend_streak;
      cards.push(`
        <div class="insights-highlight-card">
          <span class="insights-highlight-icon" style="background: rgba(16,185,129,0.12); color: var(--accent-green);"><span data-icon="ShieldCheck"></span></span>
          <div>
            <div class="insights-highlight-label">LONGEST NO-SPEND STREAK</div>
            <div class="insights-highlight-value">${s.days} days</div>
            <div class="insights-highlight-sub">${fmtDay(s.start_date)} → ${fmtDay(s.end_date)}</div>
          </div>
        </div>`);
    }

    if (cards.length === 0) {
      container.innerHTML = `<div class="empty-state"><span data-icon="Trophy"></span><p>No highlights yet — start adding transactions.</p></div>`;
    } else {
      container.innerHTML = cards.join('');
    }
    hydrateIcons(container);
  }

  // ---------- Flagged expenses ----------
  function pillClass(type) {
    if (type === 'High Amount') return 'insights-pill-red';
    if (type === 'Sudden Spike') return 'insights-pill-amber';
    return 'insights-pill-purple';
  }

  function renderFlagged(f) {
    const count = (f && f.flagged_count) || 0;
    const items = (f && f.items) || [];

    const badge = $('flaggedBadge');
    badge.innerHTML = `${SpenIcons.icon('Bell')} ${count} flagged`;
    badge.className = `insights-flag-badge ${count > 0 ? '' : 'insights-flag-badge-empty'}`;

    const list = $('flaggedList');
    if (items.length === 0) {
      list.innerHTML = `<div class="empty-state" style="padding: 16px 0;"><span data-icon="CircleCheck"></span><p>Nothing flagged this month. Keep it up!</p></div>`;
      $('showMoreBtn').style.display = 'none';
    } else {
      list.innerHTML = items
        .map(
          (item) => `
        <div class="insights-flag-item">
          <span class="insights-heat-dot" style="background: ${escapeHtml(item.color_code)};"></span>
          <div style="flex: 1; min-width: 0;">
            <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap;">
              <span style="font-weight: 700; font-size: 13px;">${escapeHtml(item.description || 'Transaction')}</span>
              <span style="font-weight: 800; color: var(--accent-red);">${money2(item.amount)}</span>
            </div>
            <div style="font-size: 12px; color: var(--text-muted); margin: 2px 0 6px;">${escapeHtml(item.category_name || '')} · ${fmtDay(item.date)}</div>
            <div style="display: flex; gap: 6px; flex-wrap: wrap;">${item.pills.map((p) => `<span class="${pillClass(p.type)}">${escapeHtml(p.label)}</span>`).join('')}</div>
          </div>
        </div>`
        )
        .join('');
      $('showMoreBtn').style.display = 'block';
    }
    hydrateIcons(badge);
    hydrateIcons(list);
  }

  // ---------- Download report (PDF) ----------
  const FULL_MONTHS = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  function reportMonthLabel(mm) {
    const [y, m] = String(mm || '')
      .substring(0, 7)
      .split('-');
    return m && y ? `${FULL_MONTHS[parseInt(m, 10) - 1]} ${y}` : mm || '';
  }

  function reportStatusColor(status) {
    return status === 'Over' ? '#ef4444' : status === 'Watch' ? '#f59e0b' : '#10b981';
  }

  function reportStatusLabel(status) {
    return status === 'Over' ? 'Over budget' : status === 'Watch' ? 'Watch' : 'Normal';
  }

  function buildReportHTML(data) {
    const s = data.summary || {};
    const monthLabel = reportMonthLabel(data.meta && data.meta.month_year);
    const net = parseFloat(s.net || 0);
    const netColor = net >= 0 ? '#10b981' : '#ef4444';
    const hm = (data.category_heatmap && data.category_heatmap.items) || [];
    const fh = data.financial_health || {};
    const person = data.spending_personality || {};
    const hl = data.highlights || {};
    const flagged = (data.flagged_expenses && data.flagged_expenses.items) || [];
    const generated = data.meta && data.meta.generated_at ? new Date(data.meta.generated_at) : new Date();

    const summaryCards = [
      { label: 'INCOME', value: money2(s.income), color: '#10b981' },
      { label: 'SPENT', value: money2(s.expense), color: '#ef4444' },
      { label: 'NET SAVINGS', value: money2(s.net), color: netColor },
      { label: 'SAVINGS RATE', value: `${s.savings_rate || 0}%`, color: '#3b82f6' },
    ]
      .map(
        (c) => `
      <div style="flex:1;min-width:150px;background:#ffffff;border:1px solid #e5e9f2;border-top:3px solid ${c.color};border-radius:12px;padding:16px;box-sizing:border-box;">
        <div style="font-size:10px;letter-spacing:1px;color:#64748b;font-weight:700;">${c.label}</div>
        <div style="font-size:22px;font-weight:800;color:${c.color};margin-top:6px;">${c.value}</div>
      </div>`
      )
      .join('');

    const rows =
      hm.length > 0
        ? hm
            .map((item) => {
              const pct = item.pct === null ? '—' : `${item.pct}%`;
              const limitText = item.budgeted ? money(item.limit) : 'No budget';
              const stColor = reportStatusColor(item.status);
              const spentText = item.spent > 0 ? money2(item.spent) : '—';
              return `
        <tr>
          <td style="padding:9px 8px;border-bottom:1px solid #eef1f7;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${escapeHtml(item.color_code || '#cbd5e1')};"></span>
              <span style="font-weight:600;color:#0f172a;">${escapeHtml(item.category_name)}</span>
            </div>
          </td>
          <td style="padding:9px 8px;border-bottom:1px solid #eef1f7;text-align:right;color:#0f172a;font-weight:700;">${spentText}</td>
          <td style="padding:9px 8px;border-bottom:1px solid #eef1f7;text-align:right;color:#64748b;">${limitText}</td>
          <td style="padding:9px 8px;border-bottom:1px solid #eef1f7;text-align:right;color:#64748b;">${pct}</td>
          <td style="padding:9px 8px;border-bottom:1px solid #eef1f7;text-align:right;">
            <span style="font-size:11px;font-weight:700;color:#ffffff;background:${stColor};border-radius:999px;padding:3px 10px;">${reportStatusLabel(item.status)}</span>
          </td>
        </tr>`;
            })
            .join('')
        : '<tr><td colspan="5" style="text-align:center;color:#64748b;padding:24px;">No spending recorded for this period.</td></tr>';

    const highlights = [];
    if (hl.biggest_expense) {
      const b = hl.biggest_expense;
      highlights.push(`
        <div style="flex:1;min-width:200px;background:#ffffff;border:1px solid #e5e9f2;border-radius:12px;padding:14px;box-sizing:border-box;">
          <div style="font-size:10px;letter-spacing:1px;color:#64748b;font-weight:700;">BIGGEST EXPENSE</div>
          <div style="font-size:18px;font-weight:800;color:#ef4444;margin-top:6px;">${money2(b.amount)}</div>
          <div style="font-size:12px;color:#64748b;margin-top:4px;">${escapeHtml(b.description || '')} · ${escapeHtml(b.category || '')}</div>
        </div>`);
    }
    if (hl.highest_spending_day) {
      const d = hl.highest_spending_day;
      highlights.push(`
        <div style="flex:1;min-width:200px;background:#ffffff;border:1px solid #e5e9f2;border-radius:12px;padding:14px;box-sizing:border-box;">
          <div style="font-size:10px;letter-spacing:1px;color:#64748b;font-weight:700;">HIGHEST SPENDING DAY</div>
          <div style="font-size:18px;font-weight:800;color:#f59e0b;margin-top:6px;">${money2(d.amount)}</div>
          <div style="font-size:12px;color:#64748b;margin-top:4px;">${fmtDay(d.date)} was your most expensive day</div>
        </div>`);
    }
    if (hl.longest_no_spend_streak) {
      const st = hl.longest_no_spend_streak;
      highlights.push(`
        <div style="flex:1;min-width:200px;background:#ffffff;border:1px solid #e5e9f2;border-radius:12px;padding:14px;box-sizing:border-box;">
          <div style="font-size:10px;letter-spacing:1px;color:#64748b;font-weight:700;">LONGEST NO-SPEND STREAK</div>
          <div style="font-size:18px;font-weight:800;color:#10b981;margin-top:6px;">${st.days} days</div>
          <div style="font-size:12px;color:#64748b;margin-top:4px;">${fmtDay(st.start_date)} → ${fmtDay(st.end_date)}</div>
        </div>`);
    }

    const flaggedRows =
      flagged.length > 0
        ? flagged
            .slice(0, 8)
            .map(
              (i) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #eef1f7;">
          <div style="min-width:0;">
            <div style="font-size:13px;font-weight:600;color:#0f172a;">${escapeHtml(i.description || 'Transaction')}</div>
            <div style="font-size:12px;color:#64748b;margin-top:2px;">${escapeHtml(i.category_name || '')} · ${fmtDay(i.date)}${(i.pills || []).length > 0 ? ' · ' + (i.pills || []).map((p) => escapeHtml(p.label)).join(' · ') : ''}</div>
          </div>
          <div style="font-size:14px;font-weight:800;color:#ef4444;white-space:nowrap;margin-left:12px;">${money2(i.amount)}</div>
        </div>`
            )
            .join('')
        : '<div style="font-size:13px;color:#64748b;padding:8px 0;">Nothing flagged this month.</div>';

    return `
      <div style="width:794px;padding:36px 40px;background:#f5f7fb;color:#0f172a;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-sizing:border-box;">
        <!-- Header -->
        <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #3b82f6;padding-bottom:16px;">
          <div style="display:flex;align-items:center;gap:12px;">
            <div style="width:44px;height:44px;border-radius:12px;background:#eef4ff;display:flex;align-items:center;justify-content:center;">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            </div>
            <div>
              <div style="font-size:18px;font-weight:800;color:#0f172a;">SpenSight</div>
              <div style="font-size:11px;letter-spacing:1.5px;color:#3b82f6;font-weight:700;">FINANCIAL INSIGHTS REPORT</div>
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:20px;font-weight:800;color:#0f172a;">${escapeHtml(monthLabel)}</div>
            <div style="font-size:11px;color:#64748b;margin-top:4px;">Generated ${generated.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
          </div>
        </div>

        <!-- Summary cards -->
        <div style="display:flex;gap:12px;margin-top:20px;flex-wrap:wrap;">${summaryCards}</div>

        <!-- Category breakdown -->
        <div style="margin-top:24px;background:#ffffff;border:1px solid #e5e9f2;border-radius:14px;padding:18px;">
          <div style="font-size:14px;font-weight:800;color:#0f172a;">Category Spending Breakdown</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">${hm.length} active categor${hm.length === 1 ? 'y' : 'ies'} this period</div>
          <table style="width:100%;border-collapse:collapse;margin-top:12px;">
            <thead>
              <tr style="border-bottom:2px solid #e5e9f2;">
                <th style="text-align:left;padding:8px;font-size:11px;letter-spacing:1px;color:#64748b;">CATEGORY</th>
                <th style="text-align:right;padding:8px;font-size:11px;letter-spacing:1px;color:#64748b;">SPENT</th>
                <th style="text-align:right;padding:8px;font-size:11px;letter-spacing:1px;color:#64748b;">BUDGET</th>
                <th style="text-align:right;padding:8px;font-size:11px;letter-spacing:1px;color:#64748b;">% OF SPEND</th>
                <th style="text-align:right;padding:8px;font-size:11px;letter-spacing:1px;color:#64748b;">STATUS</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>

        <!-- Highlights -->
        ${
          highlights.length > 0
            ? `
        <div style="margin-top:24px;">
          <div style="font-size:14px;font-weight:800;color:#0f172a;">Spending Highlights</div>
          <div style="display:flex;gap:12px;margin-top:10px;flex-wrap:wrap;">${highlights.join('')}</div>
        </div>`
            : ''
        }

        <!-- Health + personality -->
        <div style="display:flex;gap:12px;margin-top:24px;flex-wrap:wrap;">
          <div style="flex:1;min-width:260px;background:#ffffff;border:1px solid #e5e9f2;border-radius:14px;padding:18px;box-sizing:border-box;">
            <div style="font-size:14px;font-weight:800;color:#0f172a;">Financial Health</div>
            <div style="display:flex;align-items:center;gap:10px;margin-top:10px;">
              <span style="font-size:30px;font-weight:800;color:#3b82f6;">${fh.score == null ? 'N/A' : fh.score}<span style="font-size:14px;color:#64748b;">${fh.score == null ? '' : '/100'}</span></span>
              <span style="font-size:12px;font-weight:700;color:${fh.score == null ? '#64748b' : fh.score >= 70 ? '#10b981' : fh.score >= 40 ? '#f59e0b' : '#ef4444'};background:${fh.score == null ? '#f1f5f9' : fh.score >= 70 ? '#ecfdf5' : fh.score >= 40 ? '#fffbeb' : '#fef2f2'};border-radius:999px;padding:4px 10px;">${escapeHtml(fh.score == null ? 'No Data' : (fh.status || 'Healthy'))}</span>
            </div>
            <div style="font-size:12px;color:#64748b;margin-top:6px;">Savings rate <span style="font-weight:700;color:#0f172a;">${fh.savings_rate || 0}%</span></div>
          </div>
          <div style="flex:1;min-width:260px;background:#ffffff;border:1px solid #e5e9f2;border-radius:14px;padding:18px;box-sizing:border-box;">
            <div style="font-size:14px;font-weight:800;color:#0f172a;">Spending Personality</div>
            <div style="font-size:18px;font-weight:800;color:#8b5cf6;margin-top:10px;">${escapeHtml(person.title || '—')}</div>
            <div style="font-size:12px;color:#64748b;margin-top:6px;line-height:1.6;">${escapeHtml(person.description || '')}</div>
            ${person.top_category ? `<div style="font-size:12px;color:#0f172a;margin-top:8px;"><span style="font-weight:700;">Top category:</span> ${escapeHtml(person.top_category)} (${person.top_share || 0}% of spend)</div>` : ''}
          </div>
        </div>

        <!-- Flagged expenses -->
        <div style="margin-top:24px;background:#ffffff;border:1px solid #e5e9f2;border-radius:14px;padding:18px;">
          <div style="font-size:14px;font-weight:800;color:#0f172a;">Flagged Expenses</div>
          <div style="margin-top:8px;">${flaggedRows}</div>
        </div>

        <div style="text-align:center;font-size:11px;color:#94a3b8;margin-top:24px;border-top:1px solid #e5e9f2;padding-top:14px;">
          Generated by SpenSight — your personal money copilot · Confidential
        </div>
      </div>`;
  }

  async function downloadReport() {
    if (!currentData) {
      showToast('No insights to download yet.', 'error');
      return;
    }
    if (typeof html2pdf === 'undefined') {
      showToast('PDF library failed to load. Please refresh and try again.', 'error');
      return;
    }

    const mm = currentData.meta && currentData.meta.month_year;
    const [y, m] = String(mm || new Date().toISOString().substring(0, 7))
      .substring(0, 7)
      .split('-');
    const fileName = `SpenSight_Report_${FULL_MONTHS[parseInt(m, 10) - 1] || m}_${y}.pdf`;

    const container = $('pdfReport');
    container.innerHTML = buildReportHTML(currentData);

    downloadBtn.disabled = true;
    downloadBtn.innerHTML = `${SpenIcons.icon('RefreshCw')} Generating PDF…`;
    try {
      await html2pdf()
        .set({
          margin: 0,
          filename: fileName,
          image: { type: 'jpeg', quality: 0.98 },
          html2canvas: { scale: 2, useCORS: true, backgroundColor: '#f5f7fb', logging: false },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
          pagebreak: { mode: ['css', 'legacy'] },
        })
        .from(container)
        .save();
      showToast(`Report downloaded as ${fileName}.`, 'success');
    } catch (err) {
      console.error('PDF generation failed:', err);
      showToast('Failed to generate PDF. Please try again.', 'error');
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.innerHTML = `${SpenIcons.icon('Download')} Download Report`;
      container.innerHTML = '';
    }
  }

  // ---------- Init ----------
  loadOverview(currentMonth);
});
