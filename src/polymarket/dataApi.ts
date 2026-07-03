// Typed, rate-limited, read-only clients for Polymarket's public HTTP APIs.
// No auth, no keys. A shared token-bucket keeps total request rate under the
// configured budget (< 10 req/s). On HTTP 429 we back off exponentially with
// jitter and emit a `rate_limited` log event. `fetchFn` is injectable for tests.

import type { Logger } from "pino";
import type { OrderBook, BookLevel, Side } from "../types";

export type FetchFn = typeof fetch;

const DATA_API = "https://data-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

/** Simple token-bucket rate limiter. Refills continuously up to `ratePerSec`. */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = ratePerSec;
    this.lastRefill = now();
  }

  async acquire(): Promise<void> {
    // Refill based on elapsed time, then either consume a token or wait.
    for (;;) {
      const t = this.now();
      const elapsedSec = (t - this.lastRefill) / 1000;
      this.tokens = Math.min(this.ratePerSec, this.tokens + elapsedSec * this.ratePerSec);
      this.lastRefill = t;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
      await sleep(waitMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ApiClientOptions {
  ratePerSec: number;
  logger: Logger;
  fetchFn?: FetchFn;
  maxRetries?: number;
  /** Injectable jitter source for deterministic tests. Returns [0,1). */
  jitter?: () => number;
  /** Called on notable transport events (e.g. "rate_limited", "network_error"). */
  onEvent?: (event: string) => void;
}

/** Raw leader trade as returned by the data-api activity endpoint (defensive subset). */
export interface RawActivity {
  transactionHash: string;
  timestamp: number; // unix seconds
  conditionId: string;
  asset: string; // tokenId
  side: string; // "BUY" | "SELL"
  size: number; // shares
  usdcSize: number; // notional USD
  price: number; // decimal 0..1
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
  type?: string;
}

export interface RawPosition {
  asset: string; // tokenId
  conditionId: string;
  size: number; // shares held (signed or absolute depending on API)
  avgPrice: number; // decimal 0..1
  title?: string;
}

export interface MarketMeta {
  conditionId: string;
  category: string | null;
  endDateIso: string | null;
  closed: boolean;
  resolvedOutcomePrice: number | null; // outcome[0] price: 1 or 0 once resolved, else null
  /** CLOB token ids, index-aligned with `outcomePrices`. */
  tokenIds: string[];
  /** Outcome prices (0 or 1 once resolved), index-aligned with `tokenIds`. */
  outcomePrices: number[];
}

export class PolymarketClient {
  private readonly limiter: RateLimiter;
  private readonly fetchFn: FetchFn;
  private readonly log: Logger;
  private readonly maxRetries: number;
  private readonly jitter: () => number;
  private readonly onEvent: (event: string) => void;

  constructor(opts: ApiClientOptions) {
    this.limiter = new RateLimiter(opts.ratePerSec);
    this.fetchFn = opts.fetchFn ?? fetch;
    this.log = opts.logger;
    this.maxRetries = opts.maxRetries ?? 5;
    this.jitter = opts.jitter ?? Math.random;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  private async getJson<T>(url: string): Promise<T> {
    let attempt = 0;
    for (;;) {
      await this.limiter.acquire();
      let res: Response;
      try {
        res = await this.fetchFn(url, { headers: { accept: "application/json" } });
      } catch (err) {
        if (attempt >= this.maxRetries) throw err;
        await this.backoff(attempt++, url, "network_error");
        continue;
      }
      if (res.status === 429) {
        if (attempt >= this.maxRetries) {
          throw new Error(`429 Too Many Requests after ${attempt} retries: ${url}`);
        }
        await this.backoff(attempt++, url, "rate_limited");
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return (await res.json()) as T;
    }
  }

  private async backoff(attempt: number, url: string, reason: string): Promise<void> {
    this.onEvent(reason);
    const base = Math.min(1000 * 2 ** attempt, 30_000);
    const waitMs = Math.floor(base * (0.5 + this.jitter() * 0.5));
    this.log.warn({ event: reason, url, attempt, waitMs }, "backing off");
    await sleep(waitMs);
  }

  /** Recent TRADE activity for a leader, newest first. */
  async getActivity(wallet: string, limit = 100): Promise<RawActivity[]> {
    const url = `${DATA_API}/activity?user=${wallet}&type=TRADE&limit=${limit}`;
    return this.getJson<RawActivity[]>(url);
  }

  /**
   * All activity types (TRADE, REDEEM, MERGE, SPLIT, …) for screening/history.
   * Paginates via `offset` (newest first) until the API runs dry or `maxRecords`
   * is reached. Returns `{ records, truncated }` — when truncated, downstream
   * stats like activity span are lower bounds, not the wallet's true history.
   */
  async getActivityAll(
    wallet: string,
    opts: { pageSize?: number; maxRecords?: number } = {},
  ): Promise<{ records: RawActivity[]; truncated: boolean }> {
    const pageSize = Math.min(opts.pageSize ?? 500, 500); // API max per page
    const maxRecords = opts.maxRecords ?? 3000;
    const records: RawActivity[] = [];
    let offset = 0;
    for (;;) {
      const url = `${DATA_API}/activity?user=${wallet}&limit=${pageSize}&offset=${offset}`;
      const page = await this.getJson<RawActivity[]>(url);
      records.push(...page);
      if (page.length < pageSize) return { records, truncated: false };
      if (records.length >= maxRecords) return { records: records.slice(0, maxRecords), truncated: true };
      offset += pageSize;
    }
  }

  /**
   * Market metadata for many condition ids in chunked batches (gamma accepts
   * repeated `condition_ids` params). Missing markets are absent from the map.
   */
  async getMarketMetaBatch(conditionIds: string[]): Promise<Map<string, MarketMeta>> {
    const out = new Map<string, MarketMeta>();
    const ids = [...new Set(conditionIds)];
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      const params = chunk.map((id) => `condition_ids=${id}`).join("&");
      // Gamma filters out closed markets unless closed=true is passed, so a
      // single query silently drops resolved markets — query both and merge.
      for (const extra of ["", "&closed=true"]) {
        const url = `${GAMMA_API}/markets?${params}${extra}`;
        const arr = await this.getJson<RawMarket[]>(url).catch(() => [] as RawMarket[]);
        for (const m of arr) {
          const meta = toMarketMeta(m);
          if (meta) out.set(meta.conditionId, meta);
        }
      }
    }
    return out;
  }

  /**
   * Category per event slug, from the gamma events endpoint (first meaningful
   * tag label, lowercased). The market object itself no longer carries a
   * usable category, but every activity record has an `eventSlug`.
   */
  async getEventCategoryBatch(slugs: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const unique = [...new Set(slugs)].filter(Boolean);
    for (let i = 0; i < unique.length; i += 20) {
      const chunk = unique.slice(i, i + 20);
      const url = `${GAMMA_API}/events?${chunk.map((s) => `slug=${encodeURIComponent(s)}`).join("&")}`;
      const arr = await this.getJson<RawEvent[]>(url).catch(() => [] as RawEvent[]);
      for (const e of arr) {
        if (!e.slug) continue;
        const cat = firstMeaningfulTag(e.tags);
        if (cat) out.set(e.slug, cat.toLowerCase());
      }
    }
    return out;
  }

  /** Open positions for a leader. */
  async getPositions(wallet: string): Promise<RawPosition[]> {
    const url = `${DATA_API}/positions?user=${wallet}`;
    return this.getJson<RawPosition[]>(url);
  }

  /** Orderbook snapshot for a token, normalized to cents + shares and sorted. */
  async getBook(tokenId: string, now: () => Date = () => new Date()): Promise<OrderBook> {
    const url = `${CLOB_API}/book?token_id=${tokenId}`;
    const raw = await this.getJson<RawBook>(url);
    return normalizeBook(tokenId, raw, now().toISOString());
  }

  /** Market metadata by condition id (category, resolution, end date). */
  async getMarketMeta(conditionId: string): Promise<MarketMeta | null> {
    // Gamma omits closed markets from the default listing, so a market that
    // resolves after we open a position would vanish from the plain query and
    // resolution would never be detected — check the closed listing too.
    const openArr = await this.getJson<RawMarket[]>(`${GAMMA_API}/markets?condition_ids=${conditionId}`);
    const m =
      openArr[0] ??
      (await this.getJson<RawMarket[]>(`${GAMMA_API}/markets?condition_ids=${conditionId}&closed=true`))[0];
    if (!m) return null;
    return toMarketMeta(m, conditionId);
  }
}

function toMarketMeta(m: RawMarket, fallbackConditionId?: string): MarketMeta | null {
  const id = m.conditionId ?? fallbackConditionId;
  if (!id) return null;
  const outcomePrices = parseNumArray(m.outcomePrices);
  return {
    conditionId: id,
    category: m.category ?? firstTag(m.tags) ?? null,
    endDateIso: m.endDate ?? m.end_date_iso ?? null,
    closed: Boolean(m.closed),
    resolvedOutcomePrice: m.closed && outcomePrices.length > 0 ? outcomePrices[0]! : null,
    tokenIds: parseStrArray(m.clobTokenIds),
    outcomePrices,
  };
}

interface RawEvent {
  slug?: string;
  tags?: Array<{ label?: string; slug?: string }>;
}

/** Generic housekeeping tags that say nothing about the market's category. */
const GENERIC_TAGS = new Set(["all", "hide from new", "recurring", "trending"]);

function firstMeaningfulTag(tags: RawEvent["tags"]): string | null {
  for (const t of tags ?? []) {
    const label = t.label ?? t.slug;
    if (label && !GENERIC_TAGS.has(label.toLowerCase())) return label;
  }
  return null;
}

interface RawBook {
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
}

interface RawMarket {
  conditionId?: string;
  category?: string | null;
  tags?: unknown;
  endDate?: string | null;
  end_date_iso?: string | null;
  closed?: boolean;
  outcomePrices?: unknown;
  clobTokenIds?: unknown;
}

/** Gamma returns arrays as JSON-encoded strings, e.g. "[\"1\",\"0\"]". */
function parseNumArray(raw: unknown): number[] {
  const arr = typeof raw === "string" ? safeJson(raw) : raw;
  return Array.isArray(arr) ? arr.map((x) => Number(x)).filter((n) => Number.isFinite(n)) : [];
}
function parseStrArray(raw: unknown): string[] {
  const arr = typeof raw === "string" ? safeJson(raw) : raw;
  return Array.isArray(arr) ? arr.map((x) => String(x)) : [];
}
function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function firstTag(tags: unknown): string | null {
  if (Array.isArray(tags) && tags.length > 0) {
    const t = tags[0];
    if (typeof t === "string") return t;
    if (t && typeof t === "object" && "label" in t) return String((t as { label: unknown }).label);
  }
  return null;
}

/** Convert a decimal price (0..1) string to integer cents (1..99), clamped. */
export function toCents(priceDecimal: number): number {
  return Math.max(1, Math.min(99, Math.round(priceDecimal * 100)));
}

export function normalizeSide(raw: string): Side {
  return raw.toUpperCase() === "SELL" ? "SELL" : "BUY";
}

export function normalizeBook(tokenId: string, raw: RawBook, fetchedTs: string): OrderBook {
  const asks: BookLevel[] = (raw.asks ?? [])
    .map((l) => ({ priceCents: toCents(Number(l.price)), sizeShares: Number(l.size) }))
    .filter((l) => l.sizeShares > 0)
    .sort((a, b) => a.priceCents - b.priceCents); // ascending: best ask first
  const bids: BookLevel[] = (raw.bids ?? [])
    .map((l) => ({ priceCents: toCents(Number(l.price)), sizeShares: Number(l.size) }))
    .filter((l) => l.sizeShares > 0)
    .sort((a, b) => b.priceCents - a.priceCents); // descending: best bid first
  return { tokenId, asks, bids, fetchedTs };
}
