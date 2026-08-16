const db = require('../config/db');
const { invalidateUserCache } = require('../services/cacheService');
const analytics = require('../services/analyticsService');

const toInt = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
};
const toFloat = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
};

const DEFAULT_ACCOUNTS = [
  { name: 'Cash', type: 'Cash', color_code: '#84cc16', icon_name: 'Wallet' },
  { name: 'Card', type: 'Card', color_code: '#ef4444', icon_name: 'CreditCard' },
  { name: 'Savings', type: 'Savings', color_code: '#ec4899', icon_name: 'PiggyBank' },
];

const getAccounts = async (req, res) => {
  try {
    const userId = req.user.id;
    const { from, to } = analytics.resolveRangeParams(req.query);

    let accountRes = await db.query('SELECT * FROM accounts WHERE user_id = $1 ORDER BY id ASC', [userId]);

    if (accountRes.rows.length === 0) {
      for (const acc of DEFAULT_ACCOUNTS) {
        await db.query(
          'INSERT INTO accounts (user_id, name, type, balance, color_code, icon_name) VALUES ($1, $2, $3, $4, $5, $6)',
          [userId, acc.name, acc.type, 0.0, acc.color_code, acc.icon_name]
        );
      }
      accountRes = await db.query('SELECT * FROM accounts WHERE user_id = $1 ORDER BY id ASC', [userId]);
    }

    const totalsQuery = `
      SELECT
        COALESCE(SUM(CASE WHEN t.type = 'income' OR (t.type = 'expense' AND t.is_debit = false) THEN t.amount ELSE 0 END), 0) AS income_so_far,
        COALESCE(SUM(CASE WHEN t.type = 'expense' AND t.is_debit = true THEN t.amount ELSE 0 END), 0) AS expense_so_far
      FROM transactions t
      WHERE t.user_id = $1 AND t.date >= $2::date AND t.date <= $3::date
    `;
    const totalsRes = await db.query(totalsQuery, [userId, from, to]);

    const totalBalance = accountRes.rows.reduce((acc, a) => acc + toFloat(a.balance), 0);

    return res.json({
      accounts: accountRes.rows,
      summary: {
        all_accounts_balance: totalBalance,
        expense_so_far: toFloat(totalsRes.rows[0]?.expense_so_far),
        income_so_far: toFloat(totalsRes.rows[0]?.income_so_far),
      },
    });
  } catch (error) {
    console.error('Get Accounts Error:', error);
    return res.status(500).json({ error: 'Failed to fetch accounts.' });
  }
};

const createAccount = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, type = 'Savings', balance = 0.0, color_code = '#3b82f6', icon_name = 'Wallet' } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Account name is required.' });
    }

    const result = await db.query(
      'INSERT INTO accounts (user_id, name, type, balance, color_code, icon_name) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [userId, String(name).trim(), type, toFloat(balance), color_code, icon_name]
    );

    await invalidateUserCache(userId);
    return res.status(201).json({ account: result.rows[0] });
  } catch (error) {
    console.error('Create Account Error:', error);
    return res.status(500).json({ error: 'Failed to create account.' });
  }
};

const updateAccount = async (req, res) => {
  try {
    const userId = req.user.id;
    const accId = toInt(req.params.id);
    if (!accId) return res.status(400).json({ error: 'Invalid account id.' });

    const existing = await db.query('SELECT * FROM accounts WHERE id = $1 AND user_id = $2', [accId, userId]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Account not found.' });

    const body = req.body || {};
    const name = body.name !== undefined && String(body.name).trim() ? String(body.name).trim() : existing.rows[0].name;
    const type = body.type || existing.rows[0].type;
    const balance =
      body.balance !== undefined && body.balance !== '' ? toFloat(body.balance) : toFloat(existing.rows[0].balance);
    const color_code = body.color_code || existing.rows[0].color_code;
    const icon_name = body.icon_name || existing.rows[0].icon_name;

    const result = await db.query(
      'UPDATE accounts SET name = $1, type = $2, balance = $3, color_code = $4, icon_name = $5 WHERE id = $6 AND user_id = $7 RETURNING *',
      [name, type, balance, color_code, icon_name, accId, userId]
    );

    await invalidateUserCache(userId);
    return res.json({ account: result.rows[0] });
  } catch (error) {
    console.error('Update Account Error:', error);
    return res.status(500).json({ error: 'Failed to update account.' });
  }
};

const deleteAccount = async (req, res) => {
  try {
    const userId = req.user.id;
    const accId = toInt(req.params.id);
    if (!accId) return res.status(400).json({ error: 'Invalid account id.' });

    const existing = await db.query('SELECT * FROM accounts WHERE id = $1 AND user_id = $2', [accId, userId]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Account not found.' });

    await db.query('DELETE FROM accounts WHERE id = $1 AND user_id = $2', [accId, userId]);
    await invalidateUserCache(userId);
    return res.json({ message: 'Account deleted.' });
  } catch (error) {
    console.error('Delete Account Error:', error);
    return res.status(500).json({ error: 'Failed to delete account.' });
  }
};

module.exports = {
  getAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
};
