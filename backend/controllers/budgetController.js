const db = require('../config/db');
const { invalidateUserCache } = require('../services/cacheService');

const toInt = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
};
const toFloat = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
};

const getBudgets = async (req, res) => {
  try {
    const userId = req.user.id;
    const monthYear = req.query.month_year || new Date().toISOString().substring(0, 7);
    const carryOver = String(req.query.carry_over || 'false').toLowerCase() === 'true';

    // Resolve previous month for carry-over math
    const [y, m] = monthYear.split('-').map((n) => parseInt(n, 10));
    const prevMonth = new Date(Date.UTC(y, m - 2, 1)).toISOString().substring(0, 7);

    const query = `
      SELECT
        c.id as category_id,
        c.name as category_name,
        c.icon_name,
        c.color_code,
        b.id as budget_id,
        COALESCE(b.monthly_limit, 0) as limit_amount,
        COALESCE(SUM(t.amount), 0) as total_spent
      FROM categories c
      LEFT JOIN budgets b ON b.category_id = c.id AND b.user_id = $1 AND b.month_year = $2
      LEFT JOIN transactions t ON t.category_id = c.id AND t.user_id = $1 AND TO_CHAR(t.date, 'YYYY-MM') = $2
        AND t.type = 'expense' AND t.is_debit = true
       WHERE c.type = 'expense'
       GROUP BY c.id, c.name, c.icon_name, c.color_code, b.id, b.monthly_limit
      ORDER BY b.monthly_limit DESC, c.name ASC
    `;
    const result = await db.query(query, [userId, monthYear]);

    // Previous-month surplus lookup (only when carry-over toggle is on)
    let carryMap = {};
    if (carryOver) {
      const prevQuery = `
        SELECT b.category_id,
               b.monthly_limit,
               COALESCE(SUM(t.amount), 0) AS spent
        FROM budgets b
         LEFT JOIN transactions t ON t.category_id = b.category_id
           AND t.user_id = b.user_id AND TO_CHAR(t.date, 'YYYY-MM') = $2
           AND t.type = 'expense' AND t.is_debit = true
         WHERE b.user_id = $1 AND b.month_year = $2
        GROUP BY b.category_id, b.monthly_limit
      `;
      const prevRes = await db.query(prevQuery, [userId, prevMonth]);
      prevRes.rows.forEach((r) => {
        const surplus = Math.max(0, toFloat(r.monthly_limit) - toFloat(r.spent));
        carryMap[r.category_id] = surplus;
      });
    }

    const budgets = result.rows.map((b) => {
      const limit = toFloat(b.limit_amount);
      const carried = carryOver ? toFloat(carryMap[b.category_id] || 0) : 0;
      const effectiveLimit = limit + carried;
      return {
        ...b,
        limit_amount: limit,
        carried_over: carried,
        effective_limit: effectiveLimit,
        total_spent: toFloat(b.total_spent),
        usage_percent:
          effectiveLimit > 0 ? Math.min(999, Math.round((toFloat(b.total_spent) / effectiveLimit) * 100)) : 0,
      };
    });

    return res.json({ budgets });
  } catch (error) {
    console.error('Get Budgets Error:', error);
    return res.status(500).json({ error: 'Failed to fetch budgets.' });
  }
};

const createBudget = async (req, res) => {
  try {
    const userId = req.user.id;
    const { category_id, limit_amount, month_year } = req.body || {};
    const categoryId = toInt(category_id);
    const targetMonth = month_year || new Date().toISOString().substring(0, 7);

    if (!categoryId || toFloat(limit_amount) <= 0) {
      return res.status(400).json({ error: 'A valid category and positive limit are required.' });
    }

    const query = `
      INSERT INTO budgets (user_id, category_id, monthly_limit, month_year)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, category_id, month_year)
      DO UPDATE SET monthly_limit = EXCLUDED.monthly_limit
      RETURNING *
    `;
    const result = await db.query(query, [userId, categoryId, toFloat(limit_amount), targetMonth]);
    await invalidateUserCache(userId);
    return res.status(201).json({ budget: result.rows[0] });
  } catch (error) {
    console.error('Create Budget Error:', error);
    return res.status(500).json({ error: 'Failed to save budget.' });
  }
};

const updateBudget = async (req, res) => {
  try {
    const userId = req.user.id;
    const budgetId = toInt(req.params.id);
    if (!budgetId) {
      return res.status(400).json({ error: 'Invalid budget id.' });
    }

    const limit = toFloat(req.body && req.body.limit_amount);
    if (limit <= 0) {
      return res.status(400).json({ error: 'Budget limit must be a positive number.' });
    }

    const result = await db.query('UPDATE budgets SET monthly_limit = $1 WHERE id = $2 AND user_id = $3 RETURNING *', [
      limit,
      budgetId,
      userId,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Budget not found.' });
    }

    await invalidateUserCache(userId);
    return res.json({ message: 'Budget updated.', budget: result.rows[0] });
  } catch (error) {
    console.error('Update Budget Error:', error);
    return res.status(500).json({ error: 'Failed to update budget.' });
  }
};

const deleteBudget = async (req, res) => {
  try {
    const userId = req.user.id;
    const budgetId = toInt(req.params.id);
    if (!budgetId) {
      return res.status(400).json({ error: 'Invalid budget id.' });
    }

    const result = await db.query('DELETE FROM budgets WHERE id = $1 AND user_id = $2 RETURNING id', [
      budgetId,
      userId,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Budget not found.' });
    }

    await invalidateUserCache(userId);
    return res.json({ message: 'Budget removed.' });
  } catch (error) {
    console.error('Delete Budget Error:', error);
    return res.status(500).json({ error: 'Failed to remove budget.' });
  }
};

const copyPastBudgets = async (req, res) => {
  try {
    const userId = req.user.id;
    const targetMonth = req.body?.target_month || new Date().toISOString().substring(0, 7);

    const pastMonthQuery = `
      SELECT DISTINCT month_year FROM budgets
      WHERE user_id = $1 AND month_year < $2
      ORDER BY month_year DESC LIMIT 1
    `;
    const pastRes = await db.query(pastMonthQuery, [userId, targetMonth]);

    if (pastRes.rows.length === 0) {
      return res.status(404).json({ error: 'No past budget records found to copy from.' });
    }

    const sourceMonth = pastRes.rows[0].month_year;

    const copyQuery = `
      INSERT INTO budgets (user_id, category_id, monthly_limit, month_year)
      SELECT user_id, category_id, monthly_limit, $1
      FROM budgets
      WHERE user_id = $2 AND month_year = $3
      ON CONFLICT (user_id, category_id, month_year)
      DO UPDATE SET monthly_limit = EXCLUDED.monthly_limit
    `;
    await db.query(copyQuery, [targetMonth, userId, sourceMonth]);
    await invalidateUserCache(userId);

    return res.json({ message: `Successfully copied budget limits from ${sourceMonth}.` });
  } catch (error) {
    console.error('Copy Past Budgets Error:', error);
    return res.status(500).json({ error: 'Failed to copy budgets from past months.' });
  }
};

// Carry-over preference persisted on the users row
const getCarryOver = async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await db.query('SELECT carry_over FROM users WHERE id = $1', [userId]);
    return res.json({ carry_over: !!(result.rows[0] && result.rows[0].carry_over) });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to load preference.' });
  }
};

const setCarryOver = async (req, res) => {
  try {
    const userId = req.user.id;
    const enabled = !!(req.body && req.body.carry_over);
    await db.query('UPDATE users SET carry_over = $1 WHERE id = $2', [enabled, userId]);
    return res.json({ carry_over: enabled });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to save preference.' });
  }
};

module.exports = {
  getBudgets,
  createBudget,
  updateBudget,
  deleteBudget,
  copyPastBudgets,
  getCarryOver,
  setCarryOver,
};
