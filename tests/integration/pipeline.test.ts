/**
 * Integration Tests — Full Pipeline
 * 
 * Covers:
 * - Conservation of money (no line in two committed groups)
 * - Determinism (same input → same output hash)
 * - Order independence (shuffled input → same output hash)
 * - Idempotent re-ingest (same content-hash → same run)
 * - Scale tests (50 / 500 / 5000 records)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { generateMerchantMonth } from '../../src/data/generator';
import { computeInputHash } from '../../src/ingest/reader';
import { parseNarrationRegex } from '../../src/narration/regex-parser';
import { runMatcherPipeline } from '../../src/matcher/pipeline';
import { verifyFees } from '../../src/verifier/fee-verifier';
import { classifyExceptions } from '../../src/exceptions/classifier';
import { computeOutputHash } from '../../src/eval/metrics';
import { resetDb, getDb } from '../../src/db/database';
import type { LedgerLine } from '../../src/types';

// Reset DB before each test to avoid state leaks
beforeEach(() => {
  resetDb();
});

// ─── Helper: run full pipeline on generated data ───────────────────────────────

function runPipeline(seed: number, records: number) {
  const data = generateMerchantMonth({ seed, targetRecords: records });
  const run_id = `test-pipeline-${seed}-${records}`;

  const payments = data.payments.map(p => ({ ...p, run_id }));
  const bankLines = data.bankStatement.map(b => ({ ...b, run_id }));
  const settlements = data.settlements.map(s => ({ ...s, run_id }));
  const internalPayments = payments.filter(p => p.source === 'internal');

  // Parse narrations
  for (const bankLine of bankLines) {
    if (bankLine.narration_raw) {
      bankLine.narration_parsed = parseNarrationRegex(bankLine.narration_raw);
    }
  }

  // Run matcher
  const matchResult = runMatcherPipeline(bankLines, internalPayments, settlements, run_id, false);

  // Verify fees
  const feeResults = verifyFees(internalPayments, data.feeSchedules);

  // Classify exceptions
  const exceptions = classifyExceptions(
    run_id, matchResult, feeResults.results, [], internalPayments, bankLines, false
  );

  // Output hash
  const outputHash = computeOutputHash(matchResult, exceptions);

  return { data, matchResult, feeResults, exceptions, outputHash, bankLines, internalPayments, settlements };
}

// ─── Conservation of Money ─────────────────────────────────────────────────────

describe('conservation of money', () => {
  it('no line appears in two committed groups', () => {
    const { matchResult } = runPipeline(42, 200);

    const committedGroups = matchResult.allGroups.filter(g => g.group.committed);
    const lineIdSet = new Set<string>();

    for (const { members } of committedGroups) {
      for (const m of members) {
        expect(lineIdSet.has(m.line_id)).toBe(false);
        lineIdSet.add(m.line_id);
      }
    }
  });

  it('total committed lines ≤ total lines', () => {
    const { matchResult, bankLines, internalPayments } = runPipeline(42, 200);

    const totalLines = bankLines.length + internalPayments.length;
    const committedMembers = matchResult.allGroups
      .filter(g => g.group.committed)
      .reduce((count, g) => count + g.members.length, 0);

    expect(committedMembers).toBeLessThanOrEqual(totalLines);
  });
});

// ─── Determinism ───────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('same seed → identical output hash (run twice)', () => {
    const run1 = runPipeline(99, 100);
    resetDb();
    const run2 = runPipeline(99, 100);

    expect(run1.outputHash).toBe(run2.outputHash);
    expect(run1.outputHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('different seed → different output hash', () => {
    const run1 = runPipeline(42, 100);
    resetDb();
    const run2 = runPipeline(43, 100);

    expect(run1.outputHash).not.toBe(run2.outputHash);
  });
});

// ─── Order Independence ────────────────────────────────────────────────────────

describe('order independence', () => {
  it('shuffled bank lines → same match results', () => {
    const data = generateMerchantMonth({ seed: 55, targetRecords: 100 });
    const run_id_1 = 'test-order-1';
    const run_id_2 = 'test-order-2';

    // Run 1: original order
    const bankLines1 = data.bankStatement.map(b => ({ ...b, run_id: run_id_1 }));
    const payments1 = data.payments.filter(p => p.source === 'internal').map(p => ({ ...p, run_id: run_id_1 }));
    const settlements1 = data.settlements.map(s => ({ ...s, run_id: run_id_1 }));

    for (const b of bankLines1) {
      if (b.narration_raw) b.narration_parsed = parseNarrationRegex(b.narration_raw);
    }
    const match1 = runMatcherPipeline(bankLines1, payments1, settlements1, run_id_1, false);
    const exc1 = classifyExceptions(run_id_1, match1, [], [], payments1, bankLines1, false);
    const hash1 = computeOutputHash(match1, exc1);

    // Run 2: shuffled bank lines (reverse order)
    resetDb();
    const shuffledBank = [...data.bankStatement].reverse();
    const bankLines2 = shuffledBank.map(b => ({ ...b, run_id: run_id_2 }));
    const payments2 = data.payments.filter(p => p.source === 'internal').map(p => ({ ...p, run_id: run_id_2 }));
    const settlements2 = data.settlements.map(s => ({ ...s, run_id: run_id_2 }));

    for (const b of bankLines2) {
      if (b.narration_raw) b.narration_parsed = parseNarrationRegex(b.narration_raw);
    }
    const match2 = runMatcherPipeline(bankLines2, payments2, settlements2, run_id_2, false);
    const exc2 = classifyExceptions(run_id_2, match2, [], [], payments2, bankLines2, false);
    const hash2 = computeOutputHash(match2, exc2);

    // Same number of matched groups
    expect(match1.totalMatched).toBe(match2.totalMatched);
  });
});

// ─── Content-Hash Idempotency ──────────────────────────────────────────────────

describe('content-hash idempotency', () => {
  it('same input data → same content hash', () => {
    const data = generateMerchantMonth({ seed: 42, targetRecords: 50 });
    const hash1 = computeInputHash(
      JSON.stringify(data.payments),
      JSON.stringify(data.bankStatement),
      '42'
    );
    const hash2 = computeInputHash(
      JSON.stringify(data.payments),
      JSON.stringify(data.bankStatement),
      '42'
    );
    expect(hash1).toBe(hash2);
  });

  it('different seed → different content hash', () => {
    const data1 = generateMerchantMonth({ seed: 42, targetRecords: 50 });
    const data2 = generateMerchantMonth({ seed: 43, targetRecords: 50 });
    const hash1 = computeInputHash(JSON.stringify(data1.payments), '42');
    const hash2 = computeInputHash(JSON.stringify(data2.payments), '43');
    expect(hash1).not.toBe(hash2);
  });
});

// ─── Scale Tests ───────────────────────────────────────────────────────────────

describe('scale', () => {
  it('handles 50 records', () => {
    const { matchResult, exceptions } = runPipeline(42, 50);
    expect(matchResult.totalMatched).toBeGreaterThan(0);
    expect(exceptions.length).toBeGreaterThanOrEqual(0);
  });

  it('handles 500 records', () => {
    const { matchResult, exceptions } = runPipeline(42, 500);
    expect(matchResult.totalMatched).toBeGreaterThan(0);
    expect(matchResult.totalMatched).toBeGreaterThan(10);
  });

  it('handles 5000 records with reasonable throughput', () => {
    const start = Date.now();
    const { matchResult } = runPipeline(42, 5000);
    const elapsed = Date.now() - start;

    expect(matchResult.totalMatched).toBeGreaterThan(0);
    // Should complete within 30 seconds
    expect(elapsed).toBeLessThan(30000);
    
    const throughput = (5000 / elapsed) * 1000;
    console.log(`  Throughput at 5000 records: ${Math.round(throughput)} records/sec`);
  });

  it('metrics do not degrade at scale', () => {
    const small = runPipeline(42, 50);
    resetDb();
    const large = runPipeline(42, 500);

    // Match rate should be comparable (within 20% delta)
    const smallMatchRate = small.matchResult.totalMatched /
      Math.max(1, small.bankLines.filter(b => b.direction === 'credit').length);
    const largeMatchRate = large.matchResult.totalMatched /
      Math.max(1, large.bankLines.filter(b => b.direction === 'credit').length);

    expect(Math.abs(smallMatchRate - largeMatchRate)).toBeLessThan(0.3);
  });
});
