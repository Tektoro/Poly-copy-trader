// Signal filtering (spec §4). Applied to BUY entries. Each rejection returns a
// concrete skip_reason so the ledger records *why* we passed on a leader trade —
// skips are data, not silence.

import type { Config } from "../config";
import type { LeaderTradeDetected, PortfolioState, SkipReason } from "../types";

export type FilterResult = { accept: true } | { accept: false; reason: SkipReason };

/**
 * Decide whether to copy a BUY entry. Order is deliberate: cheap/structural
 * rejections (category, price, size, time) first, then portfolio-state caps.
 */
export function evaluateEntry(
  trade: LeaderTradeDetected,
  allowedCategories: string[],
  cfg: Config,
  portfolio: PortfolioState,
): FilterResult {
  // Category must be in the leader's allow-list. Unknown category (null) is rejected
  // rather than assumed safe.
  if (trade.category === null || !allowedCategories.includes(trade.category)) {
    return { accept: false, reason: "category_not_allowed" };
  }

  // No endgame favorites — slippage eats the edge above the cap.
  if (trade.priceCents > cfg.filters.maxEntryPriceCents) {
    return { accept: false, reason: "entry_price_too_high" };
  }

  // Ignore dust / iceberg-probe trades.
  if (trade.sizeUsd < cfg.filters.minLeaderTradeUsd) {
    return { accept: false, reason: "leader_size_too_small" };
  }

  // Endgame sniping isn't copyable.
  if (
    trade.minutesToResolution !== null &&
    trade.minutesToResolution < cfg.filters.minMinutesToResolution
  ) {
    return { accept: false, reason: "resolves_too_soon" };
  }

  // No averaging in the paper phase.
  if (portfolio.heldTokenIds.has(trade.tokenId)) {
    return { accept: false, reason: "already_holding" };
  }

  // Sizing caps.
  if (portfolio.openPositionCount >= cfg.sizing.maxConcurrentPositions) {
    return { accept: false, reason: "max_concurrent_positions" };
  }
  if (
    portfolio.openExposureUsd + cfg.sizing.notionalPerPositionUsd >
    cfg.sizing.maxTotalExposureUsd
  ) {
    return { accept: false, reason: "max_total_exposure" };
  }

  return { accept: true };
}
