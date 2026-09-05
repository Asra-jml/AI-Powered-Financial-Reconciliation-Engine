# Bahikhata — Settlement Integrity Engine

> **REAL / TEST-MODE / SIMULATED Legend:**
> - 🟢 **REAL:** The engine, schema, invariant checks, matcher, tests, determinism, fee/GST recomputation
> - 🟡 **TEST-MODE:** Razorpay Payments/Orders/Refunds/Settlement reads against `rzp_test_` keys
> - 🟣 **SIMULATED:** The merchant-month volume, the bank statement, and all injected breaks
> - ❌ **NOT CLAIMED:** That any real merchant was overcharged. We detect *injected* variance in a simulator.

---

## The Settlement Identity

```
net_credited  ==  Σ captured_amount
                − Σ platform_fee
                − Σ gst_on_fee
                − Σ refunds
                − Σ adjustments (disputes, chargebacks, reversals)
                ± rounding_tolerance
```

Every reconciliation either satisfies this identity or produces a typed exception explaining which term is wrong. This single equation is the architecture, the test suite, and the pitch.

---

## The Problem

> *"The 2026 builder consensus: verification capacity, not generation speed, is the bottleneck. Reconciliation, settlement and forecasting are still done by hand."*
> — Razorpay AI Buildathon Track 04 Brief

Indian merchants receive net settlement credits in bulk. Verifying that gross captures minus fees, GST, refunds and adjustments equals the bank credit is manual, so under-crediting and fee variance go undetected for months.

**Bahikhata** (the traditional Indian ledger) is a read-only settlement-integrity engine that reconciles a merchant's month three ways:

1. **Internal payment ledger** ↔ **Razorpay settlement/recon data** ↔ **Bank statement**
2. Recomputes fees and GST from a versioned schedule
3. Surfaces money the merchant was overcharged or never credited
4. Emits a typed, resolvable exception list

## Architecture

```
[Ledger CSV/JSON]   [Razorpay test-mode API]   [Bank statement file]
        │                    │ (read-only)             │
        ▼                    ▼                         ▼
                 ┌──────────────────────────┐
                 │  Ingest + Normalise      │  content-hash → idempotent
                 │  (zod validated)         │  amounts → integer paise
                 └────────────┬─────────────┘
                              │
                  ┌───────────▼────────────┐
                  │ Narration Parser        │ ── LLM (typed out) ──┐
                  │ regex-first, LLM-fallback│                     │ measured
                  └───────────┬─────────────┘ ◀── regex baseline ──┘ marginal value
                              ▼
        ┌─────────────────────────────────────────────┐
        │ DETERMINISTIC MATCHER (pure, unit-tested)   │
        │  S1 exact identifier (UTR/RRN/settlement_id)│
        │  S2 batch identity check (the invariant)    │
        │  S3 bounded residual allocation (subset-sum)│
        │  precision-first: ambiguity → exception     │
        └─────────────────────┬───────────────────────┘
                              ▼
        ┌─────────────────────────────────────────────┐
        │ ARITHMETIC VERIFIER                          │
        │  fee_schedules (versioned, cited) → expected │
        │  GST recompute → variance detection          │
        └─────────────────────┬───────────────────────┘
                              ▼
     [Exception Classifier (closed taxonomy)]
                              ▼
     [Append-only audit_log] → [Metrics Harness] → [Dashboard]
```

### Trust Boundary

**The LLM has zero matching authority.** It parses bank narrations and writes explanation text. It never decides a match, never does arithmetic, and never writes to the database.

## Results

| Method | Match (Count) | Match (Value) | False Match |
|--------|--------------|---------------|-------------|
| **Bahikhata** | ~85-92% | ~88-95% | **0.00%** |
| Naive (amount+date) | ~60-70% | ~65-75% | ~2-5% |
| Oracle (ground truth) | ~97% | ~98% | 0.00% |

→ See [METRICS.md](METRICS.md) for full results including "where this does not win."

## Exception Taxonomy

| Class | Severity | Detectable As |
|-------|----------|---------------|
| `MISSING_CREDIT` | Critical | Settlement reported, no bank credit |
| `FEE_VARIANCE` | High | Fee charged ≠ schedule |
| `GST_VARIANCE` | High | GST recomputation mismatch |
| `DUPLICATE_CREDIT` | Critical | Duplicate bank credit |
| `TIMING_BREAK` | Medium | Credit outside expected window |
| `UNSETTLED_CAPTURE` | High | Capture never settled, aged >7d |
| `NARRATION_UNPARSEABLE` | Low | Bank narration can't be parsed |
| `AMBIGUOUS_MATCH` | Medium | Two subsets sum identically |
| `SETTLEMENT_IDENTITY_BREAK` | Critical | Settlement equation doesn't hold |
| `UNMATCHED_BANK_CREDIT` | High | Bank credit with no settlement |
| `UNMATCHED_PAYMENT` | Medium | Payment with no settlement |
| `ROUNDING_VARIANCE` | Info | Small rounding difference |

## Quick Start

```bash
# Clone and install
git clone <repo-url>
cd bahikhata
npm install

# Run demo (500 records, seed 42)
npm run demo -- --seed 42 --records 500

# Start API + Dashboard
npm run dev
# Open http://localhost:3000

# Generate data only
npm run generate -- --seed 42 --records 5000
```

### Docker

```bash
docker-compose up
# Open http://localhost:3000
```

## What is Real vs Simulated

| Component | Status |
|-----------|--------|
| Engine, matcher, verifier, schema | 🟢 REAL |
| Fee/GST recomputation from versioned schedule | 🟢 REAL |
| Exception classification & evidence chains | 🟢 REAL |
| Determinism & idempotency guarantees | 🟢 REAL |
| Razorpay API reads (test-mode) | 🟡 TEST-MODE |
| Merchant-month data volume | 🟣 SIMULATED |
| Bank statement & narrations | 🟣 SIMULATED |
| Injected breaks (fee variance, missing credits) | 🟣 SIMULATED |

## Stack

- **Node.js + TypeScript + Express** — compile-time safe exception taxonomy
- **SQLite** (better-sqlite3) — zero-config, WAL mode, trigger-enforced constraints
- **Zod** — runtime validation on all boundaries
- **Claude API** (optional) — narration parsing fallback, temperature 0
- **No LangGraph, no multi-agent, no vector DB, no Redis**

## Links

- [DECISIONS.md](DECISIONS.md) — Architecture decisions & rejected alternatives
- [DATASET.md](DATASET.md) — Generative world model & break injection
- [METRICS.md](METRICS.md) — Full results including "where this does not win"

---

**Track 04 — AI Finance Controller** | Razorpay AI Buildathon 2026
