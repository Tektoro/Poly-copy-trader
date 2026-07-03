// Signal engine: the decision layer. Takes detected leader trades, dedupes them
// idempotently, applies entry filters, drives the paper executor, and records
// everything (fills AND skips) to the ledger. Also handles exits: a leader SELL
// or a PositionsMerge by a leader holding a position we copied is a close signal.

import type { Logger } from "pino";
import type { Config, Leader } from "../config";
import type { Ledger } from "../ledger/db";
import { evaluateEntry } from "./filters";
import { settleAtClose, simulateExit, simulateFill } from "../paper/executor";
import type { LeaderTradeDetected, OrderBook, SignalStatus, SkipReason } from "../types";

export interface EngineDeps {
  getBook: (tokenId: string) => Promise<OrderBook | null>;
  logger: Logger;
  now: () => Date;
}

export class SignalEngine {
  private readonly leadersByWallet: Map<string, Leader>;

  constructor(
    private readonly ledger: Ledger,
    private readonly cfg: Config,
    private readonly deps: EngineDeps,
  ) {
    this.leadersByWallet = new Map(cfg.leaders.map((l) => [l.wallet.toLowerCase(), l]));
  }

  /** Primary entry point for a detected leader trade. */
  async onLeaderTrade(trade: LeaderTradeDetected): Promise<void> {
    // Idempotency: never process the same (txHash, wallet, tokenId) twice.
    if (this.ledger.hasSignal(trade.txHash, trade.wallet, trade.tokenId)) return;

    if (trade.side === "BUY") {
      await this.handleEntry(trade);
    } else {
      await this.handleLeaderExit(trade);
    }
  }

  /**
   * Merge-exit: a leader who holds an open copied position performed a
   * PositionsMerge — a stealthy exit. If we hold a copied position in that
   * market (condition id), sell it against the current bid.
   */
  async onMergeExit(wallet: string, conditionId: string, ts: string, txHash: string): Promise<void> {
    const pos = this.ledger.openPositionByCondition(wallet, conditionId);
    if (!pos) return;
    const tokenId = pos.token_id;

    const book = await this.deps.getBook(tokenId);
    const bestBid = book?.bids[0]?.priceCents ?? null;
    if (!book || bestBid === null) {
      this.log("merge_exit_no_book", { wallet, tokenId });
      return;
    }

    // Synthetic SELL at the current bid (merges have no market price of their own).
    const synthetic: LeaderTradeDetected = {
      wallet,
      label: this.leadersByWallet.get(wallet.toLowerCase())?.label ?? wallet,
      marketId: pos.token_id,
      tokenId,
      category: null,
      side: "SELL",
      priceCents: bestBid,
      sizeUsd: pos.filled_usd,
      leaderTs: ts,
      detectedTs: this.deps.now().toISOString(),
      detectionSource: "chain",
      txHash,
      minutesToResolution: null,
    };
    // Sell the full held position (share-targeted), not a fixed notional.
    const fill = simulateExit(bestBid, pos.filled_shares, book, this.cfg);
    const signalId = this.recordSignal(synthetic, fill.filled ? "filled" : "skipped", fill.skipReason ?? null);
    if (!fill.filled || fill.simFillCents === undefined) {
      this.log("merge_exit_unfilled", { tokenId, reason: fill.skipReason });
      return;
    }
    const pnl = settleAtClose(pos.sim_fill_cents, fill.simFillCents, pos.filled_shares, "BUY", this.cfg.fees.takerFeeBps);
    this.ledger.closePosition(pos.id, synthetic.detectedTs, "merge_exit", fill.simFillCents, pnl);
    this.log("merge_exit_closed", { tokenId, pnl, signalId });
  }

  private async handleEntry(trade: LeaderTradeDetected): Promise<void> {
    const leader = this.leadersByWallet.get(trade.wallet.toLowerCase());
    const allowed = leader?.allowedCategories ?? [];
    const portfolio = this.ledger.portfolioState();

    const verdict = evaluateEntry(trade, allowed, this.cfg, portfolio);
    if (!verdict.accept) {
      this.recordSignal(trade, "skipped", verdict.reason);
      this.log("entry_skipped", { tokenId: trade.tokenId, reason: verdict.reason });
      return;
    }

    const book = await this.deps.getBook(trade.tokenId);
    if (!book) {
      this.recordSignal(trade, "skipped", "book_unavailable");
      return;
    }

    const fill = simulateFill(trade, book, this.cfg);
    if (!fill.filled) {
      this.recordSignal(trade, "skipped", fill.skipReason ?? "book_unavailable");
      this.log("entry_unfilled", {
        tokenId: trade.tokenId,
        reason: fill.skipReason,
        bestAskCents: fill.bestOppositeCents,
        limitCents: fill.limitCents,
      });
      return;
    }

    const signalId = this.recordSignal(trade, "filled", null);
    this.ledger.insertPosition({
      signal_id: signalId,
      wallet: trade.wallet,
      token_id: trade.tokenId,
      side: "BUY",
      sim_fill_cents: fill.simFillCents!,
      filled_usd: fill.filledUsd!,
      filled_shares: fill.filledShares!,
      edge_capture_cents: fill.edgeCaptureCents!,
      opened_ts: trade.detectedTs,
    });
    this.log("entry_filled", {
      tokenId: trade.tokenId,
      simFillCents: fill.simFillCents,
      edgeCaptureCents: fill.edgeCaptureCents,
      filledUsd: fill.filledUsd,
    });
  }

  private async handleLeaderExit(trade: LeaderTradeDetected): Promise<void> {
    const pos = this.ledger.openPositionByToken(trade.tokenId);
    if (!pos) {
      // Leader sold something we never copied — informational, not actionable.
      this.recordSignal(trade, "skipped", null);
      return;
    }

    const book = await this.deps.getBook(trade.tokenId);
    if (!book) {
      this.recordSignal(trade, "skipped", "book_unavailable");
      return;
    }

    // Sell the full held position (share-targeted) at/above the leader's exit − chase.
    const fill = simulateExit(trade.priceCents, pos.filled_shares, book, this.cfg);
    if (!fill.filled || fill.simFillCents === undefined) {
      this.recordSignal(trade, "skipped", fill.skipReason ?? "book_unavailable");
      return;
    }

    const signalId = this.recordSignal(trade, "filled", null);
    const pnl = settleAtClose(pos.sim_fill_cents, fill.simFillCents, pos.filled_shares, "BUY", this.cfg.fees.takerFeeBps);
    this.ledger.closePosition(pos.id, trade.detectedTs, "leader_exit", fill.simFillCents, pnl);
    this.log("leader_exit_closed", { tokenId: trade.tokenId, pnl, signalId });
  }

  private recordSignal(trade: LeaderTradeDetected, status: SignalStatus, skipReason: SkipReason | null): number {
    const { id } = this.ledger.insertSignal({
      wallet: trade.wallet,
      market_id: trade.marketId,
      token_id: trade.tokenId,
      side: trade.side,
      leader_price_cents: trade.priceCents,
      leader_size_usd: trade.sizeUsd,
      leader_ts: trade.leaderTs,
      detected_ts: trade.detectedTs,
      detection_source: trade.detectionSource,
      status,
      skip_reason: skipReason,
      tx_hash: trade.txHash,
      category: trade.category,
    });
    return id;
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.deps.logger.info({ event, ...fields });
  }
}
