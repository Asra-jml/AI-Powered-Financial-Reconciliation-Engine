/**
 * Bahikhata — Narration Parser (Regex-first)
 * 
 * Extracts UTR, RRN, settlement ID, method, and sender from bank narrations.
 * Five bank-specific regex patterns covering HDFC, ICICI, SBI, Axis, Kotak styles.
 * 
 * The LLM fallback is in llm-parser.ts — this module is the baseline.
 */

import type { NarrationParseResult } from '../types';

// ─── Regex Patterns (per bank template) ────────────────────────────────────────

const PATTERNS: Array<{
  name: string;
  regex: RegExp;
  extract: (match: RegExpMatchArray) => Partial<NarrationParseResult>;
}> = [
  {
    // HDFC-style: NEFT-RAZORPAYSOFTW-UTR123...-SETTLEMENT
    name: 'HDFC_NEFT',
    regex: /NEFT[-\s]*RAZORPAY\w*[-\s]*(UTR\d{8,15})[-\s]*SETTLEMENT/i,
    extract: (m) => ({
      utr: m[1],
      method: 'NEFT' as const,
      sender: 'RAZORPAY',
    }),
  },
  {
    // ICICI-style: IMPS/P2M/RZP/UTR.../RAZORPAY SOFTWARE
    name: 'ICICI_IMPS',
    regex: /IMPS\/?P2M\/?RZP\/?([A-Z0-9]{8,20})\/RAZORPAY/i,
    extract: (m) => ({
      utr: m[1],
      method: 'IMPS' as const,
      sender: 'RAZORPAY',
    }),
  },
  {
    // SBI-style: BULK CR RZRPY <last8 of UTR> MERCHANT SETTLEMENT
    name: 'SBI_BULK',
    regex: /BULK\s*CR\s*RZRPY\s*(\w{6,10})\s*MERCHANT\s*SETTLEMENT/i,
    extract: (m) => ({
      utr: m[1], // partial UTR
      method: 'BULK' as const,
      sender: 'RAZORPAY',
    }),
  },
  {
    // Axis-style: NEFT CR-RAZORPAY-UTR...-INR xxx.xx
    name: 'AXIS_NEFT',
    regex: /NEFT\s*CR[-\s]*RAZORPAY[-\s]*(UTR\d{8,15})[-\s]*INR/i,
    extract: (m) => ({
      utr: m[1],
      method: 'NEFT' as const,
      sender: 'RAZORPAY',
    }),
  },
  {
    // Kotak-style: RTGS-RAZORPAY SOFTWARE PVT LTD-UTR...
    name: 'KOTAK_RTGS',
    regex: /RTGS[-\s]*RAZORPAY\s*SOFTWARE.*?[-\s]*(UTR\d{8,15})/i,
    extract: (m) => ({
      utr: m[1],
      method: 'RTGS' as const,
      sender: 'RAZORPAY',
    }),
  },
  {
    // Generic UTR catch-all
    name: 'GENERIC_UTR',
    regex: /(UTR\d{8,15})/i,
    extract: (m) => ({
      utr: m[1],
      method: 'UNKNOWN' as const,
    }),
  },
  {
    // Generic RAZORPAY reference
    name: 'GENERIC_RZP',
    regex: /(?:RAZORPAY|RZRPY|RZP)/i,
    extract: () => ({
      sender: 'RAZORPAY',
      method: 'UNKNOWN' as const,
    }),
  },
  {
    // Settlement ID pattern
    name: 'SETTLEMENT_ID',
    regex: /(?:SETL|SETTLEMENT)[-_\s]*([A-Z0-9]{8,20})/i,
    extract: (m) => ({
      settlement_id: m[1],
    }),
  },
];

// ─── Parse Function ────────────────────────────────────────────────────────────

export function parseNarrationRegex(narration: string): NarrationParseResult {
  const trimmed = narration.trim();
  
  if (!trimmed) {
    return {
      raw: narration,
      method: 'UNKNOWN',
      confidence: 0,
    };
  }

  const result: NarrationParseResult = {
    raw: narration,
    method: 'UNKNOWN',
    confidence: 0,
  };

  let matchCount = 0;

  for (const pattern of PATTERNS) {
    const match = trimmed.match(pattern.regex);
    if (match) {
      const extracted = pattern.extract(match);
      // Only set fields that aren't already populated with a more specific value.
      // This prevents generic patterns (GENERIC_UTR, GENERIC_RZP) from overwriting
      // bank-specific methods like 'NEFT', 'IMPS', 'RTGS', 'BULK'.
      for (const [key, value] of Object.entries(extracted)) {
        const current = (result as any)[key];
        if (current === undefined || current === null || current === 'UNKNOWN') {
          (result as any)[key] = value;
        }
      }
      matchCount++;
    }
  }

  // Confidence based on what we extracted
  if (result.utr && result.sender) {
    result.confidence = 0.95;
  } else if (result.utr) {
    result.confidence = 0.80;
  } else if (result.sender) {
    result.confidence = 0.50;
  } else if (result.settlement_id) {
    result.confidence = 0.70;
  } else {
    result.confidence = 0.0;
  }

  return result;
}

/**
 * Batch parse narrations and return results with accuracy stats
 */
export function parseNarrationsBatch(narrations: string[]): {
  results: NarrationParseResult[];
  stats: {
    total: number;
    parsed_with_utr: number;
    parsed_with_sender: number;
    unparseable: number;
    avg_confidence: number;
  };
} {
  const results = narrations.map(parseNarrationRegex);
  
  const parsed_with_utr = results.filter(r => r.utr).length;
  const parsed_with_sender = results.filter(r => r.sender).length;
  const unparseable = results.filter(r => r.confidence === 0).length;
  const avg_confidence = results.reduce((s, r) => s + r.confidence, 0) / results.length;

  return {
    results,
    stats: {
      total: narrations.length,
      parsed_with_utr,
      parsed_with_sender,
      unparseable,
      avg_confidence,
    },
  };
}
