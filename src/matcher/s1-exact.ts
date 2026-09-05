/**
 * Bahikhata — Stage 1: Exact Identifier Match
 * 
 * Matches bank credits to settlements/payments by exact UTR, RRN, or settlement_id.
 * This is the highest-confidence stage — equivalent to a database join.
 * Pure function, no side effects.
 */

import crypto from 'crypto';
import type { LedgerLine, MatchGroup, MatchMember, Settlement } from '../types';
import { ROUNDING_TOLERANCE_PAISE } from '../config/rules';

export interface S1Result {
  matchedGroups: Array<{
    group: MatchGroup;
    members: MatchMember[];
    settlementId: string;
    bankLineId: string;
  }>;
  unmatchedBankLines: LedgerLine[];
  unmatchedSettlementIds: string[];
}

/**
 * Stage 1: Match bank credits to settlements by exact identifier.
 * 
 * A bank line matches a settlement if:
 * 1. UTR in parsed narration matches a settlement's UTR, OR
 * 2. Settlement ID appears in the narration
 * 
 * Only credit lines are considered (debits are bank charges, ignored).
 */
export function matchS1Exact(
  bankLines: LedgerLine[],
  internalLines: LedgerLine[],
  settlements: Array<{ settlement_id: string; expected_net_paise: number; settled_on: string }>,
  run_id: string
): S1Result {
  const matchedGroups: S1Result['matchedGroups'] = [];
  const matchedBankLineIds = new Set<string>();
  const matchedSettlementIds = new Set<string>();

  // Build lookup maps
  const settlementByUtr = new Map<string, typeof settlements[0]>();
  const settlementById = new Map<string, typeof settlements[0]>();
  
  // Map UTRs from internal payments to their settlements
  const utrToSettlement = new Map<string, string>();
  for (const line of internalLines) {
    if (line.utr && line.settlement_id) {
      utrToSettlement.set(line.utr, line.settlement_id);
    }
  }

  for (const s of settlements) {
    settlementById.set(s.settlement_id, s);
  }

  // Only consider credit lines from bank
  const bankCredits = bankLines.filter(b => b.direction === 'credit');

  for (const bankLine of bankCredits) {
    if (matchedBankLineIds.has(bankLine.line_id)) continue;

    const parsed = bankLine.narration_parsed
      ? (typeof bankLine.narration_parsed === 'string' ? JSON.parse(bankLine.narration_parsed) : bankLine.narration_parsed)
      : null;

    let matchedSettlement: typeof settlements[0] | undefined;

    // Try matching by UTR
    if (parsed?.utr) {
      // Direct UTR match against internal payment UTRs
      const settlementId = utrToSettlement.get(parsed.utr);
      if (settlementId) {
        matchedSettlement = settlementById.get(settlementId);
      }
    }

    // Try matching by bank line's UTR field directly
    if (!matchedSettlement && bankLine.utr) {
      const settlementId = utrToSettlement.get(bankLine.utr);
      if (settlementId) {
        matchedSettlement = settlementById.get(settlementId);
      }
    }

    // Try matching by settlement_id in narration
    if (!matchedSettlement && parsed?.settlement_id) {
      matchedSettlement = settlementById.get(parsed.settlement_id);
    }

    if (matchedSettlement && !matchedSettlementIds.has(matchedSettlement.settlement_id)) {
      const group_id = crypto.createHash('md5').update(`${run_id}:s1:${matchedSettlement.settlement_id}:${bankLine.line_id}`).digest('hex');
      
      // Compute invariant delta
      const delta = Math.abs(bankLine.amount_paise - matchedSettlement.expected_net_paise);

      // Only commit if within tolerance
      const withinTolerance = delta <= ROUNDING_TOLERANCE_PAISE;

      const group: MatchGroup = {
        group_id,
        run_id,
        strategy: 'S1_exact',
        confidence: withinTolerance ? 1.0 : 0.8,
        committed: withinTolerance,
        invariant_delta_paise: delta,
        settlement_id: matchedSettlement.settlement_id,
      };

      // Members: the bank line + all internal lines for this settlement
      const settlementPayments = internalLines.filter(l => l.settlement_id === matchedSettlement!.settlement_id);
      const members: MatchMember[] = [
        { group_id, line_id: bankLine.line_id },
        ...settlementPayments.map(p => ({ group_id, line_id: p.line_id })),
      ];

      matchedGroups.push({
        group,
        members,
        settlementId: matchedSettlement.settlement_id,
        bankLineId: bankLine.line_id,
      });

      matchedBankLineIds.add(bankLine.line_id);
      matchedSettlementIds.add(matchedSettlement.settlement_id);
    }
  }

  const unmatchedBankLines = bankCredits.filter(b => !matchedBankLineIds.has(b.line_id));
  const unmatchedSettlementIds = settlements
    .map(s => s.settlement_id)
    .filter(id => !matchedSettlementIds.has(id));

  return { matchedGroups, unmatchedBankLines, unmatchedSettlementIds };
}
