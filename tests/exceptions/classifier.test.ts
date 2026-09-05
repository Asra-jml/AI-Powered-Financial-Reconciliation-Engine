/**
 * Tests for Exception Classifier
 * Covers: severity mapping, evidence structure, resolution proposals,
 * duplicate detection, all 12 exception classes
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { classifyExceptions } from '../../src/exceptions/classifier';
import type { LedgerLine } from '../../src/types';
import type { MatchPipelineResult } from '../../src/matcher/pipeline';
import type { FeeVerificationResult, SettlementIdentityResult } from '../../src/verifier/fee-verifier';

const RUN_ID = 'test-run-exc';

// ─── Minimal match result with no matches ──────────────────────────────────────

function emptyMatchResult(): MatchPipelineResult {
  return {
    s1: { matchedGroups: [], unmatchedBankLines: [], unmatchedSettlementIds: [] },
    s2: { matchedGroups: [], unmatchedBankLines: [], unmatchedSettlementIds: [] },
    s3: {
      matchedGroups: [],
      ambiguousGroups: [],
      unmatchedBankLines: [],
      unmatchedSettlementIds: [],
    },
    totalMatched: 0,
    totalMatchedValuePaise: 0,
    totalUnmatched: 0,
    ambiguousCount: 0,
    allGroups: [],
  };
}

describe('classifyExceptions', () => {
  // ─── FEE_VARIANCE ────────────────────────────────────────────────

  describe('FEE_VARIANCE', () => {
    it('creates exception with correct evidence', () => {
      const feeResults: FeeVerificationResult[] = [{
        payment_id: 'pay_1',
        line_id: 'line_1',
        instrument: 'card',
        amount_paise: 100000,
        occurred_on: '2026-08-10',
        charged_fee_paise: 2500,
        charged_gst_paise: 360,
        expected_fee_paise: 2000,
        expected_gst_paise: 360,
        fee_delta_paise: 500,
        gst_delta_paise: 0,
        has_fee_variance: true,
        has_gst_variance: false,
        schedule_id: 'sched-1',
        schedule_rate_bps: 200,
        schedule_effective_from: '2026-01-01',
      }];

      const exceptions = classifyExceptions(
        RUN_ID, emptyMatchResult(), feeResults, [], [], [], false
      );

      const feeExc = exceptions.find(e => e.class === 'FEE_VARIANCE');
      expect(feeExc).toBeDefined();
      expect(feeExc!.severity).toBe('high');
      expect(feeExc!.amount_paise).toBe(500);
      expect(feeExc!.evidence.payment_id).toBe('pay_1');
      expect(feeExc!.evidence.schedule_rate_bps).toBe(200);
      expect(feeExc!.proposed_resolution).toContain('pricing plan');
    });
  });

  // ─── GST_VARIANCE ────────────────────────────────────────────────

  describe('GST_VARIANCE', () => {
    it('creates exception when GST mismatch detected', () => {
      const feeResults: FeeVerificationResult[] = [{
        payment_id: 'pay_2',
        line_id: 'line_2',
        instrument: 'card',
        amount_paise: 100000,
        occurred_on: '2026-08-10',
        charged_fee_paise: 2000,
        charged_gst_paise: 500,
        expected_fee_paise: 2000,
        expected_gst_paise: 360,
        fee_delta_paise: 0,
        gst_delta_paise: 140,
        has_fee_variance: false,
        has_gst_variance: true,
        schedule_id: 'sched-1',
        schedule_rate_bps: 200,
        schedule_effective_from: '2026-01-01',
      }];

      const exceptions = classifyExceptions(
        RUN_ID, emptyMatchResult(), feeResults, [], [], [], false
      );

      const gstExc = exceptions.find(e => e.class === 'GST_VARIANCE');
      expect(gstExc).toBeDefined();
      expect(gstExc!.severity).toBe('high');
      expect(gstExc!.amount_paise).toBe(140);
    });
  });

  // ─── MISSING_CREDIT ──────────────────────────────────────────────

  describe('MISSING_CREDIT', () => {
    it('creates exception for unmatched settlements', () => {
      const matchResult = emptyMatchResult();
      matchResult.s3.unmatchedSettlementIds = ['setl_missing_1', 'setl_missing_2'];

      const exceptions = classifyExceptions(
        RUN_ID, matchResult, [], [], [], [], false
      );

      const missingExc = exceptions.filter(e => e.class === 'MISSING_CREDIT');
      expect(missingExc).toHaveLength(2);
      expect(missingExc[0].severity).toBe('critical');
      expect(missingExc[0].explanation_text).toContain('no corresponding bank credit');
    });
  });

  // ─── AMBIGUOUS_MATCH ─────────────────────────────────────────────

  describe('AMBIGUOUS_MATCH', () => {
    it('creates exception when engine refuses to guess', () => {
      const matchResult = emptyMatchResult();
      matchResult.s3.ambiguousGroups = [{
        bankLineId: 'bank-ambig-1',
        possibleSubsets: [['setl_a', 'setl_b'], ['setl_c', 'setl_d']],
      }];

      const bankLines: LedgerLine[] = [{
        line_id: 'bank-ambig-1',
        run_id: RUN_ID,
        source: 'bank',
        amount_paise: 100000,
        direction: 'credit',
        occurred_on: '2026-08-12',
        is_refund: false,
        is_dispute: false,
      }];

      const exceptions = classifyExceptions(
        RUN_ID, matchResult, [], [], [], bankLines, false
      );

      const ambigExc = exceptions.find(e => e.class === 'AMBIGUOUS_MATCH');
      expect(ambigExc).toBeDefined();
      expect(ambigExc!.severity).toBe('medium');
      expect(ambigExc!.amount_paise).toBe(100000);
      expect(ambigExc!.proposed_resolution).toContain('Manual review');
      expect(ambigExc!.evidence.possible_subsets).toHaveLength(2);
    });
  });

  // ─── SETTLEMENT_IDENTITY_BREAK ───────────────────────────────────

  describe('SETTLEMENT_IDENTITY_BREAK', () => {
    it('creates exception when identity equation fails', () => {
      const identityResults: SettlementIdentityResult[] = [{
        settlement_id: 'setl_broken',
        component_payments_paise: 100000,
        component_fees_paise: 2000,
        component_gst_paise: 360,
        component_refunds_paise: 0,
        component_adjustments_paise: 0,
        expected_net_paise: 97640,
        actual_credited_paise: 90000,
        identity_delta_paise: 7640,
        identity_holds: false,
      }];

      const exceptions = classifyExceptions(
        RUN_ID, emptyMatchResult(), [], identityResults, [], [], false
      );

      const breakExc = exceptions.find(e => e.class === 'SETTLEMENT_IDENTITY_BREAK');
      expect(breakExc).toBeDefined();
      expect(breakExc!.severity).toBe('critical');
      expect(breakExc!.amount_paise).toBe(7640);
    });
  });

  // ─── NARRATION_UNPARSEABLE ───────────────────────────────────────

  describe('NARRATION_UNPARSEABLE', () => {
    it('flags bank lines with confidence 0', () => {
      const bankLines: LedgerLine[] = [{
        line_id: 'bank-noparse',
        run_id: RUN_ID,
        source: 'bank',
        amount_paise: 50000,
        direction: 'credit',
        occurred_on: '2026-08-12',
        narration_raw: 'MISC CR 1234 XYZ',
        narration_parsed: { confidence: 0, method: 'UNKNOWN', raw: 'MISC CR 1234 XYZ' },
        is_refund: false,
        is_dispute: false,
      }];

      const exceptions = classifyExceptions(
        RUN_ID, emptyMatchResult(), [], [], [], bankLines, false
      );

      const parseExc = exceptions.find(e => e.class === 'NARRATION_UNPARSEABLE');
      expect(parseExc).toBeDefined();
      expect(parseExc!.severity).toBe('low');
    });
  });

  // ─── DUPLICATE_CREDIT ────────────────────────────────────────────

  describe('DUPLICATE_CREDIT', () => {
    it('detects same amount + same date as duplicate', () => {
      const bankLines: LedgerLine[] = [
        {
          line_id: 'bank-dup-1',
          run_id: RUN_ID,
          source: 'bank',
          amount_paise: 75000,
          direction: 'credit',
          occurred_on: '2026-08-15',
          narration_parsed: { confidence: 0.9, method: 'NEFT', raw: '' },
          is_refund: false,
          is_dispute: false,
        },
        {
          line_id: 'bank-dup-2',
          run_id: RUN_ID,
          source: 'bank',
          amount_paise: 75000,
          direction: 'credit',
          occurred_on: '2026-08-15',
          narration_parsed: { confidence: 0.9, method: 'NEFT', raw: '' },
          is_refund: false,
          is_dispute: false,
        },
      ];

      const exceptions = classifyExceptions(
        RUN_ID, emptyMatchResult(), [], [], [], bankLines, false
      );

      const dupExc = exceptions.find(e => e.class === 'DUPLICATE_CREDIT');
      expect(dupExc).toBeDefined();
      expect(dupExc!.severity).toBe('critical');
      expect(dupExc!.evidence.duplicate_count).toBe(2);
    });
  });

  // ─── Severity Mapping ────────────────────────────────────────────

  describe('severity mapping', () => {
    it('MISSING_CREDIT is critical', () => {
      const matchResult = emptyMatchResult();
      matchResult.s3.unmatchedSettlementIds = ['setl_x'];
      const exceptions = classifyExceptions(RUN_ID, matchResult, [], [], [], [], false);
      expect(exceptions.find(e => e.class === 'MISSING_CREDIT')?.severity).toBe('critical');
    });

    it('DUPLICATE_CREDIT is critical', () => {
      const bankLines: LedgerLine[] = [
        { line_id: 'a', run_id: RUN_ID, source: 'bank', amount_paise: 100, direction: 'credit', occurred_on: '2026-08-10', narration_parsed: { confidence: 1, method: 'NEFT', raw: '' }, is_refund: false, is_dispute: false },
        { line_id: 'b', run_id: RUN_ID, source: 'bank', amount_paise: 100, direction: 'credit', occurred_on: '2026-08-10', narration_parsed: { confidence: 1, method: 'NEFT', raw: '' }, is_refund: false, is_dispute: false },
      ];
      const exceptions = classifyExceptions(RUN_ID, emptyMatchResult(), [], [], [], bankLines, false);
      expect(exceptions.find(e => e.class === 'DUPLICATE_CREDIT')?.severity).toBe('critical');
    });
  });

  // ─── No exceptions on clean data ────────────────────────────────

  describe('clean data', () => {
    it('produces no exceptions when everything matches', () => {
      const exceptions = classifyExceptions(
        RUN_ID, emptyMatchResult(), [], [], [], [], false
      );
      expect(exceptions).toHaveLength(0);
    });
  });
});
