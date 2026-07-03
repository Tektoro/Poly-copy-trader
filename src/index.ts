// Orchestrator (spec §Definition of done). Wires config → ledger → detection →
// signal engine → paper executor → dashboard, and runs the periodic jobs
// (resolution settlement, nightly metrics, heartbeat). Handles graceful shutdown
// and cross-restart downtime accounting.

import { loadConfig, loadEnv } from "./config";
import { getLogger } from "./logger";
import { Ledger } from "./ledger/db";
import { PolymarketClient } from "./polymarket/dataApi";
import { ActivityPoller } from "./detection/activityPoller";
import { ChainListener } from "./detection/chainListener";
import { SignalEngine } from "./signals/signalEngine";
import { settleAtResolution } from "./paper/executor";
import { runNightly } from "./ledger/metrics";
import { createApp, type HealthPayload } from "./dashboard/server";
import type { OrderBook } from "./types";

const HEARTBEAT_MS = 30_000;
const DOWNTIME_THRESHOLD_MS = 2 * 60_000;
const RESOLUTION_POLL_MS = 5 * 60_000;
const NIGHTLY_MS = 24 * 60 * 60_000;

async function main(): Promise<void> {
  const env = loadEnv();
  const cfg = loadConfig();
  const logger = getLogger(env.logLevel);
  const now = (): Date => new Date();
  const startedAt = now();

  logger.info({ event: "boot", mode: cfg.mode, leaders: cfg.leaders.length, port: env.port });

  const ledger = new Ledger();
  ledger.syncLeaders(cfg.leaders.map((l) => ({ wallet: l.wallet, label: l.label, categories: l.allowedCategories, addedAt: l.addedAt })));

  const counters = { errorCount: 0, rateLimitedCount: 0 };
  const client = new PolymarketClient({
    ratePerSec: cfg.polling.globalMaxReqPerSec,
    logger,
    onEvent: (event) => {
      if (event === "rate_limited") counters.rateLimitedCount++;
      else counters.errorCount++;
    },
  });

  const getBook = async (tokenId: string): Promise<OrderBook | null> => {
    try {
      return await client.getBook(tokenId, now);
    } catch (err) {
      logger.warn({ event: "book_fetch_failed", tokenId, err: String(err) });
      return null;
    }
  };

  const engine = new SignalEngine(ledger, cfg, { getBook, logger, now });

  // Cross-restart downtime accounting: if the last heartbeat is stale, we were down.
  await recordDowntimeSinceLastHeartbeat(ledger, client, cfg, startedAt, logger);

  const poller = new ActivityPoller(client, cfg, {
    onTrade: (t) => engine.onLeaderTrade(t),
    logger,
    now,
  });
  poller.start();

  let chain: ChainListener | null = null;
  if (env.polygonWssUrl) {
    chain = new ChainListener(env.polygonWssUrl, {
      logger,
      leaderWallets: cfg.leaders.map((l) => l.wallet),
      onMergeExit: (w, c, ts, tx) => engine.onMergeExit(w, c, ts, tx),
      now,
    });
    chain.start();
  } else {
    logger.info({ event: "chain_listener_disabled", reason: "POLYGON_WSS_URL not set" });
  }

  // Periodic jobs.
  const heartbeat = setInterval(() => ledger.kvSet("last_heartbeat", now().toISOString()), HEARTBEAT_MS);
  ledger.kvSet("last_heartbeat", startedAt.toISOString());
  const resolutionTimer = setInterval(() => void settleResolvedPositions(ledger, client, cfg, logger, now), RESOLUTION_POLL_MS);
  const nightlyTimer = setInterval(() => {
    const r = runNightly(ledger, cfg);
    logger.info({ event: "nightly_metrics", rows: r.rows, csv: r.csvPath });
  }, NIGHTLY_MS);

  // Dashboard.
  const health = (): HealthPayload => {
    const nowMs = now().getTime();
    return {
      uptimeSec: (nowMs - startedAt.getTime()) / 1000,
      startedTs: startedAt.toISOString(),
      pollers: poller.status().map((p) => ({
        ...p,
        lastEventAgeSec: p.lastEventTs ? (nowMs - Date.parse(p.lastEventTs)) / 1000 : null,
      })),
      chain: chain?.status() ?? { enabled: false, connected: false, orderFilledCount: 0, mergeCount: 0 },
      errorCount: counters.errorCount,
      rateLimitedCount: counters.rateLimitedCount,
      downtime: ledger.recentDowntime(50),
    };
  };
  const app = createApp({ ledger, cfg, health, now });
  const server = app.listen(env.port, () => logger.info({ event: "dashboard_listening", url: `http://localhost:${env.port}` }));

  // Graceful shutdown.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: "shutdown", signal });
    clearInterval(heartbeat);
    clearInterval(resolutionTimer);
    clearInterval(nightlyTimer);
    poller.stop();
    void chain?.stop();
    ledger.kvSet("last_heartbeat", now().toISOString());
    runNightly(ledger, cfg);
    server.close(() => {
      ledger.close();
      logger.info({ event: "shutdown_complete" });
      process.exit(0);
    });
    // Hard-stop safety net if server.close hangs.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => logger.error({ event: "unhandled_rejection", reason: String(reason) }));
}

/** Close any open position whose market has resolved, settling at 100¢/0¢. */
async function settleResolvedPositions(
  ledger: Ledger,
  client: PolymarketClient,
  cfg: { fees: { takerFeeBps: number } },
  logger: ReturnType<typeof getLogger>,
  now: () => Date,
): Promise<void> {
  const open = ledger.openPositions();
  for (const pos of open) {
    // The market (condition id) is on the originating signal.
    const signal = ledger.recentSignals(100_000).find((s) => s.id === pos.signal_id);
    if (!signal) continue;
    let meta;
    try {
      meta = await client.getMarketMeta(signal.market_id);
    } catch {
      continue;
    }
    if (!meta || !meta.closed) continue;
    const idx = meta.tokenIds.indexOf(pos.token_id);
    const resolvedPrice = idx >= 0 ? meta.outcomePrices[idx] : meta.resolvedOutcomePrice;
    if (resolvedPrice !== 0 && resolvedPrice !== 1) continue; // can't determine outcome yet
    const pnl = settleAtResolution(pos.sim_fill_cents, pos.filled_shares, resolvedPrice as 0 | 1, cfg.fees.takerFeeBps);
    ledger.closePosition(pos.id, now().toISOString(), "resolution", resolvedPrice * 100, pnl);
    logger.info({ event: "position_settled", tokenId: pos.token_id, resolvedPrice, pnl });
  }
}

/** On startup, if the last heartbeat is stale, record the gap and count missed leader trades. */
async function recordDowntimeSinceLastHeartbeat(
  ledger: Ledger,
  client: PolymarketClient,
  cfg: { leaders: Array<{ wallet: string }> },
  startedAt: Date,
  logger: ReturnType<typeof getLogger>,
): Promise<void> {
  const last = ledger.kvGet("last_heartbeat");
  if (!last) return;
  const gapMs = startedAt.getTime() - Date.parse(last);
  if (gapMs < DOWNTIME_THRESHOLD_MS) return;

  let missed = 0;
  const sinceSec = Date.parse(last) / 1000;
  for (const l of cfg.leaders) {
    try {
      const acts = await client.getActivityAll(l.wallet, 100);
      missed += acts.filter((a) => a.timestamp > sinceSec && a.timestamp <= startedAt.getTime() / 1000).length;
    } catch {
      /* best effort */
    }
  }
  ledger.insertDowntime(last, startedAt.toISOString(), missed);
  logger.warn({ event: "downtime_recorded", from: last, to: startedAt.toISOString(), missedSignals: missed });
}

void main();
