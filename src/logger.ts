// Structured JSON logging via pino. Writes to ./logs/bot-<date>.log and mirrors
// to stderr. Log records are the audit trail: rate_limited, skip_reason, downtime,
// missed_signal, fills, etc. all flow through here.

import { mkdirSync, createWriteStream } from "node:fs";
import { resolve } from "node:path";
import pino from "pino";

const LOG_DIR = resolve(process.cwd(), "logs");

let singleton: pino.Logger | null = null;

/** Deterministic date-stamped log filename without relying on Date at import time. */
function logFileName(now: Date): string {
  const day = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return resolve(LOG_DIR, `bot-${day}.log`);
}

export function getLogger(level = process.env.LOG_LEVEL ?? "info"): pino.Logger {
  if (singleton) return singleton;
  mkdirSync(LOG_DIR, { recursive: true });

  const fileStream = createWriteStream(logFileName(new Date()), { flags: "a" });
  singleton = pino(
    {
      level,
      base: { app: "polymarket-paper-bot" },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream([
      { stream: fileStream, level },
      { stream: process.stderr, level },
    ]),
  );
  return singleton;
}
