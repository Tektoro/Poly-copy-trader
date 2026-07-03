import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ledger } from "../src/ledger/db";
import { PolymarketClient } from "../src/polymarket/dataApi";
import { ActivityPoller } from "../src/detection/activityPoller";
import { SignalEngine } from "../src/signals/signalEngine";
import type { LeaderTradeDetected, OrderBook } from "../src/types";
import { fakeFetch, silentLogger, testConfig, FIXED_NOW, type Fixture } from "./helpers";

const fx = JSON.parse(readFileSync(resolve(__dirname, "fixtures", "leaderDay.json"), "utf8")) as Fixture;
const cfg = testConfig();
const now = (): Date => FIXED_NOW;

interface ReplayResult {
  ledger: Ledger;
  emitted: LeaderTradeDetected[];
}

async function runReplay(): Promise<ReplayResult> {
  const logger = silentLogger();
  const ledger = new Ledger(":memory:");
  ledger.syncLeaders(cfg.leaders.map((l) => ({ wallet: l.wallet, label: l.label, categories: l.allowedCategories, addedAt: l.addedAt })));

  const client = new PolymarketClient({ ratePerSec: 1000, logger, fetchFn: fakeFetch(fx), jitter: () => 0 });
  const getBook = (tokenId: string): Promise<OrderBook | null> => client.getBook(tokenId, now);
  const engine = new SignalEngine(ledger, cfg, { getBook, logger, now });

  const emitted: LeaderTradeDetected[] = [];
  const poller = new ActivityPoller(client, cfg, {
    onTrade: async (t) => {
      emitted.push(t);
      await engine.onLeaderTrade(t);
    },
    logger,
    now,
  });

  // Skip priming so every fixture trade is treated as fresh, and drive one poll.
  const anyPoller = poller as unknown as { primed: Set<string>; lastSeenMs: Map<string, number>; pollLeader: (l: unknown) => Promise<void> };
  anyPoller.primed.add(fx.wallet);
  anyPoller.lastSeenMs.set(fx.wallet, 0);
  await anyPoller.pollLeader(cfg.leaders[0]);

  return { ledger, emitted };
}

describe("replay acceptance (§9)", () => {
  it("detects ≥95% of fixture trades with the correct side", async () => {
    const { emitted } = await runReplay();
    const tradeCount = fx.activity.filter((a) => (a.type ?? "TRADE") === "TRADE").length;
    expect(emitted.length).toBe(tradeCount);
    const correct = emitted.filter((e) => {
      const src = fx.activity.find((a) => a.transactionHash === e.txHash);
      return src && String(src.side).toUpperCase() === e.side;
    }).length;
    expect(correct / emitted.length).toBeGreaterThanOrEqual(0.95);
  });

  it("records every leader trade as a signal with the right status/reason", async () => {
    const { ledger } = await runReplay();
    const byTx = new Map(ledger.recentSignals(100).map((s) => [s.tx_hash, s]));
    expect(byTx.size).toBe(5);
    expect(byTx.get("0xA")?.status).toBe("filled");
    expect(byTx.get("0xB")?.skip_reason).toBe("leader_size_too_small");
    expect(byTx.get("0xC")?.skip_reason).toBe("entry_price_too_high");
    expect(byTx.get("0xD")?.skip_reason).toBe("category_not_allowed");
    expect(byTx.get("0xE")?.status).toBe("filled"); // leader exit
  });

  it("obeys every §5 fill rule: fills at/worse than book, within cap, skips reasoned", async () => {
    const { ledger } = await runReplay();
    const positions = ledger.allPositions();
    // One entry (0xA), closed by the leader exit (0xE).
    expect(positions.length).toBe(1);
    const p = positions[0]!;
    expect(p.sim_fill_cents).toBeGreaterThanOrEqual(51); // never better than best ask (51)
    expect(p.sim_fill_cents).toBeLessThanOrEqual(53); // never above chase cap (50+3)
    expect(p.edge_capture_cents).toBeCloseTo(-1, 4);
    expect(p.filled_usd).toBeCloseTo(100, 4);
    expect(p.close_type).toBe("leader_exit");
    expect(p.close_price_cents).toBeCloseTo(54, 4);
    expect(p.pnl_usd!).toBeCloseTo((0.54 - 0.51) * (100 / 0.51), 3);
    expect(ledger.openPositions().length).toBe(0);
  });

  it("is idempotent: replaying the same trades produces no duplicates", async () => {
    const { ledger, emitted } = await runReplay();
    const beforeSignals = ledger.recentSignals(100).length;
    const beforePositions = ledger.allPositions().length;
    const logger = silentLogger();
    const client = new PolymarketClient({ ratePerSec: 1000, logger, fetchFn: fakeFetch(fx), jitter: () => 0 });
    const engine = new SignalEngine(ledger, cfg, { getBook: (t) => client.getBook(t, now), logger, now });
    for (const t of emitted) await engine.onLeaderTrade(t);
    expect(ledger.recentSignals(100).length).toBe(beforeSignals);
    expect(ledger.allPositions().length).toBe(beforePositions);
  });

  it("is deterministic: same fixture → identical ledger", async () => {
    const a = await runReplay();
    const b = await runReplay();
    expect(projectSignals(a.ledger)).toEqual(projectSignals(b.ledger));
    expect(projectPositions(a.ledger)).toEqual(projectPositions(b.ledger));
  });
});

function projectSignals(ledger: Ledger): unknown[] {
  return ledger
    .recentSignals(100)
    .map((s) => ({ tx: s.tx_hash, status: s.status, reason: s.skip_reason, side: s.side }))
    .sort((x, y) => x.tx.localeCompare(y.tx));
}

function projectPositions(ledger: Ledger): unknown[] {
  return ledger
    .allPositions()
    .map((p) => ({
      fill: p.sim_fill_cents,
      edge: p.edge_capture_cents,
      usd: p.filled_usd,
      closeType: p.close_type,
      closePrice: p.close_price_cents,
      pnl: p.pnl_usd,
    }));
}
