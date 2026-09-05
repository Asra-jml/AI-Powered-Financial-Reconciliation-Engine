/**
 * Sensitivity Analysis
 * Runs the pipeline across varying rates of missing UTRs to prove the
 * value of S2 (Identity) and S3 (Residual) matchers.
 */

import { generateMerchantMonth } from '../data/generator';
import { runMatcherPipeline } from '../matcher/pipeline';

function runSensitivitySweep() {
  const seed = 42;
  const records = 500;
  
  console.log("Missing UTR % | S1 Matches | S2 Matches | S3 Matches | Ambiguous");
  console.log("-------------------------------------------------------------------");

  for (const missingRate of [0.0, 0.1, 0.3, 0.5, 0.8, 1.0]) {
    // We mock the missing UTR rate by stripping UTRs from bank lines after generation
    const data = generateMerchantMonth({ seed, targetRecords: records });
    
    for (const bankLine of data.bankStatement) {
      if (Math.random() < missingRate) {
        bankLine.narration_raw = 'GIBBERISH TRANSFER';
      }
    }

    const settlements = data.settlements.map(s => ({ ...s, run_id: 'test' }));
    const internalPayments = data.payments.filter(p => p.source === 'internal');

    const result = runMatcherPipeline(data.bankStatement, internalPayments, settlements, 'test', false);

    console.log(
      `${(missingRate * 100).toFixed(0).padStart(13)}% | ` +
      `${result.s1.matchedGroups.length.toString().padStart(10)} | ` +
      `${result.s2.matchedGroups.length.toString().padStart(10)} | ` +
      `${result.s3.matchedGroups.length.toString().padStart(10)} | ` +
      `${result.s3.ambiguousGroups.length.toString().padStart(9)}`
    );
  }
}

if (require.main === module) {
  runSensitivitySweep();
}
