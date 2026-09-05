/**
 * Bahikhata — Exception Classifier
 * 
 * Closed taxonomy of 12 exception types with evidence, severity, and proposed resolutions.
 * Each exception has a typed structure — no free-form strings.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Exception, ExceptionClass, Severity, LedgerLine } from '../types';
import type { FeeVerificationResult, SettlementIdentityResult } from '../verifier/fee-verifier';
import type { MatchPipelineResult } from '../matcher/pipeline';
import { insertException, insertAuditLog } from '../db/database';
import { UNSETTLED_CAPTURE_AGEING_DAYS } from '../config/rules';

// ─── Severity Assignment ───────────────────────────────────────────────────────

const SEVERITY_MAP: Record<ExceptionClass, Severity> = {
  MISSING_CREDIT: 'critical',
  FEE_VARIANCE: 'high',
  GST_VARIANCE: 'high',
  DUPLICATE_CREDIT: 'critical',
  TIMING_BREAK: 'medium',
  UNSETTLED_CAPTURE: 'high',
  NARRATION_UNPARSEABLE: 'low',
  AMBIGUOUS_MATCH: 'medium',
  SETTLEMENT_IDENTITY_BREAK: 'critical',
  UNMATCHED_BANK_CREDIT: 'high',
  UNMATCHED_PAYMENT: 'medium',
  ROUNDING_VARIANCE: 'info',
};

// ─── Resolution Proposals ──────────────────────────────────────────────────────

const RESOLUTION_MAP: Record<ExceptionClass, string> = {
  MISSING_CREDIT: 'Verify with bank: confirm whether settlement credit was received. If not, raise a support ticket with Razorpay referencing the settlement ID.',
  FEE_VARIANCE: 'Compare charged fee against your pricing plan on the Razorpay dashboard. If confirmed overcharge, raise a billing dispute with Razorpay support.',
  GST_VARIANCE: 'Cross-check GST computation: GST should be 18% of the platform fee. Verify the fee schedule and GST rate. If incorrect, request a revised tax invoice.',
  DUPLICATE_CREDIT: 'Flag for manual review: confirm whether the duplicate credit is genuine (e.g., a split settlement) or an error. If duplicate, the amount may be recovered by the bank.',
  TIMING_BREAK: 'Review settlement cycle: credit arrived outside the expected T+2 window. May be due to banking holidays or processing delays. Usually benign.',
  UNSETTLED_CAPTURE: 'Payment captured but not settled within expected window. Check settlement status on Razorpay dashboard. May require a support escalation.',
  NARRATION_UNPARSEABLE: 'Bank narration could not be parsed. Manual matching may be required. Consider requesting clearer narration format from the bank.',
  AMBIGUOUS_MATCH: 'Multiple valid allocations exist for this bank credit. Manual review required to select the correct match. The engine refuses to guess.',
  SETTLEMENT_IDENTITY_BREAK: 'The settlement identity equation does not hold. The components (captures - fees - GST - refunds - adjustments) do not equal the net credit. Investigate each component.',
  UNMATCHED_BANK_CREDIT: 'Bank credit could not be matched to any settlement. May be a non-Razorpay credit, a manual transfer, or a data gap.',
  UNMATCHED_PAYMENT: 'Payment exists in the ledger but has no corresponding settlement or bank credit within the expected window.',
  ROUNDING_VARIANCE: 'Small rounding difference detected. Usually benign and within acceptable tolerance. Monitor for patterns.',
};

// ─── Exception Classification ──────────────────────────────────────────────────

export function classifyExceptions(
  run_id: string,
  matchResult: MatchPipelineResult,
  feeResults: FeeVerificationResult[],
  identityResults: SettlementIdentityResult[],
  internalLines: LedgerLine[],
  bankLines: LedgerLine[],
  persistToDb: boolean = true
): Exception[] {
  const exceptions: Exception[] = [];

  // ─── 1. FEE_VARIANCE ─────────────────────────────────────────────

  const feeVariances = feeResults.filter(r => r.has_fee_variance);
  for (const fv of feeVariances) {
    const exc: Exception = {
      exception_id: uuidv4(),
      run_id,
      class: 'FEE_VARIANCE',
      severity: SEVERITY_MAP.FEE_VARIANCE,
      amount_paise: Math.abs(fv.fee_delta_paise),
      evidence: {
        payment_id: fv.payment_id,
        instrument: fv.instrument,
        amount_paise: fv.amount_paise,
        charged_fee_paise: fv.charged_fee_paise,
        expected_fee_paise: fv.expected_fee_paise,
        delta_paise: fv.fee_delta_paise,
        schedule_rate_bps: fv.schedule_rate_bps,
        schedule_effective_from: fv.schedule_effective_from,
        schedule_id: fv.schedule_id,
      },
      proposed_resolution: RESOLUTION_MAP.FEE_VARIANCE,
      explanation_text: `Payment ${fv.payment_id} (${fv.instrument}, ₹${(fv.amount_paise / 100).toFixed(2)}): charged fee ₹${(fv.charged_fee_paise / 100).toFixed(2)} vs expected ₹${(fv.expected_fee_paise / 100).toFixed(2)} (rate: ${fv.schedule_rate_bps / 100}%). Delta: ₹${(Math.abs(fv.fee_delta_paise) / 100).toFixed(2)}.`,
      resolved_by: 'unresolved',
      resolved_at: null,
      line_ids: [fv.line_id],
    };
    exceptions.push(exc);
  }

  // ─── 2. GST_VARIANCE ─────────────────────────────────────────────

  const gstVariances = feeResults.filter(r => r.has_gst_variance);
  for (const gv of gstVariances) {
    const exc: Exception = {
      exception_id: uuidv4(),
      run_id,
      class: 'GST_VARIANCE',
      severity: SEVERITY_MAP.GST_VARIANCE,
      amount_paise: Math.abs(gv.gst_delta_paise),
      evidence: {
        payment_id: gv.payment_id,
        charged_gst_paise: gv.charged_gst_paise,
        expected_gst_paise: gv.expected_gst_paise,
        delta_paise: gv.gst_delta_paise,
      },
      proposed_resolution: RESOLUTION_MAP.GST_VARIANCE,
      explanation_text: `Payment ${gv.payment_id}: charged GST ₹${(gv.charged_gst_paise / 100).toFixed(2)} vs expected ₹${(gv.expected_gst_paise / 100).toFixed(2)}. Delta: ₹${(Math.abs(gv.gst_delta_paise) / 100).toFixed(2)}.`,
      resolved_by: 'unresolved',
      resolved_at: null,
      line_ids: [gv.line_id],
    };
    exceptions.push(exc);
  }

  // ─── 3. SETTLEMENT_IDENTITY_BREAK ─────────────────────────────────

  const identityBreaks = identityResults.filter(r => !r.identity_holds && r.actual_credited_paise > 0);
  for (const ib of identityBreaks) {
    const exc: Exception = {
      exception_id: uuidv4(),
      run_id,
      class: 'SETTLEMENT_IDENTITY_BREAK',
      severity: SEVERITY_MAP.SETTLEMENT_IDENTITY_BREAK,
      amount_paise: ib.identity_delta_paise,
      evidence: {
        settlement_id: ib.settlement_id,
        components: {
          payments: ib.component_payments_paise,
          fees: ib.component_fees_paise,
          gst: ib.component_gst_paise,
          refunds: ib.component_refunds_paise,
          adjustments: ib.component_adjustments_paise,
        },
        expected_net: ib.expected_net_paise,
        actual_credited: ib.actual_credited_paise,
        delta: ib.identity_delta_paise,
      },
      proposed_resolution: RESOLUTION_MAP.SETTLEMENT_IDENTITY_BREAK,
      explanation_text: `Settlement ${ib.settlement_id}: identity break. Expected ₹${(ib.expected_net_paise / 100).toFixed(2)}, credited ₹${(ib.actual_credited_paise / 100).toFixed(2)}. Delta: ₹${(ib.identity_delta_paise / 100).toFixed(2)}.`,
      resolved_by: 'unresolved',
      resolved_at: null,
      line_ids: [],
      settlement_id: ib.settlement_id,
    };
    exceptions.push(exc);
  }

  // ─── 4. MISSING_CREDIT (unmatched settlements) ───────────────────

  for (const settlementId of matchResult.s3.unmatchedSettlementIds) {
    const idResult = identityResults.find(r => r.settlement_id === settlementId);
    const expectedAmount = idResult ? idResult.expected_net_paise : 0;
    
    const exc: Exception = {
      exception_id: uuidv4(),
      run_id,
      class: 'MISSING_CREDIT',
      severity: SEVERITY_MAP.MISSING_CREDIT,
      amount_paise: expectedAmount,
      evidence: { settlement_id: settlementId },
      proposed_resolution: RESOLUTION_MAP.MISSING_CREDIT,
      explanation_text: `Settlement ${settlementId} has no corresponding bank credit.`,
      resolved_by: 'unresolved',
      resolved_at: null,
      line_ids: [],
      settlement_id: settlementId,
    };
    exceptions.push(exc);
  }

  // ─── 5. AMBIGUOUS_MATCH ──────────────────────────────────────────

  for (const ambiguous of matchResult.s3.ambiguousGroups) {
    const bankLine = bankLines.find(b => b.line_id === ambiguous.bankLineId);
    const exc: Exception = {
      exception_id: uuidv4(),
      run_id,
      class: 'AMBIGUOUS_MATCH',
      severity: SEVERITY_MAP.AMBIGUOUS_MATCH,
      amount_paise: bankLine?.amount_paise || 0,
      evidence: {
        bank_line_id: ambiguous.bankLineId,
        possible_subsets: ambiguous.possibleSubsets,
        candidate_count: ambiguous.possibleSubsets.length,
      },
      proposed_resolution: RESOLUTION_MAP.AMBIGUOUS_MATCH,
      explanation_text: `Bank credit of ₹${((bankLine?.amount_paise || 0) / 100).toFixed(2)} has ${ambiguous.possibleSubsets.length} possible settlement allocations. Manual review required.`,
      resolved_by: 'unresolved',
      resolved_at: null,
      line_ids: [ambiguous.bankLineId],
    };
    exceptions.push(exc);
  }

  // ─── 6. UNMATCHED_BANK_CREDIT ────────────────────────────────────

  const unmatchedCredits = matchResult.s3.unmatchedBankLines.filter(b => b.direction === 'credit');
  for (const bankLine of unmatchedCredits) {
    const exc: Exception = {
      exception_id: uuidv4(),
      run_id,
      class: 'UNMATCHED_BANK_CREDIT',
      severity: SEVERITY_MAP.UNMATCHED_BANK_CREDIT,
      amount_paise: bankLine.amount_paise,
      evidence: {
        bank_line_id: bankLine.line_id,
        narration: bankLine.narration_raw,
        date: bankLine.occurred_on,
      },
      proposed_resolution: RESOLUTION_MAP.UNMATCHED_BANK_CREDIT,
      explanation_text: `Bank credit of ₹${(bankLine.amount_paise / 100).toFixed(2)} on ${bankLine.occurred_on} could not be matched to any settlement.`,
      resolved_by: 'unresolved',
      resolved_at: null,
      line_ids: [bankLine.line_id],
    };
    exceptions.push(exc);
  }

  // ─── 7. NARRATION_UNPARSEABLE ────────────────────────────────────

  const unparseableLines = bankLines.filter(b => {
    const parsed = typeof b.narration_parsed === 'string'
      ? JSON.parse(b.narration_parsed)
      : b.narration_parsed;
    return parsed && parsed.confidence === 0;
  });
  for (const line of unparseableLines) {
    const exc: Exception = {
      exception_id: uuidv4(),
      run_id,
      class: 'NARRATION_UNPARSEABLE',
      severity: SEVERITY_MAP.NARRATION_UNPARSEABLE,
      amount_paise: line.amount_paise,
      evidence: {
        bank_line_id: line.line_id,
        narration_raw: line.narration_raw,
      },
      proposed_resolution: RESOLUTION_MAP.NARRATION_UNPARSEABLE,
      explanation_text: `Bank narration could not be parsed: "${(line.narration_raw || '').slice(0, 50)}..."`,
      resolved_by: 'unresolved',
      resolved_at: null,
      line_ids: [line.line_id],
    };
    exceptions.push(exc);
  }

  // ─── 8. DUPLICATE_CREDIT ─────────────────────────────────────────

  // Detect duplicate bank credits (same amount + close date)
  const creditsByAmount = new Map<number, LedgerLine[]>();
  const bankCredits = bankLines.filter(b => b.direction === 'credit');
  for (const b of bankCredits) {
    const existing = creditsByAmount.get(b.amount_paise) || [];
    existing.push(b);
    creditsByAmount.set(b.amount_paise, existing);
  }

  for (const [amount, lines] of creditsByAmount) {
    if (lines.length > 1) {
      // Check for duplicates on the same date
      const byDate = new Map<string, LedgerLine[]>();
      for (const l of lines) {
        const existing = byDate.get(l.occurred_on) || [];
        existing.push(l);
        byDate.set(l.occurred_on, existing);
      }
      for (const [date, dateLines] of byDate) {
        if (dateLines.length > 1) {
          const exc: Exception = {
            exception_id: uuidv4(),
            run_id,
            class: 'DUPLICATE_CREDIT',
            severity: SEVERITY_MAP.DUPLICATE_CREDIT,
            amount_paise: amount * (dateLines.length - 1), // excess amount
            evidence: {
              duplicate_count: dateLines.length,
              amount_paise: amount,
              date,
              line_ids: dateLines.map(l => l.line_id),
            },
            proposed_resolution: RESOLUTION_MAP.DUPLICATE_CREDIT,
            explanation_text: `${dateLines.length} credits of ₹${(amount / 100).toFixed(2)} on ${date}. Possible duplicate — review required.`,
            resolved_by: 'unresolved',
            resolved_at: null,
            line_ids: dateLines.map(l => l.line_id),
          };
          exceptions.push(exc);
        }
      }
    }
  }

  // ─── Persist to DB ───────────────────────────────────────────────

  if (persistToDb) {
    for (const exc of exceptions) {
      insertException(exc);
      insertAuditLog({
        run_id,
        entity: 'exception',
        entity_id: exc.exception_id,
        actor: 'engine',
        action: `classified_${exc.class}`,
        after_state: {
          class: exc.class,
          severity: exc.severity,
          amount_paise: exc.amount_paise,
        },
      });
    }
  }

  return exceptions;
}
