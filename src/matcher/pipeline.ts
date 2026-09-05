/**
 * Bahikhata — Matcher Pipeline
 * 
 * Orchestrates S1 → S2 → S3 with precision-first commit policy.
 * Ambiguity becomes an exception, never a guess.
 */

import { matchS1Exact, type S1Result } from './s1-exact';
import { matchS2Identity, type S2Result } from './s2-identity';
import { matchS3Residual, type S3Result } from './s3-residual';
import { parseNarrationRegex } from '../narration/regex-parser';
import type { LedgerLine, MatchGroup, MatchMember } from '../types';
import {
  insertMatchGroup, insertMatchMembers, insertAuditLog,
  updateSettlementStatus, commitMatchGroup
} from '../db/database';

export interface MatchPipelineResult {
  s1: S1Result;
  s2: S2Result;
  s3: S3Result;
  totalMatched: number;
  totalMatchedValuePaise: number;
  totalUnmatched: number;
  ambiguousCount: number;
  allGroups: Array<{ group: MatchGroup; members: MatchMember[] }>;
}

/**
 * Run the full three-stage matching pipeline.
 * 
 * Pre-condition: bank lines should have narration_parsed populated.
 */
export function runMatcherPipeline(
  bankLines: LedgerLine[],
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
  run_id: string,
  persistToDb: boolean = true
): MatchPipelineResult {
  // ─── Pre-process: parse narrations if not already done ───────────

  for (const bankLine of bankLines) {
    if (!bankLine.narration_parsed && bankLine.narration_raw) {
      const parsed = parseNarrationRegex(bankLine.narration_raw);
      bankLine.narration_parsed = parsed;
    }
  }

  // ─── Stage 1: Exact identifier match ─────────────────────────────

  const s1 = matchS1Exact(bankLines, internalLines, settlements, run_id);

  // ─── Stage 2: Settlement identity check ──────────────────────────

  const s2 = matchS2Identity(
    s1.unmatchedBankLines,
    s1.unmatchedSettlementIds,
    internalLines,
    settlements,
    run_id
  );

  // ─── Stage 3: Bounded residual allocation ────────────────────────

  const s3 = matchS3Residual(
    s2.unmatchedBankLines,
    s2.unmatchedSettlementIds,
    internalLines,
    settlements,
    run_id
  );

  // ─── Collect all groups ──────────────────────────────────────────

  const allGroups: Array<{ group: MatchGroup; members: MatchMember[] }> = [];

  for (const g of s1.matchedGroups) {
    allGroups.push({ group: g.group, members: g.members });
  }
  for (const g of s2.matchedGroups) {
    allGroups.push({ group: g.group, members: g.members });
  }
  for (const g of s3.matchedGroups) {
    allGroups.push({ group: g.group, members: g.members });
  }

  // ─── Persist to DB ───────────────────────────────────────────────

  if (persistToDb) {
    for (const { group, members } of allGroups) {
      insertMatchGroup(group);
      insertMatchMembers(members);

      if (group.committed) {
        // Update settlement status
        if (group.settlement_id) {
          const sids = group.settlement_id.split(',');
          for (const sid of sids) {
            const bankMember = members.find(m => {
              const bankLine = bankLines.find(b => b.line_id === m.line_id);
              return bankLine !== undefined;
            });
            updateSettlementStatus(
              sid, run_id, 'matched',
              bankMember?.line_id
            );
          }
        }

        insertAuditLog({
          run_id,
          entity: 'match_group',
          entity_id: group.group_id,
          actor: 'engine',
          action: `committed_${group.strategy}`,
          after_state: {
            strategy: group.strategy,
            confidence: group.confidence,
            member_count: members.length,
            invariant_delta_paise: group.invariant_delta_paise,
          },
        });
      }
    }
  }

  // ─── Compute summary ────────────────────────────────────────────

  const committedGroups = allGroups.filter(g => g.group.committed);
  const matchedBankLineIds = new Set<string>();
  
  for (const { members } of committedGroups) {
    for (const m of members) {
      const bankLine = bankLines.find(b => b.line_id === m.line_id);
      if (bankLine) matchedBankLineIds.add(bankLine.line_id);
    }
  }

  const bankCredits = bankLines.filter(b => b.direction === 'credit');
  const totalMatchedValuePaise = bankCredits
    .filter(b => matchedBankLineIds.has(b.line_id))
    .reduce((s, b) => s + b.amount_paise, 0);

  return {
    s1,
    s2,
    s3,
    totalMatched: matchedBankLineIds.size,
    totalMatchedValuePaise,
    totalUnmatched: bankCredits.length - matchedBankLineIds.size,
    ambiguousCount: s3.ambiguousGroups.length,
    allGroups,
  };
}
