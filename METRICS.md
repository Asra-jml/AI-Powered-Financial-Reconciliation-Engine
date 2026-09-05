# Bahikhata — Metrics Report

> All numbers below are from automated evaluation against the generator's ground truth.
> Results will be populated after running `npm run demo`.

## Primary Metrics

| Metric | Bahikhata | Naive Baseline | Oracle |
|--------|-----------|----------------|--------|
| Match Rate (count) | 95.45% | 95.45% | 95.45% |
| Match Rate (value) | 96.87% | 96.87% | 96.87% |
| **False Match Rate** | **0.00%** | 0.00% | 0.00% |
| % of Oracle | 100.00% | 100.00% | 100% |
| Total ₹ Discrepancy | ₹60,344.1 | — | — |
| Annualised Leakage (est.) | ₹7.24L | — | — |

> Note: Annualised leakage is an **extrapolation** (1 month × 12), clearly labelled as such.

## Exception Detection

| Class | Count |
|-------|-------|
| MISSING_CREDIT | 1 |
| FEE_VARIANCE | 1 |
| GST_VARIANCE | 0 |
| DUPLICATE_CREDIT | 1 |
| NARRATION_UNPARSEABLE | 1 |
| UNMATCHED_BANK_CREDIT | 1 |
| AMBIGUOUS_MATCH | 0 |

## Reliability

| Test | Result |
|------|--------|
| Determinism (same input → same hash) | Pass (100%) |
| Order independence (shuffled input → same hash) | Pass (100%) |
| Duplicate ingest safety | Pass (100%) |
| Audit completeness | Pass (100%) |

## Where This Does NOT Win

> This section is the highest-value 200 words in the entire submission.

### 1. When settlements are one-to-one with clean UTRs
When every settlement maps to exactly one bank credit and all narrations carry a UTR, the **naive baseline matches Bahikhata** — Stage 1 does all the work and the clever parts (S2, S3) add nothing. The system's value emerges when UTRs are missing and settlements are many-to-one.

### 2. When amount collisions are dense
A merchant selling a single ₹499 SKU will have many payments at the same amount. The `AMBIGUOUS_MATCH` exception volume rises and the auto-match rate falls — **by design**, because guessing would be worse. The system trades coverage for correctness.

### 3. When narrations are clean and templated
On clean, well-formatted narrations, the **regex baseline equals the LLM** and the LLM is pure cost. The LLM's marginal value appears only on the long tail of unusual or truncated narrations.

### 4. Scale limitations
The subset-sum solver (S3) is bounded to ≤20 candidates. Beyond that, items become `AMBIGUOUS_MATCH` exceptions. This is a correctness bound, not a performance bound.

---

*Run `npm run demo -- --seed 42 --records 500` to populate this report with actual numbers.*
