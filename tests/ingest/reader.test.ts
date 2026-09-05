/**
 * Tests for ingest/reader module
 * Covers: toPaise, normaliseDate, computeInputHash, parseCSV, normalise functions
 */
import { describe, it, expect } from 'vitest';
import {
  computeInputHash,
  parseCSV,
  toPaise,
  normaliseDate,
  normaliseBankStatement,
  normalisePaymentLedger,
} from '../../src/ingest/reader';

// ─── toPaise ───────────────────────────────────────────────────────────────────

describe('toPaise', () => {
  it('converts rupee string with decimal to paise', () => {
    expect(toPaise('1234.56')).toBe(123456);
  });

  it('converts integer string as paise (no decimal)', () => {
    expect(toPaise('150000')).toBe(150000);
  });

  it('converts rupee number with decimal to paise', () => {
    expect(toPaise(1234.56)).toBe(123456);
  });

  it('keeps large integer numbers as paise', () => {
    expect(toPaise(150000)).toBe(150000);
  });

  it('strips ₹ symbol and commas', () => {
    expect(toPaise('₹1,234.56')).toBe(123456);
  });

  it('returns 0 for non-numeric string', () => {
    expect(toPaise('abc')).toBe(0);
  });

  it('returns 0 for empty string', () => {
    expect(toPaise('')).toBe(0);
  });

  it('handles small rupee amounts', () => {
    expect(toPaise(4.99)).toBe(499);
  });

  it('rounds correctly for floating-point edge cases', () => {
    // 19.99 * 100 = 1998.9999... in IEEE 754
    expect(toPaise('19.99')).toBe(1999);
  });
});

// ─── normaliseDate ─────────────────────────────────────────────────────────────

describe('normaliseDate', () => {
  it('returns ISO date unchanged', () => {
    expect(normaliseDate('2026-08-15')).toBe('2026-08-15');
  });

  it('converts DD/MM/YYYY to ISO', () => {
    expect(normaliseDate('15/08/2026')).toBe('2026-08-15');
  });

  it('converts DD-MM-YYYY to ISO', () => {
    expect(normaliseDate('15-08-2026')).toBe('2026-08-15');
  });

  it('extracts date from ISO timestamp', () => {
    expect(normaliseDate('2026-08-15T14:30:00+05:30')).toBe('2026-08-15');
  });

  it('pads single-digit day and month', () => {
    expect(normaliseDate('5/8/2026')).toBe('2026-08-05');
  });

  it('returns empty string for empty input', () => {
    expect(normaliseDate('')).toBe('');
  });
});

// ─── computeInputHash ──────────────────────────────────────────────────────────

describe('computeInputHash', () => {
  it('produces same hash for same inputs', () => {
    const hash1 = computeInputHash('data1', 'data2');
    const hash2 = computeInputHash('data1', 'data2');
    expect(hash1).toBe(hash2);
  });

  it('produces different hash for different inputs', () => {
    const hash1 = computeInputHash('data1', 'data2');
    const hash2 = computeInputHash('data1', 'data3');
    expect(hash1).not.toBe(hash2);
  });

  it('returns a hex string of SHA-256 length', () => {
    const hash = computeInputHash('test');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is order-dependent (different order → different hash)', () => {
    const hash1 = computeInputHash('a', 'b');
    const hash2 = computeInputHash('b', 'a');
    expect(hash1).not.toBe(hash2);
  });
});

// ─── parseCSV ──────────────────────────────────────────────────────────────────

describe('parseCSV', () => {
  it('parses simple CSV with headers', () => {
    const csv = 'name,amount\nAlice,100\nBob,200';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ name: 'Alice', amount: '100' });
    expect(rows[1]).toEqual({ name: 'Bob', amount: '200' });
  });

  it('returns empty for header-only CSV', () => {
    const csv = 'name,amount';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(0);
  });

  it('returns empty for empty string', () => {
    expect(parseCSV('')).toHaveLength(0);
  });

  it('skips malformed rows with wrong column count', () => {
    const csv = 'a,b,c\n1,2,3\n4,5\n6,7,8';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(2); // row 2 skipped
  });

  it('strips quotes from fields', () => {
    const csv = '"name","amount"\n"Alice","100"';
    const rows = parseCSV(csv);
    expect(rows[0]).toEqual({ name: 'Alice', amount: '100' });
  });
});

// ─── normaliseBankStatement ────────────────────────────────────────────────────

describe('normaliseBankStatement', () => {
  it('converts bank CSV rows to LedgerLines', () => {
    const rows = [
      { date: '15/08/2026', amount: '15000.50', narration: 'NEFT-RAZORPAY-UTR123' },
    ];
    const { lines, errors } = normaliseBankStatement(rows, 'test-run-id');
    expect(lines).toHaveLength(1);
    expect(errors).toHaveLength(0);
    expect(lines[0].amount_paise).toBe(1500050);
    expect(lines[0].occurred_on).toBe('2026-08-15');
    expect(lines[0].source).toBe('bank');
    expect(lines[0].direction).toBe('credit');
    expect(lines[0].narration_raw).toBe('NEFT-RAZORPAY-UTR123');
  });

  it('reports error for rows with zero amount', () => {
    const rows = [{ date: '15/08/2026', amount: '0' }];
    const { lines, errors } = normaliseBankStatement(rows, 'test-run');
    expect(lines).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('Zero');
  });

  it('reports error for rows with missing date', () => {
    const rows = [{ amount: '1000' }];
    const { lines, errors } = normaliseBankStatement(rows, 'test-run');
    expect(lines).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('handles case-insensitive column names', () => {
    const rows = [{ Date: '2026-08-15', Amount: '500.00', Narration: 'TEST' }];
    const { lines } = normaliseBankStatement(rows, 'test-run');
    expect(lines).toHaveLength(1);
    expect(lines[0].amount_paise).toBe(50000);
  });
});

// ─── normalisePaymentLedger ────────────────────────────────────────────────────

describe('normalisePaymentLedger', () => {
  it('converts payment rows to LedgerLines', () => {
    const rows = [{
      payment_id: 'pay_123',
      order_id: 'order_456',
      amount: '999.00',
      date: '2026-08-10',
      instrument: 'card',
      fee: '19.98',
      gst: '3.60',
    }];
    const { lines, errors } = normalisePaymentLedger(rows, 'test-run');
    expect(lines).toHaveLength(1);
    expect(errors).toHaveLength(0);
    expect(lines[0].amount_paise).toBe(99900);
    expect(lines[0].fee_paise).toBe(1998);
    expect(lines[0].gst_paise).toBe(360);
    expect(lines[0].payment_id).toBe('pay_123');
    expect(lines[0].source).toBe('internal');
    expect(lines[0].direction).toBe('credit');
    expect(lines[0].is_refund).toBe(false);
  });

  it('marks refund rows correctly', () => {
    const rows = [{ amount: '500', date: '2026-08-10', type: 'refund' }];
    const { lines } = normalisePaymentLedger(rows, 'test-run');
    expect(lines[0].is_refund).toBe(true);
    expect(lines[0].direction).toBe('debit');
  });

  it('marks dispute rows correctly', () => {
    const rows = [{ amount: '500', date: '2026-08-10', type: 'dispute' }];
    const { lines } = normalisePaymentLedger(rows, 'test-run');
    expect(lines[0].is_dispute).toBe(true);
    expect(lines[0].direction).toBe('debit');
  });
});
