import { generateMerchantMonth } from './data/generator';

console.log('Starting generation...');
const start = Date.now();
const data = generateMerchantMonth({ seed: 42, targetRecords: 50 });
console.log(`Generated in ${Date.now() - start}ms`);
console.log('Payments:', data.payments.length);
console.log('Settlements:', data.settlements.length);
console.log('Bank lines:', data.bankStatement.length);
console.log('Breaks:', data.groundTruth.injectedBreaks.length);
