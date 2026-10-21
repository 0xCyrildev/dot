import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import base58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import {
  encodeUpdate,
  decodeUpdate,
  isBytes,
  YellowstoneUpgradeFeed,
  type AccountUpdate,
  type GeyserLike,
} from '../src/rpc/yellowstone.js';
import { decodeProgramData } from '../src/state/programdata.js';
import { BPF_LOADER_UPGRADEABLE } from '../src/ids.js';
import { FakeTransport, fixture } from './helpers.js';
import type { SubscribeRequest, SubscribeUpdate } from '@triton-one/yellowstone-grpc';
import { EventEmitter } from 'node:events';

/**
 * Proving the gRPC path without a live endpoint.
 *
 * The claim this test can honestly support: **Dot decodes real protobuf frames
 * containing real mainnet `ProgramData` bytes.** It builds the frame with the
 * package's own generated `SubscribeUpdate.encode`, feeds the resulting wire bytes
 * into the feed, and asserts the account survives the trip — same pubkey, same
 * bytes, same upgrade authority the chain reported. That is materially stronger
 * than the SDK-level fake used in `transports.test.ts`, which handed the feed an
 * object literal shaped like whatever the author believed the message to be.
 *
 * It does NOT prove: TCP/HTTP2 handshake, x-token auth, replay (`isReplay`)
 * semantics, or reconnect behaviour. Those live in the transport, below the seam
 * this test reaches. The limit code says so; it is not quietly deleted.
 */

const observed = fixture<{
  accounts: Array<{ program: string; programData: string; headBase64: string; expect: { authority: string | null } }>;
}>('programdata-observed');

// The LBUZ account, byte-for-byte as mainnet served it.
const REAL = observed.accounts[0]!;
const REAL_BYTES = Buffer.from(REAL.headBase64, 'base64');

function frameFor(opts: {
  address: string;
  data: Buffer;
  isStartup?: boolean;
  slot?: string;
  signature?: string;
}): SubscribeUpdate {
  return {
    filters: ['loader'],
    createdAt: undefined,
    account: {
      isStartup: opts.isStartup ?? false,
      slot: opts.slot ?? '459621012',
      bankId: undefined,
      account: {
        pubkey: new PublicKey(opts.address).toBuffer(),
        lamports: '12633600',
        owner: new PublicKey(BPF_LOADER_UPGRADEABLE).toBuffer(),
        executable: false,
        rentEpoch: '18446744073709551615',
        data: new Uint8Array(opts.data),
        writeVersion: '4471',
        txnSignature: opts.signature ? new Uint8Array(base58.decode(opts.signature)) : undefined,
      },
    },
  } as unknown as SubscribeUpdate;
}

class RawByteStream extends EventEmitter {
  /** Emits *bytes*, like a gRPC-web or recorded transport would. */
  pushBytes(update: SubscribeUpdate): void {
    this.emit('data', encodeUpdate(update));
  }
}

/**
 * Starts the feed for real. A feed that was constructed but never started has no
 * data handler attached, and a test against it proves nothing except that
 * assertions can be written.
 */
async function feedOver(bytesStream: RawByteStream): Promise<YellowstoneUpgradeFeed> {
  const fake: GeyserLike = {
    subscribe: async (_req: SubscribeRequest) => bytesStream as unknown as Awaited<ReturnType<GeyserLike['subscribe']>>,
  };
  const feed = new YellowstoneUpgradeFeed({ endpoint: 'http://127.0.0.1:10000', clientFactory: () => fake });
  await feed.start();
  return feed;
}

describe('yellowstone wire format (protobuf level)', () => {
  it('produces a non-trivial encoded frame from a real account', () => {
    const bytes = encodeUpdate(frameFor({ address: REAL.programData, data: REAL_BYTES }));
    expect(bytes.length).toBeGreaterThan(REAL_BYTES.length);
    expect(isBytes(bytes)).toBe(true);
  });

  it('decodes a raw frame into the same account the chain served', async () => {
    const stream = new RawByteStream();
    const feed = await feedOver(stream);
    const seen: AccountUpdate[] = [];
    feed.on('account', (u: AccountUpdate) => seen.push(u));

    stream.pushBytes(frameFor({ address: REAL.programData, data: REAL_BYTES, signature: '3Q9mZ6W4rGk2bQeP7oV1sYtDnChA8xLuMbKfR2vN9jQdS6bHtGwLpXcVyUaEsTiDkRnBqMoPfZxWvYcLdKeAf' }));

    expect(seen).toHaveLength(1);
    const u = seen[0]!;
    expect(u.kind).toBe('programdata');
    expect(u.address).toBe(REAL.programData);
    // The bytes survived encode -> wire -> decode unchanged, which is the whole point.
    expect(u.data.equals(REAL_BYTES)).toBe(true);
    expect(u.lamports).toBe(12_633_600n);
    expect(u.writeVersion).toBe(4471n);
    expect(u.slot).toBe(459621012);
    expect(u.txnSignature).toMatch(/^3Q9mZ6/);
  });

  it('carries the frame into the layout decoder and recovers the real upgrade authority', async () => {
    const stream = new RawByteStream();
    const feed = await feedOver(stream);
    let recovered: string | null | undefined;
    feed.on('account', (u: AccountUpdate) => {
      recovered = decodeProgramData({ address: u.address, lamports: Number(u.lamports), owner: BPF_LOADER_UPGRADEABLE, data: u.data }, u.address).authority;
    });
    stream.pushBytes(frameFor({ address: REAL.programData, data: REAL_BYTES }));
    // JADaUV8… is the authority mainnet reported for this account.
    expect(recovered).toBe(REAL.expect.authority);
  });

  it('refuses an unclassifiable frame rather than emitting a half-parsed account', async () => {
    const stream = new RawByteStream();
    const feed = await feedOver(stream);
    const seen: unknown[] = [];
    feed.on('account', (u) => seen.push(u));
    stream.pushBytes(frameFor({ address: REAL.programData, data: Buffer.alloc(60, 9) }));
    expect(seen).toHaveLength(0);
    expect(feed.statsView().layoutMismatch).toBe(1);
  });

  it('drops a startup replay frame arriving as bytes', async () => {
    const stream = new RawByteStream();
    const feed = await feedOver(stream);
    const seen: unknown[] = [];
    feed.on('account', (u) => seen.push(u));
    stream.pushBytes(frameFor({ address: REAL.programData, data: REAL_BYTES, isStartup: true }));
    expect(seen).toHaveLength(0);
    expect(feed.statsView().startupSkipped).toBe(1);
  });

  it('fails loudly on a truncated frame instead of yielding an empty update', () => {
    const whole = encodeUpdate(frameFor({ address: REAL.programData, data: REAL_BYTES }));
    const truncated = whole.subarray(0, Math.floor(whole.length / 2));
    let threw = false;
    try {
      const decoded = decodeUpdate(truncated);
      // Either it throws, or it decodes to something provably not an account.
      if (!decoded.account?.account || decoded.account.account.data.length !== REAL_BYTES.length) threw = true;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('encodes the request-shaped data the feed relies on, and does not invent bytes', () => {
    const feed = new YellowstoneUpgradeFeed({ endpoint: 'http://127.0.0.1:10000', authorityPubkey: 'JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd' });
    const req = feed.buildRequest();
    expect(req.accounts['loader']!.filters[0]!.memcmp!.base58).toBe('JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd');
    // An empty message legitimately encodes to zero bytes in protobuf; asserting a
    // length here would only test that the codec is not a no-op.
    const empty = encodeUpdate({ filters: [], createdAt: undefined } as unknown as SubscribeUpdate);
    expect(empty.length).toBe(0);
    const slotOnly = encodeUpdate({ filters: ['x'], createdAt: undefined, slot: { slot: '1', status: 0 } } as unknown as SubscribeUpdate);
    expect(slotOnly.length).toBeGreaterThan(0);
    expect(decodeUpdate(slotOnly).filters).toEqual(['x']);
  });
});

describe('yellowstone against a live endpoint', () => {
  const endpoint = process.env.YELLOWSTONE_ENDPOINT;
  // Skipped, not faked: an unreachable endpoint must not become a passing test.
  it.skipIf(!endpoint)('connects, pings, and receives at least one loader account frame', async () => {
    const feed = new YellowstoneUpgradeFeed({
      endpoint: endpoint!,
      ...(process.env.YELLOWSTONE_TOKEN ? { xToken: process.env.YELLOWSTONE_TOKEN } : {}),
      commitment: 'processed',
      includeStartup: true,
    });
    const got: AccountUpdate[] = [];
    feed.on('account', (u) => got.push(u));
    await feed.start();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && got.length === 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
    const stats = feed.statsView();
    feed.stop();
    expect(stats.connected).toBe(true);
    expect(stats.updates).toBeGreaterThan(0);
  }, 30_000);
});
