/**
 * Tests for S3 Bounded Residual Allocation (Subset-Sum)
 * Covers: unique solution → commit, multiple solutions → AMBIGUOUS_MATCH,
 * >20 candidates → escalated, timeout behavior
 */
import { describe, it, expect } from 'vitest';
import { matchS3Residual } from '../../src/matcher/s3-residual';
import type { LedgerLine } from '../../src/types';

const RUN_ID = 'test-run-s3';

function makeBankLine(overrides: Partial<LedgerLine> = {}): LedgerLine {
  return {
    line_id: `bank-${Math.random().toString(36).slice(2, 8)}`,
    run_id: RUN_ID,
    source: 'bank',
    amount_paise: 150000,
    direction: 'credit',
    occurred_on: '2026-08-12',
    is_refund: false,
    is_dispute: false,
    ...overrides,
  };
}

function makePayment(settlementId: string, overrides: Partial<LedgerLine> = {}): LedgerLine {
  return {
    line_id: `pay-${Math.random().toString(36).slice(2, 8)}`,
    run_id: RUN_ID,
    source: 'internal',
    amount_paise: 50000,
    direction: 'credit',
    occurred_on: '2026-08-10',
    settlement_id: settlementId,
    instrument: 'card',
    is_refund: false,
    is_dispute: false,
    ...overrides,
  };
}

describe('matchS3Residual', () => {
  it('commits when a unique subset sums to bank credit', () => {
    // Bank credit = 150000
    // Settlements: 80000 + 70000 = 150000 (unique)
    const bankLines = [makeBankLine({ amount_paise: 150000 })];
    const settlements = [
      { settlement_id: 'setl_a', expected_net_paise: 80000, settled_on: '2026-08-12' },
      { settlement_id: 'setl_b', expected_net_paise: 70000, settled_on: '2026-08-12' },
      { settlement_id: 'setl_c', expected_net_paise: 30000, settled_on: '2026-08-12' },
    ];
    const internalLines = [
      makePayment('setl_a'),
      makePayment('setl_b'),
      makePayment('setl_c'),
    ];

    const result = matchS3Residual(
      bankLines, ['setl_a', 'setl_b', 'setl_c'], internalLines, settlements, RUN_ID
    );

    expect(result.matchedGroups).toHaveLength(1);
    expect(result.matchedGroups[0].group.strategy).toBe('S3_residual');
    expect(result.matchedGroups[0].group.committed).toBe(true);
    expect(result.matchedGroups[0].settlementIds).toContain('setl_a');
    expect(result.matchedGroups[0].settlementIds).toContain('setl_b');
    expect(result.ambiguousGroups).toHaveLength(0);
  });

  it('flags AMBIGUOUS_MATCH when two subsets sum to the same amount', () => {
    // Bank credit = 100000
    // Subset A: 60000 + 40000 = 100000
    // Subset B: 70000 + 30000 = 100000
    const bankLines = [makeBankLine({ amount_paise: 100000 })];
    const settlements = [
      { settlement_id: 'setl_1', expected_net_paise: 60000, settled_on: '2026-08-12' },
      { settlement_id: 'setl_2', expected_net_paise: 40000, settled_on: '2026-08-12' },
      { settlement_id: 'setl_3', expected_net_paise: 70000, settled_on: '2026-08-12' },
      { settlement_id: 'setl_4', expected_net_paise: 30000, settled_on: '2026-08-12' },
    ];
    const internalLines = settlements.map(s => makePayment(s.settlement_id));

    const result = matchS3Residual(
      bankLines,
      settlements.map(s => s.settlement_id),
      internalLines,
      settlements,
      RUN_ID
    );

    expect(result.ambiguousGroups.length).toBeGreaterThanOrEqual(1);
    // Should NOT commit — ambiguous
    expect(result.matchedGroups).toHaveLength(0);
  });

  it('escalates when >20 candidates (exceeds solver bound)', () => {
    const bankLines = [makeBankLine({ amount_paise: 500000 })];
    
    // 25 settlements → exceeds RESIDUAL_SOLVER_MAX_CANDIDATES (20)
    const settlements = Array.from({ length: 25 }, (_, i) => ({
      settlement_id: `setl_${i}`,
      expected_net_paise: 20000 + i * 100,
      settled_on: '2026-08-12',
    }));
    const internalLines = settlements.map(s => makePayment(s.settlement_id));

    const result = matchS3Residual(
      bankLines,
      settlements.map(s => s.settlement_id),
      internalLines,
      settlements,
      RUN_ID
    );

    // Should escalate to ambiguous, not attempt to solve
    expect(result.ambiguousGroups).toHaveLength(1);
    expect(result.matchedGroups).toHaveLength(0);
  });

  it('returns unmatched when no subset sums to the target', () => {
    const bankLines = [makeBankLine({ amount_paise: 999999 })]; // no subset can match
    const settlements = [
      { settlement_id: 'setl_x', expected_net_paise: 10000, settled_on: '2026-08-12' },
      { settlement_id: 'setl_y', expected_net_paise: 20000, settled_on: '2026-08-12' },
    ];
    const internalLines = settlements.map(s => makePayment(s.settlement_id));

    const result = matchS3Residual(
      bankLines, ['setl_x', 'setl_y'], internalLines, settlements, RUN_ID
    );

    expect(result.matchedGroups).toHaveLength(0);
    expect(result.unmatchedBankLines).toHaveLength(1);
  });

  it('handles single settlement matching exactly', () => {
    const bankLines = [makeBankLine({ amount_paise: 50000 })];
    const settlements = [
      { settlement_id: 'setl_single', expected_net_paise: 50000, settled_on: '2026-08-12' },
    ];
    const internalLines = [makePayment('setl_single')];

    const result = matchS3Residual(
      bankLines, ['setl_single'], internalLines, settlements, RUN_ID
    );

    expect(result.matchedGroups).toHaveLength(1);
    expect(result.matchedGroups[0].group.committed).toBe(true);
  });

  it('ignores debit bank lines', () => {
    const bankLines = [makeBankLine({ direction: 'debit', amount_paise: 50000 })];
    const settlements = [
      { settlement_id: 'setl_d', expected_net_paise: 50000, settled_on: '2026-08-12' },
    ];
    const internalLines = [makePayment('setl_d')];

    const result = matchS3Residual(
      bankLines, ['setl_d'], internalLines, settlements, RUN_ID
    );

    expect(result.matchedGroups).toHaveLength(0);
  });

  it('handles empty inputs gracefully', () => {
    const result = matchS3Residual([], [], [], [], RUN_ID);
    expect(result.matchedGroups).toHaveLength(0);
    expect(result.ambiguousGroups).toHaveLength(0);
    expect(result.unmatchedBankLines).toHaveLength(0);
  });
});
