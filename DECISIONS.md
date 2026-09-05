# Bahikhata — Architecture Decisions

## Decisions Made

### 1. SQLite over PostgreSQL
**Decision:** Use SQLite (better-sqlite3) instead of PostgreSQL.
**Rationale:** Zero-config setup means any reviewer can `npm install && npm run demo` without Docker/Postgres. WAL mode provides concurrent reads. Triggers enforce the no-double-commit constraint. For a hackathon submission, a working SQLite demo beats a broken Postgres setup.
**Trade-off:** Lose `SELECT ... FOR UPDATE`, `NUMERIC` type, and partial unique indexes (simulated via triggers).

### 2. No LangGraph / No Multi-Agent Framework
**Decision:** Do not use LangGraph, CrewAI, or any multi-agent orchestration.
**Rationale:** "I did not use a multi-agent framework, because reconciliation must be deterministic and replayable. Autonomy is the wrong thing to optimise here — auditability is." The control flow is a fixed deterministic pipeline with two narrow model calls. A graph framework would add nondeterminism, latency, and failure surface for zero measurable gain.

### 3. No LLM-as-Matcher
**Decision:** The LLM never decides a match.
**Rationale:** Non-deterministic, unauditable, and unmeasurable. The matcher is pure code with unit tests. A false match conceals a missing credit — strictly worse than an exception.

### 4. No Vector DB / RAG
**Decision:** No vector database, no retrieval-augmented generation.
**Rationale:** The problem is structured numerical matching, not semantic search. Bank narrations are parsed into typed structs, not embedded into vectors. Adding a vector DB would be résumé-driven design.

### 5. Integer Paise, Never Floats
**Decision:** All amounts are integer paise (bigint concept).
**Rationale:** A single floating-point rounding error in a finance system is the kind of thing a payments panel will hunt for. Integer arithmetic is exact and testable.

### 6. Precision-First Commit Policy
**Decision:** Never commit a match unless allocation is unique and the settlement identity holds.
**Rationale:** A wrong match is strictly worse than an exception. The system optimises for zero false matches, accepting a lower auto-match rate as the trade-off.

### 7. No Redis / No Message Queues
**Decision:** Synchronous pipeline, no external state stores.
**Rationale:** The reconciliation pipeline runs in seconds for 5,000 records. Adding infrastructure complexity for a sub-10-second process is pure overhead.

### 8. Content-Hash Idempotency
**Decision:** Same input → same run, enforced by SHA-256 hash of all input files.
**Rationale:** Finance systems must produce byte-identical output for identical input. This is a correctness property, not a performance optimization.

## Alternatives Considered and Rejected

| Alternative | Why Rejected |
|-------------|-------------|
| PostgreSQL | Extra setup burden for reviewers; SQLite sufficient for demo scale |
| LangGraph | Non-deterministic orchestration for a deterministic pipeline |
| LLM matching | Unauditable, unmeasurable, non-deterministic |
| Vector DB / RAG | Structured numerical problem, not semantic search |
| Float arithmetic | Rounding errors in financial systems are unacceptable |
| Redis | Sub-10-second pipeline doesn't need external caching |
| Kubernetes | Way beyond demo scope |
| Dark mode toggle | "No 3D, no animation, no dark-mode toggle" — already dark by default |
