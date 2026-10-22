import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrior, savePrior } from '../src/state/priorStore.js';

/** Dot's memory feeds the behavioural axis, so a silently malformed entry is a score built on nothing. */
describe('priorStore', () => {
  async function tmp() {
    return await mkdtemp(join(tmpdir(), 'dot-prior-'));
  }

  it('round-trips through save and load', async () => {
    const path = join(await tmp(), 'state.json');
    const m = new Map<string, import('../src/agent/scout.js').PriorDigest>([
      ['Pg1', { at: 1_760_000_000_000, knownDependents: 3, lamportsRouted: 42, tier: 'P2', upgradesAt: [1_760_000_000_000] }],
    ]);
    await savePrior(path, m);
    const back = await loadPrior(path);
    expect(back?.get('Pg1')?.upgradesAt).toEqual([1_760_000_000_000]);
    expect(back?.size).toBe(1);
  });

  it('returns null for a missing or unparseable file rather than throwing at the caller', async () => {
    const dir = await tmp();
    expect(await loadPrior(join(dir, 'nope.json'))).toBeNull();
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{not json');
    expect(await loadPrior(bad)).toBeNull();
  });

  it('drops an entry with no usable timestamp instead of letting it render as "Invalid Date"', async () => {
    // priorDigestAt is printed into the axis label; a digest whose `at` is absent or NaN would put a
    // broken date inside a score, which is worse than reporting no memory at all.
    const dir = await tmp();
    const path = join(dir, 'mixed.json');
    await writeFile(path, JSON.stringify({
      good: { at: 1_760_000_000_000, knownDependents: 0, lamportsRouted: 0, tier: 'P3' },
      noAt: { knownDependents: 1, lamportsRouted: 0, tier: 'P3' },
      nanAt: { at: null, knownDependents: 1, lamportsRouted: 0, tier: 'P3' },
    }));
    const loaded = await loadPrior(path);
    expect([...loaded!.keys()]).toEqual(['good']);
  });

  it('creates the parent directory, because a lost answer is expensive at the end of a paid run', async () => {
    const path = join(await tmp(), 'deep', 'nested', 'state.json');
    await savePrior(path, new Map([['Pg1', { at: 1, knownDependents: 0, lamportsRouted: 0, tier: 'P3' }]]));
    expect((await loadPrior(path))?.size).toBe(1);
  });
});
