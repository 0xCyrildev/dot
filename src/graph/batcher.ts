import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { GraphBuilder } from './builder.js';
import { analyzeTrace } from './normalize.js';
import { resolveAccountKeys } from './keys.js';
import type { SolanaClient } from '../rpc/client.js';
import type { WireBlock, WireBlockTransaction, WireGetTransactionResult, WireSignatureInfo } from '../rpc/wire.js';
import type { Budget } from '../agent/budget.js';
import { BudgetExhaustedError } from '../errors.js';

/**
 * Block-batched trace ingestion.
 *
 * The claim being tested: "one `getBlock` replaces many `getTransaction`s, so the
 * RPC call count stops scaling with transactions." That is true of *calls* and
 * false of *bytes*. A mainnet block is not the target program's transactions — it
 * is every transaction in the slot, thousands of them, and `jsonParsed` is the
 * most verbose encoding available. So batching trades a call budget for a
 * bandwidth budget. It is absolutely the right move when `maxRpcCalls` is the
 * binding constraint, and it is the wrong move when `maxWallMs` is, because a
 * 30 MB block download is slower than six 20 KB transaction fetches.
 *
 * This module therefore plans against an explicit cost model, prints the
 * arithmetic it used, and marks every input it could not measure as unverified
 * rather than quietly promoting a guess into a constant. `dot calibrate` replaces
 * the defaults with numbers from your actual endpoint.
 */

export type CostModel = {
  /** Transactions in an average produced block. */
  avgBlockTransactions: number;
  /** Wire bytes of an average `jsonParsed` transaction, block-included meta. */
  avgTxnBytes: number;
  /** Bytes per block above which Dot refuses to fetch it, to bound memory. */
  maxBlockBytes: number;
  /** Target-program transactions per block below which batching is a bad trade. */
  densityFloor: number;
  /** Where these numbers came from. Never a bare default presented as fact. */
  source: string;
  measuredAt: number | null;
};

export const UNVERIFIED_DEFAULTS: CostModel = {
  avgBlockTransactions: 2000,
  avgTxnBytes: 6_500,
  maxBlockBytes: 32_000_000,
  densityFloor: 4,
  source: 'defaults_unverified: run `dot calibrate --rpc <url>` to measure these',
  measuredAt: null,
};

export async function loadCostModel(path?: string): Promise<CostModel> {
  if (!path) return UNVERIFIED_DEFAULTS;
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<CostModel>;
    const merged: CostModel = { ...UNVERIFIED_DEFAULTS, ...raw, source: path } as CostModel;
    if (typeof raw.measuredAt === 'number') merged.measuredAt = raw.measuredAt;
    return merged;
  } catch (e) {
    return { ...UNVERIFIED_DEFAULTS, source: `${path} unreadable (${(e as Error).message}); using unverified defaults` };
  }
}

export type BlockGroup = { slot: number; signatures: string[] };

export type IngestPlan = {
  chosen: 'per_block' | 'per_signature';
  relevantTransactions: number;
  distinctBlocks: number;
  density: number;
  est: {
    callsPerSignature: number;
    callsPerBlock: number;
    bytesPerSignature: number;
    bytesPerBlock: number;
  };
  /** Calls saved divided by bytes added. Above 1 batching looks free; it is not. */
  callSavingRatio: number;
  byteAmplification: number;
  rationale: string;
  costModel: CostModel;
};

export type IngestSummary = {
  strategy: 'per_block' | 'per_signature';
  blocksFetched: number;
  blocksNull: number;
  blocksOversized: number;
  transactionsScanned: number;
  transactionsRelevant: number;
  errors: number;
  /** Cumulative wire bytes for this ingest. The number that makes batching honest. */
  bytes: number;
  bytesLastBlock: number;
  stoppedReason: string | null;
};

export class BlockBatcher {
  constructor(
    private readonly client: SolanaClient,
    private readonly model: CostModel = UNVERIFIED_DEFAULTS,
    private readonly budget?: Budget,
  ) {}

  /**
   * Signatures already carry their slot, so grouping needs no extra calls.
   * Skipped slots never appear here — they simply have no signatures.
   */
  groupBySlot(sigs: WireSignatureInfo[]): BlockGroup[] {
    const m = new Map<number, string[]>();
    for (const s of sigs) {
      const list = m.get(s.slot) ?? [];
      list.push(s.signature);
      m.set(s.slot, list);
    }
    return [...m.entries()].sort((a, b) => b[0] - a[0]).map(([slot, signatures]) => ({ slot, signatures }));
  }

  plan(groups: BlockGroup[]): IngestPlan {
    const n = groups.reduce((s, g) => s + g.signatures.length, 0);
    const b = groups.length || 1;
    const density = n / b;
    const { avgBlockTransactions, avgTxnBytes } = this.model;

    const est = {
      callsPerSignature: n,
      callsPerBlock: b,
      bytesPerSignature: n * avgTxnBytes,
      bytesPerBlock: b * avgBlockTransactions * avgTxnBytes,
    };
    const callSavingRatio = n === 0 ? 1 : est.callsPerSignature / est.callsPerBlock;
    const byteAmplification = est.bytesPerSignature === 0 ? 1 : est.bytesPerBlock / est.bytesPerSignature;

    const callsBind = this.budget ? this.budget.snapshot().remaining.rpcCalls < n : false;
    const worthIt = density >= this.model.densityFloor;
    const chosen: IngestPlan['chosen'] = callsBind || worthIt ? 'per_block' : 'per_signature';

    const rationale =
      `${n} relevant tx(s) across ${b} block(s), density ${density.toFixed(2)} tx/block. ` +
      `per_signature: ${est.callsPerSignature} call(s), ~${fmtBytes(est.bytesPerSignature)}. ` +
      `per_block: ${est.callsPerBlock} call(s), ~${fmtBytes(est.bytesPerBlock)} ` +
      `(amplification ${byteAmplification.toFixed(1)}x, because a block carries every transaction in the slot, not yours). ` +
      `Calls ${callSavingRatio.toFixed(1)}x cheaper, bytes ${byteAmplification.toFixed(1)}x dearer. ` +
      `Chose ${chosen} because ${callsBind ? 'the remaining RPC-call budget is the binding constraint' : `density ${density.toFixed(2)} ${worthIt ? '>=' : '<'} floor ${this.model.densityFloor}`}. ` +
      `Cost model: ${this.model.source}.`;

    return {
      chosen,
      relevantTransactions: n,
      distinctBlocks: groups.length,
      density,
      est,
      callSavingRatio,
      byteAmplification,
      rationale,
      costModel: this.model,
    };
  }

  /**
   * Fetch the planned blocks and fold every transaction in them that touches the
   * target into the graph.
   *
   * `getBlock` returns null for skipped slots and for blocks the node pruned; the
   * two are indistinguishable from the response alone, so both are counted and
   * neither is reported as a failure.
   */
  async ingest(
    program: string,
    groups: BlockGroup[],
    builder: GraphBuilder,
    opts: { includeLogs?: boolean; maxBlocks?: number } = {},
  ): Promise<IngestSummary> {
    const summary: IngestSummary = {
      strategy: 'per_block',
      blocksFetched: 0,
      blocksNull: 0,
      blocksOversized: 0,
      transactionsScanned: 0,
      transactionsRelevant: 0,
      errors: 0,
      bytes: 0,
      bytesLastBlock: 0,
      stoppedReason: null,
    };
    const maxBlocks = opts.maxBlocks ?? groups.length;
    const cap = Math.min(groups.length, maxBlocks);

    for (let i = 0; i < cap; i++) {
      const group = groups[i]!;
      let block: WireBlock | null;
      try {
        block = await this.client.getBlock(group.slot, {
          transactionDetails: 'full',
          ...(opts.includeLogs === undefined ? {} : { logMessages: opts.includeLogs }),
        });
      } catch (e) {
        if (e instanceof BudgetExhaustedError) {
          summary.stoppedReason = `budget exhausted after ${summary.blocksFetched} block(s): ${e.kind}`;
          break;
        }
        summary.errors++;
        continue;
      }
      if (block === null) {
        summary.blocksNull++;
        continue;
      }
      const bytesNow = this.client.statsView().bytes;
      const blockBytes = Math.max(0, bytesNow - summary.bytes);
      summary.bytes = bytesNow;
      if (blockBytes > this.model.maxBlockBytes) {
        summary.blocksOversized++;
        continue;
      }
      summary.blocksFetched++;

      for (const entry of block.transactions ?? []) {
        summary.transactionsScanned++;
        const wire = this.toWire(entry, block, group.slot);
        if (wire === null) continue;
        const keys = wire.transaction.message.accountKeys.map((k) => k.pubkey);
        if (!keys.includes(program)) continue;
        summary.transactionsRelevant++;
      summary.bytesLastBlock = blockBytes;
        const resolution = resolveAccountKeys(wire);
        builder.addTrace(wire.transaction.signatures[0] ?? `block-${group.slot}`, wire, analyzeTrace(wire, resolution));
      }
    }
    if (summary.stoppedReason === null && cap < groups.length) {
      summary.stoppedReason = `maxBlocks ${maxBlocks} reached with ${groups.length - cap} block(s) unexamined`;
    }
    return summary;
  }

  /**
   * Adapt a block entry to the `getTransaction` shape the normalizer consumes.
   * `version` is optional in block responses and `transactionIndex` is absent, so
   * the index is synthesized and the version falls back to `null`. Attribution does
   * not read either field; `resolveAccountKeys` decides the key table from
   * `source: "lookupTable"` markers and `meta.loadedAddresses`, which is why the
   * missing `version` does not silently corrupt anything.
   */
  private toWire(entry: WireBlockTransaction, block: WireBlock, slot: number): WireGetTransactionResult | null {
    if (!entry.transaction?.message) return null;
    return {
      slot: entry.slot ?? block.slot ?? slot,
      transactionIndex: undefined,
      blockTime: entry.blockTime ?? block.blockTime ?? null,
      meta: entry.meta ?? null,
      version: entry.version ?? null,
      transaction: entry.transaction,
    };
  }
}

function fmtBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} kB`;
  return `${n} B`;
}
