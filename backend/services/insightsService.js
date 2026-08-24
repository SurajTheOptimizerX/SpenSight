// ============================================================
// Insights Service
// Computes the full Insights Overview payload for a user +
// month: spending personality, category heatmap, budget
// overrun prediction, financial health breakdown, weekly
// spending pace, spending highlights and flagged expenses.
// Everything is read-only and month-parametric (YYYY-MM).
// ============================================================

const db = require('../config/db');
const aiEngine = require('./aiEngine');

const CURRENCY = process.env.CURRENCY_SYMBOL || '₹';
const DEFAULT_COLOR = '#6B7280';

function daysInMonth(monthYear) {
  const [y, m] = String(monthYear)
    .split('-')
    .map((n) => parseInt(n, 10));
  if (!y || !m) return 30;
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function isCurrentMonth(monthYear) {
  return monthYear === new Date().toISOString().substring(0, 7);
}

function clampPct(n) {
  return Math.max(0, Math.min(100, Number(n.toFixed(1))));
}

// Single entry point for the Insights Overview page.
async function getOverview(userId, monthYear) {
  const mm = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(monthYear))
    ? String(monthYear)
    : new Date().toISOString().substring(0, 7);

  console.log(`[INSIGHTS] getOverview user=${userId} month=${mm}`);

  const [totals, categorySpend, budgets, expenses] = await Promise.all([
    loadTotals(userId, mm),
    loadCategorySpend(userId, mm),
    loadBudgets(userId, mm),
    loadExpenses(userId, mm),
  ]);

  console.log(`[INSIGHTS] data loaded: income=${totals.income} expense=${totals.expense} categories=${categorySpend.length} budgets=${budgets.length} expense_txns=${expenses.length}`);

  const health = await aiEngine.calculateHealthScore(userId, mm);

  console.log(`[INSIGHTS] health score=${health.score} status=${health.status}`);

  return {
    meta: {
      month_year: mm,
      currency: CURRENCY,
      generated_at: new Date().toISOString(),
    },
    summary: {
      income: totals.income,
      expense: totals.expense,
      net: totals.income - totals.expense,
      savings_rate:
        totals.income > 0 ? Number((((totals.income - totals.expense) / totals.income) * 100).toFixed(1)) : 0,
      transaction_count: expenses.length,
    },
    spending_personality: computePersonality(categorySpend),
    category_heatmap: computeHeatmap(categorySpend, budgets),
    overrun_prediction: computeOverrun(categorySpend, budgets, totals.expense, mm),
    financial_health: computeHealthBreakdown(health, budgets, categorySpend),
    pace_tracker: computePace(expenses, mm),
    highlights: computeHighlights(expenses),
    flagged_expenses: computeFlagged(expenses, categorySpend, budgets),
  };
}

async function loadTotals(userId, monthYear) {
  const sql = `
    SELECT
      COALESCE(SUM(CASE WHEN t.type = 'income' OR (t.type = 'expense' AND t.is_debit = false) THEN t.amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN t.type = 'expense' AND t.is_debit = true THEN t.amount ELSE 0 END), 0) AS expense
    FROM transactions t
    WHERE t.user_id = $1 AND t.type != 'transfer' AND TO_CHAR(t.date, 'YYYY-MM') = $2
  `;
  const res = await db.query(sql, [userId, monthYear]);
  const row = res.rows[0] || {};
  const income = parseFloat(row.income || 0);
  const expense = parseFloat(row.expense || 0);
  console.log(`[INSIGHTS] loadTotals user=${userId} month=${monthYear} => income=${income} expense=${expense} (SQL: ${sql.replace(/\s+/g, ' ').trim()})`);
  return { income, expense };
}

async function loadCategorySpend(userId, monthYear) {
  const sql = `
    SELECT
      COALESCE(c.name, 'Uncategorized') AS category_name,
      COALESCE(c.color_code, '${DEFAULT_COLOR}') AS color_code,
      COALESCE(SUM(t.amount), 0) AS total_amount
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    WHERE t.user_id = $1 AND TO_CHAR(t.date, 'YYYY-MM') = $2
      AND t.type = 'expense' AND t.is_debit = true
    GROUP BY c.name, c.color_code
    ORDER BY total_amount DESC
  `;
  const res = await db.query(sql, [userId, monthYear]);
  return res.rows.map((r) => ({
    category_name: r.category_name,
    color_code: r.color_code || DEFAULT_COLOR,
    total_amount: parseFloat(r.total_amount || 0),
  }));
}

async function loadBudgets(userId, monthYear) {
  const sql = `
    SELECT
      b.category_id,
      COALESCE(c.name, 'Uncategorized') AS category_name,
      COALESCE(c.color_code, '${DEFAULT_COLOR}') AS color_code,
      b.monthly_limit,
      COALESCE(SUM(CASE WHEN t.type = 'expense' AND t.is_debit = true THEN t.amount ELSE 0 END), 0) AS spent
    FROM budgets b
    LEFT JOIN categories c ON b.category_id = c.id
    LEFT JOIN transactions t ON t.category_id = b.category_id
      AND t.user_id = b.user_id AND TO_CHAR(t.date, 'YYYY-MM') = $2
    WHERE b.user_id = $1 AND b.month_year = $3
    GROUP BY b.category_id, c.name, c.color_code, b.monthly_limit
  `;
  const res = await db.query(sql, [userId, monthYear, monthYear]);
  return res.rows.map((r) => ({
    category_id: r.category_id,
    category_name: r.category_name,
    color_code: r.color_code || DEFAULT_COLOR,
    monthly_limit: parseFloat(r.monthly_limit || 0),
    spent: parseFloat(r.spent || 0),
  }));
}

async function loadExpenses(userId, monthYear) {
  const sql = `
    SELECT
      t.id,
      TO_CHAR(t.date, 'YYYY-MM-DD') AS date,
      t.description,
      t.amount,
      COALESCE(c.name, 'Uncategorized') AS category_name,
      COALESCE(c.color_code, '${DEFAULT_COLOR}') AS color_code
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    WHERE t.user_id = $1 AND TO_CHAR(t.date, 'YYYY-MM') = $2
      AND t.type = 'expense' AND t.is_debit = true
    ORDER BY t.date ASC, t.id ASC
  `;
  const res = await db.query(sql, [userId, monthYear]);
  return res.rows.map((r) => ({
    id: r.id,
    date: r.date,
    description: r.description,
    amount: parseFloat(r.amount || 0),
    category_name: r.category_name,
    color_code: r.color_code || DEFAULT_COLOR,
  }));
}

// ---- Spending personality ---------------------------------
function computePersonality(categorySpend) {
  const total = categorySpend.reduce((s, c) => s + c.total_amount, 0);
  if (total <= 0) {
    return {
      title: 'No Spending Yet',
      tagline: 'Your month is a clean slate',
      description: `Nothing recorded for this month yet. Add a few expenses and we'll read your habits instantly.`,
      top_category: null,
      top_share: 0,
      active_categories: 0,
    };
  }

  const top = categorySpend[0];
  const topShare = (top.total_amount / total) * 100;
  const activeCount = categorySpend.length;

  let title = 'Moderate Spender';
  let tagline = 'A little here, a little there';
  let description = `Your spending is spread across ${activeCount} categories with ${top.category_name} leading at ${topShare.toFixed(0)}%.`;

  if (topShare >= 60) {
    title = 'Single-Focus Spender';
    tagline = 'All eggs in one basket';
    description = `${top.category_name} eats ${topShare.toFixed(0)}% of your spend. One tweak in that category would move your whole month.`;
  } else if (topShare >= 40) {
    title = 'Category Concentrator';
    tagline = 'Two or three habits drive it';
    description = `${top.category_name} takes ${topShare.toFixed(0)}% of your spending. Consider capping it with a budget.`;
  } else if (activeCount >= 6) {
    title = 'Balanced Spender';
    tagline = 'Nicely diversified habits';
    description = `Your money is spread across ${activeCount} categories — a healthy sign of balanced financial behaviour.`;
  }

  return {
    title,
    tagline,
    description,
    top_category: top.category_name,
    top_share: Number(topShare.toFixed(1)),
    active_categories: activeCount,
  };
}

// ---- Category heatmap (Normal / Watch / Over) -------------
function computeHeatmap(categorySpend, budgets) {
  const items = [];
  const seen = new Set();

  const budgetMap = {};
  budgets.forEach((b) => {
    budgetMap[b.category_name] = b;
  });

  categorySpend.forEach((c) => {
    const budget = budgetMap[c.category_name];
    const limit = budget ? budget.monthly_limit : 0;
    const pct = limit > 0 ? clampPct((c.total_amount / limit) * 100) : null;
    const status = limit > 0 ? (pct >= 100 ? 'Over' : pct >= 80 ? 'Watch' : 'Normal') : 'Normal';
    items.push({
      category_name: c.category_name,
      color_code: c.color_code,
      spent: c.total_amount,
      limit: limit || null,
      pct: pct === null ? null : Number(pct.toFixed(0)),
      budgeted: limit > 0,
      status,
    });
    seen.add(c.category_name);
  });

  // Include budgeted categories with no spend yet so the heatmap is complete.
  budgets.forEach((b) => {
    if (seen.has(b.category_name)) return;
    const pct = b.monthly_limit > 0 ? clampPct((b.spent / b.monthly_limit) * 100) : 0;
    items.push({
      category_name: b.category_name,
      color_code: b.color_code,
      spent: b.spent,
      limit: b.monthly_limit || null,
      pct: b.monthly_limit > 0 ? Number(pct.toFixed(0)) : null,
      budgeted: b.monthly_limit > 0,
      status: b.monthly_limit > 0 ? (pct >= 100 ? 'Over' : pct >= 80 ? 'Watch' : 'Normal') : 'Normal',
    });
  });

  items.sort((a, b) => b.spent - a.spent);
  return { items };
}

// ---- Budget overrun prediction ----------------------------
function computeOverrun(categorySpend, budgets, totalExpense, monthYear) {
  const totalBudget = budgets.reduce((s, b) => s + b.monthly_limit, 0);
  const elapsed = elapsedDays(monthYear);
  const dailyAvg = elapsed > 0 ? totalExpense / elapsed : 0;
  const projected = Math.round(dailyAvg * daysInMonth(monthYear));

  const overrunCategories = budgets
    .filter((b) => b.monthly_limit > 0)
    .map((b) => {
      const pct = clampPct((b.spent / b.monthly_limit) * 100);
      const categoryDaily = elapsed > 0 ? b.spent / elapsed : 0;
      const projectedCat = Math.round(categoryDaily * daysInMonth(monthYear));
      return {
        category_name: b.category_name,
        color_code: b.color_code,
        limit: b.monthly_limit,
        spent: b.spent,
        pct: Number(pct.toFixed(0)),
        projected: projectedCat,
        projected_pct: b.monthly_limit > 0 ? clampPct((projectedCat / b.monthly_limit) * 100) : 0,
      };
    })
    .filter((c) => c.projected_pct >= 80 || c.pct >= 80);

  const delta = projected - totalBudget;
  const deltaPct = totalBudget > 0 ? (delta / totalBudget) * 100 : 0;
  let status = 'on_track';
  if (totalBudget <= 0) status = 'no_budget';
  else if (delta > 0 && deltaPct <= 10) status = 'watch';
  else if (delta > 0) status = 'over';

  let message;
  if (totalBudget <= 0) {
    message = 'Set category budgets to get a personalised end-of-month prediction.';
  } else if (delta <= 0) {
    message = `Projected spend of ${CURRENCY}${projected.toLocaleString('en-IN')} stays within your ${CURRENCY}${totalBudget.toLocaleString('en-IN')} budget.`;
  } else {
    message = `You'll exceed your ${CURRENCY}${totalBudget.toLocaleString('en-IN')} budget by roughly ${CURRENCY}${delta.toLocaleString('en-IN')}.`;
  }

  return {
    total_budget: totalBudget,
    spent_so_far: totalExpense,
    projected_spend: projected,
    delta,
    status,
    message,
    overrun_categories: overrunCategories.slice(0, 4),
  };
}

function elapsedDays(monthYear) {
  const d = new Date();
  const days = daysInMonth(monthYear);
  if (!isCurrentMonth(monthYear)) return days;
  const today = d.getDate();
  return Math.max(1, Math.min(today, days));
}

// ---- Financial health breakdown ---------------------------
function healthTag(score) {
  if (score >= 80) return 'Well';
  if (score >= 50) return 'Watch';
  return 'Risk';
}

function computeHealthBreakdown(health, budgets, categorySpend) {
  // No-data guard: when the engine surfaced a neutral "No Data" state, do not
  // fabricate a breakdown (sub-scores, pacing, 0/100 gauge) for an empty account.
  if (health.score === null || health.label === 'No Data') {
    return {
      score: null,
      status: 'NEUTRAL',
      savings_rate: 0,
      sub_scores: [],
    };
  }

  const score = Math.max(0, Math.min(100, Math.round(health.health_score || 0)));

  // Budget pacing: share of budgets currently within their limit.
  const budgeted = budgets.filter((b) => b.monthly_limit > 0);
  const pacing =
    budgeted.length > 0
      ? Math.round((budgeted.filter((b) => b.spent <= b.monthly_limit).length / budgeted.length) * 100)
      : null;

  // Category balance: low concentration = high balance score.
  const total = categorySpend.reduce((s, c) => s + c.total_amount, 0);
  const topShare = total > 0 ? (categorySpend[0].total_amount / total) * 100 : 0;
  let balanceScore = 100;
  if (topShare >= 60) balanceScore = 40;
  else if (topShare >= 45) balanceScore = 60;
  else if (topShare >= 30) balanceScore = 80;

  // Savings discipline.
  const savingsRate = parseFloat(health.savings_rate || 0);
  let savingsScore = 0;
  if (savingsRate >= 20) savingsScore = 100;
  else if (savingsRate >= 10) savingsScore = 75;
  else if (savingsRate >= 0) savingsScore = 50;

  const subScores = [];
  if (pacing !== null) {
    subScores.push({ label: 'Budget Pacing', score: pacing, tag: healthTag(pacing) });
  }
  subScores.push({ label: 'Category Balance', score: balanceScore, tag: healthTag(balanceScore) });
  subScores.push({ label: 'Savings Discipline', score: savingsScore, tag: healthTag(savingsScore) });

  return {
    score,
    status: health.overall_status || (score >= 70 ? 'Healthy' : score >= 40 ? 'Warning' : 'Critical'),
    savings_rate: Number(savingsRate.toFixed(1)),
    sub_scores: subScores,
  };
}

// ---- Weekly pace tracker ----------------------------------
function computePace(expenses, monthYear) {
  const daily = {};
  expenses.forEach((e) => {
    const key = String(e.date).substring(0, 10);
    daily[key] = (daily[key] || 0) + e.amount;
  });

  const today = new Date();
  let anchor;
  if (isCurrentMonth(monthYear)) {
    anchor = today;
  } else {
    const days = daysInMonth(monthYear);
    anchor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), days));
  }
  const anchorTime = anchor.getTime();

  const weekSlice = (daysBackFrom, daysBackTo) => {
    let sum = 0;
    let count = 0;
    for (let i = daysBackFrom; i >= daysBackTo; i--) {
      const d = new Date(anchorTime - i * 86400000);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      const val = daily[key] || 0;
      sum += val;
      count += 1;
    }
    return count > 0 ? sum / count : 0;
  };

  const thisAvg = weekSlice(6, 0);
  const lastAvg = weekSlice(13, 7);

  let changePct = null;
  if (lastAvg > 0 && thisAvg > 0) {
    changePct = Number((((thisAvg - lastAvg) / lastAvg) * 100).toFixed(1));
  } else if (thisAvg > 0 && lastAvg === 0) {
    changePct = 100;
  } else if (thisAvg === 0 && lastAvg > 0) {
    changePct = -100;
  }

  const topDays = Object.entries(daily)
    .map(([date, amount]) => ({ date, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3);

  const insights = [];
  if (changePct === null) {
    insights.push("No expenses in the tracked windows yet — add transactions and we'll measure your pace.");
  } else if (changePct < 0) {
    insights.push(
      `Your daily spending is ${Math.abs(changePct).toFixed(0)}% lower than last week. The trend is your friend — keep it rolling.`
    );
  } else if (changePct > 0) {
    insights.push(
      `Daily spending is up ${changePct.toFixed(0)}% vs last week. Double-check the big-ticket days below.`
    );
  } else {
    insights.push('Your daily pace is holding steady versus last week.');
  }

  return {
    this_week_daily_avg: Number(thisAvg.toFixed(2)),
    last_week_daily_avg: Number(lastAvg.toFixed(2)),
    change_pct: changePct,
    top_days: topDays,
    insights,
  };
}

// ---- Spending highlights ----------------------------------
function computeHighlights(expenses) {
  let biggest = null;
  const byDay = {};
  expenses.forEach((e) => {
    if (!biggest || e.amount > biggest.amount) biggest = e;
    const key = String(e.date).substring(0, 10);
    byDay[key] = (byDay[key] || 0) + e.amount;
  });

  const days = Object.keys(byDay).sort();
  let highestDay = null;
  for (const d of days) {
    if (!highestDay || byDay[d] > highestDay.amount) highestDay = { date: d, amount: byDay[d] };
  }

  let longestStreak = { days: 0, start_date: null, end_date: null };
  if (days.length > 0 && expenses.length > 0) {
    const spendSet = new Set(days);
    const lastDate = String(expenses[expenses.length - 1].date).substring(0, 10);
    const endDate = new Date(`${lastDate}T00:00:00`);
    const startDate = new Date(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1);
    let cursor = new Date(startDate);
    let cur = 0;
    let curStart = null;
    let best = 0;
    let bestStart = null;
    let bestEnd = null;
    while (cursor.getTime() <= endDate.getTime()) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
      if (spendSet.has(key)) {
        if (cur > best) {
          best = cur;
          bestStart = curStart;
          bestEnd = previousDay(cursor);
        }
        cur = 0;
        curStart = null;
      } else {
        if (curStart === null) curStart = key;
        cur += 1;
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    if (cur > best) {
      best = cur;
      bestStart = curStart;
      bestEnd = previousDay(endDate);
    }
    if (best > 0 && bestStart) {
      longestStreak = { days: best, start_date: bestStart, end_date: bestEnd || bestStart };
    }
  }

  return {
    biggest_expense: biggest
      ? {
          description: biggest.description,
          amount: biggest.amount,
          date: biggest.date,
          category: biggest.category_name,
          color_code: biggest.color_code,
        }
      : null,
    highest_spending_day: highestDay,
    longest_no_spend_streak: longestStreak.days > 0 ? longestStreak : null,
  };
}

function previousDay(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---- Flagged expenses -------------------------------------
function computeFlagged(expenses, categorySpend, budgets) {
  if (expenses.length === 0) {
    return { flagged_count: 0, items: [] };
  }

  const catAvg = {};
  const catTotals = {};
  const byCategory = {};
  categorySpend.forEach((c) => {
    catTotals[c.category_name] = c.total_amount;
  });

  expenses.forEach((e) => {
    catAvg[e.category_name] = (catAvg[e.category_name] || 0) + e.amount;
    byCategory[e.category_name] = byCategory[e.category_name] || [];
    byCategory[e.category_name].push(e);
  });
  Object.keys(catAvg).forEach((k) => {
    catAvg[k] = catAvg[k] / byCategory[k].length;
  });

  const budgetMap = {};
  budgets.forEach((b) => {
    budgetMap[b.category_name] = b;
  });

  const flags = [];
  expenses.forEach((e) => {
    const pills = [];
    const avg = catAvg[e.category_name] || 0;
    const categoryMax = byCategory[e.category_name].reduce((m, x) => (x.amount > m.amount ? x : m), { amount: 0 });

    if (avg > 0 && e.amount >= avg * 2) {
      pills.push({ type: 'High Amount', label: 'High Amount' });
    }
    if (avg > 0 && e.amount >= avg * 1.5 && e.amount === categoryMax.amount && e.amount >= 500) {
      pills.push({ type: 'Sudden Spike', label: 'Sudden Spike' });
    }
    const budget = budgetMap[e.category_name];
    if (budget && budget.monthly_limit > 0 && budget.spent / budget.monthly_limit >= 0.7) {
      pills.push({ type: 'Category Overuse', label: 'Category Overuse' });
    }
    if (pills.length > 0) {
      flags.push({ ...e, pills });
    }
  });

  flags.sort((a, b) => b.amount - a.amount);
  return {
    flagged_count: flags.length,
    items: flags.slice(0, 12),
  };
}

module.exports = { getOverview };
