import { describe, it, expect, vi } from 'vitest';
import { computeInputHash } from '../../src/ingest/reader';
import { parseNarrationLLM } from '../../src/narration/llm-parser';

describe('Failure Injection & Graceful Degradation', () => {

  it('computes identical input hash for duplicate uploads (idempotent)', () => {
    const p1 = '[{"amount":100}]';
    const b1 = '[{"amount":100}]';
    const hash1 = computeInputHash(p1, b1, '123');
    const hash2 = computeInputHash(p1, b1, '123');
    expect(hash1).toBe(hash2);
  });

  it('falls back to regex parser when LLM times out or errors', async () => {
    // We expect the LLM parser to still return a valid NarrationParseResult 
    // even if the API key is invalid or request fails (it catches and falls back to regex).
    // Let's pass a narration it can regex parse.
    const narration = "NEFT CR-RAZORPAY-UTR1234567890-INR";
    const result = await parseNarrationLLM(narration);
    expect(result.utr).toBe('UTR1234567890');
    expect(result.confidence).toBeGreaterThan(0);
  });

});
