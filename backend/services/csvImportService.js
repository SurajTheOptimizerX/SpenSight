// ============================================================
// CSV Import Service
// Single shared pipeline for parsing, auto-categorizing and
// persisting bank statement rows. Used synchronously by the
// /upload-csv endpoint (returns count + category ids) and by
// the background BullMQ worker.
// ============================================================

const db = require('../config/db');
const { parseBankCSV } = require('../utils/csvParser');
const { classifyTransaction } = require('./categorizationService');
const { invalidateUserCache } = require('./cacheService');

// Resolve a category id by name. Tries an exact case-insensitive match
// first, then a fuzzy substring match, and only falls back to
// 'Uncategorized' when nothing matches. Never returns auto-generated /
// dummy categories (e.g. "EdgeCat161514").
async function categoryIdByName(name) {
  const clean = String(name || '').trim();
  const uncategorized = async () => {
    const fb = await db.query("SELECT id FROM categories WHERE name = 'Uncategorized' LIMIT 1");
    return fb.rows.length > 0 ? fb.rows[0].id : null;
  };
  if (!clean) return uncategorized();

  let res = await db.query(
    "SELECT id FROM categories WHERE LOWER(name) = LOWER($1) AND name NOT LIKE 'EdgeCat%' LIMIT 1",
    [clean]
  );
  if (res.rows.length === 0) {
    res = await db.query(
      "SELECT id FROM categories WHERE name ILIKE '%' || $1 || '%' AND name NOT LIKE 'EdgeCat%' LIMIT 1",
      [clean]
    );
  }
  if (res.rows.length > 0) return res.rows[0].id;
  return uncategorized();
}

/**
 * Delete every transaction previously imported from a CSV statement
 * (source = 'csv_import') for a user, reversing the balance impact per
 * account so manual transactions are never touched.
 * @returns {Promise<number>} number of deleted rows
 */
async function removeImportedForUser(userId) {
  await db.query(
    `
    UPDATE accounts a SET balance = a.balance - sub.net
    FROM (
      SELECT account_id,
             SUM(CASE WHEN is_debit THEN -amount ELSE amount END) AS net
      FROM transactions
      WHERE user_id = $1 AND source = 'csv_import' AND account_id IS NOT NULL
      GROUP BY account_id
    ) sub
    WHERE a.id = sub.account_id AND a.user_id = $1
  `,
    [userId]
  );

  const res = await db.query("DELETE FROM transactions WHERE user_id = $1 AND source = 'csv_import'", [userId]);
  return res.rowCount || 0;
}

/**
 * Build a dedupe key set of (date, description, amount) for a user's
 * existing transactions so merge-mode imports can skip exact matches.
 * @returns {Promise<Set<string>>}
 */
async function existingTransactionKeys(userId) {
  const res = await db.query(
    `
    SELECT DATE(date) AS d, LOWER(BTRIM(description)) AS descr, amount::numeric
    FROM transactions
    WHERE user_id = $1
  `,
    [userId]
  );

  const set = new Set();
  for (const r of res.rows) {
    set.add(`${formatDateKey(r.d)}|${r.descr}|${Number(r.amount)}`);
  }
  return set;
}

// 'YYYY-MM-DD' for Date objects and ISO strings alike (avoid TZ shifts)
function formatDateKey(value) {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).substring(0, 10);
}

/**
 * Parse a CSV statement, auto-categorize every row (merchant
 * keyword matching) and persist the transactions to Postgres.
 * @param {number} userId
 * @param {string} filePath - path to the uploaded CSV
 * @param {string} [mode] - 'replace' wipes previous CSV imports first;
 *                          'merge' (default) skips rows that already exist.
 * @returns {Promise<{count: number, skipped: number, malformed: number, categoryIds: number[], netBalance: number}>}
 */
async function processCsvFile(userId, filePath, mode = 'merge') {
  if (mode === 'replace') {
    await removeImportedForUser(userId);
  }

  const { rows: parsed, malformed } = await parseBankCSV(filePath);
  if (parsed.length === 0) {
    return { count: 0, skipped: 0, malformed, categoryIds: [], netBalance: 0 };
  }

  const existingKeys = mode === 'replace' ? null : await existingTransactionKeys(userId);

  // Resolve the fallback account once (create Cash if needed). Rows that name an
  // ACCOUNT get their own account resolved below and bypass this one.
  let accountRes = await db.query('SELECT id FROM accounts WHERE user_id = $1 ORDER BY id LIMIT 1', [userId]);
  let accountId;
  if (accountRes.rows.length === 0) {
    const newAcc = await db.query(
      "INSERT INTO accounts (user_id, name, type, balance, icon_name, color_code) VALUES ($1, 'Cash', 'Cash', 0.00, 'Wallet', '#3b82f6') RETURNING id",
      [userId]
    );
    accountId = newAcc.rows[0].id;
  } else {
    accountId = accountRes.rows[0].id;
  }

  // Resolve (and lazily create) an account per distinct ACCOUNT column value so
  // third-party exports spanning several cards / wallets are not collapsed onto
  // a single account.
  const accountCache = new Map();
  const getAccountId = async (name) => {
    const clean = String(name || '').trim();
    if (!clean) return accountId;
    const key = clean.toLowerCase();
    if (accountCache.has(key)) return accountCache.get(key);

    let res = await db.query('SELECT id FROM accounts WHERE user_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1', [
      userId,
      clean,
    ]);
    let id;
    if (res.rows.length > 0) {
      id = res.rows[0].id;
    } else {
      const created = await db.query(
        "INSERT INTO accounts (user_id, name, type, balance, icon_name, color_code) VALUES ($1, $2, 'Cash', 0.00, 'Wallet', '#3b82f6') RETURNING id",
        [userId, clean]
      );
      id = created.rows[0].id;
    }
    accountCache.set(key, id);
    return id;
  };

  // Cache category id resolution for the batch
  const categoryCache = new Map();
  const getCategoryId = async (name) => {
    if (categoryCache.has(name)) return categoryCache.get(name);
    const id = await categoryIdByName(name);
    categoryCache.set(name, id);
    return id;
  };

  const rows = [];
  const categoryIds = [];
  let netBalance = 0;
  let skipped = 0;

  for (const tx of parsed) {
    if (existingKeys) {
      const key = `${formatDateKey(tx.transaction_date)}|${tx.description.trim().toLowerCase()}|${Number(tx.amount)}`;
      if (existingKeys.has(key)) {
        skipped += 1;
        continue;
      }
      existingKeys.add(key);
    }

    const classification = classifyTransaction(tx.description);
    const providedCategory = tx.category ? String(tx.category).trim() : '';
    const classifierCategory =
      tx.type === 'income'
        ? classification.category === 'Uncategorized'
          ? 'Uncategorized'
          : classification.category
        : classification.category;

    // Prefer the category declared directly in the CSV row (e.g. "Food",
    // "Bills", "Health"); fall back to the smart classifier, then to
    // 'Uncategorized' only as a last resort.
    let categoryId = providedCategory ? await getCategoryId(providedCategory) : await getCategoryId(classifierCategory);
    if (!categoryId && providedCategory) {
      categoryId = await getCategoryId(classifierCategory);
    }
    const finalCategoryId = categoryId || (await getCategoryId('Uncategorized'));
    const rowAccountId = await getAccountId(tx.account);

    rows.push({
      userId,
      categoryId: finalCategoryId,
      accountId: rowAccountId,
      date: tx.transaction_date,
      description: tx.description,
      amount: tx.amount,
      type: tx.type,
      isDebit: tx.is_debit,
      source: 'csv_import',
    });
    categoryIds.push(finalCategoryId);

    netBalance += tx.is_debit ? -tx.amount : tx.amount;
  }

  if (rows.length > 0) {
    const userIds = rows.map((r) => r.userId);
    const dbCategoryIds = rows.map((r) => r.categoryId);
    const accountIds = rows.map((r) => r.accountId);
    const dates = rows.map((r) => r.date);
    const descriptions = rows.map((r) => r.description);
    const amounts = rows.map((r) => r.amount);
    const types = rows.map((r) => r.type);
    const isDebits = rows.map((r) => r.isDebit);
    const sources = rows.map((r) => r.source);

    const query = `
      INSERT INTO transactions (user_id, category_id, account_id, date, description, amount, type, is_debit, source)
      SELECT * FROM UNNEST(
        $1::int[], $2::int[], $3::int[], $4::timestamptz[], $5::text[],
        $6::numeric[], $7::text[], $8::boolean[], $9::text[]
      )
    `;
    await db.query(query, [userIds, dbCategoryIds, accountIds, dates, descriptions, amounts, types, isDebits, sources]);

    // Reflect the net balance change on every account touched by this import
    const netByAccount = new Map();
    for (const r of rows) {
      const delta = r.isDebit ? -r.amount : r.amount;
      netByAccount.set(r.accountId, (netByAccount.get(r.accountId) || 0) + Number(delta));
    }
    for (const [id, delta] of netByAccount) {
      await db.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3', [delta, id, userId]);
    }
  }

  await invalidateUserCache(userId);
  return { count: rows.length, skipped, malformed, categoryIds, netBalance };
}

module.exports = { processCsvFile, categoryIdByName, removeImportedForUser };
