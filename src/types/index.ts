/**
 * Bahikhata — Core Types & Zod Schemas
 * 
 * All domain types are defined here with Zod validation.
 * Amounts are always integer paise (bigint in concept, number in JS for SQLite compat).
 */

import { z } from 'zod';

// ─── Enums ─────────────────────────────────────────────────────────────────────

export const SourceEnum = z.enum(['internal', 'razorpay', 'bank']);
export type Source = z.infer<typeof SourceEnum>;

export const DirectionEnum = z.enum(['credit', 'debit']);
export type Direction = z.infer<typeof DirectionEnum>;

export const InstrumentEnum = z.enum(['card', 'upi', 'netbanking', 'wallet', 'emi']);
export type Instrument = z.infer<typeof InstrumentEnum>;

export const MatchStrategyEnum = z.enum(['S1_exact', 'S2_identity', 'S3_residual', 'MANUAL']);
export type MatchStrategy = z.infer<typeof MatchStrategyEnum>;

export const RunStatusEnum = z.enum(['pending', 'running', 'completed', 'interrupted', 'partial']);
export type RunStatus = z.infer<typeof RunStatusEnum>;

export const SettlementStatusEnum = z.enum(['matched', 'partial', 'missing', 'ambiguous']);
export type SettlementStatus = z.infer<typeof SettlementStatusEnum>;

export const ExceptionClassEnum = z.enum([
  'MISSING_CREDIT',
  'FEE_VARIANCE',
  'GST_VARIANCE',
  'DUPLICATE_CREDIT',
  'TIMING_BREAK',
  'UNSETTLED_CAPTURE',
  'NARRATION_UNPARSEABLE',
  'AMBIGUOUS_MATCH',
  'SETTLEMENT_IDENTITY_BREAK',
  'UNMATCHED_BANK_CREDIT',
  'UNMATCHED_PAYMENT',
  'ROUNDING_VARIANCE',
]);
export type ExceptionClass = z.infer<typeof ExceptionClassEnum>;

export const SeverityEnum = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type Severity = z.infer<typeof SeverityEnum>;

export const ResolutionEnum = z.enum(['unresolved', 'human', 'auto']);
export type Resolution = z.infer<typeof ResolutionEnum>;

export const ActorEnum = z.enum(['engine', 'llm', 'human']);
export type Actor = z.infer<typeof ActorEnum>;

// ─── Zod Schemas ───────────────────────────────────────────────────────────────

export const LedgerLineSchema = z.object({
  line_id: z.string().uuid(),
  run_id: z.string().uuid(),
  source: SourceEnum,
  external_id: z.string().optional(),
  utr: z.string().optional(),
  settlement_id: z.string().optional(),
  amount_paise: z.number().int(),
  direction: DirectionEnum,
  instrument: InstrumentEnum.optional(),
  occurred_on: z.string(),       // ISO date string YYYY-MM-DD
  raw: z.any().optional(),
  narration_raw: z.string().optional(),
  narration_parsed: z.any().optional(),
  fee_paise: z.number().int().optional(),
  gst_paise: z.number().int().optional(),
  order_id: z.string().optional(),
  payment_id: z.string().optional(),
  is_refund: z.boolean().default(false),
  is_dispute: z.boolean().default(false),
});
export type LedgerLine = z.infer<typeof LedgerLineSchema>;

export const SettlementSchema = z.object({
  settlement_id: z.string(),
  run_id: z.string().uuid(),
  expected_net_paise: z.number().int(),
  actual_credit_line_id: z.string().uuid().nullable().default(null),
  settled_on: z.string(),
  status: SettlementStatusEnum,
  component_payments_paise: z.number().int().default(0),
  component_fees_paise: z.number().int().default(0),
  component_gst_paise: z.number().int().default(0),
  component_refunds_paise: z.number().int().default(0),
  component_adjustments_paise: z.number().int().default(0),
});
export type Settlement = z.infer<typeof SettlementSchema>;

export const MatchGroupSchema = z.object({
  group_id: z.string().uuid(),
  run_id: z.string().uuid(),
  strategy: MatchStrategyEnum,
  confidence: z.number().min(0).max(1),
  committed: z.boolean().default(false),
  invariant_delta_paise: z.number().int().default(0),
  settlement_id: z.string().optional(),
});
export type MatchGroup = z.infer<typeof MatchGroupSchema>;

export const MatchMemberSchema = z.object({
  group_id: z.string().uuid(),
  line_id: z.string().uuid(),
});
export type MatchMember = z.infer<typeof MatchMemberSchema>;

export const FeeScheduleSchema = z.object({
  schedule_id: z.string().uuid(),
  instrument: InstrumentEnum,
  plan: z.string().default('standard'),
  rate_bps: z.number().int().min(0),
  flat_fee_paise: z.number().int().min(0).default(0),
  gst_bps: z.number().int().min(0),
  effective_from: z.string(),     // ISO date
  effective_to: z.string().nullable().default(null),
  source_citation: z.string().optional(),
});
export type FeeSchedule = z.infer<typeof FeeScheduleSchema>;

export const ExceptionSchema = z.object({
  exception_id: z.string().uuid(),
  run_id: z.string().uuid(),
  class: ExceptionClassEnum,
  severity: SeverityEnum,
  amount_paise: z.number().int(),
  evidence: z.any(),
  proposed_resolution: z.string(),
  explanation_text: z.string(),
  resolved_by: ResolutionEnum.default('unresolved'),
  resolved_at: z.string().nullable().default(null),
  line_ids: z.array(z.string().uuid()).default([]),
  settlement_id: z.string().optional(),
});
export type Exception = z.infer<typeof ExceptionSchema>;

export const AuditLogSchema = z.object({
  id: z.number().int().optional(),
  run_id: z.string().uuid(),
  entity: z.string(),
  entity_id: z.string(),
  actor: ActorEnum,
  action: z.string(),
  before: z.any().nullable().default(null),
  after: z.any().nullable().default(null),
  ts: z.string(),
});
export type AuditLog = z.infer<typeof AuditLogSchema>;

export const RunSchema = z.object({
  run_id: z.string().uuid(),
  input_hash: z.string(),
  started_at: z.string(),
  finished_at: z.string().nullable().default(null),
  record_count: z.number().int().default(0),
  engine_version: z.string(),
  status: RunStatusEnum,
  seed: z.number().int().optional(),
});
export type Run = z.infer<typeof RunSchema>;

// ─── API Types ─────────────────────────────────────────────────────────────────

export interface RunSummary {
  run_id: string;
  status: RunStatus;
  record_count: number;
  engine_version: string;
  gross_captures_paise: number;
  total_fees_paise: number;
  total_gst_paise: number;
  total_refunds_paise: number;
  total_adjustments_paise: number;
  expected_net_paise: number;
  actual_credited_paise: number;
  unexplained_paise: number;
  match_rate_by_count: number;
  match_rate_by_value: number;
  false_match_rate: number;
  exception_count: number;
  throughput_records_per_sec: number;
  determinism_hash: string;
  started_at: string;
  finished_at: string | null;
}

export interface MetricsReport {
  run_id: string;
  match_rate_by_count: number;
  match_rate_by_value: number;
  false_match_rate: number;
  percent_of_oracle: number;
  exception_precision: Record<string, number>;
  exception_recall: Record<string, number>;
  exception_f1: Record<string, number>;
  throughput_records_per_sec: number;
  determinism_hash: string;
  determinism_pass: boolean;
  order_independence_pass: boolean;
  total_discrepancy_paise: number;
  annualised_leakage_paise: number;
}

// ─── Narration Parse Result ────────────────────────────────────────────────────

export const NarrationParseResultSchema = z.object({
  utr: z.string().optional(),
  rrn: z.string().optional(),
  settlement_id: z.string().optional(),
  sender: z.string().optional(),
  method: z.enum(['NEFT', 'RTGS', 'IMPS', 'UPI', 'BULK', 'UNKNOWN']).default('UNKNOWN'),
  confidence: z.number().min(0).max(1).default(0),
  raw: z.string(),
});
export type NarrationParseResult = z.infer<typeof NarrationParseResultSchema>;

// ─── Generator Types ───────────────────────────────────────────────────────────

export interface GeneratedData {
  payments: LedgerLine[];
  settlements: Settlement[];
  bankStatement: LedgerLine[];
  feeSchedules: FeeSchedule[];
  groundTruth: GroundTruth;
  seed: number;
}

export interface GroundTruth {
  trueAllocations: Map<string, string[]>; // settlement_id → payment line_ids
  injectedBreaks: InjectedBreak[];
}

export interface InjectedBreak {
  type: ExceptionClass;
  affectedLineIds: string[];
  affectedSettlementId?: string;
  details: Record<string, any>;
}
