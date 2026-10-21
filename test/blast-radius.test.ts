import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { PublicKey } from '@solana/web3.js';
import {
  BlastRadiusScanner,
  toWarnings,
  extractProgramPair,
  renderBlastRadius,
  type AnalyzeProgram,
} from '../src/commands/blastRadius.js';
import { BPF_LOADER_UPGRADEABLE } from '../src/ids.js';
import { deriveProgramData } from '../src/state/programdata.js';
import { SolanaClient } from '../src/rpc/client.js';
import { Budget } from '../src/agent/budget.js';
import { FakeTransport, fixture, txFixture } from './helpers.js';
import type { WireGetTransactionResult } from '../src/rpc/wire.js';

const observed = fixture<{ programPointers: Array<{ program: string; pointsTo: string }> }>('programdata-observed');
const P = observed.programPointers[0]!;
const OTHER = observed.programPointers[1]!;

/** A loader transaction shaped like a real `upgrade`: program, its programdata, a buffer, the loader. */
function loaderTx(program: string, programData: string, withPair = true): WireGetTransactionResult {
  const keys = [
    'FnSCQX1CYdGkGgd7RSScZzVij7nfKhYK5VcjaAozv3d5',
    program,
    ...(withPair ? [programData] : []),
    BPF_LOADER_UPGRADEABLE,
    'SysvarC1ock11111111111111111111111111111111',
    'SysvarRent111111111111111111111111111111111',
  ].map((pubkey) => ({ pubkey, signer: false, source: 'transaction' as const, writable: false }));
  return {
    slot: 459_621_012,
    blockTime: 1_760_000_000,
    version: 'legacy',
    meta: {
      err: null,
      fee: 1000,
      preBalances: keys.map(() => 1_000_000),
      postBalances: keys.map((_, i) => 1_000_000 + (i === 2 ? 500_000 : 0)),
      innerInstructions: null,
      logMessages: null,
    },
    transaction: {
      message: { accountKeys: keys, instructions: [{ programId: BPF_LOADER_UPGRADEABLE, accounts: [], data: 'x' }], recentBlockhash: 'r' },
      signatures: ['sig'],
    },
  };
}

describe('upgrade discovery over plain RPC', () => {
  it('proves the program/programdata pair by re-deriving the PDA locally', () => {
    const pair = extractProgramPair(loaderTx(P.program, P.pointsTo));
    expect(pair).toEqual({ program: P.program, programData: P.pointsTo });
    // and the derivation is the chain's own relation, not a lookup table
    expect(deriveProgramData(P.program)).toBe(P.pointsTo);
  });

  it('returns null rather than guessing when no key re-derives to another key', () => {
    expect(extractProgramPair(loaderTx(P.program, P.pointsTo, false))).toBeNull();
  });

  it('ignores a transaction that never names the loader', () => {
    expect(extractProgramPair(txFixture('tx-nested'))).toBeNull();
  });

  it('walks the loader index and reports the retention boundary it hit', async () => {
    const transport = new FakeTransport([
      {
        match: (m) => m === 'getSignaturesForAddress',
        resultFn: () => [
          { signature: 's1', slot: 100, err: null, blockTime: 1_760_000_000, confirmationStatus: 'finalized' },
          { signature: 's2', slot: 99, err: null, blockTime: 1_759_000_000, confirmationStatus: 'finalized' },
        ],
      },
      { match: (m) => m === 'getTransaction', resultFn: () => loaderTx(P.program, P.pointsTo) },
    ]);
    const client = new SolanaClient({ transport, budget: new Budget({ maxRpcCalls: 100, maxSignatures: 100 }) });
    const scanner = new BlastRadiusScanner(client, async () => ({ dependents: 0, transitiveDependents: 0, lamportsRouted: 0, mintsTouched: 0, authority: null }));
    const { records, discovery, skipped } = await scanner.discover({ maxRecords: 5 });
    expect(records).toHaveLength(5);
    expect(records[0]?.program).toBe(P.program);
    expect(skipped.noProgramPair).toBe(0);
    // Two windows returned the same two sigs, so the no-progress stop is what ended it.
    expect(discovery.stoppedReason).not.toBeNull();
  });

  it('counts loader touches that are not upgrades instead of dropping them silently', async () => {
    const transport = new FakeTransport([
      { match: (m) => m === 'getSignaturesForAddress', result: [{ signature: 's1', slot: 1, err: null, blockTime: 1 }] },
      { match: (m) => m === 'getTransaction', resultFn: () => loaderTx(P.program, P.pointsTo, false) },
    ]);
    const client = new SolanaClient({ transport, budget: new Budget({ maxRpcCalls: 50, maxSignatures: 50 }) });
    const scanner = new BlastRadiusScanner(client, async () => ({ dependents: 0, transitiveDependents: 0, lamportsRouted: 0, mintsTouched: 0, authority: null }));
    const { records, skipped } = await scanner.discover({ maxRecords: 3 });
    expect(records).toHaveLength(0);
    expect(skipped.noProgramPair).toBeGreaterThan(0);
  });
});

const analyzeFor = (table: Record<string, { dependents: number; transitiveDependents?: number; lamportsRouted: number; authority?: string | null }>): AnalyzeProgram =>
  async (program) => {
    const row = table[program]!;
    return {
      dependents: row.dependents,
      transitiveDependents: row.transitiveDependents ?? 0,
      lamportsRouted: row.lamportsRouted,
      mintsTouched: 2,
      authority: row.authority ?? null,
    };
  };

describe('ecosystem ranking', () => {
  const rec = (program: string) => ({
    signature: 's',
    slot: 1,
    blockTime: 1_760_000_000,
    program,
    programData: 'ignored',
    lamportsTouched: 0,
  });

  it('ranks a widely-depended high-value upgrade above a lonely low-value one', async () => {
    const whale = P.program;
    const small = OTHER.program;
    const transport = new FakeTransport([]);
    const client = new SolanaClient({ transport, budget: new Budget({ maxRpcCalls: 50 }) });
    const scanner = new BlastRadiusScanner(
      client,
      analyzeFor({
        [whale]: { dependents: 40, transitiveDependents: 60, lamportsRouted: 9e11, authority: 'AuthWhale' },
        [small]: { dependents: 1, lamportsRouted: 1e6, authority: null },
      }),
    );
    const res = await scanner.run({ maxRecords: 10, minValueLamports: 0, minDependents: 0, programs: [whale, small] });
    const ranked = await scanner.rank([rec(whale), rec(small)], { maxRecords: 10, minValueLamports: 0, minDependents: 0 });
    expect(ranked.ranked[0]?.program).toBe(whale);
    expect(ranked.ranked[0]!.rank.composite).toBeGreaterThan(ranked.ranked[1]!.rank.composite);
    expect(res.value.usdPerSol).toBeNull();
    expect(res.value.note).toContain('will not invent one');
  });

  it('prints a declared multisig only when the operator declared it', async () => {
    const scanner = new BlastRadiusScanner(
      new SolanaClient({ transport: new FakeTransport([]), budget: new Budget({}) }),
      analyzeFor({ [P.program]: { dependents: 3, lamportsRouted: 1e9, authority: 'AuthX' } }),
    );
    const declared = await scanner.rank([rec(P.program)], {
      maxRecords: 1,
      minValueLamports: 0,
      minDependents: 0,
      authorityMap: new Map([['AuthX', { label: '3-of-5 multisig (operator-declared)' }]]),
    });
    expect(declared.ranked[0]?.authorityLabel).toBe('3-of-5 multisig (operator-declared)');

    const undeclared = await scanner.rank([rec(P.program)], { maxRecords: 1, minValueLamports: 0, minDependents: 0 });
    expect(undeclared.ranked[0]?.authorityLabel).toContain('not readable from chain data');
  });

  it('ranks 2 dependents with 400 SOL-scale value above 14 dependents with a tenth of it', async () => {
    // The model, stated in the plan: value is absolute, breadth is not. A formula
    // that log-scales both axes hides this and would let 14 callers outrank 10x the
    // value at stake.
    const scanner = new BlastRadiusScanner(
      new SolanaClient({ transport: new FakeTransport([]), budget: new Budget({}) }),
      analyzeFor({
        [P.program]: { dependents: 2, lamportsRouted: 4e11, authority: 'AuthA' },
        [OTHER.program]: { dependents: 14, lamportsRouted: 4e10, authority: 'AuthB' },
      }),
    );
    const { ranked } = await scanner.rank(
      [{ signature: 's', slot: 1, blockTime: 1, program: P.program, programData: 'x', lamportsTouched: 0 },
       { signature: 's2', slot: 2, blockTime: 2, program: OTHER.program, programData: 'y', lamportsTouched: 0 }],
      { maxRecords: 2, minValueLamports: 0, minDependents: 0 },
    );
    expect(ranked[0]?.program).toBe(P.program);
    expect(ranked[0]!.rank.valueScore).toBeGreaterThan(ranked[1]!.rank.valueScore);
    expect(ranked[0]!.rank.dependentsScore).toBeLessThan(ranked[1]!.rank.dependentsScore);
    expect(ranked[0]!.rank.formula).toContain('linear, absolute');
  });

  it('emits a warning list naming who to notify, and counts what it could not read', async () => {
    const scanner = new BlastRadiusScanner(
      new SolanaClient({ transport: new FakeTransport([]), budget: new Budget({}) }),
      async () => ({
        dependents: 2,
        transitiveDependents: 0,
        lamportsRouted: 1e11,
        mintsTouched: 1,
        authority: 'AuthA',
        detail: {
          dependents: [
            { program: 'Dep1', authority: 'OwnerOne', lamportsRouted: 5e10 },
            { program: 'Dep2', authority: null, lamportsRouted: 1e9 },
          ],
        },
      }),
    );
    const { ranked } = await scanner.rank(
      [{ signature: 's', slot: 1, blockTime: 1, program: P.program, programData: 'x', lamportsTouched: 0 }],
      { maxRecords: 1, minValueLamports: 0, minDependents: 0 },
    );
    const warnings = toWarnings({
      records: [],
      ranked,
      skipped: { noProgramPair: 0, pruned: 0, errors: 0, belowThreshold: 0, budgetStops: 0 },
      discovery: { method: 'test', scanned: 1, oldestSeenBlockTime: null, requestedSince: null, sinceSatisfied: null, stoppedReason: null },
      value: { unit: 'lamports', usdPerSol: null, note: 'test' },
    });
    expect(warnings[0]?.notify).toEqual(['OwnerOne']);
    expect(warnings[0]?.unobservedAuthorities).toBe(1);
    expect(warnings[0]?.reason).toContain('dependent program');
  });

  it('labels renounced authority as renounced, not as missing data', async () => {
    const scanner = new BlastRadiusScanner(
      new SolanaClient({ transport: new FakeTransport([]), budget: new Budget({}) }),
      analyzeFor({ [P.program]: { dependents: 2, lamportsRouted: 5e8, authority: null } }),
    );
    const { ranked } = await scanner.rank([rec(P.program)], { maxRecords: 1, minValueLamports: 0, minDependents: 0 });
    expect(ranked[0]?.authorityLabel).toContain('renounced');
  });

  it('converts to USD only from an operator-supplied price, and says so', () => {
    const text = renderBlastRadius({
      records: [rec(P.program)],
      ranked: [{
        program: P.program, upgrades: 1, lastSlot: 9, lastBlockTime: null, dependents: 14, transitiveDependents: 30,
        lamportsRouted: 40_000_000_000_000, mintsTouched: 6, authority: 'Auth', authorityLabel: '3-of-5 multisig (operator-declared)',
        rank: { dependentsScore: 1, valueScore: 1, composite: 1, formula: 'test' },
      }],
      skipped: { noProgramPair: 0, pruned: 0, errors: 0, belowThreshold: 0, budgetStops: 0 },
      discovery: { method: 'test', scanned: 1, oldestSeenBlockTime: null, requestedSince: 1_759_000_000, sinceSatisfied: false, stoppedReason: 'retention' },
      value: { unit: 'lamports', usdPerSol: 140, note: 'operator supplied' },
    });
    expect(text).toContain('| 14 | 30 |');
    expect(text).toContain('Operators who should be notified');
    expect(text).toContain('3-of-5 multisig (operator-declared)');
    // 40e12 lamports = 40,000 SOL at an operator-declared $140
    expect(text).toContain('$5,600,000');
    expect(text).toContain('NOT reached');
    expect(text).toContain('never examined');
  });

  it('refuses to claim a --since window was covered when it was not', async () => {
    const transport = new FakeTransport([
      { match: (m) => m === 'getSignaturesForAddress', result: [] },
    ]);
    const scanner = new BlastRadiusScanner(new SolanaClient({ transport, budget: new Budget({ maxRpcCalls: 10 }) }), async () => ({ dependents: 0, transitiveDependents: 0, lamportsRouted: 0, mintsTouched: 0, authority: null }));
    const { discovery, records } = await scanner.discover({ maxRecords: 20, since: 1_700_000_000 });
    expect(records).toHaveLength(0);
    // Nothing was seen at all, so Dot cannot claim the window was covered — and
    // equally cannot claim it was missed. It reports null and says why.
    expect(discovery.sinceSatisfied).toBeNull();
    expect(discovery.stoppedReason).toContain('retains');
  });
});
