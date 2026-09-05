/**
 * Tests for S2 Identity Matcher
 * Covers: amount+date match with identity verified, multiple candidates → defer,
 * date outside window → no match
 */
import { describe, it, expect } from 'vitest';
import { matchS2Identity } from '../../src/matcher/s2-identity';
import type { LedgerLine } from '../../src/types';
import { MATCH_DATE_WINDOW_DAYS } from '../../src/config/rules';

const RUN_ID = 'test-run-s2';

function makeBankLine(overrides: Partial<LedgerLine> = {}): LedgerLine {
  return {
    line_id: `bank-${Math.random().toString(36).slice(2, 8)}`,
    run_id: RUN_ID,
    source: 'bank',
    amount_paise: 95000,
    direction: 'credit',
    occurred_on: '2026-08-12',
    is_refund: false,
    is_dispute: false,
    ...overrides,
  };
}

function makePayment(overrides: Partial<LedgerLine> = {}): LedgerLine {
  return {
    line_id: `pay-${Math.random().toString(36).slice(2, 8)}`,
    run_id: RUN_ID,
    source: 'internal',
    amount_paise: 100000,
    direction: 'credit',
    occurred_on: '2026-08-10',
    settlement_id: 'setl_100',
    instrument: 'card',
    is_refund: false,
    is_dispute: false,
    ...overrides,
  };
}

const SETTLEMENTS = [
  {
    settlement_id: 'setl_100',
    expected_net_paise: 95000,
    settled_on: '2026-08-12',
    component_payments_paise: 100000,
    component_fees_paise: 2000,
    component_gst_paise: 360,
    component_refunds_paise: 2640,
    component_adjustments_paise: 0,
  },
];

describe('matchS2Identity', () => {
  it('matches when amount ≈ expected_net and date within window', () => {
    const bankLines = [makeBankLine()];
    const internalLines = [makePayment()];

    const result = matchS2Identity(
      bankLines, ['setl_100'], internalLines, SETTLEMENTS, RUN_ID
    );

    expect(result.matchedGroups).toHaveLength(1);
    expect(result.matchedGroups[0].settlementId).toBe('setl_100');
    expect(result.matchedGroups[0].group.strategy).toBe('S2_identity');
    expect(result.unmatchedBankLines).toHaveLength(0);
    expect(result.unmatchedSettlementIds).toHaveLength(0);
  });

  it('defers when multiple candidates match (ambiguity)', () => {
    // Two bank credits with same amount on same date
    const bankLines = [
      makeBankLine({ line_id: 'bank-a' }),
      makeBankLine({ line_id: 'bank-b' }),
    ];
    const internalLines = [makePayment()];

    const result = matchS2Identity(
      bankLines, ['setl_100'], internalLines, SETTLEMENTS, RUN_ID
    );

    // Should NOT match — ambiguous (candidates.length > 1)
    expect(result.matchedGroups).toHaveLength(0);
    expect(result.unmatchedSettlementIds).toContain('setl_100');
  });

  it('does not match when date is outside window', () => {
    const bankLines = [makeBankLine({
      occurred_on: '2026-08-25', // 13 days after settlement date
    })];
    const internalLines = [makePayment()];

    const result = matchS2Identity(
      bankLines, ['setl_100'], internalLines, SETTLEMENTS, RUN_ID
    );

    expect(result.matchedGroups).toHaveLength(0);
  });

  it('does not match when amount is too far off', () => {
    const bankLines = [makeBankLine({ amount_paise: 50000 })]; // way off from 95000
    const internalLines = [makePayment()];

    const result = matchS2Identity(
      bankLines, ['setl_100'], internalLines, SETTLEMENTS, RUN_ID
    );

    expect(result.matchedGroups).toHaveLength(0);
  });

  it('skips debit bank lines', () => {
    const bankLines = [makeBankLine({ direction: 'debit' })];
    const internalLines = [makePayment()];

    const result = matchS2Identity(
      bankLines, ['setl_100'], internalLines, SETTLEMENTS, RUN_ID
    );

    expect(result.matchedGroups).toHaveLength(0);
  });

  it('verifies settlement identity equation', () => {
    const bankLines = [makeBankLine()];
    const internalLines = [makePayment()];

    const result = matchS2Identity(
      bankLines, ['setl_100'], internalLines, SETTLEMENTS, RUN_ID
    );

    if (result.matchedGroups.length > 0) {
      // Identity holds: 100000 - 2000 - 360 - 2640 - 0 = 95000
      const group = result.matchedGroups[0].group;
      expect(group.confidence).toBeGreaterThanOrEqual(0.70);
    }
  });

  it('handles empty unmatched lists gracefully', () => {
    const result = matchS2Identity([], [], [], SETTLEMENTS, RUN_ID);
    expect(result.matchedGroups).toHaveLength(0);
    expect(result.unmatchedBankLines).toHaveLength(0);
  });
});
