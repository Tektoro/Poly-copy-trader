// Activity poller — the primary, always-on detection path. Polls each leader's
// data-api TRADE activity on a fixed interval and emits new trades downstream.
//
// On the first poll for a leader we PRIME (record the latest timestamp, emit
// nothing) so we never backfill pre-watch history as if it were live. After that,
// only trades strictly newer than the last seen leader timestamp are emitted.

import type { Logger } from "pino";
import type { Config, Leader } from "../config";
import type { LeaderTradeDetected } from "../types";
import {
  normalizeSide,
  toCents,
  type MarketMeta,
  type PolymarketClient,
  type RawActivity,
} from "../polymarket/dataApi";

export interface PollerDeps {
  onTrade: (trade: LeaderTradeDetected) => Promise<void>;
  logger: Logger;
  now: () => Date;
}

interface MetaCacheEntry {
  meta: MarketMeta | null;
  fetchedMs: number;
}

const META_TTL_MS = 5 * 60 * 1000;

export class ActivityPoller {
  private timers: NodeJS.Timeout[] = [];
  private lastSeenMs = new Map<string, number>(); // wallet -> max leaderTs seen (ms)
  private primed = new Set<string>();
  private readonly metaCache = new Map<string, MetaCacheEntry>();
  // eventSlug -> category. Slugs never change category; cache for the process lifetime.
  private readonly eventCategoryCache = new Map<string, string | null>();
  private stopped = false;

  constructor(
    private readonly client: PolymarketClient,
    private readonly cfg: Config,
    private readonly deps: PollerDeps,
  ) {}

  start(): void {
    for (const leader of this.cfg.leaders) {
      // Stagger nothing fancy; the shared rate limiter serializes requests anyway.
      const timer = setInterval(() => {
        void this.pollLeader(leader);
      }, this.cfg.polling.leaderActivityIntervalMs);
      this.timers.push(timer);
      // Kick an immediate first poll to prime quickly.
      void this.pollLeader(leader);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Health snapshot for the dashboard: last successful poll + last event age. */
  status(): Array<{ wallet: string; label: string; lastEventTs: string | null }> {
    return this.cfg.leaders.map((l) => {
      const ms = this.lastSeenMs.get(l.wallet);
      return {
        wallet: l.wallet,
        label: l.label,
        lastEventTs: ms ? new Date(ms).toISOString() : null,
      };
    });
  }

  private async pollLeader(leader: Leader): Promise<void> {
    if (this.stopped) return;
    let activity: RawActivity[];
    try {
      activity = await this.client.getActivity(leader.wallet, 100);
    } catch (err) {
      this.deps.logger.warn({ event: "poll_error", wallet: leader.wallet, err: String(err) });
      return;
    }

    if (!this.primed.has(leader.wallet)) {
      const maxMs = activity.reduce((m, a) => Math.max(m, a.timestamp * 1000), 0);
      this.lastSeenMs.set(leader.wallet, maxMs || this.deps.now().getTime());
      this.primed.add(leader.wallet);
      this.deps.logger.info({ event: "poller_primed", wallet: leader.wallet, baselineTs: this.lastSeenMs.get(leader.wallet) });
      return;
    }

    const since = this.lastSeenMs.get(leader.wallet) ?? 0;
    // Oldest-first so downstream ordering matches chronology.
    const fresh = activity
      .filter((a) => a.timestamp * 1000 > since)
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const a of fresh) {
      const trade = await this.toTrade(leader, a);
      this.lastSeenMs.set(leader.wallet, Math.max(this.lastSeenMs.get(leader.wallet) ?? 0, a.timestamp * 1000));
      try {
        await this.deps.onTrade(trade);
      } catch (err) {
        this.deps.logger.error({ event: "on_trade_error", wallet: leader.wallet, err: String(err) });
      }
    }
  }

  private async toTrade(leader: Leader, a: RawActivity): Promise<LeaderTradeDetected> {
    const meta = await this.getMeta(a.conditionId);
    const minutesToResolution = meta?.endDateIso
      ? Math.round((Date.parse(meta.endDateIso) - this.deps.now().getTime()) / 60_000)
      : null;
    // Category lives on the event's tags, not the market object (gamma dropped
    // the market-level category) — same resolution the screener uses.
    const eventCategory = a.eventSlug ? await this.getEventCategory(a.eventSlug) : null;
    return {
      wallet: leader.wallet,
      label: leader.label,
      marketId: a.conditionId,
      tokenId: a.asset,
      category: eventCategory ?? meta?.category?.toLowerCase() ?? null,
      side: normalizeSide(a.side),
      priceCents: toCents(a.price),
      sizeUsd: a.usdcSize,
      leaderTs: new Date(a.timestamp * 1000).toISOString(),
      detectedTs: this.deps.now().toISOString(),
      detectionSource: "activity",
      txHash: a.transactionHash,
      minutesToResolution,
    };
  }

  private async getEventCategory(eventSlug: string): Promise<string | null> {
    if (this.eventCategoryCache.has(eventSlug)) return this.eventCategoryCache.get(eventSlug)!;
    try {
      const map = await this.client.getEventCategoryBatch([eventSlug]);
      const cat = map.get(eventSlug) ?? null;
      this.eventCategoryCache.set(eventSlug, cat);
      return cat;
    } catch (err) {
      this.deps.logger.warn({ event: "event_category_error", eventSlug, err: String(err) });
      return null; // not cached — retry on the next trade for this event
    }
  }

  private async getMeta(conditionId: string): Promise<MarketMeta | null> {
    const cached = this.metaCache.get(conditionId);
    const nowMs = this.deps.now().getTime();
    if (cached && nowMs - cached.fetchedMs < META_TTL_MS) return cached.meta;
    try {
      const meta = await this.client.getMarketMeta(conditionId);
      this.metaCache.set(conditionId, { meta, fetchedMs: nowMs });
      return meta;
    } catch (err) {
      this.deps.logger.warn({ event: "meta_error", conditionId, err: String(err) });
      return cached?.meta ?? null;
    }
  }
}
