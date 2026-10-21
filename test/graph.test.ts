import { describe, expect, it } from 'vitest';
import { resolveAccountKeys } from '../src/graph/keys.js';
import { analyzeTrace } from '../src/graph/normalize.js';
import { GraphBuilder, dependentsByDepth, directDependents } from '../src/graph/builder.js';
import { txFixture } from './helpers.js';

const VAULT = '6p2RJu3sreYUznWeWh422HNbzf6JvU3X46KS1grXFejo';
const CHARLIE = '5XZobBCgcyuBM4m1E1rZVei7Me6V8FzwSLexuU194KcN';
const ALPHA = '5PjDJaGfSPJj4tFzMRCiuuAasKg5n8dJKXKenhuwZexx';
const BRAVO = '5TeWSsjg2gbxCyWVniXeCmwM7UtHTCK7svzJr5xYJzHf';
const DELTA = '5bV6jUfhDHCQVA1WfKBUnXUsboJgoKgkzkKcxr3joew5';
const SYSTEM = '11111111111111111111111111111111';

describe('account key resolution', () => {
  it('uses the node-inlined table when the response already carries lookupTable keys', () => {
    const tx = txFixture('tx-nested');
    const r = resolveAccountKeys(tx);
    expect(r.method).toBe('static_only');
    expect(r.keys).toHaveLength(tx.transaction.message.accountKeys.length);
    expect(r.unresolvedIndexes).toEqual([]);
  });

  it('composes static + loaded-writable + loaded-readonly for a v0 transaction', () => {
    const tx = txFixture('tx-v0-lookup');
    const r = resolveAccountKeys(tx);
    expect(r.method).toBe('composed_from_loadedAddresses');
    expect(r.keys.length).toBe(5 + 2);
    // Order is load-bearing: index 5 is the writable table entry, 6 the readonly one.
    expect(r.keys[5]).toBe(VAULT);
    expect(r.keys[6]).toBe(CHARLIE);
    expect(r.unresolvedIndexes).toEqual([]);
  });

  it('reports an index it cannot resolve instead of silently reading undefined', () => {
    const tx = txFixture('tx-v0-lookup');
    tx.meta.loadedAddresses = { writable: [], readonly: [] };
    const r = resolveAccountKeys(tx);
    expect(r.keys.length).toBe(5);
    expect(r.unresolvedIndexes.length).toBeGreaterThan(0);
    expect(r.unresolvedIndexes[0]?.index).toBe(5);
  });
});

describe('graph aggregation', () => {
  it('builds edges with the caller resolved per group', () => {
    const tx = txFixture('tx-depth3');
    const b = new GraphBuilder(ALPHA);
    b.addTrace('sig1', tx, analyzeTrace(tx, resolveAccountKeys(tx)));
    const g = b.finalize();
    expect(g.detailedEdges.find((e) => e.to === CHARLIE)?.from).toBe(BRAVO);
    expect(g.detailedEdges.length).toBeGreaterThan(2);
    expect(g.tracesFailed).toBe(0);
  });

  it('attributes inbound lamports once, to the call that touched the receiving account', () => {
    const tx = txFixture('tx-depth3');
    const pre = [...tx.meta.preBalances];
    tx.meta.postBalances = [...pre];
    tx.meta.postBalances[5] = (tx.meta.postBalances[5] ?? 0) + 750_000;
    const b = new GraphBuilder(ALPHA);
    b.addTrace('sig1', tx, analyzeTrace(tx, resolveAccountKeys(tx)));
    const g = b.finalize();
    const edge = g.detailedEdges.find((e) => e.to === DELTA);
    expect(edge?.lamportsRouted).toBe(750_000);
    // The same value must not also be credited to the depth-3 sibling call.
    const charlie = g.detailedEdges.find((e) => e.to === CHARLIE);
    expect(charlie?.lamportsRouted ?? 0).toBeLessThanOrEqual(750_000);
  });

  it('counts a rolled-back transaction as an interaction but never as moved value', () => {
    const tx = txFixture('tx-failed');
    const pre = [...tx.meta.preBalances];
    tx.meta.postBalances = [...pre];
    tx.meta.postBalances[5] = (tx.meta.postBalances[5] ?? 0) + 9_000_000;
    const b = new GraphBuilder(ALPHA);
    const analysis = analyzeTrace(tx, resolveAccountKeys(tx));
    b.addTrace('sigX', tx, analysis);
    const g = b.finalize();
    expect(g.tracesFailed).toBe(1);
    expect(g.detailedEdges.reduce((s, e) => s + e.count, 0)).toBe(1);
    expect(g.detailedEdges.reduce((s, e) => s + e.lamportsRouted, 0)).toBe(0);
  });

  it('keeps system noise out of the dependent count but in the edge list', () => {
    const tx = txFixture('tx-depth3');
    // BRAVO is the upgraded program here: ALPHA calls it, so ALPHA is BRAVO's
    // dependent. Reversing this is the single easiest way to publish a blast
    // radius that names the wrong victims.
    const b = new GraphBuilder(BRAVO);
    b.addTrace('sig1', tx, analyzeTrace(tx, resolveAccountKeys(tx)));
    const g = b.finalize();
    expect(g.detailedEdges.some((e) => e.to === SYSTEM)).toBe(true);
    expect(directDependents(g, BRAVO).map((e) => e.from)).toContain(ALPHA);
    expect(directDependents(g, BRAVO).some((e) => e.from === SYSTEM)).toBe(false);
  });

  it('walks transitive dependents by depth and never revisits a node', () => {
    const tx = txFixture('tx-depth3');
    const b = new GraphBuilder(SYSTEM);
    b.addTrace('sig1', tx, analyzeTrace(tx, resolveAccountKeys(tx)));
    const g = b.finalize();
    const at = (d: number) => dependentsByDepth(g, SYSTEM, 3).filter((x) => x.depth === d).map((x) => x.program);
    expect(at(1)).toContain(ALPHA);
    expect(at(2)).toHaveLength(0);
    const all = dependentsByDepth(g, SYSTEM, 3).map((x) => x.program);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('encoding equivalence', () => {
  it('resolves the same graph whether accounts arrive as pubkeys or as indexes', () => {
    const parsedForm = txFixture('tx-depth3');
    const jsonForm = txFixture('tx-depth3-json-encoded');

    const build = (tx: typeof parsedForm) => {
      const b = new GraphBuilder(tx.transaction.message.instructions[0]!.programId);
      b.addTrace('sig', tx, analyzeTrace(tx, resolveAccountKeys(tx)));
      return b.finalize();
    };

    const a = build(parsedForm);
    const c = build(jsonForm);
    expect(a.detailedEdges.map((e) => `${e.from}>${e.to}`)).toEqual(c.detailedEdges.map((e) => `${e.from}>${e.to}`));
    expect(a.detailedEdges.map((e) => e.lamportsRouted)).toEqual(c.detailedEdges.map((e) => e.lamportsRouted));
    // And the nested edge is attributed the same way in both encodings.
    expect(a.detailedEdges.find((e) => e.to === CHARLIE)?.from).toBe(BRAVO);
    expect(c.detailedEdges.find((e) => e.to === CHARLIE)?.from).toBe(BRAVO);
  });

  it('recovers accounts from parsed.info when the node sends an instruction with no accounts array at all', () => {
    const tx = txFixture('tx-depth3');
    const resolution = resolveAccountKeys(tx);
    const analysis = analyzeTrace(tx, resolution);
    const VAULT = '6p2RJu3sreYUznWeWh422HNbzf6JvU3X46KS1grXFejo';
    const USER = '6k78AbasGMFFrhG95Pj6jQbqkVt7FQMhVgemxJovWKR6';
    const sys = analysis.frames.find((f) => f.accountSource === 'parsed_info');
    expect(sys?.accountPubkeys).toEqual(expect.arrayContaining([USER, VAULT]));
  });
});

describe('value accounting honesty', () => {
  it('does not let a per-edge sum masquerade as a transaction total', () => {
    const tx = txFixture('tx-depth3');
    tx.meta.postBalances = [...tx.meta.preBalances];
    // One account receives value; several attributed calls touch it.
    tx.meta.postBalances[5] = (tx.meta.preBalances[5] ?? 0) + 1_000_000;
    const b = new GraphBuilder(ALPHA);
    const analysis = analyzeTrace(tx, resolveAccountKeys(tx));
    // Duplicate the same trace under three signatures to make the overcount visible
    // at the transaction level too.
    for (const sig of ['s1', 's2', 's3']) b.addTrace(sig, tx, analysis);
    const g = b.finalize();
    const edgeSum = g.detailedEdges.reduce((s2, e) => s2 + e.lamportsRouted, 0);
    // Edges legitimately repeat a movement across the calls that touched it...
    expect(edgeSum).toBeGreaterThan(1_000_000);
    // ...but the deduped total counts each receiving account once per transaction.
    expect(g.lamportsMovedDeduped).toBe(3_000_000);
    expect(g.lamportsMovedDeduped).toBeLessThan(edgeSum);
  });

  it('keeps the deduped total at zero when nothing actually moved', () => {
    const tx = txFixture('tx-failed');
    tx.meta.postBalances = [...tx.meta.preBalances];
    tx.meta.postBalances[5] = (tx.meta.postBalances[5] ?? 0) + 5_000_000;
    const b = new GraphBuilder(ALPHA);
    b.addTrace('sigF', tx, analyzeTrace(tx, resolveAccountKeys(tx)));
    expect(b.finalize().lamportsMovedDeduped).toBe(0);
  });
});
