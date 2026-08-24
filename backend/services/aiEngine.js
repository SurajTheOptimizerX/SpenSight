// ============================================================
// Cleo AI Engine
// Live database-driven financial insights, health scoring and
// a streaming conversational assistant. Falls back to a fully
// local data engine when no OpenAI key is configured, so the
// app works out of the box in Docker.
// ============================================================

const db = require('../config/db');
const analytics = require('./analyticsService');

const CURRENCY = process.env.CURRENCY_SYMBOL || '₹';

/**
 * Calculates dynamic 0-100 Financial Health Score for a user in a given YYYY-MM.
 * Optionally accepts a custom { startDate, endDate } (YYYY-MM-DD) window to score.
 */
exports.calculateHealthScore = async (userId, monthYear, range = {}) => {
  try {
    const { startDate, endDate } = range;
    const useRange = Boolean(startDate && endDate);

    const totalsQuery = `
      SELECT
        COALESCE(SUM(CASE WHEN c.type = 'income' THEN t.amount ELSE 0 END), 0) AS total_income,
        COALESCE(SUM(CASE WHEN c.type = 'expense' THEN t.amount ELSE 0 END), 0) AS total_expense
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.user_id = $1 AND t.type != 'transfer'
        AND ${useRange ? 't.date >= $2::date AND t.date <= $3::date' : "TO_CHAR(t.date, 'YYYY-MM') = $2"}
    `;
    const totalsParams = useRange ? [userId, startDate, endDate] : [userId, monthYear];
    const totalsRes = await db.query(totalsQuery, totalsParams);
    const totalIncome = parseFloat(totalsRes.rows[0].total_income || 0);
    const totalExpense = parseFloat(totalsRes.rows[0].total_expense || 0);

    const balanceQuery = `
      SELECT COALESCE(SUM(balance), 0) AS total_balance
      FROM accounts
      WHERE user_id = $1
    `;
    const balanceRes = await db.query(balanceQuery, [userId]);
    const totalBalance = parseFloat(balanceRes.rows[0].total_balance || 0);

    // No-data guard: the user has no income, no expenses and no account
    // balance for the period, so a fabricated score (e.g. 45/100 WARNING)
    // would be misleading. Surface a neutral "No Data" state instead.
    if (totalIncome === 0 && totalExpense === 0 && totalBalance === 0) {
      // Self-heal any stale summary row left by the pre-guard code so the
      // persisted state matches the neutral response we are about to return.
      await db.query('DELETE FROM financial_health_summary WHERE user_id = $1 AND month_year = $2', [userId, monthYear]);

      return {
        score: null,
        label: 'No Data',
        status: 'NEUTRAL',
        // Aliases so existing consumers reading DB-shaped fields stay safe.
        health_score: null,
        savings_rate: 0,
        overall_status: 'NEUTRAL',
        totalIncome,
        totalExpense,
        totalBalance,
      };
    }

    const budgetQuery = `
      SELECT
        b.monthly_limit AS limit_amount,
        COALESCE(SUM(CASE WHEN t.type = 'expense' AND t.is_debit = true THEN t.amount ELSE 0 END), 0) AS actual_spend
      FROM budgets b
      LEFT JOIN transactions t ON b.category_id = t.category_id
        AND t.user_id = b.user_id
        AND TO_CHAR(t.date, 'YYYY-MM') = $2
        AND t.type = 'expense' AND t.is_debit = true
      WHERE b.user_id = $1 AND b.month_year = $3
      GROUP BY b.id, b.monthly_limit
    `;
    const budgetRes = await db.query(budgetQuery, [userId, monthYear, monthYear]);
    const budgets = budgetRes.rows;

    let score = 0;
    let savingsRate = 0;

    if (totalIncome > 0) {
      savingsRate = ((totalIncome - totalExpense) / totalIncome) * 100;
      if (savingsRate >= 30) score += 40;
      else if (savingsRate >= 20) score += 30;
      else if (savingsRate >= 10) score += 20;
      else if (savingsRate > 0) score += 10;
    } else if (totalExpense === 0) {
      score += 20;
    }

    if (budgets.length > 0) {
      const nonOverbudgetCount = budgets.filter((b) => parseFloat(b.actual_spend) <= parseFloat(b.limit_amount)).length;
      score += Math.round((nonOverbudgetCount / budgets.length) * 40);
    } else {
      score += 25;
    }

    if (totalIncome > 0 && totalExpense <= totalIncome * 0.7) {
      score += 20;
    } else if (totalIncome > 0 && totalExpense <= totalIncome) {
      score += 10;
    }

    score = Math.min(100, Math.max(0, Math.round(score)));

    let status = 'Healthy';
    if (score < 40) status = 'Critical';
    else if (score < 70) status = 'Warning';

    const upsertHealthQuery = `
      INSERT INTO financial_health_summary (user_id, health_score, savings_rate, month_year, overall_status)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, month_year) DO UPDATE
      SET health_score = EXCLUDED.health_score,
          savings_rate = EXCLUDED.savings_rate,
          overall_status = EXCLUDED.overall_status,
          calculated_at = CURRENT_TIMESTAMP
      RETURNING *
    `;
    const healthRes = await db.query(upsertHealthQuery, [userId, score, savingsRate.toFixed(2), monthYear, status]);

    const saved = healthRes.rows[0];
    return {
      ...saved,
      score: saved.health_score === null || saved.health_score === undefined ? null : Number(saved.health_score),
      label: null,
      status: saved.overall_status || 'Healthy',
      totalIncome,
      totalExpense,
      totalBalance,
    };
  } catch (error) {
    console.error('Calculate Health Score Error:', error);
    throw error;
  }
};

/**
 * Scans transactions & budgets for dynamic alerts:
 *  - Budget threshold warnings (>80% and >100%)
 *  - Recurring subscription detection
 *  - Month-over-month spending spikes
 * Optionally accepts a { startDate, endDate } window to scope the budget scan.
 */
exports.generateAIInsights = async (userId, monthYear, range = {}) => {
  const { startDate, endDate } = range;
  const useRange = Boolean(startDate && endDate);
  const insightsCreated = [];

  const insertInsight = async ({ type, title, message, severity }) => {
    const dupCheck = await db.query('SELECT id FROM ai_insights WHERE user_id = $1 AND title = $2 AND message = $3', [
      userId,
      title,
      message,
    ]);
    if (dupCheck.rows.length === 0) {
      await db.query('INSERT INTO ai_insights (user_id, type, title, message, severity) VALUES ($1, $2, $3, $4, $5)', [
        userId,
        type,
        title,
        message,
        severity,
      ]);
      insightsCreated.push({ title, severity, type });
    }
  };

  // 1. Budget threshold warnings
  const txnDateFilter = useRange
    ? 't.date >= $3::date AND t.date <= $4::date'
    : "TO_CHAR(t.date, 'YYYY-MM') = $3";
  const overbudgetParams = useRange
    ? [userId, monthYear, startDate, endDate]
    : [userId, monthYear, monthYear];
  const overbudgetQuery = `
    SELECT
      c.name AS category_name,
      b.monthly_limit AS limit_amount,
      COALESCE(SUM(CASE WHEN t.type = 'expense' AND t.is_debit = true THEN t.amount ELSE 0 END), 0) AS total_spent
    FROM budgets b
    JOIN categories c ON b.category_id = c.id
    LEFT JOIN transactions t ON b.category_id = t.category_id
      AND t.user_id = b.user_id
      AND t.type = 'expense' AND t.is_debit = true
      AND ${txnDateFilter}
    WHERE b.user_id = $1 AND b.month_year = $2
    GROUP BY c.name, b.monthly_limit
  `;
  const overbudgetRes = await db.query(overbudgetQuery, overbudgetParams);

  for (const row of overbudgetRes.rows) {
    const limit = parseFloat(row.limit_amount);
    const spent = parseFloat(row.total_spent);
    const pctUsed = limit > 0 ? Math.round((spent / limit) * 100) : 0;

    if (pctUsed >= 100) {
      await insertInsight({
        type: 'budget_alert',
        title: `Budget Exceeded: ${row.category_name}`,
        message: `You have spent ${pctUsed}% (${CURRENCY}${spent.toFixed(2)}) of your ${CURRENCY}${limit.toFixed(2)} limit for ${row.category_name} this month.`,
        severity: 'high',
      });
    } else if (pctUsed >= 80) {
      await insertInsight({
        type: 'budget_alert',
        title: `Budget Warning: ${row.category_name}`,
        message: `You have used ${pctUsed}% (${CURRENCY}${spent.toFixed(2)}) of your ${CURRENCY}${limit.toFixed(2)} monthly allowance for ${row.category_name}.`,
        severity: 'medium',
      });
    }
  }

  // 2. Recurring subscriptions
  const subs = await analytics.detectSubscriptions(userId);
  for (const sub of subs.slice(0, 5)) {
    await insertInsight({
      type: 'recurring_flag',
      title: `Recurring Expense: ${sub.description}`,
      message: `"${sub.description}" (${CURRENCY}${sub.amount.toFixed(2)}) charged ${sub.occurrences} times since ${sub.first_seen}. Consider reviewing if you still use it.`,
      severity: sub.occurrences >= 4 ? 'medium' : 'low',
    });
  }

  // 3. Spending spike vs previous window
  const spikes = useRange
    ? await analytics.detectSpendingSpikes(userId, { startDate, endDate })
    : await analytics.detectSpendingSpikes(userId, { month_year: monthYear });
  for (const spike of spikes) {
    await insertInsight(spike);
  }

  return insightsCreated;
};

/**
 * Streaming reply generator. If a valid OPENAI_API_KEY is present
 * the OpenAI streaming client is used; otherwise a local data-aware
 * engine streams a relevant answer computed from live DB records.
 */
exports.streamChatReply = async ({ userId, prompt, res }) => {
  const text = String(prompt || '').toLowerCase();

  const write = (chunk) => {
    res.write(`data: ${JSON.stringify({ token: chunk })}\n\n`);
    if (res.flush) res.flush();
  };

  const finish = () => {
    res.write('data: [DONE]\n\n');
    res.end();
  };

  // Optional OpenAI streaming path
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey && apiKey !== 'your_openai_api_key_here') {
    try {
      const { default: OpenAI } = require('openai');
      const client = new OpenAI({ apiKey });

      const context = await buildLiveContext(userId);
      const stream = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        stream: true,
        temperature: 0.7,
        messages: [
          {
            role: 'system',
            content:
              'You are Cleo, a witty but kind AI financial copilot. Use the live financial context provided to give concise, actionable advice. Roast gently when asked, but always stay helpful.',
          },
          { role: 'user', content: `${context}\n\nUser question: ${prompt}` },
        ],
      });

      for await (const part of stream) {
        const token = part.choices[0]?.delta?.content || '';
        if (token) write(token);
      }
      finish();
      return;
    } catch (err) {
      console.error('OpenAI stream failed, falling back to local engine:', err.message);
    }
  }

  // Local data-driven streaming engine
  try {
    const summary = await analytics.getSummary(userId, { month_year: currentMonth() });
    const breakdown = await analytics.getCategoryBreakdown(userId, { month_year: currentMonth() });
    const subs = await analytics.detectSubscriptions(userId);
    const budgets = await fetchBudgets(userId, currentMonth());

    const sentences = composeReply(text, { summary, breakdown, subs, budgets });
    for (const sentence of sentences) {
      write(sentence + ' ');
    }
    finish();
  } catch (error) {
    console.error('Local Cleo reply error:', error);
    write('I ran into a hiccup reading your finances. Try again in a moment.');
    finish();
  }
};

function currentMonth() {
  return new Date().toISOString().substring(0, 7);
}

async function buildLiveContext(userId) {
  const summary = await analytics.getSummary(userId, { month_year: currentMonth() });
  const breakdown = await analytics.getCategoryBreakdown(userId, { month_year: currentMonth() });
  const subs = await analytics.detectSubscriptions(userId);
  const topCategories = breakdown.categories
    .filter((c) => c.type === 'expense')
    .slice(0, 5)
    .map((c) => `${c.category}: ${CURRENCY}${c.amount.toFixed(2)} (${c.percentage}%)`)
    .join('; ');
  return `LIVE FINANCIAL CONTEXT\n- Income: ${CURRENCY}${summary.income_so_far.toFixed(2)}\n- Expenses: ${CURRENCY}${summary.expense_so_far.toFixed(2)}\n- Net: ${CURRENCY}${summary.net_so_far.toFixed(2)}\n- Top expense categories: ${topCategories || 'none'}\n- Recurring subs: ${
    subs
      .slice(0, 5)
      .map((s) => `${s.description} (${CURRENCY}${s.amount.toFixed(2)} x${s.occurrences})`)
      .join(', ') || 'none'
  }`;
}

async function fetchBudgets(userId, monthYear) {
  const res = await db.query(
    `
    SELECT
      c.name AS category_name,
      COALESCE(b.monthly_limit, 0) AS limit_amount,
      COALESCE(SUM(CASE WHEN t.type = 'expense' AND t.is_debit = true THEN t.amount ELSE 0 END), 0) AS total_spent
    FROM budgets b
    JOIN categories c ON b.category_id = c.id
    LEFT JOIN transactions t ON b.category_id = t.category_id
      AND t.user_id = b.user_id AND TO_CHAR(t.date, 'YYYY-MM') = $2
      AND t.type = 'expense' AND t.is_debit = true
    WHERE b.user_id = $1 AND b.month_year = $3
    GROUP BY c.name, b.monthly_limit
  `,
    [userId, monthYear, monthYear]
  );
  return res.rows;
}

function composeReply(text, { summary, breakdown, subs, budgets }) {
  const fmt = (n) => `${CURRENCY}${n.toFixed(2)}`;
  const topExpense = breakdown.categories.filter((c) => c.type === 'expense').slice(0, 3);

  if (text.includes('roast') || text.includes('burn') || text.includes('joke')) {
    const roastTarget = topExpense[0];
    if (roastTarget) {
      return [
        'Oh honey, let me take a look at this. ',
        `You dropped ${fmt(roastTarget.amount)} on ${roastTarget.category} — that is ${roastTarget.percentage}% of everything you spent this month. `,
        topExpense.length > 1
          ? `And ${topExpense[1].category} was right behind it with ${fmt(topExpense[1].amount)}. `
          : '',
        'I am not judging. I am just saying your credit card might be trying to file a restraining order. ',
        'Fix it by setting a category budget and I will make sure you stay in line. Promise.',
      ].filter(Boolean);
    }
    return ['You have no spending to roast yet — which honestly is the flex of the year. Keep it up!'];
  }

  if (text.includes('subscription') || text.includes('recurring')) {
    if (subs.length === 0) {
      return [
        'Good news: I could not find any recurring subscriptions. Your accounts are squeaky clean.',
        'Keep an eye on any charge that shows up month after month though.',
      ];
    }
    const names = subs
      .slice(0, 4)
      .map((s) => `${s.description} (${fmt(s.amount)} x${s.occurrences})`)
      .join(', ');
    const total = subs.reduce((sum, s) => sum + s.amount, 0);
    return [
      `I found ${subs.length} recurring subscription(s): ${names}. `,
      `They are eating roughly ${fmt(total)} per cycle. `,
      `Cancel any you do not use — that money could go straight into savings.`,
    ];
  }

  if (text.includes('budget') || text.includes('track') || text.includes('limit')) {
    if (budgets.length === 0) {
      return [
        'You have not set any category budgets yet. ',
        'Head to the Budgets view and set limits, then I can actually tell you whether you are on track.',
      ];
    }
    const over = budgets.filter((b) => parseFloat(b.total_spent) > parseFloat(b.limit_amount));
    const near = budgets.filter(
      (b) =>
        parseFloat(b.total_spent) <= parseFloat(b.limit_amount) &&
        parseFloat(b.total_spent) >= parseFloat(b.limit_amount) * 0.8
    );
    const parts = [];
    if (over.length) parts.push(`You are over budget on ${over.map((b) => b.category_name).join(', ')}. `);
    if (near.length) parts.push(`${near.map((b) => b.category_name).join(', ')} are getting close to their limits. `);
    if (!over.length && !near.length)
      parts.push('Great news — you are comfortably within all of your category budgets. ');
    parts.push('I would trim the over-budget categories first and reallocate before month end.');
    return parts;
  }

  if (text.includes('health') || text.includes('score') || text.includes('how am i')) {
    const rate = parseFloat(summary.savings_rate);
    const verdict = rate >= 20 ? 'excellent' : rate >= 10 ? 'decent' : rate >= 0 ? 'tight' : 'concerning';
    return [
      `Your net this month is ${fmt(summary.net_so_far)} with a savings rate of ${rate.toFixed(1)}%. `,
      `That is a ${verdict} position. `,
      rate >= 10
        ? 'Keep pushing — a 20% savings rate is the golden target.'
        : `Aim to keep expenses under 80% of income to build a healthier buffer.`,
    ];
  }

  if (text.includes('spike') || text.includes('anomal') || text.includes('alert')) {
    const spike = topExpense[0];
    if (spike && spike.percentage >= 30) {
      return [
        `Heads up: ${spike.category} is ${spike.percentage}% of your spending — that is a concentration worth watching.`,
        'Set a budget on it and I will alert you the moment it approaches the line.',
      ];
    }
    return [
      'I scanned your numbers for anomalies — nothing screaming at me right now. ',
      'I will ping you the second something looks off.',
    ];
  }

  // Default general analysis
  const parts = [
    `Here is your snapshot: income ${fmt(summary.income_so_far)}, expenses ${fmt(summary.expense_so_far)}, net ${fmt(summary.net_so_far)}. `,
  ];
  if (topExpense.length) {
    parts.push(`Your top category is ${topExpense[0].category} at ${fmt(topExpense[0].amount)}. `);
  }
  parts.push('You can ask me to roast your spending, check budgets, list subscriptions, or give you a health score.');
  return parts;
}
