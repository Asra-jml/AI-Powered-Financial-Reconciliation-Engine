/**
 * Bahikhata — Arithmetic Verifier
 * 
 * Recomputes expected fee and GST per payment from versioned fee schedules.
 * Detects fee variance and GST variance.
 * All arithmetic is integer paise — never floats.
 * 
 * The settlement identity:
 *   net_credited == Σ captured - Σ fees - Σ gst - Σ refunds - Σ adjustments ± tolerance
 */

import type { LedgerLine, FeeSchedule } from '../types';
import { ROUNDING_TOLERANCE_PAISE, GST_ON_GATEWAY_FEES_BPS } from '../config/rules';

export interface FeeVerificationResult {
  payment_id: string;
  line_id: string;
  instrument: string;
  amount_paise: number;
  occurred_on: string;

  // Charged (from data)
  charged_fee_paise: number;
  charged_gst_paise: number;

  // Expected (recomputed from schedule)
  expected_fee_paise: number;
  expected_gst_paise: number;

  // Variance
  fee_delta_paise: number;
  gst_delta_paise: number;
  has_fee_variance: boolean;
  has_gst_variance: boolean;

  // Schedule used
  schedule_id: string | null;
  schedule_rate_bps: number;
  schedule_effective_from: string;
}

export interface SettlementIdentityResult {
  settlement_id: string;
  component_payments_paise: number;
  component_fees_paise: number;
  component_gst_paise: number;
  component_refunds_paise: number;
  component_adjustments_paise: number;
  expected_net_paise: number;
  actual_credited_paise: number;
  identity_delta_paise: number;
  identity_holds: boolean;
}

/**
 * Compute expected fee for a payment using the versioned fee schedule.
 * Selects the schedule by instrument and payment date.
 */
export function computeExpectedFee(
  amountPaise: number,
  instrument: string,
  date: string,
  schedules: FeeSchedule[]
): { feePaise: number; gstPaise: number; schedule: FeeSchedule | null } {
  // Find applicable schedule
  const schedule = schedules.find(s =>
    s.instrument === instrument &&
    s.effective_from <= date &&
    (s.effective_to === null || s.effective_to >= date)
  ) || null;

  if (!schedule) {
    return { feePaise: 0, gstPaise: 0, schedule: null };
  }

  // Integer arithmetic: (amount * rate_bps) / 10000 + flat_fee
  const feePaise = Math.round((amountPaise * schedule.rate_bps) / 10000) + schedule.flat_fee_paise;
  const gstPaise = Math.round((feePaise * schedule.gst_bps) / 10000);

  return { feePaise, gstPaise, schedule };
}

/**
 * Verify fees and GST for a batch of payments.
 * Returns variance details for each payment.
 */
export function verifyFees(
  payments: LedgerLine[],
  schedules: FeeSchedule[]
): {
  results: FeeVerificationResult[];
  totalFeeVariancePaise: number;
  totalGstVariancePaise: number;
  feeVarianceCount: number;
  gstVarianceCount: number;
} {
  const results: FeeVerificationResult[] = [];
  let totalFeeVariancePaise = 0;
  let totalGstVariancePaise = 0;
  let feeVarianceCount = 0;
  let gstVarianceCount = 0;

  for (const payment of payments) {
    if (payment.is_refund || payment.is_dispute) continue;
    if (!payment.instrument) continue;

    const { feePaise, gstPaise, schedule } = computeExpectedFee(
      payment.amount_paise,
      payment.instrument,
      payment.occurred_on,
      schedules
    );

    const chargedFee = payment.fee_paise || 0;
    const chargedGst = payment.gst_paise || 0;

    const feeDelta = chargedFee - feePaise;
    const gstDelta = chargedGst - gstPaise;

    const hasFeeVariance = Math.abs(feeDelta) > ROUNDING_TOLERANCE_PAISE;
    const hasGstVariance = Math.abs(gstDelta) > ROUNDING_TOLERANCE_PAISE;

    if (hasFeeVariance) {
      feeVarianceCount++;
      totalFeeVariancePaise += feeDelta;
    }
    if (hasGstVariance) {
      gstVarianceCount++;
      totalGstVariancePaise += gstDelta;
    }

    results.push({
      payment_id: payment.payment_id || payment.external_id || payment.line_id,
      line_id: payment.line_id,
      instrument: payment.instrument,
      amount_paise: payment.amount_paise,
      occurred_on: payment.occurred_on,
      charged_fee_paise: chargedFee,
      charged_gst_paise: chargedGst,
      expected_fee_paise: feePaise,
      expected_gst_paise: gstPaise,
      fee_delta_paise: feeDelta,
      gst_delta_paise: gstDelta,
      has_fee_variance: hasFeeVariance,
      has_gst_variance: hasGstVariance,
      schedule_id: schedule?.schedule_id || null,
      schedule_rate_bps: schedule?.rate_bps || 0,
      schedule_effective_from: schedule?.effective_from || '',
    });
  }

  return {
    results,
    totalFeeVariancePaise,
    totalGstVariancePaise,
    feeVarianceCount,
    gstVarianceCount,
  };
}

/**
 * Verify the settlement identity equation for each settlement.
 */
export function verifySettlementIdentity(
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
  actualCredits: Map<string, number> // settlement_id → actual bank credit paise
): SettlementIdentityResult[] {
  return settlements.map(s => {
    const reconstructedNet = s.component_payments_paise
      - s.component_fees_paise
      - s.component_gst_paise
      - s.component_refunds_paise
      - s.component_adjustments_paise;

    const actualCredited = actualCredits.get(s.settlement_id) || 0;
    const identityDelta = Math.abs(reconstructedNet - actualCredited);

    return {
      settlement_id: s.settlement_id,
      component_payments_paise: s.component_payments_paise,
      component_fees_paise: s.component_fees_paise,
      component_gst_paise: s.component_gst_paise,
      component_refunds_paise: s.component_refunds_paise,
      component_adjustments_paise: s.component_adjustments_paise,
      expected_net_paise: reconstructedNet,
      actual_credited_paise: actualCredited,
      identity_delta_paise: identityDelta,
      identity_holds: identityDelta <= ROUNDING_TOLERANCE_PAISE,
    };
  });
}
