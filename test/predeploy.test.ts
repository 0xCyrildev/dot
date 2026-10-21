import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  StagedUpgradeDetector,
  decodeStagedBuffer,
  finalizeEta,
  UnrecognizedBufferError,
} from '../src/state/preDeploy.js';
import { sha256 } from '../src/state/programdata.js';
import { encodeUpdate, YellowstoneUpgradeFeed, type AccountUpdate, type GeyserLike } from '../src/rpc/yellowstone.js';
import { BPF_LOADER_UPGRADEABLE } from '../src/ids.js';
import { EventEmitter } from 'node:events';
import { PublicKey } from '@solana/web3.js';
import type { SubscribeRequest, SubscribeUpdate } from '@triton-one/yellowstone-grpc';
import { fixture } from './helpers.js';

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const observed = fixture<{ accounts: Array<{ programData: string; headBase64: string }> }>('programdata-observed');
const DEPLOYED = Buffer.from(observed.accounts[0]!.headBase64, 'base64');

const AUTH = 'JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd';

/**
 * A staging Buffer as the loader shapes it: discriminant, Option<Pubkey> authority,
 * then the image. Deliberately NOT 45 bytes of header — that is ProgramData's
 * offset, and the point of this test is that Dot locates the magic instead of
 * assuming a constant.
 */
function stagingBuffer(authority: string | null, body: number[]): Buffer {
  return Buffer.concat([
    Buffer.from([1, 0, 0, 0]),
    authority ? Buffer.concat([Buffer.from([1]), new PublicKey(authority).toBuffer()]) : Buffer.from([0]),
    ELF,
    Buffer.from(body),
  ]);
}

/** A real 32-byte key, not a readable-looking string that fails base58 width checks. */
const BUFFER_ACCT = new PublicKey(Buffer.alloc(32, 77)).toBase58();

function acct(data: Buffer, address = BUFFER_ACCT): AccountUpdate {
  return {
    kind: 'buffer',
    address,
    lamports: 12_633_600n,
    executable: false,
    data,
    slot: 459_621_012,
    writeVersion: 1n,
    txnSignature: null,
    isStartup: false,
    receivedAt: Date.now(),
  };
}

describe('staged image decoding', () => {
  it('finds the ELF magic where this account actually puts it, not at 45', () => {
    const b = decodeStagedBuffer(acct(stagingBuffer(AUTH, [1, 2, 3, 4])));
    expect(b.bytecodeOffset).toBe(37);
    expect(b.bytecodeOffset).not.toBe(45);
    // The magic is part of the image: 4 header bytes of ELF plus the 4 body bytes.
    expect(b.bytecodeLen).toBe(8);
    expect(b.authority).toBe(AUTH);
  });

  it('reports a renounced staging authority as null rather than a zero key', () => {
    const b = decodeStagedBuffer(acct(stagingBuffer(null, [1, 2])));
    expect(b.authority).toBeNull();
  });

  it('hashes exactly the image bytes', () => {
    const data = stagingBuffer(AUTH, [9, 8, 7, 6, 5]);
    const b = decodeStagedBuffer(acct(data));
    expect(b.bytecodeHash).toBe(sha256(data.subarray(37)));
    expect(b.fullAccountHash).toBe(sha256(data));
  });

  it('refuses to hash a buffer with no image in it', () => {
    let code = '';
    try {
      decodeStagedBuffer(acct(Buffer.alloc(48, 3)));
    } catch (e) {
      code = (e as UnrecognizedBufferError).code ?? '';
    }
    expect(code).toBe('UNKNOWN_BUFFER_LAYOUT');
  });
});

describe('STAGED_UPGRADE events', () => {
  it('fires with a hash and a size delta once the deployed image is known', () => {
    const d = new StagedUpgradeDetector();
    const deployed = decodeStagedBuffer(acct(DEPLOYED, observed.accounts[0]!.programData));
    d.observeDeployed(observed.accounts[0]!.programData, deployed.bytecodeHash, DEPLOYED.length - 45);

    const staged = stagingBuffer(AUTH, [1, 2, 3, 4, 5, 6, 7]);
    const ev = d.observeStaged(acct(staged), { programDataKey: observed.accounts[0]!.programData, program: observed.accounts[0]!.program });
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('staged_upgrade');
    expect(ev!.program).toBe(observed.accounts[0]!.program);
    expect(ev!.staged.bytecodeLen).toBe(11);
    expect(ev!.deltaBytes).not.toBeNull();
    expect(ev!.matchesDeployed).toBe(false);
  });

  it('stays silent when the staged image is byte-identical to what is live', () => {
    const d = new StagedUpgradeDetector();
    const key = observed.accounts[0]!.programData;
    const deployed = decodeStagedBuffer(acct(DEPLOYED, key));
    d.observeDeployed(key, deployed.bytecodeHash, deployed.bytecodeLen);
    const ev = d.observeStaged(acct(Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.concat([Buffer.from([1]), new PublicKey(AUTH).toBuffer()]), DEPLOYED.subarray(45)])), { programDataKey: key });
    expect(ev).toBeNull();
    expect(d.pending()).toBe(0);
  });

  it('attributes a staged image to the program only when the bytes actually land', () => {
    const d = new StagedUpgradeDetector();
    const staged = stagingBuffer(AUTH, [4, 5, 6]);
    const ev = d.observeStaged(acct(staged));
    expect(ev!.program).toBeNull();
    expect(ev!.attribution).toBe('unattributed');
    const landed = d.attributeByLanding(ev!.staged.bytecodeHash, observed.accounts[0]!.program);
    expect(landed?.bufferAddress).toBe(ev!.staged.bufferAddress);
    expect(d.pending()).toBe(0);
  });

  it('does not invent a finalization delay', () => {
    const eta = finalizeEta();
    expect(eta.status).toBe('immediate_unless_governed');
    expect(eta.delayMs).toBeNull();
    expect(eta.governance).toBe('unobserved');
    expect(eta.reason).toContain('not readable from this account');
  });

  it('accepts an operator-declared timelock and labels it as declared', () => {
    const eta = finalizeEta(172_800_000);
    expect(eta.status).toBe('operator_declared_delay');
    expect(eta.governance).toBe('declared');
    expect(eta.delayMs).toBe(172_800_000);
  });
});

describe('staged detection over the wire', () => {
  it('emits a STAGED_UPGRADE from raw protobuf bytes end to end', async () => {
    const stream = new EventEmitter();
    const feed = new YellowstoneUpgradeFeed({
      endpoint: 'http://127.0.0.1:10000',
      clientFactory: (): GeyserLike => ({
        subscribe: async (_r: SubscribeRequest) => stream as unknown as Awaited<ReturnType<GeyserLike['subscribe']>>,
      }),
    });
    const detector = new StagedUpgradeDetector();
    const staged: AccountUpdate[] = [];
    feed.on('buffer', (u: AccountUpdate) => staged.push(u));
    await feed.start();

    const frame = {
      filters: ['loader'],
      createdAt: undefined,
      account: {
        isStartup: false,
        slot: '459621012',
        account: {
          pubkey: new PublicKey(BUFFER_ACCT).toBuffer(),
          lamports: '12633600',
          owner: new PublicKey(BPF_LOADER_UPGRADEABLE).toBuffer(),
          executable: false,
          rentEpoch: '18446744073709551615',
          data: new Uint8Array(stagingBuffer(AUTH, [1, 1, 1, 1])),
          writeVersion: '9',
          txnSignature: undefined,
        },
      },
    } as unknown as SubscribeUpdate;

    stream.emit('data', encodeUpdate(frame));
    expect(staged).toHaveLength(1);
    expect(staged[0]!.kind).toBe('buffer');
    const ev = detector.observeStaged(staged[0]!);
    expect(ev?.staged.bytecodeOffset).toBe(37);
    feed.stop();
  });
});
