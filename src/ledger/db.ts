// SQLite ledger (spec §6). Single file at ./data/ledger.db. better-sqlite3 is
// synchronous, which suits this single-writer workload and keeps the pipeline
// deterministic and easy to test. Schema is created idempotently on open.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  CloseType,
  DetectionSource,
  Side,
  SignalStatus,
  SkipReason,
} from "../types";

const DEFAULT_DB_PATH = resolve(process.cwd(), "data", "ledger.db");

export interface LeaderRow {
  wallet: string;
  label: string;
  categories: string; // JSON array
  added_at: string;
  removed_at: string | null;
  removal_reason: string | null;
}

export interface SignalRow {
  id: number;
  wallet: string;
  market_id: string;
  token_id: string;
  side: Side;
  leader_price_cents: number;
  leader_size_usd: number;
  leader_ts: string;
  detected_ts: string;
  detection_source: DetectionSource;
  status: SignalStatus;
  skip_reason: SkipReason | null;
  tx_hash: string;
  category: string | null;
}

export interface PositionRow {
  id: number;
  signal_id: number;
  wallet: string;
  token_id: string;
  side: Side;
  sim_fill_cents: number;
  filled_usd: number;
  filled_shares: number;
  edge_capture_cents: number;
  opened_ts: string;
  closed_ts: string | null;
  close_type: CloseType | null;
  close_price_cents: number | null;
  pnl_usd: number | null;
}

export class Ledger {
  readonly db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leaders (
        wallet TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        categories TEXT NOT NULL,
        added_at TEXT NOT NULL,
        removed_at TEXT,
        removal_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet TEXT NOT NULL,
        market_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        side TEXT NOT NULL,
        leader_price_cents INTEGER NOT NULL,
        leader_size_usd REAL NOT NULL,
        leader_ts TEXT NOT NULL,
        detected_ts TEXT NOT NULL,
        detection_source TEXT NOT NULL,
        status TEXT NOT NULL,
        skip_reason TEXT,
        tx_hash TEXT NOT NULL,
        category TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (tx_hash, wallet, token_id)
      );

      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER NOT NULL REFERENCES signals(id),
        wallet TEXT NOT NULL,
        token_id TEXT NOT NULL,
        side TEXT NOT NULL,
        sim_fill_cents REAL NOT NULL,
        filled_usd REAL NOT NULL,
        filled_shares REAL NOT NULL,
        edge_capture_cents REAL NOT NULL,
        opened_ts TEXT NOT NULL,
        closed_ts TEXT,
        close_type TEXT,
        close_price_cents REAL,
        pnl_usd REAL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE IF NOT EXISTS downtime (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_ts TEXT NOT NULL,
        end_ts TEXT NOT NULL,
        missed_signal_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE IF NOT EXISTS daily_metrics (
        date TEXT PRIMARY KEY,
        fills INTEGER NOT NULL,
        skips INTEGER NOT NULL,
        mean_edge REAL,
        median_edge REAL,
        p10_edge REAL,
        median_latency_s REAL,
        p95_latency_s REAL,
        pnl_usd REAL,
        leader_pnl_same_trades_usd REAL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE INDEX IF NOT EXISTS idx_signals_wallet ON signals(wallet);
      CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
      CREATE INDEX IF NOT EXISTS idx_positions_open ON positions(closed_ts);
      CREATE INDEX IF NOT EXISTS idx_positions_token ON positions(token_id);
    `);
  }

  // ---- Leaders ----------------------------------------------------------------

  syncLeaders(leaders: Array<{ wallet: string; label: string; categories: string[]; addedAt: string }>): void {
    const up = this.db.prepare(
      `INSERT INTO leaders (wallet, label, categories, added_at)
       VALUES (@wallet, @label, @categories, @addedAt)
       ON CONFLICT(wallet) DO UPDATE SET
         label = excluded.label,
         categories = excluded.categories,
         removed_at = NULL,
         removal_reason = NULL`,
    );
    const tx = this.db.transaction((rows: typeof leaders) => {
      for (const r of rows) {
        up.run({ wallet: r.wallet, label: r.label, categories: JSON.stringify(r.categories), addedAt: r.addedAt });
      }
    });
    tx(leaders);
  }

  // ---- Signals ----------------------------------------------------------------

  /** Idempotent insert. Returns the row id and whether it was newly inserted. */
  insertSignal(s: Omit<SignalRow, "id">): { id: number; inserted: boolean } {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO signals
         (wallet, market_id, token_id, side, leader_price_cents, leader_size_usd,
          leader_ts, detected_ts, detection_source, status, skip_reason, tx_hash, category)
         VALUES (@wallet, @market_id, @token_id, @side, @leader_price_cents, @leader_size_usd,
          @leader_ts, @detected_ts, @detection_source, @status, @skip_reason, @tx_hash, @category)`,
      )
      .run(s);
    if (info.changes === 1) {
      return { id: Number(info.lastInsertRowid), inserted: true };
    }
    const existing = this.db
      .prepare(`SELECT id FROM signals WHERE tx_hash = ? AND wallet = ? AND token_id = ?`)
      .get(s.tx_hash, s.wallet, s.token_id) as { id: number } | undefined;
    return { id: existing?.id ?? -1, inserted: false };
  }

  hasSignal(txHash: string, wallet: string, tokenId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM signals WHERE tx_hash = ? AND wallet = ? AND token_id = ?`)
      .get(txHash, wallet, tokenId);
    return row !== undefined;
  }

  recentSignals(limit = 100): SignalRow[] {
    return this.db
      .prepare(`SELECT * FROM signals ORDER BY id DESC LIMIT ?`)
      .all(limit) as SignalRow[];
  }

  // ---- Positions --------------------------------------------------------------

  insertPosition(p: Omit<PositionRow, "id" | "closed_ts" | "close_type" | "close_price_cents" | "pnl_usd">): number {
    const info = this.db
      .prepare(
        `INSERT INTO positions
         (signal_id, wallet, token_id, side, sim_fill_cents, filled_usd, filled_shares, edge_capture_cents, opened_ts)
         VALUES (@signal_id, @wallet, @token_id, @side, @sim_fill_cents, @filled_usd, @filled_shares, @edge_capture_cents, @opened_ts)`,
      )
      .run(p);
    return Number(info.lastInsertRowid);
  }

  closePosition(id: number, closedTs: string, closeType: CloseType, closePriceCents: number, pnlUsd: number): void {
    this.db
      .prepare(
        `UPDATE positions SET closed_ts = ?, close_type = ?, close_price_cents = ?, pnl_usd = ?
         WHERE id = ? AND closed_ts IS NULL`,
      )
      .run(closedTs, closeType, closePriceCents, pnlUsd, id);
  }

  openPositions(): PositionRow[] {
    return this.db.prepare(`SELECT * FROM positions WHERE closed_ts IS NULL`).all() as PositionRow[];
  }

  openPositionByToken(tokenId: string): PositionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM positions WHERE token_id = ? AND closed_ts IS NULL`)
      .get(tokenId) as PositionRow | undefined;
  }

  /** Find an open copied position for a wallet in a given market (condition id). */
  openPositionByCondition(wallet: string, conditionId: string): PositionRow | undefined {
    return this.db
      .prepare(
        `SELECT p.* FROM positions p
         JOIN signals s ON s.id = p.signal_id
         WHERE p.closed_ts IS NULL
           AND lower(p.wallet) = lower(?)
           AND s.market_id = ?
         LIMIT 1`,
      )
      .get(wallet, conditionId) as PositionRow | undefined;
  }

  allPositions(): PositionRow[] {
    return this.db.prepare(`SELECT * FROM positions ORDER BY id DESC`).all() as PositionRow[];
  }

  portfolioState(): { openPositionCount: number; openExposureUsd: number; heldTokenIds: Set<string> } {
    const open = this.openPositions();
    return {
      openPositionCount: open.length,
      openExposureUsd: open.reduce((sum, p) => sum + p.filled_usd, 0),
      heldTokenIds: new Set(open.map((p) => p.token_id)),
    };
  }

  // ---- Downtime ---------------------------------------------------------------

  insertDowntime(startTs: string, endTs: string, missedCount: number): void {
    this.db
      .prepare(`INSERT INTO downtime (start_ts, end_ts, missed_signal_count) VALUES (?, ?, ?)`)
      .run(startTs, endTs, missedCount);
  }

  recentDowntime(limit = 50): Array<{ start_ts: string; end_ts: string; missed_signal_count: number }> {
    return this.db
      .prepare(`SELECT start_ts, end_ts, missed_signal_count FROM downtime ORDER BY id DESC LIMIT ?`)
      .all(limit) as Array<{ start_ts: string; end_ts: string; missed_signal_count: number }>;
  }

  // ---- KV (manual sign-off, heartbeat) ---------------------------------------

  kvGet(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  kvSet(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
