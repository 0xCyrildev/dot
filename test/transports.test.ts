import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import base58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { classify, YellowstoneUpgradeFeed, MEASURED_ELF_OFFSET, type GeyserLike } from '../src/rpc/yellowstone.js';
import { ResilientClient, redactUrl } from '../src/rpc/resilient.js';
import { ProgramIndex } from '../src/state/programIndex.js';
import { deriveProgramData } from '../src/state/programdata.js';
import { Budget } from '../src/agent/budget.js';
import { SolanaClient } from '../src/rpc/client.js';
import { BPF_LOADER_UPGRADEABLE } from '../src/ids.js';
import { FakeTransport, fixture } from './helpers.js';
import type { SubscribeRequest, SubscribeUpdate } from '@triton-one/yellowstone-grpc';

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

function programdataBytes(authority: string | null): Buffer {
  return Buffer.concat([
    Buffer.from([3, 0, 0, 0]),
    (() => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(423_977_638n);
      return b;
    })(),
    authority ? Buffer.from([1]) : Buffer.from([0]),
    authority ? new PublicKey(authority).toBuffer() : Buffer.alloc(32, 0),
    ELF,
    Buffer.from([2, 3, 5, 8]),
  ]);
}

function bufferBytes(): Buffer {
  return Buffer.concat([Buffer.alloc(4), Buffer.alloc(1, 1), Buffer.alloc(32, 4), ELF, Buffer.from([1])]);
}

function update(addr: string, data: Buffer, opts: { isStartup?: boolean; signature?: string } = {}): SubscribeUpdate {
  return {
    filters: ['loader'],
    createdAt: undefined,
    account: {
      isStartup: opts.isStartup ?? false,
      slot: '400000200',
      account: {
        pubkey: new PublicKey(addr).toBuffer(),
        lamports: '12633600',
        owner: new PublicKey(BPF_LOADER_UPGRADEABLE).toBuffer(),
        executable: false,
        rentEpoch: '18446744073709551615',
        data: new Uint8Array(data),
        writeVersion: '17',
        txnSignature: opts.signature ? new Uint8Array(base58.decode(opts.signature)) : undefined,
      },
    },
  } as unknown as SubscribeUpdate;
}

class FakeGeyser extends EventEmitter {
  sent: SubscribeRequest[] = [];
  async subscribe(req: SubscribeRequest) {
    this.sent.push(req);
    const stream = new EventEmitter();
    this.stream = stream;
    return stream as unknown as Awaited<ReturnType<GeyserLike['subscribe']>>;
  }
  stream!: EventEmitter;
}

describe('loader account classification', () => {
  it('recognises ProgramData by the ELF magic at the measured offset', () => {
    expect(classify(programdataBytes(null))).toBe('programdata');
  });

  it('recognises a staging Buffer by its earlier ELF offset', () => {
    expect(classify(bufferBytes())).toBe('buffer');
  });

  it('recognises the 36-byte Program pointer', () => {
    expect(classify(Buffer.alloc(36))).toBe('program_pointer');
  });

  it('refuses to classify bytes that match no measured layout', () => {
    expect(classify(Buffer.concat([Buffer.alloc(4), Buffer.alloc(40, 7), Buffer.from([9, 9, 9, 9])]))).toBe('unknown_layout');
    expect(MEASURED_ELF_OFFSET).toBe(45);
  });
});

describe('YellowstoneUpgradeFeed', () => {
  it('subscribes by owner as base58, not bytes', () => {
    const feed = new YellowstoneUpgradeFeed({ endpoint: 'http://127.0.0.1:10000', clientFactory: () => new FakeGeyser() as unknown as GeyserLike });
    const req = feed.buildRequest();
    const filter = req.accounts['loader']!;
    expect(filter.owner).toEqual([BPF_LOADER_UPGRADEABLE]);
    expect(typeof filter.owner[0]).toBe('string');
    expect(filter.nonemptyTxnSignature).toBe(true);
  });

  it('adds the authority memcmp filter at the measured offset when asked to', () => {
    const feed = new YellowstoneUpgradeFeed({
      endpoint: 'http://127.0.0.1:10000',
      authorityPubkey: 'JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd',
      clientFactory: () => new FakeGeyser() as unknown as GeyserLike,
    });
    const f = feed.buildRequest().accounts['loader']!.filters[0]!;
    expect(f.memcmp?.offset).toBe('13');
    expect(f.memcmp?.base58).toBe('JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd');
  });

  it('decodes string u64s without narrowing them, and skips a startup replay by default', async () => {
    const geyser = new FakeGeyser();
    const feed = new YellowstoneUpgradeFeed({ endpoint: 'http://127.0.0.1:10000', clientFactory: () => geyser as unknown as GeyserLike });
    const got: Array<{ address: string; lamports: bigint; slot: number }> = [];
    feed.on('account', (u) => got.push({ address: u.address, lamports: u.lamports, slot: u.slot }));
    await feed.start();
    geyser.stream.emit('data', update('HZcJwcJ2njPDxZtpPoKnF8v2w9QAx2rS7TdJPSRkbEhu', programdataBytes('JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd'), { isStartup: true }));
    geyser.stream.emit('data', update('HZcJwcJ2njPDxZtpPoKnF8v2w9QAx2rS7TdJPSRkbEhu', programdataBytes('JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd')));
    expect(got).toHaveLength(1);
    expect(got[0]?.lamports).toBe(12_633_600n);
    expect(got[0]?.slot).toBe(400000200);
    expect(feed.statsView().startupSkipped).toBe(1);
    feed.stop();
  });

  it('counts layout mismatches instead of hashing bytes it cannot identify', async () => {
    const geyser = new FakeGeyser();
    const feed = new YellowstoneUpgradeFeed({ endpoint: 'http://127.0.0.1:10000', clientFactory: () => geyser as unknown as GeyserLike });
    let fired = 0;
    feed.on('account', () => fired++);
    await feed.start();
    geyser.stream.emit('data', update('HZcJwcJ2njPDxZtpPoKnF8v2w9QAx2rS7TdJPSRkbEhu', Buffer.concat([Buffer.alloc(4), Buffer.alloc(44, 3)])));
    expect(fired).toBe(0);
    expect(feed.statsView().layoutMismatch).toBe(1);
    feed.stop();
  });

  it('emits pointer updates, because the reverse programdata→program map is free only here', async () => {
    const geyser = new FakeGeyser();
    const feed = new YellowstoneUpgradeFeed({ endpoint: 'http://127.0.0.1:10000', clientFactory: () => geyser as unknown as GeyserLike });
    const pointers: Array<{ program: string; programData: string; slot: number }> = [];
    feed.on('pointer', (p) => pointers.push(p));
    await feed.start();
    const program = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
    const data = Buffer.concat([Buffer.from([2, 0, 0, 0]), new PublicKey('HZcJwcJ2njPDxZtpPoKnF8v2w9QAx2rS7TdJPSRkbEhu').toBuffer()]);
    geyser.stream.emit('data', update(program, data));
    expect(pointers[0]).toEqual({
      program,
      programData: 'HZcJwcJ2njPDxZtpPoKnF8v2w9QAx2rS7TdJPSRkbEhu',
      slot: 400000200,
    });
    feed.stop();
  });

  it('announces degradation the moment the stream closes, in words that cannot be misread as an all-clear', async () => {
    const geyser = new FakeGeyser();
    const feed = new YellowstoneUpgradeFeed({ endpoint: 'http://127.0.0.1:10000', clientFactory: () => geyser as unknown as GeyserLike });
    const degraded: unknown[] = [];
    feed.on('degraded', (d) => degraded.push(d));
    await feed.start();
    geyser.stream.emit('close');
    expect(degraded).toHaveLength(1);
    expect(JSON.stringify(degraded[0])).toContain('detection is OFF');
  });
});

describe('ResilientClient', () => {
  const PD = 'HZcJwcJ2njPDxZtpPoKnF8v2w9QAx2rS7TdJPSRkbEhu';
  const acct = (slot: number, data: Buffer) => ({
    context: { slot },
    value: { lamports: 12_633_600, owner: BPF_LOADER_UPGRADEABLE, executable: false, data: [data.toString('base64'), 'base64'] },
  });

  const clientFor = (handler: (m: string) => unknown) => {
    const transport = new FakeTransport([{ match: () => true, resultFn: () => handler('') }]);
    return new SolanaClient({ transport, budget: new Budget({ maxRpcCalls: 100 }) });
  };

  it('agrees when two endpoints return identical bytes at the same slot', async () => {
    const bytes = programdataBytes('JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd');
    const a = clientFor(() => acct(4000, bytes));
    const b = clientFor(() => acct(4000, bytes));
    const r = await new ResilientClient([{ client: a, url: 'https://a.test/?key=SECRET' }, { client: b, url: 'https://b.test' }]).getAccountInfoQuorum(PD);
    expect(r.agreement).toBe('agreed');
    expect(r.halt).toBe(false);
    expect(r.account?.data.length).toBe(bytes.length);
    // The report embeds endpoint labels, so credentials must not ride along.
    expect(JSON.stringify(r.endpoints)).not.toContain('SECRET');
    expect(JSON.stringify(r.endpoints)).toContain('?<redacted>');
  });

  it('halts on same-slot, different-bytes and calls it a contradiction', async () => {
    const a = clientFor(() => acct(4000, programdataBytes('JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd')));
    const b = clientFor(() => acct(4000, programdataBytes(null)));
    const r = await new ResilientClient([{ client: a, url: 'https://a.test' }, { client: b, url: 'https://b.test' }]).getAccountInfoQuorum(PD);
    expect(r.agreement).toBe('disagreed');
    expect(r.halt).toBe(true);
    expect(r.account).toBeNull();
    expect(r.reason).toContain('disagree');
  });

  it('does NOT call chain progress a disagreement', async () => {
    const a = clientFor(() => acct(4010, programdataBytes('JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd')));
    const b = clientFor(() => acct(4000, programdataBytes(null)));
    const r = await new ResilientClient([{ client: a, url: 'https://a.test' }, { client: b, url: 'https://b.test' }]).getAccountInfoQuorum(PD);
    expect(r.agreement).toBe('slot_mismatch');
    expect(r.halt).toBe(false);
    expect(r.reason).toContain('inconclusive');
  });

  it('proceeds on one dead endpoint but marks the read uncorroborated', async () => {
    const good = clientFor(() => acct(4000, programdataBytes(null)));
    const bad = new SolanaClient({
      transport: new FakeTransport([{ match: () => true, error: { code: -32000, message: 'boom' } }]),
      budget: new Budget({ maxRpcCalls: 100 }),
    });
    const r = await new ResilientClient([{ client: good, url: 'https://a.test' }, { client: bad, url: 'https://b.test' }]).getAccountInfoQuorum(PD);
    expect(r.agreement).toBe('single_source');
    expect(r.halt).toBe(false);
    expect(r.account).not.toBeNull();
    expect(r.endpoints.find((e) => !e.ok)?.error).toContain('RPC_JSONRPC');
  });

  it('halts when nothing answers rather than reporting an empty graph', async () => {
    const bad = () => new SolanaClient({ transport: new FakeTransport([{ match: () => true, error: { code: -32000, message: 'down' } }]), budget: new Budget({ maxRpcCalls: 100 }) });
    const r = await new ResilientClient([{ client: bad(), url: 'https://a.test' }, { client: bad(), url: 'https://b.test' }]).getAccountInfoQuorum(PD);
    expect(r.agreement).toBe('both_failed');
    expect(r.halt).toBe(true);
  });

  it('says plainly when there is nothing to corroborate against', async () => {
    const only = clientFor(() => acct(4000, programdataBytes(null)));
    const r = await new ResilientClient([{ client: only, url: 'https://a.test' }]).getAccountInfoQuorum(PD);
    expect(r.agreement).toBe('not_checked');
    expect(r.reason).toContain('one node’s word');
  });

  it('redacts credentials from a malformed URL instead of echoing it', () => {
    expect(redactUrl('not a url')).toBe('<unparseable-endpoint>');
  });
});

describe('ProgramIndex: naming an unnamed ProgramData', () => {
  const observed = fixture<{ programPointers: Array<{ program: string; pointsTo: string }> }>('programdata-observed');
  const pair = observed.programPointers[0]!;

  it('is derived, not stored: the pointer the chain holds is reproducible locally', () => {
    expect(deriveProgramData(pair.program)).toBe(pair.pointsTo);
  });

  it('learns from a pointer account for free', async () => {
    const client = new SolanaClient({ transport: new FakeTransport([]), budget: new Budget({}) });
    const index = new ProgramIndex(client);
    index.observePointer(pair.pointsTo, pair.program);
    const r = await index.resolve(pair.pointsTo);
    expect(r).toEqual({ program: pair.program, how: 'pointer_index', rpcCalls: 0 });
  });

  it('recovers the program from the upgrade transaction using only local derivation', async () => {
    const other = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
    const transport = new FakeTransport([
      {
        match: (m) => m === 'getTransaction',
        result: {
          slot: 1,
          version: 'legacy',
          blockTime: 0,
          meta: null,
          transaction: {
            message: {
              accountKeys: [other, pair.program, pair.pointsTo].map((pubkey) => ({ pubkey, signer: false, source: 'transaction', writable: true })),
              instructions: [],
              recentBlockhash: 'x',
            },
            signatures: ['x'],
          },
        },
      },
    ]);
    const index = new ProgramIndex(new SolanaClient({ transport, budget: new Budget({ maxRpcCalls: 10 }) }));
    const r = await index.resolve(pair.pointsTo, 'sig');
    // Both `other` and `pair.program` are candidates in the key list; only the real
    // one re-derives to this programdata.
    expect(r.program).toBe(pair.program);
    expect(r.how).toBe('upgrade_tx');
    expect(r.rpcCalls).toBe(1);
  });

  it('reports unresolved rather than guessing a program id', async () => {
    const transport = new FakeTransport([
      { match: (m) => m === 'getProgramAccounts', result: [] },
      { match: (m) => m === 'getTransaction', result: null },
    ]);
    const index = new ProgramIndex(new SolanaClient({ transport, budget: new Budget({ maxRpcCalls: 10 }) }));
    const r = await index.resolve('SomeRandomProgramDataAccount1111111111111111111111', null);
    expect(r.program).toBeNull();
    expect(r.how).toBe('unresolved');
  });
});
