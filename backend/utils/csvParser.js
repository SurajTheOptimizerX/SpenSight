const fs = require('fs');
const csv = require('csv-parser');

const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Assemble a calendar-validated 'YYYY-MM-DD' string, or null when the
 * components do not describe a real date (e.g. 31/02/2026, month 13).
 * Uses Date.UTC purely for validation so the result is timezone-agnostic.
 */
function toIsoDate(year, month, day) {
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return null;

  // Two-digit years: pivot at 70 like most statement exports.
  const fullYear = y < 100 ? (y < 70 ? y + 2000 : y + 1900) : y;
  if (fullYear < 1000 || fullYear > 9999) return null;
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > 31) return null;

  const probe = new Date(Date.UTC(fullYear, mo - 1, d));
  if (probe.getUTCFullYear() !== fullYear || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return `${fullYear}-${pad2(mo)}-${pad2(d)}`;
}

const monthIndex = (word) => MONTHS[String(word).toLowerCase().substring(0, 3)] || null;

/**
 * Parse a bank statement / expense-export date cell into an exact
 * 'YYYY-MM-DD' calendar string.
 *
 * Supported statement formats:
 *   ISO / year-first  2026-10-05, 2026-10-05T14:23:00Z, 2026-10-05 14:23
 *   Day-first         05/10/2026, 05-10-2026, 05.10.2026   (Indian / European)
 *   Month-first       10/05/2026                            (US, only when
 *                     detected unambiguously, i.e. the day slot exceeds 12)
 *   Textual months    05-Oct-2026, Oct 05 2026, 5 October 2026
 *   Dated + time      Jan 01, 2026 4:19 PM, Oct 05 2026 16:19
 *                     (third-party expense exports: the time part is dropped)
 *
 * Returns null when the value cannot be interpreted as a real date, so callers
 * never silently substitute the current date.
 */
function parseBankDate(raw) {
  if (raw === undefined || raw === null) return null;

  const text = String(raw)
    .replace(/^[\s"']+|[\s"']+$/g, '')
    .trim();
  if (!text) return null;

  // Discard any time component; only the calendar date matters. The optional
  // meridiem group is required for third-party exports such as
  // "Jan 01, 2026 4:19 PM", where the time is not the last token in the cell.
  const datePart = text
    .replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*([AaPp]\.?[Mm]\.?)?\s*$/, '')
    .split('T')[0]
    .replace(/[\s,]+$/, '')
    .trim();
  if (!datePart) return null;

  // 1. Year-first: 2026-10-05
  let m = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(datePart);
  if (m) return toIsoDate(m[1], m[2], m[3]);

  // 2. Textual month name: 05-Oct-2026 / 5 October 2026
  m = /^(\d{1,2})[./\-\s]*([A-Za-z]{3,9})[./\-\s,]*(\d{2,4})$/.exec(datePart);
  if (m && monthIndex(m[2])) return toIsoDate(m[3], monthIndex(m[2]), m[1]);

  // 3. Leading textual month: Oct 05 2026 / October 5, 2026
  m = /^([A-Za-z]{3,9})[./\-\s]*(\d{1,2})[./\-\s,]*(\d{2,4})$/.exec(datePart);
  if (m && monthIndex(m[1])) return toIsoDate(m[3], monthIndex(m[1]), m[2]);

  // 4. Numeric a/b/c. Day-first is the default (Indian statements); month-first
  //    is only chosen when the second slot cannot be a day (> 12).
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(datePart);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = m[3];
    if (a > 12) return toIsoDate(year, b, a);
    if (b > 12) return toIsoDate(year, a, b);
    return toIsoDate(year, b, a);
  }

  return null;
}

/** Today as a local 'YYYY-MM-DD' string (used only when a row has no date cell). */
function todayIsoDate() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/**
 * Public entry point for turning a raw CSV date cell into a date-only
 * 'YYYY-MM-DD' string.
 *
 * Delegates to parseBankDate() so that ambiguous numeric cells are resolved
 * (day-first vs month-first) and the result is calendar-validated, then falls
 * back to today only when the cell is missing or genuinely unreadable.
 *
 * The value is intentionally date-only rather than a full timestamp: these
 * rows land in a SQL DATE column, and a toISOString() timestamp built from a
 * local-time Date shifts the calendar day whenever the host is not UTC.
 */
function parseCsvDate(rawDate) {
  return parseBankDate(rawDate) || todayIsoDate();
}

/**
 * Parses and normalizes varying bank statement CSV headers into a
 * standard object array with debit/credit (income/expense) detection.
 * Resolves { rows, malformed } so callers can report silently-skipped
 * invalid rows (e.g. missing / zero / non-numeric amounts) to the user.
 */
exports.parseBankCSV = (filePath) => {
  return new Promise((resolve, reject) => {
    const results = [];
    let malformed = 0;

    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        const lowerToOriginal = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k]));
        const rowValue = (name) => {
          const original = lowerToOriginal.get(name.toLowerCase());
          return original !== undefined ? row[original] : undefined;
        };

        const pick = (...names) => {
          for (const name of names) {
            const value = rowValue(name);
            if (value !== undefined && value !== '') return value;
          }
          // Fallback: fuzzy contains
          for (const name of names) {
            const match = Object.keys(row).find((k) => k.toLowerCase().includes(name.toLowerCase()));
            if (match && row[match] !== undefined && row[match] !== '') return row[match];
          }
          return undefined;
        };

        const rawDesc = pick(
          'Description',
          'Narration',
          'Details',
          'Merchant',
          'Particulars',
          'Transaction',
          'Remarks',
          'Memo'
        );
        const rawNotes = pick('Notes', 'Note', 'NOTES');
        const rawCategory = pick('Category', 'Categories', 'CATEGORY');
        const rawAccount = pick('Account', 'Account Name', 'ACCOUNT');
        const rawAmount = pick('Amount', 'Txn Amount', 'Value', 'AMOUNT');
        const rawDebit = pick('Debit', 'Withdrawal', 'Withdrawals', 'Money Out', 'Paid Out', 'Dr');
        const rawCredit = pick('Credit', 'Deposit', 'Deposits', 'Money In', 'Paid In', 'Cr');
        // Third-party expense exports carry the direction in a TYPE column
        // ("Expense" / "Income") instead of separate Debit/Credit columns.
        const rawType = pick('Type', 'Transaction Type', 'TYPE');

        // Clean amount strings ("$1,200.50", "₹500", "-45.00" -> positive magnitude)
        const clean = (v) => {
          const s = String(v === undefined || v === null ? '' : v);
          const negative = /^-/.test(s.trim());
          const numeric = parseFloat(s.replace(/[^0-9.-]/g, '')) || 0;
          return { numeric: Math.abs(numeric), negative };
        };

        let amount = 0;
        let isDebit = true;

        if (rawAmount !== undefined && rawAmount !== '') {
          const cleaned = clean(rawAmount);
          amount = cleaned.numeric;
          if (cleaned.negative) isDebit = true;
        }

        // Signed Debit/Credit columns are authoritative when present. `amount`
        // always stays a positive magnitude; direction is carried by is_debit,
        // because both the balance update and the reversal query apply the sign.
        const debitColumn = rawDebit && rawDebit !== '' && clean(rawDebit).numeric > 0;
        const creditColumn = rawCredit && rawCredit !== '' && clean(rawCredit).numeric > 0;

        if (debitColumn) {
          amount = clean(rawDebit).numeric;
          isDebit = true;
        } else if (creditColumn) {
          amount = clean(rawCredit).numeric;
          isDebit = false;
        } else if (rawType !== undefined && rawType !== '') {
          // Fallback only: no dedicated Debit/Credit column, so the TYPE label
          // decides the direction.
          const type = String(rawType).toLowerCase();
          if (type.includes('income') || type.includes('credit') || type.includes('deposit')) isDebit = false;
        }

        if (!amount || amount <= 0) {
          malformed += 1;
          return;
        }

        // Parse dates in common formats (DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD).
        // Resolved through pick() so header casing / fuzzy variants still match.
        const parsedDate = parseCsvDate(
          pick(
            'Date',
            'Txn Date',
            'Transaction Date',
            'Trans Date',
            'Posting Date',
            'Value Date',
            'DATE',
            // Third-party expense exports label the date column TIME.
            'TIME',
            'Time'
          )
        );

        results.push({
          transaction_date: parsedDate,
          description: (rawNotes || rawDesc || 'Bank Transaction').trim().substring(0, 255),
          category: rawCategory ? String(rawCategory).trim() : '',
          account: rawAccount ? String(rawAccount).trim().substring(0, 100) : '',
          amount,
          is_debit: isDebit,
          type: isDebit ? 'expense' : 'income',
          raw_data: row,
        });
      })
      .on('end', () => {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        resolve({ rows: results, malformed });
      })
      .on('error', (err) => {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        reject(err);
      });
  });
};

exports.parseCsvDate = parseCsvDate;