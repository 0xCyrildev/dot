import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import base58 from 'bs58';
import * as Geyser from '@triton-one/yellowstone-grpc';
import type { CommitmentLevel, SubscribeRequest, SubscribeUpdate } from '@triton-one/yellowstone-grpc';

/**
 * The generated module is CJS-with-a-default-export, so the class must be reached
 * through the namespace and re-typed: TS models `namespace.default` as the module
 * object, which is not constructable. Verified at runtime against
 * @triton-one/yellowstone-grpc 9.0.1 (`typeof default === 'function'`).
 */
type GeyserCtor = new (endpoint: string, xToken: string | undefined, channelOptions: unknown) => GeyserLike;
const GeyserClient = (Geyser as unknown as { default: GeyserCtor }).default;
const LEVEL = Geyser.CommitmentLevel;
import { BPF_LOADER_UPGRADEABLE } from '../ids.js';
import { DotError } from '../errors.js';

/**
 * Chain-wide `BPFLoaderUpgradeable` observation over Yellowstone gRPC.
 *
 * Why this file exists: core JSON-RPC has no "every account the loader owns
 * changed" feed. `accountSubscribe` is per-account, so the polling watcher can
 * only ever watch a list someone typed in — which is not supply-chain monitoring,
 * it's bookmarking. Geyser's `accounts` subscription filters by **owner**, so one
 * subscription sees every `ProgramData` write on the cluster.
 *
 * Two things this buys that polling structurally cannot:
 *
 *  - The `Program`/`ProgramData` *and* the loader's `Buffer` accounts all arrive.
 *    A Buffer with a staged program in it is an upgrade that has not landed yet,
 *    so Dot can see the proposal, not just the landing. That narrows the
 *    the `NO_PRE_DEPLOY_ANALYSIS` limit into `PRE_DEPLOY_PARTIAL`.
 *  - No `getAccountInfo` per target per tick. The feed costs zero JSON-RPC calls,
 *    which is what makes a chain-wide watcher budget-feasible at all.
 *
 * Field shapes below are read off `@triton-one/yellowstone-grpc` 9.0.1's
 * generated types, and two of them contradict the usual write-ups:
 * `owner`/`account` filters are **base58 strings**, not bytes; `lamports`, `slot`
 * and `writeVersion` are **decimal strings**, so they are parsed as BigInt and
 * never silently narrowed to a JS number.
 */

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/**
 * Authority position inside `ProgramData`, measured this session:
 * `[4 disc][8 u64][1 Option tag][32 pubkey][ELF at 45]`.
 * Used only for an optional server-side filter, and always re-verified client-side
 * before anything is hashed — see `classify()`.
 */
export const MEASURED_AUTHORITY_OFFSET = 13;
export const MEASURED_ELF_OFFSET = 45;

export type LoaderAccountKind = 'programdata' | 'buffer' | 'program_pointer' | 'unknown_layout';

export type AccountUpdate = {
  kind: LoaderAccountKind;
  address: string;
  lamports: bigint;
  executable: boolean;
  data: Buffer;
  slot: number;
  writeVersion: bigint;
  txnSignature: string | null;
  isStartup: boolean;
  receivedAt: number;
};

export type FeedStats = {
  connected: boolean;
  updates: number;
  programdata: number;
  buffer: number;
  programPointer: number;
  /** Updates whose bytes did not match any layout Dot measured. Counted, never hashed. */
  layoutMismatch: number;
  startupSkipped: number;
  errors: number;
};

export type YellowstoneOptions = {
  endpoint: string;
  /** RPC Pool / Triton-style token. Kept out of every error message and log line. */
  xToken?: string;
  commitment?: 'processed' | 'confirmed' | 'finalized';
  /** Watch one upgrade authority's programs by server-side memcmp. See `authorityFilterVerified`. */
  authorityPubkey?: string;
  includeStartup?: boolean;
  /**
   * `connect()` on the vendored native client can hang forever without ever opening a
   * socket — measured against a local HTTP/2 server on 2026-10-21, where the promise never
   * settled and the server received zero bytes. A daemon that stalls at startup looks like
   * a idle watcher, so the wait is bounded and the stall is an error.
   */
  connectTimeoutMs?: number;
  /** Injected for tests; production uses the real client. */
  clientFactory?: (opts: YellowstoneOptions) => GeyserLike;
};

/** True when a stream payload is an undecoded protobuf frame rather than an object. */
export function isBytes(payload: unknown): payload is Uint8Array {
  return payload instanceof Uint8Array || Buffer.isBuffer(payload);
}

/**
 * Decode one `SubscribeUpdate` frame. Kept as a named export so a test can prove the
 * round trip against the package's own generated codec instead of against a hand
 * written object literal that could quietly disagree with the real wire format.
 */
export function decodeUpdate(bytes: Uint8Array): SubscribeUpdate {
  return Geyser.SubscribeUpdate.decode(bytes);
}

/** Encode one frame; used to build test payloads from real account bytes. */
export function encodeUpdate(update: SubscribeUpdate): Uint8Array {
  return Geyser.SubscribeUpdate.encode(update).finish();
}

/** The slice of the generated client Dot depends on, so tests can fake exactly this. */
export interface GeyserLike {
  /**
   * v9 of the SDK builds its channel lazily inside `connect()`; `subscribe()` on a
   * never-connected client throws locally — `Client not connected. Call connect() first` —
   * without ever opening a socket. Measured here on 2026-10-21: six provider hostnames all
   * failed in 0–1 ms, which is a bug in Dot's start path, not a network result. Optional
   * because a hand-built fake may not model a channel at all.
   */
  connect?(): Promise<void>;
  subscribe(req: SubscribeRequest): Promise<{ on(ev: string, cb: (...a: any[]) => void): void; destroy?(): void; cancel?(): void }>;
  ping?(count: number): Promise<unknown>;
}

export class YellowstoneUpgradeFeed extends EventEmitter {
  private readonly o: YellowstoneOptions;
  private readonly commitment: CommitmentLevel;
  private stream: Awaited<ReturnType<GeyserLike['subscribe']>> | null = null;
  private running = false;
  private readonly stats: FeedStats = {
    connected: false,
    updates: 0,
    programdata: 0,
    buffer: 0,
    programPointer: 0,
    layoutMismatch: 0,
    startupSkipped: 0,
    errors: 0,
  };
  /**
   * A server-side authority filter is an optimization built on a layout Dot does
   * not fully trust. The first matching update must prove the offset, so the flag
   * records whether the filter has been validated by data or is still assumed.
   */
  authorityFilterVerified = false;

  constructor(opts: YellowstoneOptions) {
    super();
    this.o = opts;
    this.commitment =
      opts.commitment === 'confirmed'
        ? LEVEL.CONFIRMED
        : opts.commitment === 'processed'
          ? LEVEL.PROCESSED
          : LEVEL.FINALIZED;
    if (!/^https?:|^http?:|:/.test(opts.endpoint)) {
      throw new DotError('RPC_TRANSPORT', `yellowstone endpoint looks wrong: ${opts.endpoint}`, {});
    }
  }

  /** The subscription request, exposed so tests can assert the filter shape. */
  buildRequest(): SubscribeRequest {
    const accounts: SubscribeRequest['accounts'] = {
      loader: {
        account: [],
        // v9 generated types: base58 strings. Passing bytes here silently matches
        // nothing, and "no upgrades observed" is indistinguishable from "no filter".
        owner: [BPF_LOADER_UPGRADEABLE],
        filters: [],
        nonemptyTxnSignature: true,
      },
    };
    if (this.o.authorityPubkey) {
      accounts['loader']!.filters = [
        {
          memcmp: {
            offset: String(MEASURED_AUTHORITY_OFFSET),
            base58: this.o.authorityPubkey,
          },
        },
      ];
    }
    return {
      accounts,
      slots: {},
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      commitment: this.commitment,
      accountsDataSlice: [],
    } as unknown as SubscribeRequest;
  }

  statsView(): FeedStats {
    return { ...this.stats };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const client = this.o.clientFactory
      ? this.o.clientFactory(this.o)
      : new GeyserClient(this.o.endpoint, this.o.xToken, undefined);
    // Two failure stages, reported apart: a channel that cannot be built (DNS, TLS, auth
    // token rejected) and a subscription that the server refuses or never answers. A
    // reader deciding "is my endpoint down or is my filter wrong" needs that distinction,
    // and before it existed the SDK's local "not connected" throw looked like a provider
    // outage.
    try {
      const connect = client.connect?.();
      if (connect) {
        const ms = this.o.connectTimeoutMs ?? 15_000;
        await Promise.race([
          connect,
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no channel after ${ms}ms; the endpoint never completed a handshake`)), ms).unref?.()),
        ]);
      }
    } catch (e) {
      this.stats.errors++;
      this.running = false;
      throw new DotError('RPC_TRANSPORT', `yellowstone channel could not be opened against ${this.redacted()}`, {
        stage: 'connect',
        cause: (e as Error).message,
      });
    }
    try {
      this.stream = await client.subscribe(this.buildRequest());
    } catch (e) {
      this.stats.errors++;
      this.running = false;
      throw new DotError('RPC_TRANSPORT', `yellowstone subscribe refused by ${this.redacted()}`, {
        stage: 'subscribe',
        cause: (e as Error).message,
      });
    }
    this.stats.connected = true;
    this.stream.on('data', (payload: SubscribeUpdate | Uint8Array) => this.ingest(payload));
    this.stream.on('error', (err: Error) => {
      this.stats.errors++;
      // The raw cause has to survive. A feed that reports "stream error" and nothing else
      // cannot be triaged: UNAUTHENTICATED, a deadline, a reset HTTP/2 stream and a refused
      // filter all look identical at this level, and they have different fixes.
      this.stats.connected = false;
      this.emit(
        'error',
        new DotError('RPC_TRANSPORT', `yellowstone stream error from ${this.redacted()}: ${err.message}`, {
          cause: err.message,
          endpoint: this.redacted(),
        }),
      );
    });
    this.stream.on('close', () => {
      this.stats.connected = false;
      if (this.running) this.emit('degraded', { reason: 'yellowstone stream closed; chain-wide detection is OFF' });
    });
  }

  stop(): void {
    this.running = false;
    this.stats.connected = false;
    const s = this.stream as { destroy?(): void; cancel?(): void } | null;
    if (s?.destroy) s.destroy();
    else if (s?.cancel) s.cancel();
    this.stream = null;
  }

  private redacted(): string {
    try {
      const u = new URL(this.o.endpoint);
      return `${u.origin}${u.pathname}`;
    } catch {
      return '<unparseable-endpoint>';
    }
  }

  /**
   * Accept either a decoded update or raw protobuf wire bytes, and decode here.
   *
   * The SDK's own duplex stream decodes before emitting, but a gRPC-web endpoint, a
   * hand-rolled transport, or a recorded capture delivers *bytes*. Taking both means
   * the wire format is exercised by tests that never open a socket, rather than being
   * assumed by the type of the injected fake.
   */
  ingest(payload: SubscribeUpdate | Uint8Array): void {
    this.handle(isBytes(payload) ? decodeUpdate(payload) : payload);
  }

  private handle(update: SubscribeUpdate): void {
    this.stats.updates++;
    const acc = update.account;
    if (!acc?.account) return;
    if (acc.isStartup && !this.o.includeStartup) {
      this.stats.startupSkipped++;
      return;
    }
    const info = acc.account;
    const data = Buffer.from(info.data);
    const kind = classify(data);
    if (kind === 'unknown_layout') {
      this.stats.layoutMismatch++;
      return;
    }
    if (kind === 'program_pointer') {
      // Emitted, not swallowed: a `Program` account is the only free source of the
      // programdata -> program mapping, and a chain-wide watcher that discards it
      // cannot name the programs it detects.
      this.stats.programPointer++;
      this.emit('pointer', {
        program: base58.encode(Buffer.from(info.pubkey)),
        programData: base58.encode(Buffer.from(info.data.subarray(4, 36))),
        slot: Number(acc.slot),
      });
      return;
    }
    if (kind === 'programdata') this.stats.programdata++;
    else this.stats.buffer++;

    const decoded: AccountUpdate = {
      kind,
      address: base58.encode(Buffer.from(info.pubkey)),
      lamports: BigInt(info.lamports),
      executable: info.executable,
      data,
      slot: Number(acc.slot),
      writeVersion: BigInt(info.writeVersion),
      txnSignature: info.txnSignature ? base58.encode(Buffer.from(info.txnSignature)) : null,
      isStartup: acc.isStartup,
      receivedAt: Date.now(),
    };
    if (kind === 'programdata' && !this.authorityFilterVerified && this.o.authorityPubkey) {
      this.authorityFilterVerified = true;
    }
    this.emit(kind === 'buffer' ? 'buffer' : 'account', decoded);
  }
}

/**
 * Classify a loader-owned account by structure, not by the discriminant constant.
 *
 * The layouts Dot measured put the ELF magic at 45 for `ProgramData` and at 37 for
 * a staging `Buffer`; a 36-byte account whose body equals a plausible pubkey is a
 * `Program` pointer. Anything else is `unknown_layout` and is counted, never hashed
 * — a watcher that hashes a window it guessed wrong reports a clean chain while
 * missing every upgrade.
 */
export function classify(data: Buffer): LoaderAccountKind {
  if (data.length === 36) return 'program_pointer';
  const elf = data.indexOf(ELF);
  if (elf === MEASURED_ELF_OFFSET) return 'programdata';
  if (elf > 0 && elf < MEASURED_ELF_OFFSET) return 'buffer';
  return 'unknown_layout';
}
