const fs = require('fs');
const csv = require('csv-parser');

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

        const rawDate = pick('Date', 'Txn Date', 'Transaction Date', 'Trans Date', 'Posting Date', 'Value Date');
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
        const rawNotes = pick('Notes', 'Note');
        const rawCategory = pick('Category', 'Categories');
        const rawAmount = pick('Amount', 'Txn Amount', 'Value', 'AMOUNT');
        const rawDebit = pick('Debit', 'Withdrawal', 'Withdrawals', 'Money Out', 'Paid Out', 'Dr');
        const rawCredit = pick('Credit', 'Deposit', 'Deposits', 'Money In', 'Paid In', 'Cr');

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

        if (rawDebit && rawDebit !== '' && parseFloat(clean(rawDebit).numeric) > 0) {
          amount = clean(rawDebit).numeric;
          isDebit = true;
        } else if (rawCredit && rawCredit !== '' && parseFloat(clean(rawCredit).numeric) > 0) {
          amount = clean(rawCredit).numeric;
          isDebit = false;
        }

        if (!amount || amount <= 0) {
          malformed += 1;
          return;
        }

        // Parse dates in common formats (DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD)
        let parsedDate = new Date(rawDate);
        if (isNaN(parsedDate.getTime()) && typeof rawDate === 'string') {
          const parts = rawDate
            .trim()
            .split(/[/.-]/)
            .map((p) => parseInt(p, 10));
          if (parts.length === 3) {
            let [a, b, c] = parts;
            if (c < 100) c += 2000;
            // Assume day-first when first part > 12, otherwise month-first
            if (a > 12) parsedDate = new Date(c, a - 1, b);
            else parsedDate = new Date(c, a - 1, b);
          }
        }
        if (isNaN(parsedDate.getTime())) parsedDate = new Date();

        results.push({
          transaction_date: parsedDate.toISOString(),
          description: (rawNotes || rawDesc || 'Bank Transaction').trim().substring(0, 255),
          category: rawCategory ? String(rawCategory).trim() : '',
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
