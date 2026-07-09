import { describe, it, expect } from "vitest";
import { evaluateEntry } from "../src/signals/filters";
import type { LeaderTradeDetected, PortfolioState } from "../src/types";
import { testConfig } from "./helpers";

const cfg = testConfig();

function trade(over: Partial<LeaderTradeDetected> = {}): LeaderTradeDetected {
  return {
    wallet: "0x1111111111111111111111111111111111111111",
    label: "T1",
    marketId: "C1",
    tokenId: "T",
    category: "sports",
    side: "BUY",
    priceCents: 50,
    sizeUsd: 1000,
    leaderTs: "2026-07-03T00:00:00Z",
    detectedTs: "2026-07-03T00:00:03Z",
    detectionSource: "activity",
    txHash: "0xA",
    minutesToResolution: 5000,
    ...over,
  };
}

function portfolio(over: Partial<PortfolioState> = {}): PortfolioState {
  return { openPositionCount: 0, openExposureUsd: 0, heldTokenIds: new Set(), ...over };
}

describe("evaluateEntry (§4)", () => {
  it("accepts a clean sports entry", () => {
    expect(evaluateEntry(trade(), ["sports"], cfg, portfolio())).toEqual({ accept: true });
  });

  it("rejects a category not in the allow-list", () => {
    const r = evaluateEntry(trade({ category: "politics" }), ["sports"], cfg, portfolio());
    expect(r).toEqual({ accept: false, reason: "category_not_allowed" });
  });

  it("rejects an unknown (null) category", () => {
    const r = evaluateEntry(trade({ category: null }), ["sports"], cfg, portfolio());
    expect(r).toEqual({ accept: false, reason: "category_not_allowed" });
  });

  it("matches categories case-insensitively (gamma tags are Title Case)", () => {
    expect(evaluateEntry(trade({ category: "Sports" }), ["sports"], cfg, portfolio())).toEqual({ accept: true });
    expect(evaluateEntry(trade({ category: "sports" }), ["Sports"], cfg, portfolio())).toEqual({ accept: true });
  });

  it("rejects entry price above the cap", () => {
    const r = evaluateEntry(trade({ priceCents: 61 }), ["sports"], cfg, portfolio());
    expect(r).toEqual({ accept: false, reason: "entry_price_too_high" });
  });

  it("rejects a trade smaller than the minimum", () => {
    const r = evaluateEntry(trade({ sizeUsd: 100 }), ["sports"], cfg, portfolio());
    expect(r).toEqual({ accept: false, reason: "leader_size_too_small" });
  });

  it("rejects a market resolving too soon", () => {
    const r = evaluateEntry(trade({ minutesToResolution: 30 }), ["sports"], cfg, portfolio());
    expect(r).toEqual({ accept: false, reason: "resolves_too_soon" });
  });

  it("rejects averaging into a held token", () => {
    const r = evaluateEntry(trade(), ["sports"], cfg, portfolio({ heldTokenIds: new Set(["T"]) }));
    expect(r).toEqual({ accept: false, reason: "already_holding" });
  });

  it("rejects when concurrent-position cap is reached", () => {
    const r = evaluateEntry(trade(), ["sports"], cfg, portfolio({ openPositionCount: 20 }));
    expect(r).toEqual({ accept: false, reason: "max_concurrent_positions" });
  });

  it("rejects when total exposure cap would be exceeded", () => {
    const r = evaluateEntry(trade(), ["sports"], cfg, portfolio({ openExposureUsd: 1950 }));
    expect(r).toEqual({ accept: false, reason: "max_total_exposure" });
  });
});
