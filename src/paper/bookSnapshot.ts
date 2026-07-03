// Pure orderbook depth math for the fill simulator. No network here — the caller
// passes in an already-fetched OrderBook. Keeping this pure makes §5 exhaustively
// testable and deterministic.

import type { OrderBook, Side } from "../types";

/** What to fill up to: a USD notional (entries) or a share count (exits/closes). */
export type FillTarget = { kind: "usd"; amount: number } | { kind: "shares"; amount: number };

export interface WalkResult {
  filledShares: number;
  filledUsd: number;
  /** Depth-weighted average fill price in fractional cents, or null if nothing filled. */
  avgFillCents: number | null;
  /** Best price on the side we're taking from (best ask for BUY, best bid for SELL). */
  bestOppositeCents: number | null;
  /** True if the best opposite price is outside our limit (can't trade at all). */
  beyondCap: boolean;
}

/**
 * Walk the book on the side we take liquidity from, filling only against displayed
 * depth at prices within `limitCents`, up to `target`.
 *
 * BUY  → take from asks, include levels with priceCents <= limitCents (ascending).
 * SELL → take from bids, include levels with priceCents >= limitCents (descending).
 *
 * This never fills at a better-than-displayed price and never crosses the limit.
 */
export function walkBook(book: OrderBook, side: Side, limitCents: number, target: FillTarget): WalkResult {
  const levels = side === "BUY" ? book.asks : book.bids;
  const best = levels[0]?.priceCents ?? null;

  const within = (priceCents: number): boolean =>
    side === "BUY" ? priceCents <= limitCents : priceCents >= limitCents;

  if (best === null) {
    return { filledShares: 0, filledUsd: 0, avgFillCents: null, bestOppositeCents: null, beyondCap: false };
  }
  if (!within(best)) {
    return { filledShares: 0, filledUsd: 0, avgFillCents: null, bestOppositeCents: best, beyondCap: true };
  }

  let remainingUsd = target.kind === "usd" ? target.amount : Number.POSITIVE_INFINITY;
  let remainingShares = target.kind === "shares" ? target.amount : Number.POSITIVE_INFINITY;
  let filledShares = 0;
  let filledUsd = 0;

  for (const level of levels) {
    if (remainingUsd <= 0 || remainingShares <= 0) break;
    if (!within(level.priceCents)) break; // levels are sorted; once outside, done
    const price = level.priceCents / 100;
    // Cap this level's take by whichever target binds first.
    const sharesByShares = remainingShares;
    const sharesByUsd = remainingUsd / price;
    const takeShares = Math.min(level.sizeShares, sharesByShares, sharesByUsd);
    const takeUsd = takeShares * price;
    filledShares += takeShares;
    filledUsd += takeUsd;
    remainingShares -= takeShares;
    remainingUsd -= takeUsd;
  }

  const avgFillCents = filledShares > 0 ? (filledUsd / filledShares) * 100 : null;
  return { filledShares, filledUsd, avgFillCents, bestOppositeCents: best, beyondCap: false };
}
