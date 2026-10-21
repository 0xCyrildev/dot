import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { PublicKey } from '@solana/web3.js';
import { BlastRadiusScanner, callersViaSelector, multiHop, type ObservedEdge } from '../src/commands/blastRadius.js';
import { SolanaClient } from '../src/rpc/client.js';
import { Budget } from '../src/agent/budget.js';
import { FakeTransport } from './helpers.js';
import base58 from 'bs58';
import { leadingSelector } from '../src/graph/builder.js';
import { anchorDiscriminator } from '../src/state/bytecodeDiff.js';

/**
 * A -> B -> C, plus D -> C. If C upgrades: B and D are direct, A is transitive at
 * depth 2 and must not be counted as though it called C itself.
 */
const A = new PublicKey(Buffer.alloc(32, 1)).toBase58();
const B = new PublicKey(Buffer.alloc(32, 2)).toBase58();
const C = new PublicKey(Buffer.alloc(32, 3)).toBase58();
const D = new PublicKey(Buffer.alloc(32, 4)).toBase58();

const withdrawSel = anchorDiscriminator('withdraw').toString('hex');
const initializeSel = anchorDiscriminator('initialize').toString('hex');

const EDGES: ObservedEdge[] = [
  { from: A, to: B, count: 40, lamportsRouted: 10, selectors: [initializeSel] },
  { from: B, to: C, count: 12, lamportsRouted: 5_000, selectors: [withdrawSel, initializeSel] },
  { from: D, to: C, count: 3, lamportsRouted: 900, selectors: [initializeSel] },
];

describe('multi-hop reach', () => {
  it('separates direct from transitive and records the intermediate', () => {
    const r = multiHop(EDGES, C, 2);
    expect(r.direct.map((x) => x.program).sort()).toEqual([B, D].sort());
    expect(r.transitive.map((x) => x.program)).toEqual([A]);
    expect(r.transitive[0]?.via).toBe(B);
    expect(r.transitive[0]?.depth).toBe(2);
  });

  it('reports nothing beyond depth 1 when asked for one hop', () => {
    const r = multiHop(EDGES, C, 1);
    expect(r.transitive).toHaveLength(0);
    expect(r.direct).toHaveLength(2);
  });

  it('never revisits a program and never credits a caller to itself', () => {
    const cyclic: ObservedEdge[] = [...EDGES, { from: C, to: A, count: 1, lamportsRouted: 0, selectors: [] }];
    const r = multiHop(cyclic, C, 4);
    const all = [...r.direct, ...r.transitive].map((x) => x.program);
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain(C);
  });

  it('weights a transitive dependent below a direct one but never to zero', () => {
    const depth1 = multiHop(EDGES, C, 1);
    const depth2 = multiHop(EDGES, C, 2);
    const weighted2 = depth2.direct.length + depth2.transitive.reduce((s, t) => s + t.weight, 0);
    expect(depth2.direct.length).toBe(depth1.direct.length);
    expect(weighted2).toBeGreaterThan(depth1.direct.length);
    expect(depth2.transitive[0]?.weight).toBeCloseTo(0.5);
  });
});

describe('selector-level exposure', () => {
  it('reads a selector off an instruction the way the chain encodes it', () => {
    const data = Buffer.concat([anchorDiscriminator('withdraw'), Buffer.alloc(8)]);
    expect(leadingSelector(base58.encode(data))).toBe(withdrawSel);
    // A shorter-than-selector payload and an undecodable string yield nothing rather
    // than a plausible wrong hex.
    expect(leadingSelector(base58.encode(Buffer.alloc(4)))).toBeNull();
    expect(leadingSelector('!!!not base58!!!')).toBeNull();
    expect(leadingSelector(undefined)).toBeNull();
  });

  it('answers who already calls the newly added entrypoint', () => {
    expect(callersViaSelector(EDGES, C, withdrawSel, 2).map((x) => x.program)).toEqual([B]);
    expect(callersViaSelector(EDGES, C, anchorDiscriminator('close_account').toString('hex'), 2)).toHaveLength(0);
  });
});

describe('blast-radius ranking with depth', () => {
  const mk = (table: Record<string, { dependents: number; lamportsRouted: number; edges: ObservedEdge[]; added?: { name: string; selector: string }[] }>) =>
    new BlastRadiusScanner(
      new SolanaClient({ transport: new FakeTransport([]), budget: new Budget({}) }),
      async (program) => {
        const row = table[program]!;
        return {
          dependents: row.dependents,
          transitiveDependents: 0,
          lamportsRouted: row.lamportsRouted,
          mintsTouched: 1,
          authority: 'Auth',
          edges: row.edges,
          ...(row.added ? { addedEntrypoints: row.added } : {}),
        };
      },
    );

  it('uses the shared edge pool so the second program sees the first program’s edges', async () => {
    const scanner = mk({
      [B]: { dependents: 1, lamportsRouted: 1e10, edges: [{ from: A, to: B, count: 40, lamportsRouted: 10, selectors: [] }] },
      [C]: { dependents: 2, lamportsRouted: 2e10, edges: EDGES.filter((e) => e.to === C), added: [{ name: 'withdraw', selector: withdrawSel }] },
    });
    const { ranked } = await scanner.rank(
      [
        { signature: 's1', slot: 1, blockTime: 1, program: B, programData: 'x', lamportsTouched: 0 },
        { signature: 's2', slot: 2, blockTime: 2, program: C, programData: 'y', lamportsTouched: 0 },
      ],
      { maxRecords: 2, minValueLamports: 0, minDependents: 0, depth: 2 },
    );
    const c = ranked.find((r) => r.program === C)!;
    expect(c.reach?.direct).toBe(2);
    expect(c.reach?.transitive).toBe(1);
    expect(c.reach?.weightedDependents).toBeCloseTo(2.5);
    expect(c.addedEntrypointExposure?.[0]?.directCallersOnSelector).toBe(1);
    expect(c.addedEntrypointExposure?.[0]?.note).toMatch(/already send this selector/);
    // B was analysed with only its own edge, but A reaches it at depth 1 either way.
    expect(ranked.find((r) => r.program === B)?.reach?.direct).toBe(1);
  });

  it('says plainly when a new entrypoint has no selector to search for', async () => {
    const scanner = mk({
      [C]: { dependents: 1, lamportsRouted: 1e10, edges: EDGES, added: [{ name: 'mystery', selector: '' }] },
    });
    const { ranked } = await scanner.rank(
      [{ signature: 's', slot: 1, blockTime: 1, program: C, programData: 'y', lamportsTouched: 0 }],
      { maxRecords: 1, minValueLamports: 0, minDependents: 0, depth: 2 },
    );
    const exposure = ranked[0]!.addedEntrypointExposure![0];
    expect(exposure.selector).toBe('');
    expect(exposure.directCallersOnSelector).toBe(0);
    expect(exposure.note).toMatch(/selector unknown/);
  });
});
