# Polymarket Copy-Trading Bot — Paper-Trading Phase

A **paper-trading** bot that watches selected profitable Polymarket traders
("leaders") and simulates copying their trades against the **live orderbook**, to
measure whether copying is viable **before any capital is deployed**.

> ⚠️ **This phase places NO real orders and holds NO private keys.** All trading is
> simulated; all data access is public and read-only. `mode: "live"` is intentionally
> not implemented and throws at startup.

The single success metric is **edge capture** — the gap between our simulated fill
price and the leader's actual fill price, per trade. The bot exists to measure that
number honestly. See [`CLAUDE-CODE-SPEC-polymarket-paper-bot.md`](./CLAUDE-CODE-SPEC-polymarket-paper-bot.md)
for the full spec and [`CLAUDE.md`](./CLAUDE.md) for a working summary.

## Quick start

```bash
npm install
npm start          # poller + (optional chain listener) + executor + dashboard
```

Open the dashboard at **http://localhost:3000**. With the placeholder leader in
`config.json` it shows an empty-but-healthy state; add a real, screened wallet to
see live simulated copying.

### Screen candidate leaders

```bash
npm run screen -- 0xWALLET1,0xWALLET2
```

Pulls each wallet's full history, computes realized P&L **including merge/split
flows** (profilers that ignore merges overstate profitability ~2×), and prints a
per-category report with a bot-likelihood flag and an include/exclude verdict.

### Tests

```bash
npm test           # replay acceptance, determinism, idempotency, §5 fill rules
npm run typecheck
```

## Configuration (`config.json`)

- `leaders[]` — wallets to copy, each with an `allowedCategories` allow-list.
- `filters` — max entry price, min leader trade size, price-chase cap, min time to
  resolution.
- `sizing` — per-position notional, max concurrent positions, max total exposure.
- `fees.takerFeeBps` — **verify the current Polymarket taker-fee schedule and set
  this before the measurement run** (crypto/sports differ post-2026 fee changes).
- `gates` — the go/no-go thresholds rendered on the dashboard.

Environment (`.env`, see `.env.example`):

- `POLYGON_WSS_URL` — optional. Enables the on-chain listener (OrderFilled side/size
  confirmation + `PositionsMerge` exit detection). **Without it the bot still runs**
  on data-api polling alone.
- `PORT` (default 3000), `LOG_LEVEL` (default `info`).

## How it works

```
data-api activity poll  ─┐
                          ├─► signal engine ─► filters (§4) ─► paper executor (§5) ─► SQLite ledger ─► dashboard
Polygon WSS (optional)  ─┘        (dedupe, merge-exit)          (honest fills)         (data/ledger.db)   (:3000)
```

- **Detection** (`src/detection/`) — 1s per-leader activity polling is the primary
  path; the optional chain listener confirms side/size (the public market WS
  misreports direction ~40% of the time) and catches stealthy merge-exits.
- **Fill simulation** (`src/paper/executor.ts`) — the heart of the project. Fills
  only against displayed book depth, never at the leader's price, never above the
  chase cap. Partial fills under $20 are skipped with a reason. Every decline is
  logged as data.
- **Ledger** (`src/ledger/`) — SQLite with signals, positions, downtime, and nightly
  `daily_metrics` (+ `exports/daily_summary.csv`).
- **Dashboard** (`src/dashboard/`) — six panels: health, latency, leaders, signals &
  positions, the edge-capture headline scatter, and the go/no-go gate tracker.

## Security notes

Polymarket bot repos are an active wallet-drainer distribution channel (typosquatted
packages). This project:

- pins **exact** dependency versions and commits the lockfile (`npm audit` runs in CI);
- uses only `express`, `better-sqlite3`, `ethers` (v6), `zod`, `pino` at runtime, plus
  Chart.js via CDN in the dashboard;
- holds **no keys** and has **no order-signing code path**.

Before the measurement run, verify the CTF Exchange contract address
(`src/detection/chainListener.ts`) and the taker-fee schedule against official
Polymarket docs.

## Out of scope (this phase)

Live order placement, wallet/key handling, non-copy strategy logic, dashboard
auth/hosting, and Telegram/email alerting are all Phase 2 (a separate spec).
