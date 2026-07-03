# PROJECT SPEC: Polymarket Copy-Trading Bot — Paper-Trading Phase
<!-- Hand this file to Claude Code as the implementation spec. It is self-contained. -->

## Mission

Build a **paper-trading** bot that monitors selected profitable Polymarket traders ("leaders") and simulates copying their trades against the live orderbook, to measure whether copying is viable before any capital is deployed. **This phase places NO real orders and holds NO private keys.** All trading is simulated; all data access is public/read-only.

The single success metric is **edge capture**: simulated fill price minus the leader's actual fill price, per trade. The bot exists to measure this number honestly.

## Hard constraints — read first

1. **NO private key, wallet, or order-signing code path may exist in this phase.** Do not scaffold live execution. A `mode: paper` config flag is fine, but `mode: live` must throw `NotImplementedError`.
2. **Dependency security is critical.** Polymarket bot repos are an active wallet-drainer distribution channel (typosquatted npm packages, e.g. `clob-client-math`). Rules:
   - Pin exact versions in package.json (no `^` or `~`).
   - Commit package-lock.json. Run `npm audit` in CI.
   - Only these external runtime deps are pre-approved: `express`, `better-sqlite3`, `ethers` (v6), `zod`, `pino`. Chart.js loaded via CDN in the dashboard HTML. Anything else: STOP and ask before adding.
   - Never install packages whose names resemble Polymarket/CLOB official libs but aren't from the `@polymarket` npm scope or the official GitHub orgs.
3. **Honest fill simulation** (rules in §5). Never simulate a fill at the leader's price. Optimistic fills invalidate the entire project.
4. All timestamps in UTC, stored as ISO 8601. All prices in cents-precision decimals (0.01–0.99).

## Tech stack

- TypeScript, Node 20 LTS, strict mode.
- SQLite via `better-sqlite3` (single file DB at `./data/ledger.db`).
- `express` serving a single-page dashboard at `http://localhost:3000`.
- `pino` for structured JSON logging to `./logs/`.
- Runs on Windows (dev machine) via `npm start`; include a Dockerfile for later VPS migration.
- Reference implementation to study (read-only, do not vendored-copy blindly): QuickNode's guide repo `quiknode-labs/qn-guide-examples` → `defi/polymarket-copy-bot`.

## Repo layout

```
polymarket-paper-bot/
├── CLAUDE.md                  # summary of this spec for future sessions
├── src/
│   ├── config.ts              # zod-validated config from config.json
│   ├── detection/
│   │   ├── activityPoller.ts  # data-api polling per leader
│   │   └── chainListener.ts   # Polygon WSS OrderFilled listener
│   ├── signals/
│   │   ├── signalEngine.ts    # dedupe, filter, merge-exit detection
│   │   └── filters.ts
│   ├── paper/
│   │   ├── executor.ts        # simulated fills against live book
│   │   └── bookSnapshot.ts    # CLOB /book fetch + depth math
│   ├── ledger/
│   │   ├── db.ts              # schema + migrations
│   │   └── metrics.ts         # nightly metric computation
│   ├── dashboard/
│   │   ├── server.ts          # express + JSON API for the UI
│   │   └── public/index.html  # SPA, Chart.js via CDN
│   ├── screening/
│   │   └── screenLeaders.ts   # CLI: candidate wallet screening
│   └── index.ts               # orchestrator, graceful shutdown
├── config.json                # leaders, caps, thresholds (checked in)
├── test/                      # vitest; replay fixtures in test/fixtures
└── Dockerfile
```

## §1 Data sources (all public, no auth)

| Purpose | Endpoint |
|---|---|
| Leader trade activity | `GET https://data-api.polymarket.com/activity?user=<wallet>&type=TRADE&limit=100` |
| Leader positions | `GET https://data-api.polymarket.com/positions?user=<wallet>` |
| Orderbook snapshot | `GET https://clob.polymarket.com/book?token_id=<tokenId>` |
| Market metadata | `GET https://gamma-api.polymarket.com/markets?...` |
| On-chain confirmation | Polygon WSS: `OrderFilled` events on CTF Exchange `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` (verify current address from official docs at build time) |
| Merge/split detection | `PositionSplit` / `PositionsMerge` events on the Conditional Tokens contract |

Rate-limit budget: keep total data-api request rate under 10 req/s across all pollers. Poll each leader's activity every 1s. On HTTP 429, exponential backoff with jitter, log a `rate_limited` event.

**Known data quirk:** the public market websocket misreports trade *direction* ~40% of the time. Direction and size must be confirmed from data-api activity records and/or on-chain events — never from the market ws feed alone.

## §2 Config (`config.json`, zod-validated)

```jsonc
{
  "mode": "paper",
  "leaders": [
    { "wallet": "0x...", "label": "RN1", "allowedCategories": ["sports"], "addedAt": "...", "reason": "..." }
  ],
  "filters": {
    "maxEntryPriceCents": 60,        // ignore leader entries above 60¢
    "minLeaderTradeUsd": 500,        // ignore dust/iceberg-test trades
    "maxPriceChaseCents": 3          // sim limit = leader fill + 3¢, never higher
  },
  "sizing": {
    "notionalPerPositionUsd": 100,
    "maxConcurrentPositions": 20,
    "maxTotalExposureUsd": 2000
  },
  "gates": {                          // go/no-go thresholds, displayed on dashboard
    "minFilledPositions": 30,
    "meanEdgeCaptureCentsMin": -3,
    "medianEdgeCaptureCentsMin": -2,
    "leaderPnlCaptureRatioMin": 0.5,
    "latencyMedianSecMax": 5,
    "latencyP95SecMax": 15
  }
}
```

## §3 Detection

- `activityPoller`: per-leader 1s polling loop. New trade = record not seen before (idempotency key: `txHash + wallet + tokenId`). Emit `LeaderTradeDetected { wallet, market, tokenId, side, priceCents, sizeUsd, leaderTs, detectedTs }`.
- `chainListener`: subscribe to `OrderFilled`; match against poller detections to confirm side/size; if on-chain event arrives first, emit from here. Track which path won (metric: detection source split).
- Merge-exit detection: a `PositionsMerge` by a leader who holds an open copied position = SELL signal for that position. This is how sharp traders exit invisibly; missing it means holding bags they've left.
- Downtime tracking: on startup after a gap, log a `downtime` row with start/end; any leader trades that occurred during the gap are logged as `missed_signal`.

## §4 Signal filtering

Reject (with logged `skip_reason`) any detected leader trade where:
- market category ∉ leader's `allowedCategories`
- leader entry price > `maxEntryPriceCents` (no endgame favorites — slippage eats the edge)
- leader trade size < `minLeaderTradeUsd`
- market resolves in < 60 minutes (endgame sniping isn't copyable)
- we already hold this position (no averaging in paper phase)
- concurrent positions or total exposure caps reached

## §5 Paper executor — fill simulation rules (the heart of the project)

On an accepted BUY signal:
1. Record `signalTs`. Fetch the live book for the token **now** (i.e., after real detection latency — do not backdate).
2. Simulated limit price = `min(leaderFillCents + maxPriceChaseCents, 99)`.
3. Walk the ask side of the book: fill only against displayed asks priced ≤ limit. Fill size = `min(configured notional, cumulative displayed depth at qualifying levels)`. Partial fills below $20 notional → treat as skip (`skip_reason: insufficient_depth`).
4. If best ask > limit → `skip_reason: price_beyond_cap`. Log the ask that existed, so we know by how much we missed.
5. Record: `simFillCents` (depth-weighted avg), `filledUsd`, `edgeCaptureCents = leaderFillCents − simFillCents` (negative = we paid more).

On SELL signal (leader exit or merge-exit): same logic against the bid side. Positions held to market resolution settle at 100¢/0¢ per the resolved outcome (poll Gamma API for resolution).

Fees: apply Polymarket's current taker fee schedule for the relevant market type to simulated P&L (verify current schedule at build time; crypto/sports markets differ post-2026 fee changes).

## §6 Ledger schema (SQLite)

Tables (all with created_at):
- `leaders` (wallet PK, label, categories, added_at, removed_at, removal_reason)
- `signals` (id, wallet, market_id, token_id, side, leader_price_cents, leader_size_usd, leader_ts, detected_ts, detection_source, status: filled|skipped|missed, skip_reason)
- `positions` (id, signal_id FK, sim_fill_cents, filled_usd, edge_capture_cents, opened_ts, closed_ts, close_type: leader_exit|merge_exit|resolution, close_price_cents, pnl_usd)
- `downtime` (start_ts, end_ts, missed_signal_count)
- `daily_metrics` (date, fills, skips, mean_edge, median_edge, p10_edge, median_latency_s, p95_latency_s, pnl_usd, leader_pnl_same_trades_usd)

Nightly job computes `daily_metrics` and exports `./exports/daily_summary.csv`.

## §7 Dashboard (`localhost:3000`)

Single page, auto-refresh 30s, six panels. JSON API endpoints under `/api/*` feeding:
1. **Health**: per-leader poller status + last-event age, WSS connection state, error/429 counts, uptime, downtime log.
2. **Latency**: histogram of detection latency, median + p95 markers vs. gate thresholds (5s / 15s), split by detection source.
3. **Leaders**: card per leader — trades last 7d, rolling 30d P&L (from positions data), days since last trade, decay flag (no trades 72h OR rolling edge capture on their copies < −3¢).
4. **Signals & positions**: live table of recent signals with status/skip reasons; open positions with entry vs. current book mid; fill-rate trend line.
5. **Edge capture** (headline): scatter of per-trade edge capture over time; rolling mean and median lines; horizontal gate lines at −3¢ and −2¢; toggle split by leader and by category.
6. **Go/no-go tracker**: each gate from config rendered as progress (e.g., fills 14/30, mean edge −1.8¢ ✓, capture ratio 0.62 ✓, median latency 3.1s ✓), plus one manual checkbox persisted in DB: "Counsel sign-off received".

Alerts: browser notification + red banner on (a) any poller down > 5 min, (b) leader dark > 72h, (c) rolling-20-trade mean edge capture < −3¢.

## §8 Leader screening CLI (`npm run screen -- <wallet,...>`)

For candidate wallets: pull full trade + position history; compute realized P&L **including PositionSplit/PositionsMerge flows** (profilers that ignore merges overstate profitability ~2x); report per category: resolved position count, total staked, avg entry price, win rate, hold time distribution, activity span, bot-likelihood flag (median reaction time to market creation < 60s or > 500 trades/day). Output a screening report table + recommended `allowedCategories`. Selection criteria for inclusion: ≥ 10 resolved positions, ≥ $5k total historical stake, avg entry ≤ 60¢, active ≥ 3 months, not bot-flagged.

## §9 Testing & acceptance

- Vitest. Fixtures: recorded activity/book responses under `test/fixtures/`.
- **Replay acceptance test (must pass before the live run):** given a fixture day of a real leader's trades, the pipeline detects ≥95% of fills with correct side, and the executor's simulated fills obey every rule in §5 (assert no fill ever at better than book price, no fill above the chase cap, skips logged with reasons).
- Determinism test: same fixture input → identical ledger output.
- Idempotency test: duplicate/overlapping activity responses produce no duplicate signals.
- 24h soak on the dev machine before declaring Phase complete: zero unhandled rejections, memory stable, downtime correctly logged across a forced sleep/wake.

## §10 Out of scope — do not build

- Live order placement, wallet management, key handling (Phase 2, separate spec).
- Any strategy logic beyond copying (no independent alpha, no averaging, no martingale).
- Auth/hosting for the dashboard (localhost only this phase).
- Telegram/email alerting (VPS phase).

## Definition of done

`npm start` on Windows runs poller + listener + executor + dashboard concurrently; a 24h soak passes; the replay acceptance test passes in CI; the dashboard renders all six panels from real live data; `npm run screen` produces a screening report for a given wallet list. The 30-day measurement run then starts — no code changes during the run except leader registry updates via config + restart.
