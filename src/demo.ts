/**
 * Bahikhata — Demo Runner
 * 
 * End-to-end pipeline: generate → ingest → parse → match → verify → classify → report.
 * Usage: tsx src/demo.ts --seed 42 --records 500
 */

import { v4 as uuidv4 } from 'uuid';
import { generateMerchantMonth } from './data/generator';
import { computeInputHash } from './ingest/reader';
import { parseNarrationRegex } from './narration/regex-parser';
import { parseNarrationLLM } from './narration/llm-parser';
import { runMatcherPipeline } from './matcher/pipeline';
import { verifyFees, verifySettlementIdentity } from './verifier/fee-verifier';
import { classifyExceptions } from './exceptions/classifier';
import { generateMetricsReport, naiveBaseline, oracleBaseline } from './eval/metrics';
import {
  getDb, resetDb, insertRun, insertLedgerLines,
  insertSettlements, insertFeeSchedules, updateRunStatus,
  getExceptionsByRun
} from './db/database';
import { ENGINE_VERSION } from './config/rules';
import type { LedgerLine } from './types';

// ─── Formatting helpers ────────────────────────────────────────────────────────

function formatPaise(paise: number): string {
  const rupees = paise / 100;
  if (rupees >= 100000) return `₹${(rupees / 100000).toFixed(2)}L`;
  if (rupees >= 1000) return `₹${rupees.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  return `₹${rupees.toFixed(2)}`;
}

function percent(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

export async function runDemo(seed: number = 42, targetRecords: number = 500): Promise<any> {
  const startTime = Date.now();

  console.log('━'.repeat(70));
  console.log('  BAHIKHATA — Settlement Integrity Engine');
  console.log('  Demo Run');
  console.log('━'.repeat(70));
  console.log(`\n  Seed: ${seed} | Target records: ${targetRecords} | Engine: v${ENGINE_VERSION}`);

  // ─── Step 1: Generate data ─────────────────────────────────────────

  console.log('\n▸ Generating synthetic merchant-month...');
  const data = generateMerchantMonth({ seed, targetRecords });
  console.log(`  ✓ ${data.payments.length} payments, ${data.settlements.length} settlements, ${data.bankStatement.length} bank lines`);
  console.log(`  ✓ ${data.groundTruth.injectedBreaks.length} injected breaks`);

  // ─── Step 2: Initialize DB ─────────────────────────────────────────

  console.log('\n▸ Initializing database...');
  resetDb();
  const db = getDb();

  const run_id = uuidv4();
  const inputHash = computeInputHash(
    JSON.stringify(data.payments),
    JSON.stringify(data.bankStatement),
    String(seed)
  );

  insertRun({
    run_id,
    input_hash: inputHash,
    started_at: new Date().toISOString(),
    engine_version: ENGINE_VERSION,
    status: 'running',
    seed,
  });

  // Insert fee schedules
  insertFeeSchedules(data.feeSchedules);
  console.log(`  ✓ ${data.feeSchedules.length} fee schedules loaded`);

  // ─── Step 3: Ingest & normalize ────────────────────────────────────

  console.log('\n▸ Ingesting data...');
  
  // Set run_id on all lines
  const payments: LedgerLine[] = data.payments.map(p => ({ ...p, run_id }));
  const bankLines: LedgerLine[] = data.bankStatement.map(b => ({ ...b, run_id }));

  insertLedgerLines(payments);
  insertLedgerLines(bankLines);
  insertSettlements(data.settlements.map(s => ({ ...s, run_id })));
  console.log(`  ✓ ${payments.length} payment lines, ${bankLines.length} bank lines ingested`);

  // ─── Step 4: Parse narrations ──────────────────────────────────────

  console.log('\n▸ Parsing bank narrations...');
  let parsedWithUtr = 0;
  let unparseable = 0;
  
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  if (hasApiKey) console.log('  Using LLM parser in parallel with Regex...');
  else console.log('  Using Regex parser (no LLM key provided)...');

  await Promise.all(bankLines.map(async (bankLine) => {
    if (bankLine.narration_raw) {
      const parsed = hasApiKey ? await parseNarrationLLM(bankLine.narration_raw) : parseNarrationRegex(bankLine.narration_raw);
      bankLine.narration_parsed = parsed;
      if (parsed.utr) parsedWithUtr++;
      if (parsed.confidence === 0) unparseable++;
    }
  }));

  console.log(`  ✓ ${parsedWithUtr} narrations yielded UTR, ${unparseable} unparseable`);

  // ─── Step 5: Match ─────────────────────────────────────────────────

  console.log('\n▸ Running 3-stage matcher...');
  const settlements = data.settlements.map(s => ({ ...s, run_id }));
  const internalPayments = payments.filter(p => p.source === 'internal');

  const matchResult = runMatcherPipeline(bankLines, internalPayments, settlements, run_id, true);

  console.log(`  ✓ S1 (exact):    ${matchResult.s1.matchedGroups.length} matched`);
  console.log(`  ✓ S2 (identity): ${matchResult.s2.matchedGroups.length} matched`);
  console.log(`  ✓ S3 (residual): ${matchResult.s3.matchedGroups.length} matched, ${matchResult.s3.ambiguousGroups.length} ambiguous`);
  console.log(`  ✓ Total matched: ${matchResult.totalMatched} / ${bankLines.filter(b => b.direction === 'credit').length} credits`);

  // ─── Step 6: Verify fees ───────────────────────────────────────────

  console.log('\n▸ Verifying fees & GST...');
  const feeResults = verifyFees(internalPayments, data.feeSchedules);
  console.log(`  ✓ ${feeResults.feeVarianceCount} fee variances (${formatPaise(Math.abs(feeResults.totalFeeVariancePaise))})`);
  console.log(`  ✓ ${feeResults.gstVarianceCount} GST variances (${formatPaise(Math.abs(feeResults.totalGstVariancePaise))})`);

  // ─── Step 7: Verify settlement identity ────────────────────────────

  console.log('\n▸ Checking settlement identity...');
  const actualCredits = new Map<string, number>();
  for (const { group, members } of matchResult.allGroups) {
    if (group.committed && group.settlement_id) {
      const sids = group.settlement_id.split(',');
      for (const sid of sids) {
        const bankMember = members.find(m => bankLines.some(b => b.line_id === m.line_id));
        if (bankMember) {
          const bankLine = bankLines.find(b => b.line_id === bankMember.line_id);
          if (bankLine) {
            actualCredits.set(sid, bankLine.amount_paise);
          }
        }
      }
    }
  }

  const identityResults = verifySettlementIdentity(settlements, actualCredits);
  const identityBreaks = identityResults.filter(r => !r.identity_holds && r.actual_credited_paise > 0);
  console.log(`  ✓ ${identityResults.length - identityBreaks.length} / ${identityResults.length} settlements pass identity check`);

  // ─── Step 8: Classify exceptions ───────────────────────────────────

  console.log('\n▸ Classifying exceptions...');
  const exceptions = classifyExceptions(
    run_id, matchResult, feeResults.results, identityResults,
    internalPayments, bankLines, true
  );

  const excCounts: Record<string, number> = {};
  for (const e of exceptions) {
    excCounts[e.class] = (excCounts[e.class] || 0) + 1;
  }
  console.log(`  ✓ ${exceptions.length} exceptions classified:`);
  for (const [cls, count] of Object.entries(excCounts).sort()) {
    console.log(`    ${cls}: ${count}`);
  }

  // ─── Step 9: Compute metrics ───────────────────────────────────────

  const elapsedMs = Date.now() - startTime;
  const metrics = generateMetricsReport(
    run_id, matchResult, exceptions, bankLines,
    data.groundTruth, settlements, elapsedMs, payments.length
  );

  // Baselines
  const bankCredits = bankLines.filter(b => b.direction === 'credit');
  const naive = naiveBaseline(bankCredits, settlements, data.groundTruth);
  const oracle = oracleBaseline(bankCredits, settlements, data.groundTruth);

  // ─── Step 10: Final report ─────────────────────────────────────────

  // Compute waterfall values
  const grossCaptures = internalPayments
    .filter(p => !p.is_refund && !p.is_dispute)
    .reduce((s, p) => s + p.amount_paise, 0);
  const totalFees = internalPayments.reduce((s, p) => s + (p.fee_paise || 0), 0);
  const totalGst = internalPayments.reduce((s, p) => s + (p.gst_paise || 0), 0);
  const totalRefunds = internalPayments.filter(p => p.is_refund).reduce((s, p) => s + p.amount_paise, 0);
  const totalAdjustments = internalPayments.filter(p => p.is_dispute).reduce((s, p) => s + p.amount_paise, 0);
  const expectedNet = grossCaptures - totalFees - totalGst - totalRefunds - totalAdjustments;
  const actualCredited = bankCredits.reduce((s, b) => s + b.amount_paise, 0);
  const unexplained = Math.abs(expectedNet - actualCredited);

  updateRunStatus(run_id, 'completed', new Date().toISOString(), payments.length);

  console.log('\n' + '━'.repeat(70));
  console.log('  WATERFALL');
  console.log('━'.repeat(70));
  console.log(`  Gross Captures:     ${formatPaise(grossCaptures)}`);
  console.log(`  − Fees:             ${formatPaise(totalFees)}`);
  console.log(`  − GST:              ${formatPaise(totalGst)}`);
  console.log(`  − Refunds:          ${formatPaise(totalRefunds)}`);
  console.log(`  − Adjustments:      ${formatPaise(totalAdjustments)}`);
  console.log(`  ─────────────────────────────`);
  console.log(`  Expected Net:       ${formatPaise(expectedNet)}`);
  console.log(`  Actual Credited:    ${formatPaise(actualCredited)}`);
  console.log(`  ▸ UNEXPLAINED:      ${formatPaise(unexplained)}`);

  console.log('\n' + '━'.repeat(70));
  console.log('  METRICS');
  console.log('━'.repeat(70));
  console.log(`  Match Rate (count): ${percent(metrics.match_rate_by_count)}`);
  console.log(`  Match Rate (value): ${percent(metrics.match_rate_by_value)}`);
  console.log(`  FALSE MATCH RATE:   ${percent(metrics.false_match_rate)}`);
  console.log(`  % of Oracle:        ${percent(metrics.percent_of_oracle)}`);
  console.log(`  Throughput:         ${metrics.throughput_records_per_sec} records/sec`);
  console.log(`  Determinism Hash:   ${metrics.determinism_hash.slice(0, 16)}...`);
  console.log(`  Total Discrepancy:  ${formatPaise(metrics.total_discrepancy_paise)}`);
  console.log(`  Annualised (est.):  ${formatPaise(metrics.annualised_leakage_paise)} [EXTRAPOLATION]`);

  console.log('\n' + '━'.repeat(70));
  console.log('  BASELINES');
  console.log('━'.repeat(70));
  console.log(`  ${'Method'.padEnd(25)} ${'Match(count)'.padEnd(15)} ${'Match(value)'.padEnd(15)} ${'False Match'.padEnd(12)}`);
  console.log(`  ${'─'.repeat(25)} ${'─'.repeat(15)} ${'─'.repeat(15)} ${'─'.repeat(12)}`);
  console.log(`  ${'Bahikhata'.padEnd(25)} ${percent(metrics.match_rate_by_count).padEnd(15)} ${percent(metrics.match_rate_by_value).padEnd(15)} ${percent(metrics.false_match_rate).padEnd(12)}`);
  console.log(`  ${naive.name.padEnd(25)} ${percent(naive.matchRateByCount).padEnd(15)} ${percent(naive.matchRateByValue).padEnd(15)} ${percent(naive.falseMatchRate).padEnd(12)}`);
  console.log(`  ${oracle.name.padEnd(25)} ${percent(oracle.matchRateByCount).padEnd(15)} ${percent(oracle.matchRateByValue).padEnd(15)} ${percent(oracle.falseMatchRate).padEnd(12)}`);

  console.log('\n' + '━'.repeat(70));
  console.log(`  Completed in ${(elapsedMs / 1000).toFixed(2)}s`);
  console.log('━'.repeat(70));

  return {
    run_id,
    metrics,
    waterfall: {
      gross_captures_paise: grossCaptures,
      total_fees_paise: totalFees,
      total_gst_paise: totalGst,
      total_refunds_paise: totalRefunds,
      total_adjustments_paise: totalAdjustments,
      expected_net_paise: expectedNet,
      actual_credited_paise: actualCredited,
      unexplained_paise: unexplained,
    },
    exceptions: excCounts,
    baselines: { naive, oracle },
    elapsed_ms: elapsedMs,
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const seedIdx = args.indexOf('--seed');
  const recordsIdx = args.indexOf('--records');
  const seed = seedIdx >= 0 ? parseInt(args[seedIdx + 1]) : 42;
  const records = recordsIdx >= 0 ? parseInt(args[recordsIdx + 1]) : 500;

  runDemo(seed, records).then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('Demo failed:', err);
    process.exit(1);
  });
}
