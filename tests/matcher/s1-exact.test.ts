/**
 * Tests for S1 Exact Identifier Matcher
 * Covers: UTR match, settlement_id match, tolerance, no-match, no double-match
 */
import { describe, it, expect } from 'vitest';
import { matchS1Exact } from '../../src/matcher/s1-exact';
import type { LedgerLine } from '../../src/types';

const RUN_ID = 'test-run-s1';

function makeBankLine(overrides: Partial<LedgerLine> = {}): LedgerLine {
  return {
    line_id: `bank-${Math.random().toString(36).slice(2, 8)}`,
    run_id: RUN_ID,
    source: 'bank',
    amount_paise: 50000,
    direction: 'credit',
    occurred_on: '2026-08-12',
    narration_raw: 'NEFT-RAZORPAYSOFTW-UTR1111111111-SETTLEMENT',
    narration_parsed: { utr: 'UTR1111111111', method: 'NEFT', sender: 'RAZORPAY', confidence: 0.95, raw: '' },
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
    amount_paise: 55000,
    direction: 'credit',
    occurred_on: '2026-08-10',
    utr: 'UTR1111111111',
    settlement_id: 'setl_001',
    instrument: 'card',
    is_refund: false,
    is_dispute: false,
    ...overrides,
  };
}

const DEFAULT_SETTLEMENTS = [
  { settlement_id: 'setl_001', expected_net_paise: 50000, settled_on: '2026-08-12' },
];

describe('matchS1Exact', () => {
  it('matches bank credit to settlement by UTR', () => {
    const bankLines = [makeBankLine()];
    const internalLines = [makePayment()];

    const result = matchS1Exact(bankLines, internalLines, DEFAULT_SETTLEMENTS, RUN_ID);

    expect(result.matchedGroups).toHaveLength(1);
    expect(result.matchedGroups[0].settlementId).toBe('setl_001');
    expect(result.matchedGroups[0].group.strategy).toBe('S1_exact');
    expect(result.matchedGroups[0].group.committed).toBe(true);
    expect(result.unmatchedBankLines).toHaveLength(0);
    expect(result.unmatchedSettlementIds).toHaveLength(0);
  });

  it('matches by bank line UTR field directly (not just narration)', () => {
    const bankLines = [makeBankLine({
      utr: 'UTR1111111111',
      narration_parsed: null, // no narration parsed
    })];
    const internalLines = [makePayment()];

    const result = matchS1Exact(bankLines, internalLines, DEFAULT_SETTLEMENTS, RUN_ID);
    expect(result.matchedGroups).toHaveLength(1);
  });

  it('matches by settlement_id in narration', () => {
    const bankLines = [makeBankLine({
      narration_parsed: { settlement_id: 'setl_001', method: 'UNKNOWN', confidence: 0.7, raw: '' },
    })];
    const internalLines = [makePayment()];

    const result = matchS1Exact(bankLines, internalLines, DEFAULT_SETTLEMENTS, RUN_ID);
    expect(result.matchedGroups).toHaveLength(1);
  });

  it('leaves unmatched bank lines when no UTR/settlement_id matches', () => {
    const bankLines = [makeBankLine({
      utr: undefined,
      narration_parsed: { method: 'UNKNOWN', confidence: 0, raw: '' },
    })];
    const internalLines = [makePayment()];

    const result = matchS1Exact(bankLines, internalLines, DEFAULT_SETTLEMENTS, RUN_ID);
    expect(result.matchedGroups).toHaveLength(0);
    expect(result.unmatchedBankLines).toHaveLength(1);
    expect(result.unmatchedSettlementIds).toHaveLength(1);
  });

  it('does not match debit bank lines (bank charges)', () => {
    const bankLines = [makeBankLine({ direction: 'debit' })];
    const internalLines = [makePayment()];

    const result = matchS1Exact(bankLines, internalLines, DEFAULT_SETTLEMENTS, RUN_ID);
    expect(result.matchedGroups).toHaveLength(0);
  });

  it('does not double-match the same settlement', () => {
    // Two bank lines with same UTR → only first should match
    const bankLines = [
      makeBankLine({ line_id: 'bank-1' }),
      makeBankLine({ line_id: 'bank-2' }),
    ];
    const internalLines = [makePayment()];

    const result = matchS1Exact(bankLines, internalLines, DEFAULT_SETTLEMENTS, RUN_ID);
    expect(result.matchedGroups).toHaveLength(1);
    expect(result.unmatchedBankLines).toHaveLength(1);
  });

  it('includes all settlement payments as group members', () => {
    const bankLines = [makeBankLine()];
    const internalLines = [
      makePayment({ line_id: 'pay-1' }),
      makePayment({ line_id: 'pay-2', utr: 'UTR2222222222' }),
    ];

    const result = matchS1Exact(bankLines, internalLines, DEFAULT_SETTLEMENTS, RUN_ID);
    expect(result.matchedGroups).toHaveLength(1);
    // Members = bank line + all payments for this settlement
    const memberCount = result.matchedGroups[0].members.length;
    expect(memberCount).toBeGreaterThanOrEqual(2); // at least bank line + 1 payment
  });

  it('sets committed=false when amount delta exceeds tolerance', () => {
    const bankLines = [makeBankLine({ amount_paise: 99999 })]; // way off from 50000
    const internalLines = [makePayment()];

    const result = matchS1Exact(bankLines, internalLines, DEFAULT_SETTLEMENTS, RUN_ID);
    expect(result.matchedGroups).toHaveLength(1);
    expect(result.matchedGroups[0].group.committed).toBe(false);
    expect(result.matchedGroups[0].group.confidence).toBeLessThan(1.0);
  });
});
