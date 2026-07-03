import { describe, it, expect } from "vitest";
import { simulateFill, simulateExit, computeLimit, edgeCapture, settleAtResolution } from "../src/paper/executor";
import type { LeaderTradeDetected, OrderBook } from "../src/types";
import { testConfig } from "./helpers";

const cfg = testConfig();

function book(asks: Array<[number, number]>, bids: Array<[number, number]>): OrderBook {
  return {
    tokenId: "T",
    asks: asks.map(([priceCents, sizeShares]) => ({ priceCents, sizeShares })),
    bids: bids.map(([priceCents, sizeShares]) => ({ priceCents, sizeShares })),
    fetchedTs: "2026-07-03T00:00:00Z",
  };
}

function buy(priceCents: number): LeaderTradeDetected {
  return {
    wallet: "0x1111111111111111111111111111111111111111",
    label: "T1",
    marketId: "C1",
    tokenId: "T",
    category: "sports",
    side: "BUY",
    priceCents,
    sizeUsd: 1000,
    leaderTs: "2026-07-03T00:00:00Z",
    detectedTs: "2026-07-03T00:00:03Z",
    detectionSource: "activity",
    txHash: "0xA",
    minutesToResolution: 5000,
  };
}

describe("computeLimit / edgeCapture", () => {
  it("BUY limit is leader + chase, capped at 99", () => {
    expect(computeLimit("BUY", 50, 3)).toBe(53);
    expect(computeLimit("BUY", 98, 5)).toBe(99);
  });
  it("SELL limit is leader - chase, floored at 1", () => {
    expect(computeLimit("SELL", 50, 3)).toBe(47);
    expect(computeLimit("SELL", 2, 5)).toBe(1);
  });
  it("edge capture is directional (positive = better than leader)", () => {
    expect(edgeCapture("BUY", 50, 49)).toBe(1); // paid less
    expect(edgeCapture("BUY", 50, 51)).toBe(-1); // paid more
    expect(edgeCapture("SELL", 50, 51)).toBe(1); // sold higher
  });
});

describe("simulateFill (BUY, §5)", () => {
  it("never fills better than the displayed book", () => {
    // Leader at 50, best ask 51 within chase cap → fill at 51, not 50.
    const r = simulateFill(buy(50), book([[51, 2000]], [[49, 2000]]), cfg);
    expect(r.filled).toBe(true);
    expect(r.simFillCents).toBeCloseTo(51, 6);
    expect(r.edgeCaptureCents).toBeCloseTo(-1, 6); // we paid 1c more than leader
  });

  it("never fills above the chase cap → price_beyond_cap", () => {
    // Leader 50, chase 3 → limit 53. Best ask 55 > 53.
    const r = simulateFill(buy(50), book([[55, 5000]], [[49, 2000]]), cfg);
    expect(r.filled).toBe(false);
    expect(r.skipReason).toBe("price_beyond_cap");
    expect(r.bestOppositeCents).toBe(55); // records the ask we missed
  });

  it("depth-weights the average across levels within the cap", () => {
    // limit 53. Ask levels 51 (small) then 53. $100 target.
    // 51: 100 shares → $51. remaining $49 at 53: 92.45 shares → total avg > 51.
    const r = simulateFill(buy(50), book([[51, 100], [53, 5000]], [[49, 2000]]), cfg);
    expect(r.filled).toBe(true);
    expect(r.simFillCents!).toBeGreaterThan(51);
    expect(r.simFillCents!).toBeLessThanOrEqual(53);
    expect(r.filledUsd).toBeCloseTo(100, 4);
  });

  it("skips when filled notional is under $20 → insufficient_depth", () => {
    // Only 10 shares at 51 → $5.10 available, under $20.
    const r = simulateFill(buy(50), book([[51, 10]], [[49, 2000]]), cfg);
    expect(r.filled).toBe(false);
    expect(r.skipReason).toBe("insufficient_depth");
  });

  it("skips when the book has no asks → insufficient_depth", () => {
    const r = simulateFill(buy(50), book([], [[49, 2000]]), cfg);
    expect(r.filled).toBe(false);
    expect(r.skipReason).toBe("insufficient_depth");
  });
});

describe("simulateExit (SELL, share-targeted)", () => {
  it("sells the full share count against bids within the floor", () => {
    // ref 55, chase 3 → floor 52. Bids: 54 (plenty). Sell 200 shares.
    const r = simulateExit(55, 200, book([[60, 1]], [[54, 3000], [52, 4000]]), cfg);
    expect(r.filled).toBe(true);
    expect(r.filledShares).toBeCloseTo(200, 4);
    expect(r.simFillCents).toBeCloseTo(54, 6);
  });

  it("declines when best bid is below the floor → price_beyond_cap", () => {
    const r = simulateExit(55, 200, book([[60, 1]], [[40, 3000]]), cfg);
    expect(r.filled).toBe(false);
    expect(r.skipReason).toBe("price_beyond_cap");
  });
});

describe("settleAtResolution", () => {
  it("pays $1/share on a win, $0 on a loss, net of fee", () => {
    // Bought 200 shares at 50c ($100 cost). Win → payout $200 → pnl +$100.
    expect(settleAtResolution(50, 200, 1, 0)).toBeCloseTo(100, 4);
    // Loss → payout $0 → pnl -$100.
    expect(settleAtResolution(50, 200, 0, 0)).toBeCloseTo(-100, 4);
  });
});
