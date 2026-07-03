// Zod-validated config. Loads ./config.json and a few environment overrides.
// Hard rule (spec §Hard constraints #1): only `mode: "paper"` is implemented.
// `mode: "live"` must throw — there is no live execution code path in this phase.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const LeaderSchema = z.object({
  wallet: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "wallet must be a 0x-prefixed 40-hex address"),
  label: z.string().min(1),
  allowedCategories: z.array(z.string().min(1)).min(1),
  addedAt: z.string(),
  reason: z.string().default(""),
});

const ConfigSchema = z.object({
  mode: z.enum(["paper", "live"]),
  leaders: z.array(LeaderSchema),
  filters: z.object({
    maxEntryPriceCents: z.number().int().min(1).max(99),
    minLeaderTradeUsd: z.number().nonnegative(),
    maxPriceChaseCents: z.number().int().min(0).max(98),
    minMinutesToResolution: z.number().nonnegative().default(60),
  }),
  sizing: z.object({
    notionalPerPositionUsd: z.number().positive(),
    maxConcurrentPositions: z.number().int().positive(),
    maxTotalExposureUsd: z.number().positive(),
  }),
  fees: z
    .object({
      takerFeeBps: z.number().nonnegative().default(0),
      note: z.string().optional(),
    })
    .default({ takerFeeBps: 0 }),
  gates: z.object({
    minFilledPositions: z.number().int().nonnegative(),
    meanEdgeCaptureCentsMin: z.number(),
    medianEdgeCaptureCentsMin: z.number(),
    leaderPnlCaptureRatioMin: z.number(),
    latencyMedianSecMax: z.number(),
    latencyP95SecMax: z.number(),
  }),
  polling: z
    .object({
      leaderActivityIntervalMs: z.number().int().positive().default(1000),
      globalMaxReqPerSec: z.number().positive().default(10),
    })
    .default({ leaderActivityIntervalMs: 1000, globalMaxReqPerSec: 10 }),
});

export type Leader = z.infer<typeof LeaderSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export interface Env {
  /** Optional Polygon WSS endpoint. If absent, chainListener is disabled. */
  polygonWssUrl: string | null;
  port: number;
  logLevel: string;
}

export function loadEnv(): Env {
  const wss = process.env.POLYGON_WSS_URL?.trim();
  return {
    polygonWssUrl: wss && wss.length > 0 ? wss : null,
    port: Number.parseInt(process.env.PORT ?? "3000", 10),
    logLevel: process.env.LOG_LEVEL ?? "info",
  };
}

export function loadConfig(configPath = resolve(process.cwd(), "config.json")): Config {
  const raw = readFileSync(configPath, "utf8");
  const parsed = ConfigSchema.parse(JSON.parse(raw));

  if (parsed.mode === "live") {
    // Intentional: Phase 2 is a separate spec. No live path exists here.
    throw new NotImplementedError(
      'mode "live" is not implemented in the paper-trading phase. ' +
        "Live order placement, wallet management, and key handling are out of scope (spec §10).",
    );
  }

  // Guard against nonsense config that would silently distort the measurement.
  if (parsed.sizing.notionalPerPositionUsd > parsed.sizing.maxTotalExposureUsd) {
    throw new Error("sizing.notionalPerPositionUsd cannot exceed sizing.maxTotalExposureUsd");
  }

  return parsed;
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
