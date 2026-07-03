// On-chain listener (spec §3) — OPTIONAL. Enabled only when POLYGON_WSS_URL is set.
// It provides two things the polling path can't do alone:
//   1. Confirmation of trade side/size from OrderFilled events (the public market
//      WS misreports direction ~40% of the time, so we never trust it alone).
//   2. Merge-exit detection: a PositionsMerge by a leader is a stealthy exit signal.
//
// This is best-effort infrastructure: any decode/connection error is logged and
// swallowed so the primary polling path keeps running. Verify both contract
// addresses against official Polymarket docs before the measurement run.

import { ethers } from "ethers";
import type { Logger } from "pino";

// TODO(verify at build time): confirm these against official Polymarket docs.
export const CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
export const CONDITIONAL_TOKENS_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

const ORDER_FILLED_ABI = [
  "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)",
];

const CT_MERGE_ABI = [
  "event PositionsMerge(address indexed stakeholder, address collateralToken, bytes32 indexed parentCollectionId, bytes32 indexed conditionId, uint256[] partition, uint256 amount)",
];

export interface ChainListenerDeps {
  logger: Logger;
  leaderWallets: string[];
  /** Called when a watched leader merges positions in a market (condition id). */
  onMergeExit: (wallet: string, conditionId: string, ts: string, txHash: string) => Promise<void>;
  /** Called on a confirmed OrderFilled involving a watched leader (side/size confirmation). */
  onOrderFilled?: (wallet: string, txHash: string) => void;
  now: () => Date;
}

export class ChainListener {
  private provider: ethers.WebSocketProvider | null = null;
  private exchange: ethers.Contract | null = null;
  private conditionalTokens: ethers.Contract | null = null;
  private connected = false;
  private orderFilledCount = 0;
  private mergeCount = 0;
  private readonly leaderSet: Set<string>;

  constructor(
    private readonly wssUrl: string,
    private readonly deps: ChainListenerDeps,
  ) {
    this.leaderSet = new Set(deps.leaderWallets.map((w) => w.toLowerCase()));
  }

  start(): void {
    try {
      this.provider = new ethers.WebSocketProvider(this.wssUrl);
      this.exchange = new ethers.Contract(CTF_EXCHANGE_ADDRESS, ORDER_FILLED_ABI, this.provider);
      this.conditionalTokens = new ethers.Contract(CONDITIONAL_TOKENS_ADDRESS, CT_MERGE_ABI, this.provider);
      this.wire();
      this.connected = true;
      this.deps.logger.info({ event: "chain_listener_started", wssUrl: redact(this.wssUrl) });
    } catch (err) {
      this.connected = false;
      this.deps.logger.error({ event: "chain_listener_start_failed", err: String(err) });
    }
  }

  private wire(): void {
    this.exchange?.on("OrderFilled", (...args: unknown[]) => {
      try {
        const ev = args[args.length - 1] as ethers.EventLog;
        const maker = String(ev.args?.[1] ?? "").toLowerCase();
        const taker = String(ev.args?.[2] ?? "").toLowerCase();
        const leader = this.leaderSet.has(maker) ? maker : this.leaderSet.has(taker) ? taker : null;
        if (!leader) return;
        this.orderFilledCount++;
        this.deps.onOrderFilled?.(leader, ev.transactionHash);
      } catch (err) {
        this.deps.logger.warn({ event: "order_filled_decode_error", err: String(err) });
      }
    });

    this.conditionalTokens?.on("PositionsMerge", (...args: unknown[]) => {
      try {
        const ev = args[args.length - 1] as ethers.EventLog;
        const stakeholder = String(ev.args?.[0] ?? "").toLowerCase();
        if (!this.leaderSet.has(stakeholder)) return;
        const conditionId = String(ev.args?.[3] ?? "");
        this.mergeCount++;
        void this.deps.onMergeExit(stakeholder, conditionId, this.deps.now().toISOString(), ev.transactionHash);
      } catch (err) {
        this.deps.logger.warn({ event: "merge_decode_error", err: String(err) });
      }
    });

    this.provider?.on("error", (err) => {
      this.connected = false;
      this.deps.logger.error({ event: "chain_ws_error", err: String(err) });
    });
  }

  status(): { enabled: boolean; connected: boolean; orderFilledCount: number; mergeCount: number } {
    return {
      enabled: true,
      connected: this.connected,
      orderFilledCount: this.orderFilledCount,
      mergeCount: this.mergeCount,
    };
  }

  async stop(): Promise<void> {
    try {
      await this.provider?.destroy();
    } catch {
      /* ignore */
    }
    this.connected = false;
  }
}

function redact(url: string): string {
  // Strip API keys embedded in the path/query of RPC URLs before logging.
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return "wss://…";
  }
}
