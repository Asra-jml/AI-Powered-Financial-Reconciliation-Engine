/**
 * Tests for fee-verifier module
 * Covers: fee computation, GST verification, mid-month schedule change,
 * settlement identity equation, and edge cases
 */
import { describe, it, expect } from 'vitest';
import {
  computeExpectedFee,
  verifyFees,
  verifySettlementIdentity,
} from '../../src/verifier/fee-verifier';
import type { LedgerLine, FeeSchedule } from '../../src/types';
import { GST_ON_GATEWAY_FEES_BPS } from '../../src/config/rules';

// ─── Test Fee Schedules (with mid-month change) ────────────────────────────────

const TEST_SCHEDULES: FeeSchedule[] = [
  {
    schedule_id: 'sched-card-old',
    instrument: 'card',
    plan: 'standard',
    rate_bps: 200,        // 2.00%
    flat_fee_paise: 0,
    gst_bps: 1800,        // 18%
    effective_from: '2026-01-01',
    effective_to: '2026-08-14',
  },
  {
    schedule_id: 'sched-card-new',
    instrument: 'card',
    plan: 'standard',
    rate_bps: 220,        // 2.20% — post schedule change
    flat_fee_paise: 0,
    gst_bps: 1800,
    effective_from: '2026-08-15',
    effective_to: null,
  },
  {
    schedule_id: 'sched-upi',
    instrument: 'upi',
    plan: 'standard',
    rate_bps: 0,          // UPI zero-MDR
    flat_fee_paise: 0,
    gst_bps: 1800,
    effective_from: '2026-01-01',
    effective_to: null,
  },
  {
    schedule_id: 'sched-netbanking',
    instrument: 'netbanking',
    plan: 'standard',
    rate_bps: 200,
    flat_fee_paise: 0,
    gst_bps: 1800,
    effective_from: '2026-01-01',
    effective_to: null,
  },
];

// ─── computeExpectedFee ────────────────────────────────────────────────────────

describe('computeExpectedFee', () => {
  it('computes correct fee for card payment before schedule change', () => {
    const { feePaise, gstPaise, schedule } = computeExpectedFee(
      100000, 'card', '2026-08-10', TEST_SCHEDULES
    );
    // 100000 * 200 / 10000 = 2000 paise (₹20)
    expect(feePaise).toBe(2000);
    // GST: 2000 * 1800 / 10000 = 360 paise (₹3.60)
    expect(gstPaise).toBe(360);
    expect(schedule?.schedule_id).toBe('sched-card-old');
  });

  it('picks the NEW schedule after mid-month change', () => {
    const { feePaise, gstPaise, schedule } = computeExpectedFee(
      100000, 'card', '2026-08-16', TEST_SCHEDULES
    );
    // 100000 * 220 / 10000 = 2200 paise (₹22)
    expect(feePaise).toBe(2200);
    // GST: 2200 * 1800 / 10000 = 396 paise (₹3.96)
    expect(gstPaise).toBe(396);
    expect(schedule?.schedule_id).toBe('sched-card-new');
  });

  it('computes zero fee for UPI (zero-MDR)', () => {
    const { feePaise, gstPaise } = computeExpectedFee(
      50000, 'upi', '2026-08-10', TEST_SCHEDULES
    );
    expect(feePaise).toBe(0);
    expect(gstPaise).toBe(0);
  });

  it('returns zero for unknown instrument with no schedule', () => {
    const { feePaise, gstPaise, schedule } = computeExpectedFee(
      100000, 'emi', '2026-08-10', TEST_SCHEDULES
    );
    expect(feePaise).toBe(0);
    expect(gstPaise).toBe(0);
    expect(schedule).toBeNull();
  });

  it('integer arithmetic: no floating-point rounding errors', () => {
    // ₹12,400 (1240000 paise) at 2.00%
    const { feePaise, gstPaise } = computeExpectedFee(
      1240000, 'card', '2026-08-10', TEST_SCHEDULES
    );
    // 1240000 * 200 / 10000 = 24800 paise
    expect(feePaise).toBe(24800);
    // 24800 * 1800 / 10000 = 4464 paise
    expect(gstPaise).toBe(4464);
    // Verify exact integers — no .0000001 etc.
    expect(Number.isInteger(feePaise)).toBe(true);
    expect(Number.isInteger(gstPaise)).toBe(true);
  });
});

// ─── verifyFees ────────────────────────────────────────────────────────────────

describe('verifyFees', () => {
  function makePayment(overrides: Partial<LedgerLine> = {}): LedgerLine {
    return {
      line_id: 'line-test-1',
      run_id: 'run-test-1',
      source: 'internal',
      amount_paise: 100000,
      direction: 'credit',
      instrument: 'card',
      occurred_on: '2026-08-10',
      fee_paise: 2000,
      gst_paise: 360,
      is_refund: false,
      is_dispute: false,
      ...overrides,
    };
  }

  it('reports no variance when fee matches schedule', () => {
    const payments = [makePayment()];
    const { feeVarianceCount, gstVarianceCount } = verifyFees(payments, TEST_SCHEDULES);
    expect(feeVarianceCount).toBe(0);
    expect(gstVarianceCount).toBe(0);
  });

  it('detects fee overcharge', () => {
    const payments = [makePayment({ fee_paise: 2500 })]; // charged ₹25, expected ₹20
    const { feeVarianceCount, totalFeeVariancePaise, results } = verifyFees(payments, TEST_SCHEDULES);
    expect(feeVarianceCount).toBe(1);
    expect(totalFeeVariancePaise).toBe(500); // overcharged by 500 paise
    expect(results[0].has_fee_variance).toBe(true);
    expect(results[0].fee_delta_paise).toBe(500);
  });

  it('detects GST variance', () => {
    const payments = [makePayment({ gst_paise: 500 })]; // charged ₹5, expected ₹3.60
    const { gstVarianceCount, results } = verifyFees(payments, TEST_SCHEDULES);
    expect(gstVarianceCount).toBe(1);
    expect(results[0].has_gst_variance).toBe(true);
    expect(results[0].gst_delta_paise).toBe(140);
  });

  it('skips refund payments', () => {
    const payments = [makePayment({ is_refund: true, fee_paise: 99999 })];
    const { results } = verifyFees(payments, TEST_SCHEDULES);
    expect(results).toHaveLength(0);
  });

  it('skips dispute payments', () => {
    const payments = [makePayment({ is_dispute: true, fee_paise: 99999 })];
    const { results } = verifyFees(payments, TEST_SCHEDULES);
    expect(results).toHaveLength(0);
  });

  it('uses correct schedule for payment date (mid-month change)', () => {
    const beforeChange = makePayment({ occurred_on: '2026-08-14', fee_paise: 2000 }); // old rate
    const afterChange = makePayment({
      line_id: 'line-test-2',
      occurred_on: '2026-08-16',
      fee_paise: 2200,
    }); // new rate

    const { feeVarianceCount } = verifyFees([beforeChange, afterChange], TEST_SCHEDULES);
    expect(feeVarianceCount).toBe(0); // both match their schedule
  });

  it('flags variance when using wrong schedule after change', () => {
    // Payment after schedule change but charged at old rate
    const payment = makePayment({
      occurred_on: '2026-08-16',
      fee_paise: 2000, // old 2.00% rate, should be 2.20%
    });
    const { feeVarianceCount, results } = verifyFees([payment], TEST_SCHEDULES);
    expect(feeVarianceCount).toBe(1);
    expect(results[0].schedule_id).toBe('sched-card-new');
    expect(results[0].expected_fee_paise).toBe(2200);
  });

  it('cites the schedule in results', () => {
    const payments = [makePayment()];
    const { results } = verifyFees(payments, TEST_SCHEDULES);
    expect(results[0].schedule_id).toBe('sched-card-old');
    expect(results[0].schedule_rate_bps).toBe(200);
    expect(results[0].schedule_effective_from).toBe('2026-01-01');
  });
});

// ─── verifySettlementIdentity ──────────────────────────────────────────────────

describe('verifySettlementIdentity', () => {
  it('identity holds when components match credit', () => {
    const settlements = [{
      settlement_id: 'setl_1',
      expected_net_paise: 95000,
      settled_on: '2026-08-12',
      component_payments_paise: 100000,
      component_fees_paise: 2000,
      component_gst_paise: 360,
      component_refunds_paise: 2640,
      component_adjustments_paise: 0,
    }];
    // Reconstructed: 100000 - 2000 - 360 - 2640 - 0 = 95000
    const actualCredits = new Map([['setl_1', 95000]]);

    const results = verifySettlementIdentity(settlements, actualCredits);
    expect(results[0].identity_holds).toBe(true);
    expect(results[0].identity_delta_paise).toBe(0);
  });

  it('identity breaks when credit is less than expected', () => {
    const settlements = [{
      settlement_id: 'setl_1',
      expected_net_paise: 95000,
      settled_on: '2026-08-12',
      component_payments_paise: 100000,
      component_fees_paise: 2000,
      component_gst_paise: 360,
      component_refunds_paise: 2640,
      component_adjustments_paise: 0,
    }];
    const actualCredits = new Map([['setl_1', 90000]]); // ₹50 less

    const results = verifySettlementIdentity(settlements, actualCredits);
    expect(results[0].identity_holds).toBe(false);
    expect(results[0].identity_delta_paise).toBe(5000);
  });

  it('reports 0 actual when settlement has no bank credit', () => {
    const settlements = [{
      settlement_id: 'setl_missing',
      expected_net_paise: 50000,
      settled_on: '2026-08-12',
      component_payments_paise: 55000,
      component_fees_paise: 2000,
      component_gst_paise: 360,
      component_refunds_paise: 2640,
      component_adjustments_paise: 0,
    }];
    const actualCredits = new Map<string, number>();

    const results = verifySettlementIdentity(settlements, actualCredits);
    expect(results[0].actual_credited_paise).toBe(0);
  });
});
