/**
 * Bahikhata — Database Layer
 * 
 * SQLite via better-sqlite3 for zero-config portability.
 * All amounts stored as integer paise. Append-only audit_log.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { DB_PATH } from '../config/rules';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function resetDb(): void {
  closeDb();
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
  }
}

function initSchema(db: Database.Database): void {
  db.exec(`
    -- Runs
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      input_hash TEXT UNIQUE NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      record_count INTEGER DEFAULT 0,
      engine_version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      seed INTEGER
    );

    -- Ledger Lines (unified: internal payments, razorpay data, bank credits)
    CREATE TABLE IF NOT EXISTS ledger_lines (
      line_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      source TEXT NOT NULL CHECK(source IN ('internal','razorpay','bank')),
      external_id TEXT,
      utr TEXT,
      settlement_id TEXT,
      amount_paise INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('credit','debit')),
      instrument TEXT,
      occurred_on TEXT NOT NULL,
      raw TEXT,
      narration_raw TEXT,
      narration_parsed TEXT,
      fee_paise INTEGER DEFAULT 0,
      gst_paise INTEGER DEFAULT 0,
      order_id TEXT,
      payment_id TEXT,
      is_refund INTEGER DEFAULT 0,
      is_dispute INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ll_run_source ON ledger_lines(run_id, source);
    CREATE INDEX IF NOT EXISTS idx_ll_run_amount ON ledger_lines(run_id, amount_paise);
    CREATE INDEX IF NOT EXISTS idx_ll_utr ON ledger_lines(utr);
    CREATE INDEX IF NOT EXISTS idx_ll_run_date ON ledger_lines(run_id, occurred_on);
    CREATE INDEX IF NOT EXISTS idx_ll_settlement ON ledger_lines(settlement_id);
    CREATE INDEX IF NOT EXISTS idx_ll_payment ON ledger_lines(payment_id);

    -- Settlements
    CREATE TABLE IF NOT EXISTS settlements (
      settlement_id TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      expected_net_paise INTEGER NOT NULL,
      actual_credit_line_id TEXT,
      settled_on TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'missing',
      component_payments_paise INTEGER DEFAULT 0,
      component_fees_paise INTEGER DEFAULT 0,
      component_gst_paise INTEGER DEFAULT 0,
      component_refunds_paise INTEGER DEFAULT 0,
      component_adjustments_paise INTEGER DEFAULT 0,
      PRIMARY KEY (settlement_id, run_id)
    );

    -- Match Groups
    CREATE TABLE IF NOT EXISTS match_groups (
      group_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      strategy TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      committed INTEGER NOT NULL DEFAULT 0,
      invariant_delta_paise INTEGER DEFAULT 0,
      settlement_id TEXT
    );

    -- Match Members
    CREATE TABLE IF NOT EXISTS match_members (
      group_id TEXT NOT NULL REFERENCES match_groups(group_id),
      line_id TEXT NOT NULL REFERENCES ledger_lines(line_id),
      PRIMARY KEY (group_id, line_id)
    );

    -- Partial unique index: a line can only be in ONE committed group
    -- SQLite doesn't support partial unique indexes directly, so we enforce in code
    -- and use a trigger
    CREATE TRIGGER IF NOT EXISTS trg_no_double_commit
    BEFORE INSERT ON match_members
    WHEN (SELECT committed FROM match_groups WHERE group_id = NEW.group_id) = 1
    BEGIN
      SELECT CASE
        WHEN EXISTS (
          SELECT 1 FROM match_members mm
          JOIN match_groups mg ON mm.group_id = mg.group_id
          WHERE mm.line_id = NEW.line_id AND mg.committed = 1
        )
        THEN RAISE(ABORT, 'Line already committed to another match group — no double commit allowed')
      END;
    END;

    -- Fee Schedules
    CREATE TABLE IF NOT EXISTS fee_schedules (
      schedule_id TEXT PRIMARY KEY,
      instrument TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'standard',
      rate_bps INTEGER NOT NULL,
      flat_fee_paise INTEGER DEFAULT 0,
      gst_bps INTEGER NOT NULL,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      source_citation TEXT
    );

    -- Exceptions
    CREATE TABLE IF NOT EXISTS exceptions (
      exception_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      class TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      amount_paise INTEGER NOT NULL DEFAULT 0,
      evidence TEXT,
      proposed_resolution TEXT,
      explanation_text TEXT,
      resolved_by TEXT NOT NULL DEFAULT 'unresolved',
      resolved_at TEXT,
      line_ids TEXT DEFAULT '[]',
      settlement_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_exc_run_class ON exceptions(run_id, class);

    -- Audit Log (append-only)
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'engine',
      action TEXT NOT NULL,
      before_state TEXT,
      after_state TEXT,
      ts TEXT NOT NULL
    );
  `);
}

// ─── Query Helpers ─────────────────────────────────────────────────────────────

export function insertRun(run: {
  run_id: string; input_hash: string; started_at: string;
  engine_version: string; status: string; seed?: number;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO runs (run_id, input_hash, started_at, engine_version, status, seed)
    VALUES (@run_id, @input_hash, @started_at, @engine_version, @status, @seed)
  `).run({ ...run, seed: run.seed ?? null });
}

export function getRunByHash(input_hash: string): any {
  return getDb().prepare('SELECT * FROM runs WHERE input_hash = ?').get(input_hash);
}

export function updateRunStatus(run_id: string, status: string, finished_at?: string, record_count?: number): void {
  const db = getDb();
  if (finished_at && record_count !== undefined) {
    db.prepare('UPDATE runs SET status = ?, finished_at = ?, record_count = ? WHERE run_id = ?')
      .run(status, finished_at, record_count, run_id);
  } else {
    db.prepare('UPDATE runs SET status = ? WHERE run_id = ?').run(status, run_id);
  }
}

export function insertLedgerLines(lines: any[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO ledger_lines (line_id, run_id, source, external_id, utr, settlement_id,
      amount_paise, direction, instrument, occurred_on, raw, narration_raw, narration_parsed,
      fee_paise, gst_paise, order_id, payment_id, is_refund, is_dispute)
    VALUES (@line_id, @run_id, @source, @external_id, @utr, @settlement_id,
      @amount_paise, @direction, @instrument, @occurred_on, @raw, @narration_raw, @narration_parsed,
      @fee_paise, @gst_paise, @order_id, @payment_id, @is_refund, @is_dispute)
  `);
  const insertMany = db.transaction((rows: any[]) => {
    for (const row of rows) {
      stmt.run({
        ...row,
        raw: row.raw ? JSON.stringify(row.raw) : null,
        narration_parsed: row.narration_parsed ? JSON.stringify(row.narration_parsed) : null,
        is_refund: row.is_refund ? 1 : 0,
        is_dispute: row.is_dispute ? 1 : 0,
        external_id: row.external_id ?? null,
        utr: row.utr ?? null,
        settlement_id: row.settlement_id ?? null,
        instrument: row.instrument ?? null,
        narration_raw: row.narration_raw ?? null,
        fee_paise: row.fee_paise ?? 0,
        gst_paise: row.gst_paise ?? 0,
        amount_paise: row.amount_paise ?? 0,
        order_id: row.order_id ?? null,
        payment_id: row.payment_id ?? null,
      });
    }
  });
  insertMany(lines);
}

export function insertSettlements(settlements: any[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO settlements (settlement_id, run_id, expected_net_paise,
      actual_credit_line_id, settled_on, status,
      component_payments_paise, component_fees_paise, component_gst_paise,
      component_refunds_paise, component_adjustments_paise)
    VALUES (@settlement_id, @run_id, @expected_net_paise,
      @actual_credit_line_id, @settled_on, @status,
      @component_payments_paise, @component_fees_paise, @component_gst_paise,
      @component_refunds_paise, @component_adjustments_paise)
  `);
  const insertMany = db.transaction((rows: any[]) => {
    for (const row of rows) {
      stmt.run({
        ...row,
        actual_credit_line_id: row.actual_credit_line_id ?? null,
      });
    }
  });
  insertMany(settlements);
}

export function insertMatchGroup(group: any): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO match_groups (group_id, run_id, strategy, confidence, committed, invariant_delta_paise, settlement_id)
    VALUES (@group_id, @run_id, @strategy, @confidence, @committed, @invariant_delta_paise, @settlement_id)
  `).run({
    ...group,
    committed: group.committed ? 1 : 0,
    settlement_id: group.settlement_id ?? null,
    invariant_delta_paise: group.invariant_delta_paise ?? 0,
  });
}

export function insertMatchMembers(members: Array<{ group_id: string; line_id: string }>): void {
  const db = getDb();
  const stmt = db.prepare('INSERT INTO match_members (group_id, line_id) VALUES (@group_id, @line_id)');
  const insertMany = db.transaction((rows: any[]) => {
    for (const row of rows) stmt.run(row);
  });
  insertMany(members);
}

export function insertException(exc: any): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO exceptions (exception_id, run_id, class, severity, amount_paise,
      evidence, proposed_resolution, explanation_text, resolved_by, resolved_at, line_ids, settlement_id)
    VALUES (@exception_id, @run_id, @class, @severity, @amount_paise,
      @evidence, @proposed_resolution, @explanation_text, @resolved_by, @resolved_at, @line_ids, @settlement_id)
  `).run({
    ...exc,
    evidence: JSON.stringify(exc.evidence),
    line_ids: JSON.stringify(exc.line_ids ?? []),
    resolved_at: exc.resolved_at ?? null,
    settlement_id: exc.settlement_id ?? null,
  });
}

export function insertAuditLog(log: {
  run_id: string; entity: string; entity_id: string;
  actor: string; action: string; before_state?: any; after_state?: any;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_log (run_id, entity, entity_id, actor, action, before_state, after_state, ts)
    VALUES (@run_id, @entity, @entity_id, @actor, @action, @before_state, @after_state, @ts)
  `).run({
    ...log,
    before_state: log.before_state ? JSON.stringify(log.before_state) : null,
    after_state: log.after_state ? JSON.stringify(log.after_state) : null,
    ts: new Date().toISOString(),
  });
}

export function insertFeeSchedules(schedules: any[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO fee_schedules (schedule_id, instrument, plan, rate_bps,
      flat_fee_paise, gst_bps, effective_from, effective_to, source_citation)
    VALUES (@schedule_id, @instrument, @plan, @rate_bps,
      @flat_fee_paise, @gst_bps, @effective_from, @effective_to, @source_citation)
  `);
  const insertMany = db.transaction((rows: any[]) => {
    for (const row of rows) {
      stmt.run({
        ...row,
        effective_to: row.effective_to ?? null,
        source_citation: row.source_citation ?? null,
      });
    }
  });
  insertMany(schedules);
}

export function getLedgerLinesByRunAndSource(run_id: string, source: string): any[] {
  return getDb().prepare('SELECT * FROM ledger_lines WHERE run_id = ? AND source = ? ORDER BY occurred_on').all(run_id, source);
}

export function getSettlementsByRun(run_id: string): any[] {
  return getDb().prepare('SELECT * FROM settlements WHERE run_id = ? ORDER BY settled_on').all(run_id);
}

export function getExceptionsByRun(run_id: string, filterClass?: string): any[] {
  if (filterClass) {
    return getDb().prepare('SELECT * FROM exceptions WHERE run_id = ? AND class = ? ORDER BY amount_paise DESC').all(run_id, filterClass);
  }
  return getDb().prepare('SELECT * FROM exceptions WHERE run_id = ? ORDER BY amount_paise DESC').all(run_id);
}

export function getExceptionById(exception_id: string): any {
  return getDb().prepare('SELECT * FROM exceptions WHERE exception_id = ?').get(exception_id);
}

export function getMatchGroupsByRun(run_id: string): any[] {
  return getDb().prepare('SELECT * FROM match_groups WHERE run_id = ? AND committed = 1').all(run_id);
}

export function getMatchMembersByGroup(group_id: string): any[] {
  return getDb().prepare(`
    SELECT mm.*, ll.* FROM match_members mm
    JOIN ledger_lines ll ON mm.line_id = ll.line_id
    WHERE mm.group_id = ?
  `).all(group_id);
}

export function getRunById(run_id: string): any {
  return getDb().prepare('SELECT * FROM runs WHERE run_id = ?').get(run_id);
}

export function getFeeSchedule(instrument: string, date: string): any {
  return getDb().prepare(`
    SELECT * FROM fee_schedules 
    WHERE instrument = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY effective_from DESC LIMIT 1
  `).get(instrument, date, date);
}

export function getAuditLog(run_id: string): any[] {
  return getDb().prepare('SELECT * FROM audit_log WHERE run_id = ? ORDER BY ts').all(run_id);
}

export function commitMatchGroup(group_id: string): void {
  getDb().prepare('UPDATE match_groups SET committed = 1 WHERE group_id = ?').run(group_id);
}

export function resolveException(exception_id: string, resolved_by: string): void {
  getDb().prepare(
    'UPDATE exceptions SET resolved_by = ?, resolved_at = ? WHERE exception_id = ?'
  ).run(resolved_by, new Date().toISOString(), exception_id);
}

export function updateSettlementStatus(settlement_id: string, run_id: string, status: string, credit_line_id?: string): void {
  if (credit_line_id) {
    getDb().prepare(
      'UPDATE settlements SET status = ?, actual_credit_line_id = ? WHERE settlement_id = ? AND run_id = ?'
    ).run(status, credit_line_id, settlement_id, run_id);
  } else {
    getDb().prepare(
      'UPDATE settlements SET status = ? WHERE settlement_id = ? AND run_id = ?'
    ).run(status, settlement_id, run_id);
  }
}
