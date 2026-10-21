import { Buffer } from 'node:buffer';
import { Budget } from '../agent/budget.js';
import { BudgetExhaustedError, DotError, describeError, isDotError } from '../errors.js';
import type {
  WireAccountState,
  WireGetTransactionResult,
  WireSignatureInfo,
  WireSignatureStatus,
} from './wire.js';
import type { RpcTransport, WithContext } from './transport.js';

function safeJsonBytes(v: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(v ?? null));
  } catch {
    return null;
  }
}

/**
 * JSON-RPC codes and message shapes that mean "this node cannot serve that
 * history", as distinct from "your request was wrong". Codes vary by client
 * software and by provider, so the message is matched as well as the code and
 * the raw code is always kept in the stats for the reader to judge.
 */
const HISTORY_UNAVAILABLE_CODES = new Set([-32015, -32007]);
const HISTORY_UNAVAILABLE_TEXT = /transaction history|history (?:is )?not available|block history|not available from the configured region/si;

export function isHistoryUnavailable(e: unknown): boolean {
  if (!isDotError(e) || e.code !== 'RPC_JSONRPC') return false;
  const code = typeof e.details.rpcCode === 'number' ? e.details.rpcCode : NaN;
  const message = typeof e.details.rpcMessage === 'string' ? e.details.rpcMessage : '';
  return HISTORY_UNAVAILABLE_CODES.has(code) || HISTORY_UNAVAILABLE_TEXT.test(message);
}

export type RpcMethod =
  | 'getTransaction'
  | 'getSignaturesForAddress'
  | 'getAccountInfo'
  | 'getMultipleAccounts'
  | 'getSlot'
  | 'getVersion'
  | 'getProgramAccounts'
  | 'getBlock'
  | 'getBlocks'
  | 'getBlocksWithLimit'
  | 'getSignatureStatuses';

export type RetryPolicy = { maxAttempts: number; baseDelayMs: number };

export type ClientStats = {
  calls: number;
  retries: number;
  pruned: number;
  failed: number;
  /** Bytes the endpoints actually sent. Call count alone hides the real cost of block batching. */
  bytes: number;
  /** True when the number is a local estimate because the response had no content-length. */
  bytesEstimated: boolean;
  byMethod: Record<string, number>;
  /** JSON-RPC error codes seen, verbatim — provider semantics vary, so keep the raw code. */
  rpcErrorCodes: Record<string, number>;
};

export type TxFetchResult =
  | { signature: string; status: 'found'; tx: WireGetTransactionResult }
  | { signature: string; status: 'pruned' }
  | { signature: string; status: 'error'; error: Record<string, unknown> };

export type AccountInfo = {
  address: string;
  lamports: number;
  owner: string;
  executable: boolean;
  data: Buffer;
};

export type SolanaClientOptions = {
  transport: RpcTransport;
  budget: Budget;
  commitment?: 'processed' | 'confirmed' | 'finalized';
  /** Required for v0 transactions; without it the node rejects versioned txs outright. */
  maxSupportedTransactionVersion?: number;
  retry?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The only place Dot talks to the chain. Every method charges the shared
 * `Budget` *before* issuing the request, including for each retry attempt, so
 * the number printed in a report is the number of round trips actually paid
 * for.
 */
export class SolanaClient {
  readonly transport: RpcTransport;
  readonly budget: Budget;
  private readonly commitment: string;
  private readonly maxVersion: number;
  private readonly retry: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly stats: ClientStats = {
    calls: 0,
    retries: 0,
    pruned: 0,
    failed: 0,
    bytes: 0,
    bytesEstimated: false,
    byMethod: {},
    rpcErrorCodes: {},
  };

  constructor(opts: SolanaClientOptions) {
    this.transport = opts.transport;
    this.budget = opts.budget;
    this.commitment = opts.commitment ?? 'finalized';
    this.maxVersion = opts.maxSupportedTransactionVersion ?? 0;
    this.retry = opts.retry ?? { maxAttempts: 3, baseDelayMs: 400 };
    this.sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  statsView(): ClientStats {
    return { ...this.stats, byMethod: { ...this.stats.byMethod }, rpcErrorCodes: { ...this.stats.rpcErrorCodes } };
  }

  resetByteCounter(): void {
    this.stats.bytes = 0;
    this.stats.bytesEstimated = false;
  }

  /** Charge first, then ask. A refused charge propagates as BudgetExhaustedError. */
  private async call<T>(method: RpcMethod, params: unknown): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
      this.budget.spendRpc(1, method);
      this.stats.calls++;
      this.stats.byMethod[method] = (this.stats.byMethod[method] ?? 0) + 1;
      try {
        const res = await this.transport.request<T>(method, params);
        this.accountBytes(method, res);
        // The transport interface allows a JSON-RPC error envelope rather than a
        // thrown error. Reading `result` off it without this check would hand the
        // caller `undefined` and look exactly like "account does not exist".
        if (res.error) {
          const code = res.error.code;
          this.stats.rpcErrorCodes[String(code)] = (this.stats.rpcErrorCodes[String(code)] ?? 0) + 1;
          throw new DotError('RPC_JSONRPC', `${method}: jsonrpc ${code} ${res.error.message}`, {
            method,
            rpcCode: code,
            rpcMessage: res.error.message,
          });
        }
        return res.result as T;
      } catch (e) {
        if (e instanceof BudgetExhaustedError) throw e;
        lastError = e;
        const retryable = isDotError(e) && (e.code === 'RPC_TRANSPORT' ||
          (e.code === 'RPC_JSONRPC' && (e.details.rpcCode === -32005 || e.details.rpcCode === 429)));
        if (!retryable) throw e;
        if (attempt < this.retry.maxAttempts) {
          this.stats.retries++;
          const hinted = typeof e === 'object' && e !== null && 'details' in e
            ? (e as { details: Record<string, unknown> }).details.retryAfterMs
            : undefined;
          const delay = typeof hinted === 'number' && hinted > 0
            ? Math.min(hinted, 15_000)
            : this.retry.baseDelayMs * 2 ** (attempt - 1);
          await this.sleep(delay);
        } else {
          throw e;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new DotError('RPC_TRANSPORT', `${method} exhausted retries`, { method });
  }

  async getSlot(): Promise<number> {
    const v = await this.call<number>('getSlot', [this.commitmentOnly()]);
    return v;
  }

  async getVersion(): Promise<{ 'solana-core'?: string; 'feature-set'?: number | string } | null> {
    try {
      return await this.call('getVersion', []);
    } catch {
      // Not every provider exposes getVersion; its absence is a reporting gap, not a failure.
      this.stats.failed = Math.max(0, this.stats.failed - 1);
      return null;
    }
  }

  async getAccountInfo(address: string): Promise<AccountInfo | null> {
    const { account } = await this.getRawAccountInfo(address);
    return account;
  }

  /**
   * `context.slot` is not decoration. Two endpoints holding different bytes for the
   * same account at *different* slots are describing chain progress; at the *same*
   * slot they are contradicting each other. Any corrouption check that cannot tell
   * those apart cries wolf on every upgrade.
   */
  async getRawAccountInfo(address: string): Promise<{ slot: number; account: AccountInfo | null }> {
    const res = await this.call<WithContext<WireAccountState<[string, 'base64']> | null>>(
      'getAccountInfo',
      [address, { encoding: 'base64', commitment: this.commitment }],
    );
    const value = res?.value ?? null;
    const slot = res?.context?.slot ?? 0;
    if (!value) return { slot, account: null };
    const [b64] = value.data;
    return {
      slot,
      account: {
        address,
        lamports: value.lamports,
        owner: value.owner,
        executable: value.executable,
        data: Buffer.from(b64, 'base64'),
      },
    };
  }

  /**
   * Where the node says these signatures live. `null` means the node does not know —
   * outside retention and not in the recent ledger — which is recorded as unknown, not
   * as "not finalized".
   */
  async getSignatureStatuses(signatures: string[]): Promise<Array<WireSignatureStatus | null>> {
    const res = await this.call<{ value: Array<WireSignatureStatus | null> }>('getSignatureStatuses', [
      signatures,
      { searchTransactionHistory: true },
    ]);
    return res?.value ?? [];
  }

  /**
   * One signature. `null` from the node is recorded as `pruned`, not as zero:
   * a pruned history silently shrinks a blast radius, and the difference has to
   * survive into the report so a reader can tell "nobody depends on this" from
   * "we were not allowed to look".
   */
  async getTransaction(signature: string): Promise<TxFetchResult> {
    try {
      const tx = await this.call<WireGetTransactionResult | null>('getTransaction', [
        signature,
        {
          encoding: 'jsonParsed',
          maxSupportedTransactionVersion: this.maxVersion,
          commitment: this.commitment,
        },
      ]);
      if (tx === null || tx === undefined) {
        this.stats.pruned++;
        return { signature, status: 'pruned' };
      }
      return { signature, status: 'found', tx };
    } catch (e) {
      if (e instanceof BudgetExhaustedError) throw e;
      // Measured against api.mainnet-beta on 2026-10-21: a node with no retention
      // answers -32015 rather than returning null. Operationally that is pruned
      // history, and calling it a fetch error hides the reason the graph is empty.
      if (isHistoryUnavailable(e)) {
        this.stats.pruned++;
        return { signature, status: 'pruned' };
      }
      this.stats.failed++;
      return { signature, status: 'error', error: describeError(e) };
    }
  }

  /**
   * Newest-first cursor walk. `until`/`before` are the only pagination there is,
   * so a caller that forgets to pass `until` re-reads the same window forever.
   */
  async getSignaturesForAddress(
    address: string,
    opts: { until?: string; limit?: number } = {},
  ): Promise<WireSignatureInfo[]> {
    const params: Record<string, unknown> = {
      limit: Math.min(opts.limit ?? 25, 1000),
      commitment: this.commitment,
    };
    if (opts.until) params.until = opts.until;
    const res = await this.call<WireSignatureInfo[]>('getSignaturesForAddress', [address, params]);
    return res ?? [];
  }

  /**
   * Bulk read used by the vault/value pass. Chunked by the caller: nodes cap the
   * number of addresses per request (commonly 20-100) and exceed it is a hard
   * error, not a partial result.
   */
  async getMultipleAccounts(addresses: string[]): Promise<Array<AccountInfo | null>> {
    const res = await this.call<WithContext<Array<WireAccountState<[string, 'base64']> | null>>>(
      'getMultipleAccounts',
      [addresses, { encoding: 'base64', commitment: this.commitment }],
    );
    return (res?.value ?? []).map((value, i) => {
      if (!value) return null;
      const [b64] = value.data;
      return {
        address: addresses[i] as string,
        lamports: value.lamports,
        owner: value.owner,
        executable: value.executable,
        data: Buffer.from(b64, 'base64'),
      };
    });
  }

  /**
   * Prefer the transport's reported wire size; `getBlock` with `jsonParsed` moves
   * tens of megabytes and a tool that counts only calls will happily recommend the
   * most expensive option. Falls back to a local serialization estimate and says so.
   */
  private accountBytes(method: string, res: { result?: unknown }): void {
    const reported = this.transport.reportedBytes?.();
    if (typeof reported === 'number' && reported > 0) {
      this.stats.bytes += reported;
      this.stats.bytesEstimated = this.stats.bytesEstimated || false;
      return;
    }
    // No transport-reported size: estimate locally and flag it. Gating this on
    // elapsed time would silently drop the byte count for every fast response,
    // which is precisely the case a fake or a cached endpoint produces.
    if (!this.stats.bytesEstimated) {
      const size = safeJsonBytes(res.result);
      if (size !== null) {
        this.stats.bytes += size;
        this.stats.bytesEstimated = true;
      }
    }
  }

  /**
   * Token-program accounts in `jsonParsed`, chunked. One call per chunk is the
   * difference between a budgetable vault sweep and one call per PDA.
   */
  async getMultipleAccountsParsed(addresses: string[]): Promise<Array<{ lamports: number; owner: string; parsedInfo?: Record<string, unknown> } | null>> {
    const res = await this.call<WithContext<Array<WireAccountState<unknown> | null>>>('getMultipleAccounts', [
      addresses,
      { encoding: 'jsonParsed', commitment: this.commitment },
    ]);
    return (res?.value ?? []).map((value) => {
      if (!value) return null;
      const data = value.data as unknown;
      const info =
        data && typeof data === 'object' && 'parsed' in data
          ? ((data as { parsed: { info?: unknown } }).parsed?.info as Record<string, unknown> | undefined)
          : undefined;
      return { lamports: value.lamports, owner: value.owner, ...(info ? { parsedInfo: info } : {}) };
    });
  }

  /**
   * One call, one whole block. This is the batching lever: the RPC *call* count
   * stops scaling with transactions. The byte count scales the other way, which is
   * why `plan()` in `src/graph/batcher.ts` reports both and does not assume the
   * cheaper-looking option is cheaper.
   */
  async getBlock(
    slot: number,
    cfg: { transactionDetails?: 'full' | 'accounts' | 'signatures' | 'none'; logMessages?: boolean; rewards?: boolean } = {},
  ): Promise<import('./wire.js').WireBlock | null> {
    const res = await this.call<import('./wire.js').WireBlock | null>('getBlock', [
      slot,
      {
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: this.maxVersion,
        commitment: this.commitment,
        transactionDetails: cfg.transactionDetails ?? 'full',
        rewards: cfg.rewards ?? false,
        ...(cfg.logMessages === undefined ? {} : { logMessages: cfg.logMessages }),
      },
    ]);
    return res ?? null;
  }

  /**
   * Slots of produced blocks in a range. Skipped slots are simply absent, which is
   * the reason `getBlock` legitimately returns null and Dot must not read that as a
   * provider fault. Providers cap the range length differently and the cap is not
   * introspectable, so it is a configured constant, not a guess.
   */
  async getBlocks(first: number, last: number): Promise<number[]> {
    const res = await this.call<number[]>('getBlocks', [first, last, { commitment: this.commitment }]);
    return res ?? [];
  }

  async getBlocksWithLimit(first: number, limit: number): Promise<number[]> {
    const res = await this.call<number[]>('getBlocksWithLimit', [first, limit, { commitment: this.commitment }]);
    return res ?? [];
  }

  private commitmentOnly(): Record<string, unknown> {
    return { commitment: this.commitment };
  }

  /**
   * Best-effort reverse pointer lookup: which `Program` accounts point at this
   * `ProgramData`. Uses a `dataSize` filter so the scan returns 36-byte pointer
   * accounts rather than 10 MB of bytecode.
   *
   * Honest limits: on mainnet the loader owns >100k accounts, so this is slow
   * and many providers gate or reject `getProgramAccounts`. Dot does not use
   * this on the hot path; it is a cross-check for the PDA derivation.
   */
  async findProgramAccountsForProgramData(programData: string): Promise<string[]> {
    const res = await this.call<Array<{ pubkey: string }>>('getProgramAccounts', [
      'BPFLoaderUpgradeab1e11111111111111111111111',
      {
        encoding: 'base64',
        commitment: this.commitment,
        filters: [{ dataSize: 36 }, { memcmp: { offset: 4, bytes: programData } }],
      },
    ]);
    return (res ?? []).map((r) => r.pubkey);
  }
}
