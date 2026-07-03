// Shared domain types and events for the paper-trading bot.
// Prices are integer cents (1..99) unless named `...CentsExact` (fractional allowed
// for depth-weighted simulated fills). All timestamps are UTC ISO-8601 strings.

export type Side = "BUY" | "SELL";

export type DetectionSource = "activity" | "chain";

export type SignalStatus = "filled" | "skipped" | "missed";

export type CloseType = "leader_exit" | "merge_exit" | "resolution";

/** Every reason we decline to (or cannot) simulate a fill. Logged on the signal. */
export type SkipReason =
  | "category_not_allowed"
  | "entry_price_too_high"
  | "leader_size_too_small"
  | "resolves_too_soon"
  | "already_holding"
  | "max_concurrent_positions"
  | "max_total_exposure"
  | "insufficient_depth"
  | "price_beyond_cap"
  | "book_unavailable";

/** A leader trade observed by a detector, before filtering. */
export interface LeaderTradeDetected {
  wallet: string;
  label: string;
  marketId: string;
  tokenId: string;
  /** Market category (e.g. "sports"), resolved from market metadata when available. */
  category: string | null;
  side: Side;
  /** Leader's fill price, integer cents 1..99. */
  priceCents: number;
  /** Leader's trade notional in USD. */
  sizeUsd: number;
  /** When the leader's trade actually happened (from activity/on-chain), UTC ISO-8601. */
  leaderTs: string;
  /** When we detected it, UTC ISO-8601. Latency = detectedTs - leaderTs. */
  detectedTs: string;
  detectionSource: DetectionSource;
  /** Idempotency components. */
  txHash: string;
  /** Minutes until the market resolves, if known (used by the time filter). */
  minutesToResolution: number | null;
}

/** One price level of the orderbook, normalized to cents + shares. */
export interface BookLevel {
  /** Integer cents 1..99. */
  priceCents: number;
  /** Number of outcome tokens (shares) displayed at this level. */
  sizeShares: number;
}

export interface OrderBook {
  tokenId: string;
  /** Ascending by price (best/lowest ask first). */
  asks: BookLevel[];
  /** Descending by price (best/highest bid first). */
  bids: BookLevel[];
  /** When the snapshot was fetched, UTC ISO-8601. */
  fetchedTs: string;
}

/** Result of the honest fill simulation (spec §5). */
export interface FillResult {
  filled: boolean;
  /** The limit we were willing to pay/accept, integer cents. */
  limitCents: number;
  /** Depth-weighted average simulated fill price, fractional cents. Present iff filled. */
  simFillCents?: number;
  /** USD notional actually filled against displayed depth. Present iff filled. */
  filledUsd?: number;
  /** Shares filled. Present iff filled. */
  filledShares?: number;
  /** Signed edge captured vs. the leader, in cents (positive = we did better). Present iff filled. */
  edgeCaptureCents?: number;
  /** Set iff not filled. */
  skipReason?: SkipReason;
  /** Best opposite-side price that existed at simulation time, for post-mortem on misses. */
  bestOppositeCents?: number;
}

/** Portfolio view the executor needs to enforce sizing/exposure caps. */
export interface PortfolioState {
  openPositionCount: number;
  openExposureUsd: number;
  heldTokenIds: Set<string>;
}
