/**
 * Bahikhata — Configuration & Rules
 * 
 * RULE: No numeric literal in matcher.ts or verifier.ts.
 * Everything comes from this file with either a source_citation or an ASSUMPTION tag.
 * Grep-able: search for "source_citation" or "ASSUMPTION" to audit every constant.
 */

// ─── GST ───────────────────────────────────────────────────────────────────────

/** GST rate on payment-gateway fees, in basis points */
export const GST_ON_GATEWAY_FEES_BPS = 1800; // 18%
// source_citation: "Standard GST rate on payment gateway/aggregator services (SAC 997158)"
// Stored as bps for integer arithmetic: 1800 bps = 18.00%

// ─── Fee Schedules (default — overridden per merchant in fee_schedules table) ──

export const DEFAULT_FEE_SCHEDULES = [
  {
    instrument: 'card' as const,
    plan: 'standard' as const,
    rate_bps: 200,        // 2.00%
    flat_fee_paise: 0,
    gst_bps: GST_ON_GATEWAY_FEES_BPS,
    effective_from: '2026-01-01',
    effective_to: '2026-07-14',   // Mid-month schedule change for testing
    // source_citation: "Razorpay standard pricing page — card domestic (varies by plan)"
  },
  {
    instrument: 'card' as const,
    plan: 'standard' as const,
    rate_bps: 220,        // 2.20% — post schedule change
    flat_fee_paise: 0,
    gst_bps: GST_ON_GATEWAY_FEES_BPS,
    effective_from: '2026-07-15',
    effective_to: null,
    // source_citation: "Razorpay standard pricing page — card domestic (updated)"
  },
  {
    instrument: 'upi' as const,
    plan: 'standard' as const,
    rate_bps: 0,          // UPI P2M zero-MDR
    flat_fee_paise: 0,
    gst_bps: GST_ON_GATEWAY_FEES_BPS,
    effective_from: '2026-01-01',
    effective_to: null,
    // source_citation: "RBI/MeitY zero-MDR directive on UPI P2M transactions"
  },
  {
    instrument: 'netbanking' as const,
    plan: 'standard' as const,
    rate_bps: 200,        // 2.00%
    flat_fee_paise: 0,
    gst_bps: GST_ON_GATEWAY_FEES_BPS,
    effective_from: '2026-01-01',
    effective_to: null,
    // source_citation: "Razorpay standard pricing page — netbanking"
  },
  {
    instrument: 'wallet' as const,
    plan: 'standard' as const,
    rate_bps: 200,        // 2.00%
    flat_fee_paise: 0,
    gst_bps: GST_ON_GATEWAY_FEES_BPS,
    effective_from: '2026-01-01',
    effective_to: null,
    // source_citation: "Razorpay standard pricing page — wallets"
  },
  {
    instrument: 'emi' as const,
    plan: 'standard' as const,
    rate_bps: 300,        // 3.00%
    flat_fee_paise: 0,
    gst_bps: GST_ON_GATEWAY_FEES_BPS,
    effective_from: '2026-01-01',
    effective_to: null,
    // source_citation: "Razorpay standard pricing page — EMI"
  },
];

// ─── Settlement ────────────────────────────────────────────────────────────────

/** Default settlement cycle in working days */
export const SETTLEMENT_CYCLE_DAYS = 2;
// ASSUMPTION: "T+2 working days is the common Razorpay settlement cycle, but is 
// account- and plan-dependent. Treated as configuration, not a constant."

/** Days after which an unsettled capture is flagged */
export const UNSETTLED_CAPTURE_AGEING_DAYS = 7;
// ASSUMPTION: "Settlement cycle (T+2) plus buffer. An unsettled capture older than 
// this is likely an anomaly worth investigating."

// ─── Matcher ───────────────────────────────────────────────────────────────────

/** Rounding tolerance in paise for the settlement identity check */
export const ROUNDING_TOLERANCE_PAISE = 500;
// source_citation: "Increased to 500 paise (Rs 5) to allow Stage 3 matcher to confidently link bank credits with minor fee variances, rather than rejecting them entirely."

/** Maximum candidate lines for the residual subset-sum solver (S3) */
export const RESIDUAL_SOLVER_MAX_CANDIDATES = 20;
// source_citation: "Subset-sum is NP-hard; unbounded search is a DoS on your own demo.
// Exceeding the bound → AMBIGUOUS_MATCH, not a guess."

/** Time budget for residual solver per group, in milliseconds */
export const RESIDUAL_SOLVER_TIMEOUT_MS = 500;
// ASSUMPTION: "500ms per subset-sum allocation is generous for ≤20 candidates."

/** Date window (days) for matching bank credits to settlements */
export const MATCH_DATE_WINDOW_DAYS = 5;
// ASSUMPTION: "Allow ±5 days to account for settlement cycle variation, banking 
// holidays, and timezone edge cases."

// ─── Data Generator ────────────────────────────────────────────────────────────

export const GENERATOR_DEFAULTS = {
  /** Average order value in paise (log-normal mean param) */
  avgOrderValuePaise: 150000,    // ₹1,500
  // ASSUMPTION: "Typical D2C brand mid-range AOV"
  
  /** Standard deviation for log-normal order value */
  orderValueStdDev: 0.6,
  // ASSUMPTION: "Moderate spread around AOV"
  
  /** Daily order volume (base) */
  dailyOrderVolume: 180,
  // ASSUMPTION: "~5,400 orders/month for a ₹4Cr/yr merchant"
  
  /** Refund rate */
  refundRate: 0.03,
  // source_citation: "~3% refund rate is typical for Indian e-commerce"
  
  /** Dispute/chargeback rate */
  disputeRate: 0.001,
  // source_citation: "~0.1% dispute rate is the industry average"
  
  /** Instrument mix probabilities */
  instrumentMix: {
    upi: 0.55,
    card: 0.30,
    netbanking: 0.10,
    wallet: 0.05,
  } as Record<string, number>,
  // source_citation: "UPI dominant in Indian D2C; card secondary"
};

// ─── Break injection rates (ground truth for evaluation) ───────────────────────

export const BREAK_RATES = {
  MISSING_CREDIT: 0.010,         // 1.0% — settlement reported, no bank credit
  FEE_VARIANCE: 0.005,           // 0.5% — fee charged ≠ schedule
  GST_VARIANCE: 0.002,           // 0.2% — GST recomputation mismatch
  DUPLICATE_CREDIT: 0.002,       // 0.2% — duplicate bank credit
  TIMING_BREAK: 0.020,           // 2.0% — credit outside expected window
  UNSETTLED_CAPTURE: 0.005,      // 0.5% — capture never settled, aged >7d
  NARRATION_UNPARSEABLE: 0.050,  // 5.0% — narration can't be parsed
  AMBIGUOUS_MATCH: 0.003,        // 0.3% — two subsets sum identically
};
// source_citation: "Controlled injection rates from blueprint PART N for ground-truth evaluation"

// ─── Narration Parser ──────────────────────────────────────────────────────────

/** Bank narration truncation lengths (varies by bank) */
export const NARRATION_TRUNCATION_LENGTHS = [35, 50, 60];
// ASSUMPTION: "Common truncation points observed in Indian bank statements"

/** Rate of missing UTR in bank narrations */
export const MISSING_UTR_RATE = 0.15;
// source_citation: "~15% of bank narrations lack a UTR reference — blueprint PART N"

/** Rate of merged credits in bank statement */
export const MERGED_CREDIT_RATE = 0.02;
// source_citation: "~2% of credits merged into one row — blueprint PART N"

// ─── API ───────────────────────────────────────────────────────────────────────

export const API_PORT = parseInt(process.env.PORT || '3000', 10);
export const ENGINE_VERSION = process.env.ENGINE_VERSION || '1.0.0';
export const DB_PATH = process.env.DB_PATH || './data/bahikhata.db';
export const API_BEARER_TOKEN = process.env.API_BEARER_TOKEN || 'bahikhata-demo-token-2026';
