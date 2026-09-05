/**
 * Bahikhata — Stage 3: Bounded Residual Allocation (Subset-Sum)
 * 
 * For remaining unmatched bank credits, attempt to find a subset of unmatched
 * settlement amounts that sum to the bank credit amount.
 * 
 * Bounded: ≤ RESIDUAL_SOLVER_MAX_CANDIDATES, time-boxed.
 * If uniqueness can't be established → AMBIGUOUS_MATCH exception, not a guess.
 * 
 * Pure function, no side effects. NP-hard problem with practical bounds.
 */

import crypto from 'crypto';
import type { LedgerLine, MatchGroup, MatchMember, Settlement } from '../types';
import { RESIDUAL_SOLVER_MAX_CANDIDATES, RESIDUAL_SOLVER_TIMEOUT_MS, ROUNDING_TOLERANCE_PAISE } from '../config/rules';

export interface S3Result {
  matchedGroups: Array<{
    group: MatchGroup;
    members: MatchMember[];
    settlementIds: string[];
    bankLineId: string;
  }>;
  ambiguousGroups: Array<{
    bankLineId: string;
    possibleSubsets: string[][];  // Multiple valid settlement subsets
  }>;
  unmatchedBankLines: LedgerLine[];
  unmatchedSettlementIds: string[];
}

/**
 * Subset-sum solver via dynamic programming.
 * Finds ALL subsets of `values` that sum to `target` within tolerance.
 * Returns at most 2 solutions (to detect ambiguity).
 * Time-boxed to prevent DoS.
 */
function findSubsetSums(
  items: Array<{ id: string; value: number }>,
  target: number,
  tolerance: number,
  timeoutMs: number
): string[][] {
  const solutions: string[][] = [];
  const startTime = Date.now();

  // Limit candidates
  if (items.length > RESIDUAL_SOLVER_MAX_CANDIDATES) {
    return []; // Too many candidates — escalate to exception
  }

  const n = items.length;

  // Recursive backtracking with pruning
  function backtrack(idx: number, currentSum: number, selected: string[]): void {
    // Time check
    if (Date.now() - startTime > timeoutMs) return;
    // Already found 2 solutions — enough to detect ambiguity
    if (solutions.length >= 2) return;

    // Check if current sum matches target
    if (selected.length > 0 && Math.abs(currentSum - target) <= tolerance) {
      solutions.push([...selected]);
      if (solutions.length >= 2) return;
    }

    // Prune: if current sum exceeds target (assuming positive values)
    if (currentSum > target + tolerance) return;

    for (let i = idx; i < n; i++) {
      selected.push(items[i].id);
      backtrack(i + 1, currentSum + items[i].value, selected);
      selected.pop();
    }
  }

  backtrack(0, 0, []);
  return solutions;
}

/**
 * Stage 3: Bounded residual allocation.
 * 
 * For each unmatched bank credit, find subsets of unmatched settlements
 * that sum to the credit amount. Only commit if the subset is unique.
 */
export function matchS3Residual(
  unmatchedBankLines: LedgerLine[],
  unmatchedSettlementIds: string[],
  internalLines: LedgerLine[],
  settlements: Array<{
    settlement_id: string;
    expected_net_paise: number;
    settled_on: string;
  }>,
  run_id: string
): S3Result {
  const matchedGroups: S3Result['matchedGroups'] = [];
  const ambiguousGroups: S3Result['ambiguousGroups'] = [];
  const matchedBankLineIds = new Set<string>();
  const matchedSettlementIds = new Set<string>();

  // Build items for subset-sum
  const settlementMap = new Map(settlements.map(s => [s.settlement_id, s]));
  const availableSettlements = unmatchedSettlementIds
    .map(id => settlementMap.get(id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined);

  // Only process credit bank lines
  const bankCredits = unmatchedBankLines.filter(b => b.direction === 'credit');

  for (const bankLine of bankCredits) {
    if (matchedBankLineIds.has(bankLine.line_id)) continue;

    // Filter to settlements not yet matched
    const candidates = availableSettlements
      .filter(s => !matchedSettlementIds.has(s.settlement_id))
      .map(s => ({ id: s.settlement_id, value: s.expected_net_paise }));

    if (candidates.length === 0) continue;
    if (candidates.length > RESIDUAL_SOLVER_MAX_CANDIDATES) {
      // Too many candidates — this becomes an ambiguous match
      ambiguousGroups.push({
        bankLineId: bankLine.line_id,
        possibleSubsets: [],
      });
      continue;
    }

    const subsets = findSubsetSums(
      candidates,
      bankLine.amount_paise,
      ROUNDING_TOLERANCE_PAISE,
      RESIDUAL_SOLVER_TIMEOUT_MS
    );

    if (subsets.length === 1) {
      // Unique solution — commit
      const solutionIds = subsets[0];
      const subsetKey = solutionIds.slice().sort().join(',');
      const group_id = crypto.createHash('md5').update(`${run_id}:s3:${bankLine.line_id}:${subsetKey}`).digest('hex');

      const group: MatchGroup = {
        group_id,
        run_id,
        strategy: 'S3_residual',
        confidence: 0.85,
        committed: true,
        invariant_delta_paise: 0,
        settlement_id: solutionIds.join(','),
      };

      // Members: bank line + all payment lines for matched settlements
      const paymentLines = internalLines.filter(l =>
        l.settlement_id && solutionIds.includes(l.settlement_id)
      );
      const members: MatchMember[] = [
        { group_id, line_id: bankLine.line_id },
        ...paymentLines.map(p => ({ group_id, line_id: p.line_id })),
      ];

      matchedGroups.push({
        group,
        members,
        settlementIds: solutionIds,
        bankLineId: bankLine.line_id,
      });

      matchedBankLineIds.add(bankLine.line_id);
      for (const sid of solutionIds) {
        matchedSettlementIds.add(sid);
      }
    } else if (subsets.length > 1) {
      // Ambiguous — refuse to pick
      ambiguousGroups.push({
        bankLineId: bankLine.line_id,
        possibleSubsets: subsets,
      });
    }
    // subsets.length === 0 → no match found, leave as unmatched
  }

  const stillUnmatchedBankLines = bankCredits.filter(b => !matchedBankLineIds.has(b.line_id));
  // Also include debit lines that were never candidates
  const debitLines = unmatchedBankLines.filter(b => b.direction === 'debit');
  
  const stillUnmatchedSettlementIds = unmatchedSettlementIds.filter(id => !matchedSettlementIds.has(id));

  return {
    matchedGroups,
    ambiguousGroups,
    unmatchedBankLines: [...stillUnmatchedBankLines, ...debitLines],
    unmatchedSettlementIds: stillUnmatchedSettlementIds,
  };
}
