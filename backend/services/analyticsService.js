// ============================================================
// Advanced Analytics Service
// Powers interactive time-range filtering (daily / weekly /
// monthly / yearly), category breakdowns with percentages,
// monthly spending trends and income-vs-expense cash flow.
// ============================================================

const db = require('../config/db');

const RANGE_MAP = {
  daily: "date_trunc('day', t.date)",
  weekly: "date_trunc('week', t.date)",
  monthly: "date_trunc('month', t.date)",
  yearly: "date_trunc('year', t.date)",
};

const RANGE_LABEL_SQL = {
  daily: "TO_CHAR(t.date, 'YYYY-MM-DD')",
  weekly: "TO_CHAR(date_trunc('week', t.date), 'YYYY-MM-DD')",
  monthly: "TO_CHAR(t.date, 'YYYY-MM')",
  yearly: "TO_CHAR(t.date, 'YYYY')",
};

const DEFAULT_COLOR = '#6B7280';
const CHART_PALETTE = [
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateStr(value) {
  if (!DATE_RE.test(String(value || ''))) return false;
  const d = new Date(`${value}T00:00:00`);
  return !isNaN(d.getTime()) && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === value;
}

function lastDayOfMonth(monthYear) {
  const [year, month] = String(monthYear || '').split('-').map((n) => parseInt(n, 10));
  if (!year || !month) return new Date().getDate();
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Pick a sensible trend-bucket granularity for an arbitrary custom range.
function bucketForSpan(from, to) {
  const days = Math.round((new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000) + 1;
  if (days <= 35) return 'daily';
  if (days <= 200) return 'weekly';
  return 'monthly';
}

function resolveRangeParams(query = {}) {
  const requested = query.view_mode || query.range;
  const known = ['daily', 'weekly', 'monthly', 'yearly'];
  let range = known.includes(requested) ? requested : 'monthly';
  const monthYear = query.month_year || new Date().toISOString().substring(0, 7);

  let from = null;
  let to = null;

  // Custom date range (startDate/endDate are the canonical params; from/to kept for backwards compat).
  const startDate = query.startDate || query.from;
  const endDate = query.endDate || query.to;
  if (isValidDateStr(startDate) && isValidDateStr(endDate) && startDate <= endDate) {
    from = startDate;
    to = endDate;
    if (!known.includes(requested)) {
      range = bucketForSpan(from, to);
    }
  } else if (range === 'yearly') {
    const year = query.year || monthYear.substring(0, 4);
    from = `${year}-01-01`;
    to = `${year}-12-31`;
  } else {
    from = `${monthYear}-01`;
    to = `${monthYear}-${String(lastDayOfMonth(monthYear)).padStart(2, '0')}`;
  }

  return { range, monthYear, from, to };
}

// Total income / expense / net for a time range
async function getSummary(userId, query = {}) {
  const { range, from, to } = resolveRangeParams(query);

  const sql = `
    SELECT
      COALESCE(SUM(CASE WHEN t.type = 'income' OR (t.type = 'expense' AND t.is_debit = false) THEN t.amount ELSE 0 END), 0) AS income_so_far,
      COALESCE(SUM(CASE WHEN t.type = 'expense' AND t.is_debit = true THEN t.amount ELSE 0 END), 0) AS expense_so_far,
      COUNT(*)::int AS transaction_count
    FROM transactions t
    WHERE t.user_id = $1 AND t.date >= $2::date AND t.date <= $3::date
  `;
  const result = await db.query(sql, [userId, from, to]);
  const row = result.rows[0] || {};
  const income = parseFloat(row.income_so_far || 0);
  const expense = parseFloat(row.expense_so_far || 0);
  const net = income - expense;
  return {
    range,
    from,
    to,
    income_so_far: income,
    expense_so_far: expense,
    net_so_far: net,
    savings_rate: income > 0 ? ((net / income) * 100).toFixed(2) : '0.00',
    transaction_count: row.transaction_count || 0,
  };
}

// Category breakdown with percentages (for doughnut / bars)
async function getCategoryBreakdown(userId, query = {}) {
  const { range, from, to } = resolveRangeParams(query);
  const params = [userId, from, to];
  const dateClause = ' AND t.date >= $2::date AND t.date <= $3::date';

  const sql = `
    SELECT
      COALESCE(c.name, 'Uncategorized') AS category,
      COALESCE(c.icon_name, 'HelpCircle') AS icon_name,
      COALESCE(c.color_code, '${DEFAULT_COLOR}') AS color_code,
      t.type AS type,
      COALESCE(SUM(t.amount), 0) AS amount
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    WHERE t.user_id = $1${dateClause}
      AND (t.type = 'expense' OR t.type = 'income')
    GROUP BY c.name, c.icon_name, c.color_code, t.type
    ORDER BY amount DESC
  `;
  const result = await db.query(sql, params);

  const rows = result.rows.map((r) => ({
    category: r.category,
    icon_name: r.icon_name,
    color_code: r.color_code || DEFAULT_COLOR,
    type: r.type,
    amount: parseFloat(r.amount || 0),
  }));

  const totalExpense = rows.filter((r) => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
  const totalIncome = rows.filter((r) => r.type === 'income').reduce((s, r) => s + r.amount, 0);

  rows.forEach((r) => {
    const total = r.type === 'expense' ? totalExpense : totalIncome;
    r.percentage = total > 0 ? Number(((r.amount / total) * 100).toFixed(1)) : 0;
    if (r.color_code === DEFAULT_COLOR) {
      r.color_code = CHART_PALETTE[rows.indexOf(r) % CHART_PALETTE.length];
    }
  });

  return {
    range,
    categories: rows,
    total_expense: totalExpense,
    total_income: totalIncome,
  };
}

// Monthly / weekly / daily time series of income vs expense (trend charts)
async function getTrends(userId, query = {}) {
  const { range, from, to } = resolveRangeParams(query);
  const labelSql = RANGE_LABEL_SQL[range] || RANGE_LABEL_SQL.monthly;

  const params = [userId, from, to];
  const dateClause = ' AND t.date >= $2::date AND t.date <= $3::date';

  const sql = `
    SELECT
      ${labelSql} AS bucket,
      COALESCE(SUM(CASE WHEN t.type = 'income' OR (t.type = 'expense' AND t.is_debit = false) THEN t.amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN t.type = 'expense' AND t.is_debit = true THEN t.amount ELSE 0 END), 0) AS expense
    FROM transactions t
    WHERE t.user_id = $1${dateClause}
    GROUP BY bucket
    ORDER BY bucket ASC
  `;
  const result = await db.query(sql, params);

  return {
    range,
    from,
    to,
    trend: result.rows.map((r) => ({
      bucket: r.bucket,
      income: parseFloat(r.income || 0),
      expense: parseFloat(r.expense || 0),
      net: parseFloat(r.income || 0) - parseFloat(r.expense || 0),
    })),
  };
}

// Cash flow ratio summary (income vs expense + health)
async function getCashFlow(userId, query = {}) {
  const summary = await getSummary(userId, query);
  const ratio =
    summary.income_so_far > 0
      ? Number((summary.expense_so_far / summary.income_so_far).toFixed(2))
      : summary.expense_so_far > 0
        ? 999
        : 0;

  return {
    ...summary,
    cashflow_ratio: ratio,
    cashflow_status: ratio <= 0.5 ? 'Excellent' : ratio <= 0.8 ? 'Good' : ratio <= 1 ? 'Watch' : 'Critical',
  };
}

// Recurring subscription detector (amount + description pattern)
async function detectSubscriptions(userId) {
  const sql = `
    SELECT description, amount, COUNT(*) AS occurrences,
           MIN(date)::date AS first_seen,
           MAX(date)::date AS last_seen
    FROM transactions
    WHERE user_id = $1 AND is_debit = true AND type = 'expense'
    GROUP BY LOWER(description), amount, description
    HAVING COUNT(*) >= 2
    ORDER BY COUNT(*) DESC
    LIMIT 20
  `;
  const result = await db.query(sql, [userId]);
  return result.rows.map((r) => ({
    description: r.description,
    amount: parseFloat(r.amount),
    occurrences: parseInt(r.occurrences, 10),
    first_seen: r.first_seen,
    last_seen: r.last_seen,
  }));
}

// Spending spike detection vs previous equivalent window
async function detectSpendingSpikes(userId, query = {}) {
  const current = await getSummary(userId, query);

  let prevQuery;
  if (query.startDate && query.endDate) {
    // Compare an arbitrary custom range to the same-length window right before it.
    const startMs = new Date(`${query.startDate}T00:00:00`).getTime();
    const spanMs = new Date(`${query.endDate}T00:00:00`).getTime() - startMs;
    const prevEnd = new Date(startMs - 86400000);
    const prevStart = new Date(prevEnd.getTime() - spanMs);
    prevQuery = {
      startDate: prevStart.toISOString().substring(0, 10),
      endDate: prevEnd.toISOString().substring(0, 10),
    };
  } else {
    const monthYear = query.month_year || new Date().toISOString().substring(0, 7);
    const [year, month] = monthYear.split('-');
    prevQuery = {
      month_year: new Date(Date.UTC(parseInt(year, 10), parseInt(month, 10) - 2, 1)).toISOString().substring(0, 7),
    };
  }
  const prev = await getSummary(userId, prevQuery);

  const spikes = [];
  if (prev.expense_so_far > 0 && current.expense_so_far > prev.expense_so_far) {
    const pct = ((current.expense_so_far - prev.expense_so_far) / prev.expense_so_far) * 100;
    if (pct >= 20) {
      spikes.push({
        type: 'spending_spike',
        title: 'Spending Spike Detected',
        message: `You spent ₹${current.expense_so_far.toFixed(2)} in the selected period — ${pct.toFixed(0)}% more than the previous period (₹${prev.expense_so_far.toFixed(2)}).`,
        severity: pct >= 50 ? 'high' : 'medium',
      });
    }
  }
  return spikes;
}

module.exports = {
  getSummary,
  getCategoryBreakdown,
  getTrends,
  getCashFlow,
  detectSubscriptions,
  detectSpendingSpikes,
  resolveRangeParams,
  RANGE_MAP,
  CHART_PALETTE,
};
