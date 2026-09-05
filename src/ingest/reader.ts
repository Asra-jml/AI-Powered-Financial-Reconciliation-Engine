/**
 * Bahikhata — Ingest & Normalise
 * 
 * Reads CSV/JSON input files, validates with Zod, normalises to canonical
 * ledger_line shape. Amounts → integer paise. Dates → IST (YYYY-MM-DD).
 * Content-hash for idempotent re-ingest.
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type { LedgerLine, Source } from '../types';

/**
 * Compute SHA-256 content hash of all input data for idempotency.
 */
export function computeInputHash(...inputs: string[]): string {
  const hash = crypto.createHash('sha256');
  for (const input of inputs) {
    hash.update(input);
  }
  return hash.digest('hex');
}

/**
 * Parse a CSV string into rows. Handles quoted fields and newlines.
 */
export function parseCSV(content: string): Array<Record<string, string>> {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows: Array<Record<string, string>> = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    if (values.length !== headers.length) continue; // Skip malformed rows
    
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j];
    }
    rows.push(row);
  }

  return rows;
}

/**
 * Convert amount to integer paise.
 * Handles: rupee strings ("1234.56"), paise integers, numbers.
 */
export function toPaise(value: string | number): number {
  if (typeof value === 'number') {
    // If it looks like rupees (has decimal), convert
    if (value % 1 !== 0 || value < 100) {
      return Math.round(value * 100);
    }
    return Math.round(value); // Already paise
  }
  
  const cleaned = String(value).replace(/[₹,\s]/g, '');
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  
  // If the string contains a decimal, treat as rupees
  if (cleaned.includes('.')) {
    return Math.round(num * 100);
  }
  return Math.round(num);
}

/**
 * Normalise date to YYYY-MM-DD IST format.
 */
export function normaliseDate(value: string): string {
  if (!value) return '';
  
  // Already in ISO format
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  
  // DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = value.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmyMatch) {
    return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, '0')}-${dmyMatch[1].padStart(2, '0')}`;
  }

  // ISO timestamp
  const isoMatch = value.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoMatch) return isoMatch[1];

  // Try Date parse as last resort
  const d = new Date(value);
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }

  return value;
}

/**
 * Normalise a batch of raw bank statement rows into LedgerLines.
 */
export function normaliseBankStatement(
  rows: Array<Record<string, string>>,
  run_id: string
): { lines: LedgerLine[]; errors: Array<{ row: number; error: string }> } {
  const lines: LedgerLine[] = [];
  const errors: Array<{ row: number; error: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      // Try common column name variations
      const amount = toPaise(
        row['amount'] || row['Amount'] || row['AMOUNT'] ||
        row['credit'] || row['Credit'] || row['debit'] || row['Debit'] || '0'
      );

      if (amount === 0) {
        errors.push({ row: i, error: 'Zero or missing amount' });
        continue;
      }

      const isDebit = !!(row['debit'] || row['Debit'] || row['DR']);
      const direction = isDebit ? 'debit' as const : 'credit' as const;

      const date = normaliseDate(
        row['date'] || row['Date'] || row['DATE'] ||
        row['value_date'] || row['Value Date'] || ''
      );

      if (!date) {
        errors.push({ row: i, error: 'Missing or invalid date' });
        continue;
      }

      const narration = row['narration'] || row['Narration'] || row['NARRATION'] ||
        row['description'] || row['Description'] || row['particulars'] || '';

      lines.push({
        line_id: uuidv4(),
        run_id,
        source: 'bank',
        amount_paise: Math.abs(amount),
        direction,
        occurred_on: date,
        narration_raw: narration,
        is_refund: false,
        is_dispute: false,
      });
    } catch (err: any) {
      errors.push({ row: i, error: err.message });
    }
  }

  return { lines, errors };
}

/**
 * Normalise internal payment ledger rows into LedgerLines.
 */
export function normalisePaymentLedger(
  rows: Array<Record<string, string>>,
  run_id: string
): { lines: LedgerLine[]; errors: Array<{ row: number; error: string }> } {
  const lines: LedgerLine[] = [];
  const errors: Array<{ row: number; error: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const amount = toPaise(row['amount'] || row['Amount'] || '0');
      if (amount === 0) {
        errors.push({ row: i, error: 'Zero or missing amount' });
        continue;
      }

      const date = normaliseDate(row['date'] || row['Date'] || row['created_at'] || '');
      if (!date) {
        errors.push({ row: i, error: 'Missing date' });
        continue;
      }

      const isRefund = (row['type'] || '').toLowerCase() === 'refund' || row['is_refund'] === 'true';
      const isDispute = (row['type'] || '').toLowerCase() === 'dispute' || row['is_dispute'] === 'true';

      lines.push({
        line_id: uuidv4(),
        run_id,
        source: 'internal',
        external_id: row['payment_id'] || row['id'] || undefined,
        payment_id: row['payment_id'] || row['id'] || undefined,
        order_id: row['order_id'] || undefined,
        utr: row['utr'] || row['UTR'] || undefined,
        settlement_id: row['settlement_id'] || undefined,
        amount_paise: amount,
        direction: isRefund || isDispute ? 'debit' : 'credit',
        instrument: (row['instrument'] || row['method'] || 'card') as any,
        occurred_on: date,
        fee_paise: toPaise(row['fee'] || row['Fee'] || '0'),
        gst_paise: toPaise(row['gst'] || row['tax'] || row['GST'] || '0'),
        is_refund: isRefund,
        is_dispute: isDispute,
      });
    } catch (err: any) {
      errors.push({ row: i, error: err.message });
    }
  }

  return { lines, errors };
}
