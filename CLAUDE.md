# CLAUDE.md — Polymarket Paper-Trading Bot

Summary of the implementation spec for future sessions. Full spec:
`CLAUDE-CODE-SPEC-polymarket-paper-bot.md`.

## What this is

A **paper-trading** bot. It watches selected profitable Polymarket traders
("leaders"), and when they trade, it simulates copying the trade against the
**live orderbook** to measure whether copying is viable. The single success
metric is **edge capture** = `leaderFillCents − simFillCents` (negative = we
paid worse than the leader).

## Hard rules (do not break)

1. **No real orders, no wallet, no key handling, ever, in this phase.**
   `mode: "paper"` is the only implemented mode. `mode: "live"` throws
   `NotImplementedError` at startup (see `src/config.ts`).
2. **Dependency security.** Exact-pinned versions only (no `^`/`~`).
   Approved runtime deps: `express`, `better-sqlite3`, `ethers` (v6), `zod`,
   `pino`. Chart.js is CDN-only in the dashboard HTML. Adding anything else
   requires an explicit human decision — never install a package whose name
   merely resembles an official Polymarket/CLOB lib.
3. **Honest fills.** Never simulate a fill at the leader's price. Fills only
   against displayed book depth, never above the chase cap. See
   `src/paper/executor.ts` §5 rules — they are the heart of the project.
4. All timestamps UTC ISO-8601. Prices are cents (integers 1–99); simulated
   fill prices may be fractional cents (depth-weighted).

## Layout

- `src/config.ts` — zod-validated config loader (`config.json` + env).
- `src/detection/` — `activityPoller` (data-api, primary), `chainListener`
  (Polygon WSS `OrderFilled` + merge/split; optional, needs `POLYGON_WSS_URL`).
- `src/signals/` — `signalEngine` (dedupe, merge-exit → SELL), `filters` (§4).
- `src/paper/` — `bookSnapshot` (CLOB `/book` + depth math), `executor` (§5).
- `src/ledger/` — `db` (SQLite schema §6), `metrics` (nightly + CSV export).
- `src/dashboard/` — `server` (express + `/api/*`), `public/index.html` (SPA).
- `src/screening/screenLeaders.ts` — `npm run screen -- <wallet,...>` (§8).
- `src/index.ts` — orchestrator + graceful shutdown + downtime tracking.

## Data sources (all public, read-only)

- Activity: `https://data-api.polymarket.com/activity`
- Positions: `https://data-api.polymarket.com/positions`
- Book: `https://clob.polymarket.com/book`
- Markets: `https://gamma-api.polymarket.com/markets`
- On-chain (optional): Polygon WSS `OrderFilled` on the CTF Exchange, and
  `PositionSplit`/`PositionsMerge` on the Conditional Tokens contract.

Rate budget: < 10 req/s total; 1s per-leader activity poll; 429 → backoff+jitter.
**Known quirk:** the market WS misreports trade *direction* ~40% of the time —
confirm side/size from data-api activity and/or on-chain events only.

## Run

- `npm install` then `npm start` → poller + listener + executor + dashboard
  (http://localhost:3000).
- `npm run screen -- 0xwallet1,0xwallet2` → screening report.
- `npm test` → vitest (replay/determinism/idempotency acceptance tests).

Verify the CTF Exchange contract address and the current taker-fee schedule
against official Polymarket docs before the measurement run.
