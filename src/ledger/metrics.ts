// Metric computation (spec §6/§7). Two consumers:
//   - the nightly job → writes daily_metrics rows + exports ./exports/daily_summary.csv
//   - the dashboard   → live overall edge/latency/gate progress
// Runnable directly: `npm run metrics`.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Ledger, type PositionRow, type SignalRow } from "./db";
import { loadConfig, type Config } from "../config";

export interface DailyMetric {
  date: string;
  fills: number;
  skips: number;
  mean_edge: number | null;
  median_edge: number | null;
  p10_edge: number | null;
  median_latency_s: number | null;
  p95_latency_s: number | null;
  pnl_usd: number;
  leader_pnl_same_trades_usd: number;
}

export interface GateProgress {
  filledPositions: number;
  meanEdgeCents: number | null;
  medianEdgeCents: number | null;
  p10EdgeCents: number | null;
  leaderPnlCaptureRatio: number | null;
  medianLatencyS: number | null;
  p95LatencyS: number | null;
  pnlUsd: number;
  leaderPnlSameTradesUsd: number;
  counselSignoff: boolean;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

function latencySec(s: SignalRow): number {
  return (Date.parse(s.detected_ts) - Date.parse(s.leader_ts)) / 1000;
}

/** Leader's P&L on the same trade, valued at the leader's entry price (apples-to-apples). */
function leaderPnlForPosition(p: PositionRow, leaderEntryCents: number): number {
  if (p.close_price_cents === null) return 0;
  const entry = leaderEntryCents / 100;
  const close = p.close_price_cents / 100;
  return (close - entry) * p.filled_shares;
}

export function computeDailyMetrics(ledger: Ledger): DailyMetric[] {
  const signals = ledger.recentSignals(100_000);
  const positions = ledger.allPositions();
  const signalById = new Map(signals.map((s) => [s.id, s]));

  const dates = new Set<string>();
  for (const s of signals) dates.add(dateOf(s.detected_ts));
  for (const p of positions) {
    dates.add(dateOf(p.opened_ts));
    if (p.closed_ts) dates.add(dateOf(p.closed_ts));
  }

  const out: DailyMetric[] = [];
  for (const date of [...dates].sort()) {
    const filledSignals = signals.filter((s) => s.status === "filled" && dateOf(s.detected_ts) === date);
    const skips = signals.filter((s) => s.status === "skipped" && dateOf(s.detected_ts) === date).length;
    const openedToday = positions.filter((p) => dateOf(p.opened_ts) === date);
    const closedToday = positions.filter((p) => p.closed_ts && dateOf(p.closed_ts) === date);

    const edges = openedToday.map((p) => p.edge_capture_cents);
    const latencies = filledSignals.map(latencySec);
    const pnl = closedToday.reduce((sum, p) => sum + (p.pnl_usd ?? 0), 0);
    const leaderPnl = closedToday.reduce((sum, p) => {
      const s = signalById.get(p.signal_id);
      return sum + (s ? leaderPnlForPosition(p, s.leader_price_cents) : 0);
    }, 0);

    out.push({
      date,
      fills: filledSignals.length,
      skips,
      mean_edge: mean(edges),
      median_edge: percentile(edges, 50),
      p10_edge: percentile(edges, 10),
      median_latency_s: percentile(latencies, 50),
      p95_latency_s: percentile(latencies, 95),
      pnl_usd: round2(pnl),
      leader_pnl_same_trades_usd: round2(leaderPnl),
    });
  }
  return out;
}

/** Overall progress against the go/no-go gates (dashboard panel 6). */
export function computeGateProgress(ledger: Ledger): GateProgress {
  const signals = ledger.recentSignals(100_000);
  const positions = ledger.allPositions();
  const signalById = new Map(signals.map((s) => [s.id, s]));

  const filled = positions; // every position row corresponds to a filled entry
  const edges = filled.map((p) => p.edge_capture_cents);
  const latencies = signals.filter((s) => s.status === "filled").map(latencySec);
  const closed = positions.filter((p) => p.closed_ts);
  const pnl = closed.reduce((sum, p) => sum + (p.pnl_usd ?? 0), 0);
  const leaderPnl = closed.reduce((sum, p) => {
    const s = signalById.get(p.signal_id);
    return sum + (s ? leaderPnlForPosition(p, s.leader_price_cents) : 0);
  }, 0);

  return {
    filledPositions: filled.length,
    meanEdgeCents: mean(edges),
    medianEdgeCents: percentile(edges, 50),
    p10EdgeCents: percentile(edges, 10),
    leaderPnlCaptureRatio: leaderPnl !== 0 ? round2(pnl / leaderPnl) : null,
    medianLatencyS: percentile(latencies, 50),
    p95LatencyS: percentile(latencies, 95),
    pnlUsd: round2(pnl),
    leaderPnlSameTradesUsd: round2(leaderPnl),
    counselSignoff: ledger.kvGet("counsel_signoff") === "true",
  };
}

export function storeDailyMetrics(ledger: Ledger, rows: DailyMetric[]): void {
  const stmt = ledger.db.prepare(
    `INSERT INTO daily_metrics
       (date, fills, skips, mean_edge, median_edge, p10_edge, median_latency_s, p95_latency_s, pnl_usd, leader_pnl_same_trades_usd)
     VALUES (@date, @fills, @skips, @mean_edge, @median_edge, @p10_edge, @median_latency_s, @p95_latency_s, @pnl_usd, @leader_pnl_same_trades_usd)
     ON CONFLICT(date) DO UPDATE SET
       fills=excluded.fills, skips=excluded.skips, mean_edge=excluded.mean_edge,
       median_edge=excluded.median_edge, p10_edge=excluded.p10_edge,
       median_latency_s=excluded.median_latency_s, p95_latency_s=excluded.p95_latency_s,
       pnl_usd=excluded.pnl_usd, leader_pnl_same_trades_usd=excluded.leader_pnl_same_trades_usd`,
  );
  const tx = ledger.db.transaction((rs: DailyMetric[]) => rs.forEach((r) => stmt.run(r)));
  tx(rows);
}

export function exportCsv(rows: DailyMetric[], path = resolve(process.cwd(), "exports", "daily_summary.csv")): string {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const header = [
    "date",
    "fills",
    "skips",
    "mean_edge",
    "median_edge",
    "p10_edge",
    "median_latency_s",
    "p95_latency_s",
    "pnl_usd",
    "leader_pnl_same_trades_usd",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.date,
        r.fills,
        r.skips,
        fmt(r.mean_edge),
        fmt(r.median_edge),
        fmt(r.p10_edge),
        fmt(r.median_latency_s),
        fmt(r.p95_latency_s),
        r.pnl_usd,
        r.leader_pnl_same_trades_usd,
      ].join(","),
    );
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return path;
}

function fmt(n: number | null): string {
  return n === null ? "" : String(round2(n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Nightly job body (also the `npm run metrics` entrypoint). */
export function runNightly(ledger: Ledger, _cfg: Config): { rows: number; csvPath: string } {
  const rows = computeDailyMetrics(ledger);
  storeDailyMetrics(ledger, rows);
  const csvPath = exportCsv(rows);
  return { rows: rows.length, csvPath };
}

// Direct-run entrypoint (works cross-platform, incl. Windows drive paths).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  const ledger = new Ledger();
  const res = runNightly(ledger, cfg);
  // eslint-disable-next-line no-console
  console.log(`Wrote ${res.rows} daily_metrics rows; CSV → ${res.csvPath}`);
  ledger.close();
}
