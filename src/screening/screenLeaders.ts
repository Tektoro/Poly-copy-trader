// Leader screening CLI (spec §8): `npm run screen -- <wallet,...>`
//
// Pulls a candidate wallet's full activity + positions, computes realized P&L
// **including PositionSplit / PositionsMerge / redeem flows** (profilers that
// ignore merges overstate profitability ~2x), and reports per-category stats,
// a bot-likelihood flag, a recommended allow-list, and an include/exclude verdict.
//
// This is a heuristic screen from public data — it is decision support, not a
// substitute for judgement. All P&L is realized cash-flow based per market.

import { pathToFileURL } from "node:url";
import { getLogger } from "../logger";
import { PolymarketClient, type MarketMeta, type RawActivity } from "../polymarket/dataApi";

interface MarketRoll {
  conditionId: string;
  category: string | null;
  netShares: number; // + long, - short; ~0 means flat/closed
  cashFlow: number; // realized USD in/out (buys negative, sells/redeems/merges positive)
  buyUsd: number;
  buyShares: number;
  firstTs: number;
  lastTs: number;
  resolved: boolean;
}

interface CategoryStat {
  category: string;
  resolvedPositions: number;
  totalStakedUsd: number;
  avgEntryCents: number;
  wins: number;
  realizedPnlUsd: number;
}

/** Cash-flow sign per activity type. Buys cost money; sells/redeems/merges return it. */
function cashFlowFor(a: RawActivity): { cash: number; shares: number; isBuy: boolean } {
  const type = (a.type ?? "TRADE").toUpperCase();
  const side = (a.side ?? "").toUpperCase();
  const usd = a.usdcSize ?? 0;
  const shares = a.size ?? 0;
  if (type === "TRADE") {
    return side === "SELL"
      ? { cash: +usd, shares: -shares, isBuy: false }
      : { cash: -usd, shares: +shares, isBuy: true };
  }
  // Merges and redeems return collateral and reduce the position; splits mint shares.
  if (type === "MERGE" || type === "REDEEM" || type === "CONVERT" || type === "REWARD") {
    return { cash: +usd, shares: -shares, isBuy: false };
  }
  if (type === "SPLIT") {
    return { cash: -usd, shares: +shares, isBuy: true };
  }
  return { cash: 0, shares: 0, isBuy: false };
}

async function rollUpMarkets(
  activity: RawActivity[],
  metaOf: (conditionId: string) => Promise<MarketMeta | null>,
): Promise<MarketRoll[]> {
  const byCondition = new Map<string, MarketRoll>();
  for (const a of activity) {
    const id = a.conditionId;
    if (!id) continue;
    const { cash, shares, isBuy } = cashFlowFor(a);
    const tsMs = a.timestamp * 1000;
    const roll =
      byCondition.get(id) ??
      { conditionId: id, category: null, netShares: 0, cashFlow: 0, buyUsd: 0, buyShares: 0, firstTs: tsMs, lastTs: tsMs, resolved: false };
    roll.netShares += shares;
    roll.cashFlow += cash;
    if (isBuy) {
      roll.buyUsd += Math.max(0, -cash);
      roll.buyShares += Math.max(0, shares);
    }
    roll.firstTs = Math.min(roll.firstTs, tsMs);
    roll.lastTs = Math.max(roll.lastTs, tsMs);
    byCondition.set(id, roll);
  }
  for (const roll of byCondition.values()) {
    const meta = await metaOf(roll.conditionId);
    roll.category = meta?.category ?? "unknown";
    roll.resolved = meta?.closed ?? false;
  }
  return [...byCondition.values()];
}

function summarize(rolls: MarketRoll[]): { categories: CategoryStat[]; overall: CategoryStat; maxTradesPerDay: number; spanDays: number } {
  const byCat = new Map<string, CategoryStat>();
  let firstTs = Number.POSITIVE_INFINITY;
  let lastTs = 0;
  for (const r of rolls) {
    firstTs = Math.min(firstTs, r.firstTs);
    lastTs = Math.max(lastTs, r.lastTs);
    const cat = r.category ?? "unknown";
    const stat = byCat.get(cat) ?? { category: cat, resolvedPositions: 0, totalStakedUsd: 0, avgEntryCents: 0, wins: 0, realizedPnlUsd: 0 };
    if (r.resolved) {
      stat.resolvedPositions += 1;
      if (r.cashFlow > 0) stat.wins += 1; // positive realized cash on a resolved market
    }
    stat.totalStakedUsd += r.buyUsd;
    stat.realizedPnlUsd += r.cashFlow;
    // accumulate share-weighted entry via temp fields on the object
    (stat as CategoryStat & { _wShares?: number; _wCents?: number })._wShares =
      ((stat as CategoryStat & { _wShares?: number })._wShares ?? 0) + r.buyShares;
    (stat as CategoryStat & { _wCents?: number })._wCents =
      ((stat as CategoryStat & { _wCents?: number })._wCents ?? 0) + (r.buyShares > 0 ? (r.buyUsd / r.buyShares) * 100 * r.buyShares : 0);
    byCat.set(cat, stat);
  }
  const categories = [...byCat.values()].map((s) => {
    const w = s as CategoryStat & { _wShares?: number; _wCents?: number };
    s.avgEntryCents = w._wShares && w._wShares > 0 ? round2((w._wCents ?? 0) / w._wShares) : 0;
    delete w._wShares;
    delete w._wCents;
    s.totalStakedUsd = round2(s.totalStakedUsd);
    s.realizedPnlUsd = round2(s.realizedPnlUsd);
    return s;
  });
  const overall: CategoryStat = {
    category: "ALL",
    resolvedPositions: categories.reduce((a, c) => a + c.resolvedPositions, 0),
    totalStakedUsd: round2(categories.reduce((a, c) => a + c.totalStakedUsd, 0)),
    avgEntryCents: 0,
    wins: categories.reduce((a, c) => a + c.wins, 0),
    realizedPnlUsd: round2(categories.reduce((a, c) => a + c.realizedPnlUsd, 0)),
  };
  const spanDays = lastTs > 0 && firstTs < lastTs ? (lastTs - firstTs) / 86_400_000 : 0;
  // trades/day for bot detection
  const perDay = new Map<string, number>();
  for (const r of rolls) perDay.set(new Date(r.lastTs).toISOString().slice(0, 10), (perDay.get(new Date(r.lastTs).toISOString().slice(0, 10)) ?? 0) + 1);
  const maxTradesPerDay = Math.max(0, ...perDay.values());
  return { categories, overall, maxTradesPerDay, spanDays: round2(spanDays) };
}

function verdict(s: ReturnType<typeof summarize>): { include: boolean; reasons: string[]; recommended: string[] } {
  const reasons: string[] = [];
  const botFlag = s.maxTradesPerDay > 500;
  if (s.overall.resolvedPositions < 10) reasons.push(`only ${s.overall.resolvedPositions} resolved positions (<10)`);
  if (s.overall.totalStakedUsd < 5000) reasons.push(`total stake $${s.overall.totalStakedUsd} (<$5k)`);
  const weightedAvgEntry = s.categories.length ? avg(s.categories.map((c) => c.avgEntryCents).filter((x) => x > 0)) : 0;
  if (weightedAvgEntry > 60) reasons.push(`avg entry ${weightedAvgEntry.toFixed(1)}¢ (>60¢)`);
  if (s.spanDays < 90) reasons.push(`active ${s.spanDays.toFixed(0)}d (<3 months)`);
  if (botFlag) reasons.push(`bot-flagged (${s.maxTradesPerDay} trades in a day)`);
  const recommended = s.categories
    .filter((c) => c.realizedPnlUsd > 0 && c.resolvedPositions >= 2 && c.category !== "unknown")
    .map((c) => c.category);
  return { include: reasons.length === 0, reasons, recommended };
}

async function screenWallet(client: PolymarketClient, wallet: string): Promise<void> {
  const activity = await client.getActivityAll(wallet, 500);
  const metaCache = new Map<string, MarketMeta | null>();
  const metaOf = async (id: string): Promise<MarketMeta | null> => {
    if (metaCache.has(id)) return metaCache.get(id)!;
    const m = await client.getMarketMeta(id).catch(() => null);
    metaCache.set(id, m);
    return m;
  };

  const rolls = await rollUpMarkets(activity, metaOf);
  const summary = summarize(rolls);
  const v = verdict(summary);

  const line = "─".repeat(78);
  console.log(`\n${line}\nSCREENING REPORT — ${wallet}\n${line}`);
  console.log(`Activity records: ${activity.length} · markets touched: ${rolls.length} · span: ${summary.spanDays}d · max trades/day: ${summary.maxTradesPerDay}`);
  console.log(`\nPer-category (realized cash-flow P&L, includes merges/splits/redeems):`);
  console.log(pad("category", 14) + pad("resolved", 10) + pad("staked$", 12) + pad("avgEntry", 10) + pad("winRate", 10) + "realizedP&L$");
  for (const c of [...summary.categories].sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd)) {
    const winRate = c.resolvedPositions > 0 ? ((c.wins / c.resolvedPositions) * 100).toFixed(0) + "%" : "—";
    console.log(pad(c.category, 14) + pad(String(c.resolvedPositions), 10) + pad(String(c.totalStakedUsd), 12) + pad(c.avgEntryCents + "¢", 10) + pad(winRate, 10) + String(c.realizedPnlUsd));
  }
  console.log(line);
  console.log(pad("ALL", 14) + pad(String(summary.overall.resolvedPositions), 10) + pad(String(summary.overall.totalStakedUsd), 12) + pad("—", 10) + pad("—", 10) + String(summary.overall.realizedPnlUsd));
  console.log(`\nVERDICT: ${v.include ? "✅ INCLUDE" : "❌ EXCLUDE"}`);
  if (v.reasons.length) console.log(`  reasons: ${v.reasons.join("; ")}`);
  console.log(`  recommended allowedCategories: ${v.recommended.length ? JSON.stringify(v.recommended) : "(none — no profitable category)"}`);
}

async function main(): Promise<void> {
  const arg = process.argv.slice(2).join(" ").trim();
  if (!arg) {
    console.error("Usage: npm run screen -- <wallet1,wallet2,...>");
    process.exit(1);
  }
  const wallets = arg.split(/[\s,]+/).filter((w) => /^0x[0-9a-fA-F]{40}$/.test(w));
  if (wallets.length === 0) {
    console.error("No valid 0x wallet addresses provided.");
    process.exit(1);
  }
  const logger = getLogger();
  const client = new PolymarketClient({ ratePerSec: 8, logger });
  for (const w of wallets) {
    try {
      await screenWallet(client, w);
    } catch (err) {
      console.error(`\nFailed to screen ${w}: ${String(err)}`);
    }
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n - 1) + " " : s + " ".repeat(n - s.length);
}
function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
