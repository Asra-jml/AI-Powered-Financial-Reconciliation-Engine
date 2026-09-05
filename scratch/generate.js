const fs = require('fs');
const path = require('path');

let settlementsCode = '';
let paymentsCode = '';
let csvContent = 'Date,Description,Withdrawal,Deposit,Balance\n';
let balance = 50000;
let baseTime = Math.floor(Date.now() / 1000) - 86400 * 30; // 30 days ago

for (let i = 1; i <= 100; i++) {
  const amount = 50000 + (i * 1234); // Pseudo-random amounts
  const fees = Math.floor(amount * 0.02);
  const tax = Math.floor(fees * 0.18);
  const net = amount;
  
  const idStr = i.toString().padStart(8, '0');
  const created = baseTime + (i * 24000); // spread over time
  const dateStr = new Date(created * 1000).toISOString().split('T')[0];
  
  settlementsCode += `      { id: 'setl_Demo${idStr}', amount: ${amount}, created_at: ${created}, fees: ${fees}, tax: ${tax} },\n`;
  paymentsCode += `      { id: 'pay_Demo${idStr}', amount: ${amount + fees + tax}, method: 'upi', created_at: ${created - 86400}, fee: ${fees}, tax: ${tax} },\n`;
  
  let depositPaise = net;
  
  // Inject exceptions for pitch
  if (i === 15 || i === 42 || i === 88) {
    // Missing credit! Don't write to CSV
    continue;
  }
  if (i === 27 || i === 55 || i === 71) {
    // Fee Variance! Bank gives less
    depositPaise -= 250; // ₹2.50 less
  }
  
  const depositStr = (depositPaise / 100).toFixed(2);
  balance += (depositPaise / 100);
  csvContent += `${dateStr},"NEFT-RAZORPAY SOFTWARE-UTR892${idStr}-SETTLEMENT",,${depositStr},${balance.toFixed(2)}\n`;
  
  // Inject unmatched bank credits
  if (i === 33 || i === 66) {
    balance += 500;
    csvContent += `${dateStr},"NEFT-UNKNOWN-REF${i}",,500.00,${balance.toFixed(2)}\n`;
  }
}

fs.writeFileSync('demo-statement.csv', csvContent);

const razorpayPath = 'src/services/razorpay.ts';
let rzp = fs.readFileSync(razorpayPath, 'utf8');

const replacement = `  // --- DEMO FALLBACK: If account is completely empty, inject realistic mock data for the pitch ---
  if (settlements.length === 0 && payments.length === 0) {
    console.log('Razorpay Test account is empty. Injecting 100 mock production records for demo purposes...');
    
    // 100 Mock Settlements
    settlements = [
${settlementsCode}    ];

    // Mock Payments
    payments = [
${paymentsCode}    ];
  }`;

rzp = rzp.replace(/\/\/ --- DEMO FALLBACK:[\s\S]*?\];\n  \}/m, replacement);
fs.writeFileSync(razorpayPath, rzp);
console.log('DONE!');
