import { GoogleGenerativeAI } from '@google/generative-ai';
import { v4 as uuidv4 } from 'uuid';
import { insertLedgerLines } from '../db/database';

export async function parseBankStatementCSV(csvContent: string, run_id: string): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is missing in environment variables.');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

  const prompt = `
You are a financial reconciliation assistant. Parse the following raw bank statement CSV and extract the credit transactions.
For each transaction, extract the Date (YYYY-MM-DD), the UTR (Unique Transaction Reference, usually a 10-12 digit alphanumeric code in the narration), and the Amount (in rupees, convert to paise).

Return a JSON array of objects with the exact keys: "date", "utr", "amount_paise", "narration_raw".
Do not return any markdown formatting or extra text, just the raw JSON array.

Raw CSV:
${csvContent}
  `;

  let parsedData: any[] = [];

  try {
    console.log('Sending bank statement to Gemini for parsing...');
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    const jsonStr = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    parsedData = JSON.parse(jsonStr);
  } catch (err: any) {
    console.warn('Gemini API call failed (invalid key or 404). Falling back to basic Regex parser for demo stability.', err.message);
    
    // Fallback naive CSV parsing
    const lines = csvContent.split('\n').slice(1); // skip header
    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split(',');
      if (parts.length >= 4) {
        const date = parts[0];
        const narration = parts[1].replace(/"/g, '');
        const amountStr = parts[3];
        if (amountStr) {
          const amount_paise = Math.round(parseFloat(amountStr) * 100);
          let utr = null;
          const utrMatch = narration.match(/UTR[A-Z0-9]+/i) || narration.match(/[0-9]{10,12}/);
          if (utrMatch) utr = utrMatch[0];
          
          parsedData.push({
            date,
            utr,
            amount_paise,
            narration_raw: narration
          });
        }
      }
    }
  }

  try {
    const bankLines = parsedData.map((row: any) => ({
      line_id: uuidv4(),
      run_id,
      source: 'bank',
      external_id: null,
      utr: row.utr || null,
      settlement_id: null,
      amount_paise: row.amount_paise,
      direction: 'credit',
      instrument: null,
      occurred_on: row.date,
      raw: row,
      narration_raw: row.narration_raw,
      narration_parsed: null,
      fee_paise: 0,
      gst_paise: 0,
      order_id: null,
      payment_id: null,
      is_refund: false,
      is_dispute: false,
    }));

    if (bankLines.length > 0) {
      insertLedgerLines(bankLines);
      console.log(`Successfully parsed and inserted ${bankLines.length} bank lines.`);
    } else {
      console.log('No transactions parsed from statement.');
    }
  } catch (err) {
    console.error('Failed to map parsed bank statement data.');
    throw new Error('Bank Statement Parsing failed.');
  }
}
