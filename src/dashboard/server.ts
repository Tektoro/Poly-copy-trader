// Dashboard server (spec §7). Express serving a single static page plus a small
// read-only JSON API that feeds the six panels. Localhost only, no auth (out of
// scope this phase). One write route: persisting the manual "counsel sign-off".

import express, { type Express } from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Config } from "../config";
import type { Ledger } from "../ledger/db";
import { computeGateProgress, computeDailyMetrics } from "../ledger/metrics";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "public");

export interface HealthPayload {
  uptimeSec: number;
  startedTs: string;
  pollers: Array<{ wallet: string; label: string; lastEventTs: string | null; lastEventAgeSec: number | null }>;
  chain: { enabled: boolean; connected: boolean; orderFilledCount: number; mergeCount: number };
  errorCount: number;
  rateLimitedCount: number;
  downtime: Array<{ start_ts: string; end_ts: string; missed_signal_count: number }>;
}

export interface DashboardContext {
  ledger: Ledger;
  cfg: Config;
  health: () => HealthPayload;
  now: () => Date;
}

export function createApp(ctx: DashboardContext): Express {
  const app = express();
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  app.get("/api/health", (_req, res) => {
    res.json(ctx.health());
  });

  app.get("/api/latency", (_req, res) => {
    const signals = ctx.ledger.recentSignals(2000).filter((s) => s.status === "filled");
    res.json(
      signals.map((s) => ({
        detectedTs: s.detected_ts,
        latencyS: (Date.parse(s.detected_ts) - Date.parse(s.leader_ts)) / 1000,
        source: s.detection_source,
      })),
    );
  });

  app.get("/api/leaders", (_req, res) => {
    const nowMs = ctx.now().getTime();
    const positions = ctx.ledger.allPositions();
    const signals = ctx.ledger.recentSignals(100_000);
    const rows = ctx.cfg.leaders.map((l) => {
      const wallet = l.wallet.toLowerCase();
      const leaderSignals = signals.filter((s) => s.wallet.toLowerCase() === wallet);
      const leaderPositions = positions.filter((p) => p.wallet.toLowerCase() === wallet);
      const last7dMs = nowMs - 7 * 24 * 3600 * 1000;
      const trades7d = leaderSignals.filter((s) => Date.parse(s.detected_ts) >= last7dMs).length;
      const lastTradeTs = leaderSignals[0]?.detected_ts ?? null;
      const daysSince = lastTradeTs ? (nowMs - Date.parse(lastTradeTs)) / 86_400_000 : null;
      const last30dMs = nowMs - 30 * 24 * 3600 * 1000;
      const pnl30d = leaderPositions
        .filter((p) => p.closed_ts && Date.parse(p.closed_ts) >= last30dMs)
        .reduce((sum, p) => sum + (p.pnl_usd ?? 0), 0);
      const recentEdges = leaderPositions.slice(0, 20).map((p) => p.edge_capture_cents);
      const rollingEdge = recentEdges.length ? recentEdges.reduce((a, b) => a + b, 0) / recentEdges.length : null;
      const decayed = (daysSince !== null && daysSince > 3) || (rollingEdge !== null && rollingEdge < -3);
      return {
        wallet: l.wallet,
        label: l.label,
        categories: l.allowedCategories,
        trades7d,
        pnl30d: round2(pnl30d),
        daysSinceLastTrade: daysSince === null ? null : round2(daysSince),
        rollingEdgeCents: rollingEdge === null ? null : round2(rollingEdge),
        decayFlag: decayed,
      };
    });
    res.json(rows);
  });

  app.get("/api/signals", (_req, res) => {
    const signals = ctx.ledger.recentSignals(200);
    const open = ctx.ledger.openPositions();
    res.json({ signals, open });
  });

  app.get("/api/edge", (_req, res) => {
    const positions = ctx.ledger.allPositions();
    const signals = new Map(ctx.ledger.recentSignals(100_000).map((s) => [s.id, s]));
    res.json(
      positions.map((p) => {
        const s = signals.get(p.signal_id);
        return {
          openedTs: p.opened_ts,
          edgeCents: p.edge_capture_cents,
          label: s?.wallet ?? p.wallet,
          category: s?.category ?? null,
          side: p.side,
        };
      }),
    );
  });

  app.get("/api/gates", (_req, res) => {
    res.json({ gates: ctx.cfg.gates, progress: computeGateProgress(ctx.ledger) });
  });

  app.get("/api/daily", (_req, res) => {
    res.json(computeDailyMetrics(ctx.ledger));
  });

  app.post("/api/signoff", (req, res) => {
    const value = req.body?.value === true;
    ctx.ledger.kvSet("counsel_signoff", value ? "true" : "false");
    res.json({ ok: true, counselSignoff: value });
  });

  return app;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
