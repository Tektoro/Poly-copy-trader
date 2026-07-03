import { describe, it, expect } from "vitest";
import { Ledger } from "../src/ledger/db";
import { PolymarketClient } from "../src/polymarket/dataApi";
import { SignalEngine } from "../src/signals/signalEngine";
import type { LeaderTradeDetected, OrderBook } from "../src/types";
import { fakeFetch, silentLogger, testConfig, FIXED_NOW, type Fixture } from "./helpers";

const cfg = testConfig();
const now = (): Date => FIXED_NOW;
const WALLET = "0x1111111111111111111111111111111111111111";

const fx: Fixture = {
  wallet: WALLET,
  activity: [],
  books: {
    T1: { asks: [{ price: "0.51", size: "2000" }], bids: [{ price: "0.54", size: "3000" }] },
  },
  markets: {
    C1: { category: "sports", endDate: "2026-12-31T00:00:00Z", closed: false, outcomePrices: '["0.5","0.5"]', clobTokenIds: '["T1","T1NO"]' },
  },
};

function makeEngine(): { engine: SignalEngine; ledger: Ledger } {
  const logger = silentLogger();
  const ledger = new Ledger(":memory:");
  ledger.syncLeaders([{ wallet: WALLET, label: "T1", categories: ["sports"], addedAt: "2026-07-01T00:00:00Z" }]);
  const client = new PolymarketClient({ ratePerSec: 1000, logger, fetchFn: fakeFetch(fx), jitter: () => 0 });
  const getBook = (t: string): Promise<OrderBook | null> => client.getBook(t, now);
  return { engine: new SignalEngine(ledger, cfg, { getBook, logger, now }), ledger };
}

function buy(): LeaderTradeDetected {
  return {
    wallet: WALLET,
    label: "T1",
    marketId: "C1",
    tokenId: "T1",
    category: "sports",
    side: "BUY",
    priceCents: 50,
    sizeUsd: 1000,
    leaderTs: "2026-07-03T00:00:00Z",
    detectedTs: "2026-07-03T00:00:03Z",
    detectionSource: "activity",
    txHash: "0xBUY",
    minutesToResolution: 5000,
  };
}

describe("SignalEngine", () => {
  it("opens a position on a copied entry", async () => {
    const { engine, ledger } = makeEngine();
    await engine.onLeaderTrade(buy());
    expect(ledger.openPositions().length).toBe(1);
  });

  it("closes the position on a leader merge-exit (SELL against the bid)", async () => {
    const { engine, ledger } = makeEngine();
    await engine.onLeaderTrade(buy());
    expect(ledger.openPositions().length).toBe(1);

    await engine.onMergeExit(WALLET, "C1", "2026-07-03T00:05:00Z", "0xMERGE");

    expect(ledger.openPositions().length).toBe(0);
    const closed = ledger.allPositions()[0]!;
    expect(closed.close_type).toBe("merge_exit");
    expect(closed.close_price_cents).toBeCloseTo(54, 4);
    // Entry ~51c, exit 54c → positive pnl.
    expect(closed.pnl_usd!).toBeGreaterThan(0);
  });

  it("ignores a merge-exit for a market we don't hold", async () => {
    const { engine, ledger } = makeEngine();
    await engine.onMergeExit(WALLET, "C1", "2026-07-03T00:05:00Z", "0xMERGE");
    expect(ledger.allPositions().length).toBe(0);
  });

  it("dedupes duplicate detections by (txHash, wallet, tokenId)", async () => {
    const { engine, ledger } = makeEngine();
    await engine.onLeaderTrade(buy());
    await engine.onLeaderTrade(buy());
    await engine.onLeaderTrade(buy());
    expect(ledger.recentSignals(100).length).toBe(1);
    expect(ledger.openPositions().length).toBe(1);
  });
});
