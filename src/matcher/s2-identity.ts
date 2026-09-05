/**
 * Bahikhata — Stage 2: Settlement Identity Check
 * 
 * For unmatched bank credits, tries to match by verifying the settlement identity:
 *   net_credited == Σ captured - Σ fees - Σ gst - Σ refunds - Σ adjustments ± tolerance
 * 
 * Matches by amount + date proximity when the identity holds.
 * Pure function, no side effects.
 */

import crypto from 'crypto';
import type { LedgerLine, MatchGroup, MatchMember, Settlement } from '../types';
import { ROUNDING_TOLERANCE_PAISE, MATCH_DATE_WINDOW_DAYS } from '../config/rules';

export interface S2Result {
  matchedGroups: Array<{
    group: MatchGroup;
    members: MatchMember[];
    settlementId: string;
    bankLineId: string;
  }>;
  unmatchedBankLines: LedgerLine[];
  unmatchedSettlementIds: string[];
}

function daysBetween(d1: string, d2: string): number {
  const t1 = new Date(d1 + 'T00:00:00Z').getTime();
  const t2 = new Date(d2 + 'T00:00:00Z').getTime();
  return Math.abs(t1 - t2) / (1000 * 60 * 60 * 24);
}

/**
 * Stage 2: Match by settlement identity verification.
 * 
 * For each unmatched settlement, find a bank credit that:
 * 1. Has amount within tolerance of expected_net
 * 2. Has date within MATCH_DATE_WINDOW_DAYS
 * 3. Settlement identity equation holds
 */
export function matchS2Identity(
  unmatchedBankLines: LedgerLine[],
  unmatchedSettlementIds: string[],
  internalLines: LedgerLine[],
  settlements: Array<{
    settlement_id: string;
    expected_net_paise: number;
    settled_on: string;
    component_payments_paise: number;
    component_fees_paise: number;
    component_gst_paise: number;
    component_refunds_paise: number;
    component_adjustments_paise: number;
  }>,
  run_id: string
): S2Result {
  const matchedGroups: S2Result['matchedGroups'] = [];
  const matchedBankLineIds = new Set<string>();
  const matchedSettlementIds = new Set<string>();

  // Build settlement map
  const settlementMap = new Map(settlements.map(s => [s.settlement_id, s]));

  for (const settlementId of unmatchedSettlementIds) {
    const settlement = settlementMap.get(settlementId);
    if (!settlement) continue;

    // Find candidate bank credits
    const candidates = unmatchedBankLines.filter(b => {
      if (matchedBankLineIds.has(b.line_id)) return false;
      if (b.direction !== 'credit') return false;

      // Amount must be within tolerance
      const amountDelta = Math.abs(b.amount_paise - settlement.expected_net_paise);
      if (amountDelta > ROUNDING_TOLERANCE_PAISE + Math.abs(settlement.expected_net_paise * 0.001)) return false;

      // Date must be within window
      if (daysBetween(b.occurred_on, settlement.settled_on) > MATCH_DATE_WINDOW_DAYS) return false;

      return true;
    });

    if (candidates.length === 1) {
      // Unique match — verify identity
      const bankLine = candidates[0];
      const delta = Math.abs(bankLine.amount_paise - settlement.expected_net_paise);

      // Verify the settlement identity
      const reconstructedNet = settlement.component_payments_paise
        - settlement.component_fees_paise
        - settlement.component_gst_paise
        - settlement.component_refunds_paise
        - settlement.component_adjustments_paise;

      const identityDelta = Math.abs(reconstructedNet - settlement.expected_net_paise);
      const identityHolds = identityDelta <= ROUNDING_TOLERANCE_PAISE;

      const group_id = crypto.createHash('md5').update(`${run_id}:s2:${settlement.settlement_id}:${bankLine.line_id}`).digest('hex');
      const group: MatchGroup = {
        group_id,
        run_id,
        strategy: 'S2_identity',
        confidence: identityHolds ? 0.90 : 0.70,
        committed: identityHolds && delta <= ROUNDING_TOLERANCE_PAISE + 100, // small tolerance for S2
        invariant_delta_paise: delta,
        settlement_id: settlementId,
      };

      const settlementPayments = internalLines.filter(l => l.settlement_id === settlementId);
      const members: MatchMember[] = [
        { group_id, line_id: bankLine.line_id },
        ...settlementPayments.map(p => ({ group_id, line_id: p.line_id })),
      ];

      matchedGroups.push({
        group,
        members,
        settlementId,
        bankLineId: bankLine.line_id,
      });

      matchedBankLineIds.add(bankLine.line_id);
      matchedSettlementIds.add(settlementId);
    }
    // If candidates.length > 1 or 0, leave for S3 or exception
  }

  const stillUnmatchedBankLines = unmatchedBankLines.filter(b => !matchedBankLineIds.has(b.line_id));
  const stillUnmatchedSettlementIds = unmatchedSettlementIds.filter(id => !matchedSettlementIds.has(id));

  return {
    matchedGroups,
    unmatchedBankLines: stillUnmatchedBankLines,
    unmatchedSettlementIds: stillUnmatchedSettlementIds,
  };
}
