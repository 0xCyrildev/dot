import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { PublicKey } from '@solana/web3.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp/server.js';
import { Budget } from '../src/agent/budget.js';
import { SolanaClient } from '../src/rpc/client.js';
import { UpgradeWatcher } from '../src/watcher/watcher.js';
import { BPF_LOADER_UPGRADEABLE } from '../src/ids.js';
import { deriveProgramData } from '../src/state/programdata.js';
import { FakeTransport, txFixture } from './helpers.js';

const AUTH = 'FnSCQX1CYdGkGgd7RSScZzVij7nfKhYK5VcjaAozv3d5';
const PROGRAM = '5PjDJaGfSPJj4tFzMRCiuuAasKg5n8dJKXKenhuwZexx';

function programDataBytes(authority: string | null, tail = [9, 9, 9, 9]): Buffer {
  return Buffer.concat([
    Buffer.from([3, 0, 0, 0]),
    (() => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(423_977_638n);
      return b;
    })(),
    authority ? Buffer.from([1]) : Buffer.from([0]),
    authority ? new PublicKey(authority).toBuffer() : Buffer.alloc(32, 0),
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, ...tail]),
  ]);
}

function watcherFor(read: () => Buffer | null) {
  const transport = new FakeTransport([
    {
      match: (m) => m === 'getAccountInfo',
      resultFn: () =>
        read() === null
          ? { context: { slot: 1 }, value: null }
          : {
              context: { slot: 1 },
              value: {
                lamports: 1,
                owner: BPF_LOADER_UPGRADEABLE,
                executable: false,
                data: [read()!.toString('base64'), 'base64'],
              },
            },
    },
  ]);
  const client = new SolanaClient({ transport, budget: new Budget({ maxRpcCalls: 1000, maxSignatures: 1000 }) });
  return { watcher: new UpgradeWatcher(client, [{ program: PROGRAM, label: 'fixture' }], { mode: 'poll' }), transport };
}

describe('UpgradeWatcher', () => {
  it('stays silent on the first observation, because a restart is not an upgrade', async () => {
    const { watcher } = watcherFor(() => programDataBytes(AUTH));
    expect(await watcher.tick('baseline')).toHaveLength(0);
    expect(watcher.snapshot()).toHaveLength(1);
  });

  it('emits upgrade when the bytecode hash moves', async () => {
    let bytes = programDataBytes(AUTH);
    const { watcher } = watcherFor(() => bytes);
    await watcher.tick('baseline');
    bytes = programDataBytes(AUTH, [1, 2, 3, 4]);
    const events = await watcher.tick('poll');
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('upgrade');
    expect(events[0]?.changed.bytecode).toBe(true);
    expect(events[0]?.changed.authority).toBe(false);
    expect(events[0]?.programData).toBe(deriveProgramData(PROGRAM));
    expect(events[0]?.label).toBe('fixture');
  });

  it('emits authority_change when only the authority moved', async () => {
    let bytes = programDataBytes(AUTH);
    const { watcher } = watcherFor(() => bytes);
    await watcher.tick('baseline');
    bytes = programDataBytes('JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd');
    const events = await watcher.tick('poll');
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('authority_change');
    expect(events[0]?.before?.authority).toBe(AUTH);
    expect(events[0]?.after?.authority).toBe('JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd');
  });

  it('records a renounced authority as a change worth reporting', async () => {
    let bytes = programDataBytes(AUTH);
    const { watcher } = watcherFor(() => bytes);
    await watcher.tick('baseline');
    bytes = programDataBytes(null);
    const events = await watcher.tick('poll');
    expect(events[0]?.after?.authority).toBeNull();
  });

  it('marks the account closed without inventing an upgrade event', async () => {
    let bytes: Buffer | null = programDataBytes(AUTH);
    const { watcher } = watcherFor(() => bytes);
    await watcher.tick('baseline');
    bytes = null;
    const events = await watcher.tick('poll');
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('program_data_closed');
    expect(watcher.snapshot()[0]?.closed).toBe(true);
  });

  it('costs exactly one read per target per tick', async () => {
    const { watcher, transport } = watcherFor(() => programDataBytes(AUTH));
    await watcher.tick('baseline');
    await watcher.tick('poll');
    expect(transport.calls.filter((c) => c.method === 'getAccountInfo')).toHaveLength(2);
  });

  it('refuses to start with an empty target list', () => {
    const { watcher } = watcherFor(() => programDataBytes(AUTH));
    expect(watcher).toBeDefined();
    const budget = new Budget({});
    const client = new SolanaClient({ transport: new FakeTransport([]), budget });
    expect(() => new UpgradeWatcher(client, [], {})).toThrow(/no watch targets/);
  });
});

describe('MCP server surface', () => {
  async function connected() {
    const server = buildServer({ mode: 'rules' });
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    return client;
  }

  it('exposes exactly the four documented tools', async () => {
    const client = await connected();
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(['dot_blast_radius', 'dot_evaluate_upgrade', 'dot_limits', 'dot_watch_status']);
    for (const t of listed.tools) expect(t.description!.length).toBeGreaterThan(40);
  });

  it('rejects a too-short program at the schema boundary', async () => {
    const client = await connected();
    const res = await client.callTool({
      name: 'dot_blast_radius',
      arguments: { program: 'not-a-pubkey', budget: { maxRpcCalls: 5, maxSignatures: 5, maxLlmTokens: 0, maxWallMs: 5000 } },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]?.text).toContain('Invalid arguments');
  });

  it('rejects a 32-character string that is not valid base58, from inside the tool', async () => {
    const client = await connected();
    const res = await client.callTool({
      name: 'dot_blast_radius',
      // Right length, illegal characters (0OIL): schema passes, decoder must not.
      arguments: { program: '0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O', budget: { maxRpcCalls: 5, maxSignatures: 5, maxLlmTokens: 0, maxWallMs: 5000 } },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]?.text).toContain('not a 32-byte base58 address');
  });

  it('declares the budget as a required input so a caller cannot accidentally ask for an unbounded scan', async () => {
    const client = await connected();
    const tools = await client.listTools();
    const blast = tools.tools.find((t) => t.name === 'dot_blast_radius')!;
    const schema = blast.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties)).toContain('budget');
    expect(schema.required).toContain('budget');
    expect(schema.required).toContain('program');
  });

  it('keeps the fixture pipeline shape honest', () => {
    const tx = txFixture('tx-depth3');
    expect(tx.transaction.message.instructions).toHaveLength(1);
    expect(tx.meta.innerInstructions?.[0]?.instructions).toHaveLength(4);
  });
});
