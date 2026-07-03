// Shared test helpers: a fake fetch that serves the recorded fixtures, a silent
// logger, and a canonical paper-mode config.

import pino from "pino";
import type { Config } from "../src/config";
import type { FetchFn } from "../src/polymarket/dataApi";

export interface Fixture {
  wallet: string;
  activity: Array<Record<string, unknown>>;
  books: Record<string, { asks: Array<{ price: string; size: string }>; bids: Array<{ price: string; size: string }> }>;
  markets: Record<string, Record<string, unknown>>;
}

export function silentLogger(): pino.Logger {
  return pino({ level: "silent" });
}

/** Build a fetch that routes Polymarket API URLs to fixture data. */
export function fakeFetch(fx: Fixture): FetchFn {
  const respond = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => body } as unknown as Response);

  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/activity")) {
      const tradeOnly = url.includes("type=TRADE");
      const acts = tradeOnly ? fx.activity.filter((a) => (a.type ?? "TRADE") === "TRADE") : fx.activity;
      return respond(acts);
    }
    if (url.includes("/positions")) return respond([]);
    if (url.includes("/book")) {
      const token = new URL(url).searchParams.get("token_id") ?? "";
      return respond(fx.books[token] ?? { asks: [], bids: [] });
    }
    if (url.includes("/markets")) {
      const cid = new URL(url).searchParams.get("condition_ids") ?? "";
      const m = fx.markets[cid];
      return respond(m ? [m] : []);
    }
    return respond([]);
  }) as FetchFn;
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  const base: Config = {
    mode: "paper",
    leaders: [
      {
        wallet: "0x1111111111111111111111111111111111111111",
        label: "T1",
        allowedCategories: ["sports"],
        addedAt: "2026-07-01T00:00:00Z",
        reason: "test",
      },
    ],
    filters: {
      maxEntryPriceCents: 60,
      minLeaderTradeUsd: 500,
      maxPriceChaseCents: 3,
      minMinutesToResolution: 60,
    },
    sizing: { notionalPerPositionUsd: 100, maxConcurrentPositions: 20, maxTotalExposureUsd: 2000 },
    fees: { takerFeeBps: 0 },
    gates: {
      minFilledPositions: 30,
      meanEdgeCaptureCentsMin: -3,
      medianEdgeCaptureCentsMin: -2,
      leaderPnlCaptureRatioMin: 0.5,
      latencyMedianSecMax: 5,
      latencyP95SecMax: 15,
    },
    polling: { leaderActivityIntervalMs: 1000, globalMaxReqPerSec: 10 },
  };
  return { ...base, ...overrides };
}

export const FIXED_NOW = new Date("2026-07-03T00:10:00Z");
