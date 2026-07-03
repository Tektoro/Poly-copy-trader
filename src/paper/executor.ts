// Paper executor — the honest fill simulator (spec §5). This is the heart of the
// project: it must NEVER fill at the leader's price, never fill better than the
// displayed book, and never cross the chase cap. Optimistic fills invalidate the
// entire measurement, so every path here is conservative and every decline is a
// logged skip with a reason.

import type { Config } from "../config";
import type { FillResult, LeaderTradeDetected, OrderBook, Side } from "../types";
import { walkBook, type FillTarget } from "./bookSnapshot";

/** Minimum notional we consider a real fill; anything less is treated as no-fill (§5.3). */
export const MIN_FILL_USD = 20;

/**
 * Simulate copying one accepted leader ENTRY (BUY) against a live book snapshot.
 * Targets the configured per-position USD notional. The book must have been
 * fetched AFTER real detection latency (do not backdate).
 */
export function simulateFill(trade: LeaderTradeDetected, book: OrderBook, cfg: Config): FillResult {
  return simulate(trade.side, trade.priceCents, book, cfg, { kind: "usd", amount: cfg.sizing.notionalPerPositionUsd });
}

/**
 * Simulate EXITING a held position by selling `shares` back into the book at the
 * SELL side, chasing down from `refPriceCents` (the leader's exit price, or the
 * current bid for a merge-exit). Targets the full share count, not a USD notional.
 */
export function simulateExit(refPriceCents: number, shares: number, book: OrderBook, cfg: Config): FillResult {
  return simulate("SELL", refPriceCents, book, cfg, { kind: "shares", amount: shares });
}

function simulate(
  side: Side,
  refPriceCents: number,
  book: OrderBook,
  cfg: Config,
  target: FillTarget,
): FillResult {
  const limitCents = computeLimit(side, refPriceCents, cfg.filters.maxPriceChaseCents);
  const walk = walkBook(book, side, limitCents, target);

  if (walk.beyondCap) {
    // Best available price is worse than our chase cap. Record the miss magnitude.
    return {
      filled: false,
      limitCents,
      skipReason: "price_beyond_cap",
      bestOppositeCents: walk.bestOppositeCents ?? undefined,
    };
  }

  if (walk.avgFillCents === null || walk.filledShares <= 0) {
    return { filled: false, limitCents, skipReason: "insufficient_depth" };
  }

  if (walk.filledUsd < MIN_FILL_USD) {
    // Some depth existed but not enough to be a meaningful position.
    return {
      filled: false,
      limitCents,
      skipReason: "insufficient_depth",
      bestOppositeCents: walk.bestOppositeCents ?? undefined,
    };
  }

  const simFillCents = round4(walk.avgFillCents);
  const edgeCaptureCents = round4(edgeCapture(side, refPriceCents, simFillCents));

  return {
    filled: true,
    limitCents,
    simFillCents,
    filledUsd: round4(walk.filledUsd),
    filledShares: round4(walk.filledShares),
    edgeCaptureCents,
    bestOppositeCents: walk.bestOppositeCents ?? undefined,
  };
}

/** BUY: pay up to leader + chase (cap 99). SELL: accept down to leader − chase (floor 1). */
export function computeLimit(side: Side, leaderCents: number, chaseCents: number): number {
  return side === "BUY"
    ? Math.min(leaderCents + chaseCents, 99)
    : Math.max(leaderCents - chaseCents, 1);
}

/**
 * Signed edge captured vs. the leader, in cents. Positive = we did better.
 * BUY: leader − sim (paying less than the leader is good).
 * SELL: sim − leader (selling higher than the leader is good).
 * The spec gives the BUY formula explicitly; SELL is its directional mirror.
 */
export function edgeCapture(side: Side, leaderCents: number, simFillCents: number): number {
  return side === "BUY" ? leaderCents - simFillCents : simFillCents - leaderCents;
}

/**
 * Settle a held position at market resolution (100¢ or 0¢ per outcome), returning
 * realized P&L in USD net of the taker fee. `resolvedOutcomePrice` is 1 (our side
 * won) or 0 (lost) for the token we hold.
 */
export function settleAtResolution(
  simFillCents: number,
  filledShares: number,
  resolvedOutcomePrice: 0 | 1,
  takerFeeBps: number,
): number {
  const payoutPerShare = resolvedOutcomePrice; // $1 or $0
  const costPerShare = simFillCents / 100;
  const gross = (payoutPerShare - costPerShare) * filledShares;
  const notional = costPerShare * filledShares;
  return round4(gross - takerFee(notional, takerFeeBps));
}

/**
 * Realized P&L in USD for closing a position by trading out (leader exit / merge exit)
 * at a simulated close price, net of taker fee on the exit notional.
 */
export function settleAtClose(
  entryFillCents: number,
  closeFillCents: number,
  filledShares: number,
  side: Side,
  takerFeeBps: number,
): number {
  const entry = entryFillCents / 100;
  const close = closeFillCents / 100;
  // A copied position is long the token; closing means selling it back.
  const gross = side === "BUY" ? (close - entry) * filledShares : (entry - close) * filledShares;
  const exitNotional = close * filledShares;
  return round4(gross - takerFee(exitNotional, takerFeeBps));
}

export function takerFee(notionalUsd: number, bps: number): number {
  return (notionalUsd * bps) / 10_000;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
