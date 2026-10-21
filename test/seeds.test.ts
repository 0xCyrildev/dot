import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  deriveSeedAddress,
  encodeSeed,
  renderHoldings,
  sumHoldings,
  type SeedSpec,
} from '../src/state/seeds.js';
import { deriveProgramData } from '../src/state/programdata.js';
import { SolanaClient } from '../src/rpc/client.js';
import { Budget } from '../src/agent/budget.js';
import { BPF_LOADER_UPGRADEABLE, TOKEN_PROGRAM } from '../src/ids.js';
import { FakeTransport, fixture } from './helpers.js';

const observed = fixture<{ programPointers: Array<{ program: string; pointsTo: string }> }>('programdata-observed');
const P = observed.programPointers[0]!;

describe('seed encoding', () => {
  it('encodes u8:0 as the byte 0x00, not the ASCII "0"', () => {
    expect(encodeSeed('u8:0')).toEqual(Buffer.from([0]));
    expect(encodeSeed('u8:0')).not.toEqual(Buffer.from('0', 'utf8'));
  });

  it('encodes integers little-endian at the stated width', () => {
    expect(encodeSeed('u16:258')).toEqual(Buffer.from([2, 1]));
    const u64 = encodeSeed('u64:1')!;
    expect(u64.length).toBe(8);
    expect(u64.readBigUInt64LE(0)).toBe(1n);
  });

  it('treats a 32-byte base58 seed as bytes and anything else as a literal', () => {
    expect(encodeSeed(P.program)).toEqual(Buffer.from(encodeSeed(`bytes:${Buffer.from(encodeSeed(P.program)!).toString('hex')}`)!));
    expect(encodeSeed('vault')).toEqual(Buffer.from('vault', 'utf8'));
  });

  it('refuses to invent an encoding', () => {
    expect(encodeSeed('u32:notanumber')).toBeNull();
  });
});

describe('PDAs derived from declared seeds', () => {
  it('reproduces a real mainnet ProgramData PDA through the seed engine', () => {
    const d = deriveSeedAddress({
      program_id: BPF_LOADER_UPGRADEABLE,
      seed_template: [P.program],
      account_type: 'RAW',
    });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.address).toBe(P.pointsTo);
      expect(d.address).toBe(deriveProgramData(P.program));
    }
  });

  it('reports an unresolved seed variable instead of guessing a value', () => {
    const d = deriveSeedAddress({ program_id: P.program, seed_template: ['vault', '$user'], account_type: 'SPL' });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/unresolved seed variable/);
  });

  it('rejects a malformed program id rather than deriving against garbage', () => {
    const d = deriveSeedAddress({ program_id: 'not-a-key', seed_template: ['vault'], account_type: 'RAW' });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/derivation failed/);
  });
});

describe('custody summation', () => {
  const specs = (n: number): SeedSpec[] =>
    Array.from({ length: n }, (_, i) => ({
      program_id: P.program,
      seed_template: [`vault${i}`],
      account_type: 'SPL' as const,
    }));

  const tokenAccount = (mint: string, amount: string) => ({
    lamports: 2_039_280,
    owner: TOKEN_PROGRAM,
    executable: false,
    rentEpoch: 18446744073709551615,
    data: {
      parsed: { type: 'account', info: { mint, owner: 'X', tokenAmount: { amount, decimals: 6, uiAmountString: amount } } },
      program: 'spl-token',
      space: 165,
    },
  });

  it('sums lamports and raw token units, chunking reads at the configured size', async () => {
    const transport = new FakeTransport([
      {
        match: (m) => m === 'getMultipleAccounts',
        resultFn: () => ({
          context: { slot: 1 },
          value: Array.from({ length: 100 }, (_, i) => (i < 3 ? tokenAccount('MINT_SO', '1500000000') : i === 3 ? null : tokenAccount('MINT_X', '7'))),
        }),
      },
    ]);
    const budget = new Budget({ maxRpcCalls: 50, maxSignatures: 50 });
    const client = new SolanaClient({ transport, budget });
    const h = await sumHoldings(client, specs(150), { chunkSize: 100 });
    expect(transport.calls.filter((c) => c.method === 'getMultipleAccounts')).toHaveLength(2);
    expect(budget.snapshot().spent.rpcCalls).toBe(2);
    // Chunk 1 requests 100 addresses: 3 SO, one absent, 96 X.
    // Chunk 2 requests the remaining 50: 3 SO, one absent, 46 X. The walk follows the
    // *request* length, so the node's extra 50 entries are ignored, not shifted.
    expect(h.accountsRead).toBe(148);
    expect(h.accountsEmpty).toBe(2);
    expect(h.observedTokenRaw.get('MINT_SO')).toBe(6n * 1_500_000_000n);
    expect(h.observedTokenRaw.get('MINT_X')).toBe(142n * 7n);
    expect(h.observedLamports).toBe(148 * 2_039_280);
    expect(h.complete).toBe(true);
  });

  it('reports a budget stop as an incomplete sweep, never as zero holdings', async () => {
    const transport = new FakeTransport([
      { match: (m) => m === 'getMultipleAccounts', result: { context: { slot: 1 }, value: [tokenAccount('MINT_SO', '1')] } },
    ]);
    const budget = new Budget({ maxRpcCalls: 1, maxSignatures: 10 });
    const h = await sumHoldings(client(budget, transport), specs(250), { chunkSize: 100 });
    expect(h.complete).toBe(false);
    expect(h.stoppedReason).toMatch(/budget exhausted/);
    expect(h.stoppedReason).toMatch(/unread/);
    expect(h.observedLamports).toBeGreaterThan(0);
    const text = renderHoldings(P.program, h);
    expect(text).toContain('INCOMPLETE');
    expect(text).toContain('Absence here is not zero holdings');
    expect(text).toContain('no USD figure');
  });

  it('counts unresolved seeds separately from accounts read', async () => {
    const transport = new FakeTransport([{ match: () => true, result: { context: { slot: 1 }, value: [] } }]);
    const budget = new Budget({ maxRpcCalls: 10 });
    const h = await sumHoldings(
      client(budget, transport),
      [
        { program_id: P.program, seed_template: ['$user'], account_type: 'SPL' },
        { program_id: P.program, seed_template: ['ok'], account_type: 'SPL' },
      ],
    );
    expect(h.unresolvedSeeds).toHaveLength(1);
    expect(h.accountsEmpty).toBe(1);
  });
});

function client(budget: Budget, transport: FakeTransport): SolanaClient {
  return new SolanaClient({ transport, budget });
}
