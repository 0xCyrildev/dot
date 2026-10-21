import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BlockBatcher, UNVERIFIED_DEFAULTS, loadCostModel, resolveCostModelPath, type CostModel } from '../src/graph/batcher.js';
import { Budget } from '../src/agent/budget.js';
import { SolanaClient } from '../src/rpc/client.js';
import { FakeTransport } from './helpers.js';

/**
 * The cost model, measured instead of assumed.
 *
 * `BlockBatcher.plan()` decides between one call per signature and one call per block from
 * two numbers: transactions per block and bytes per transaction. Both were shipped as
 * labelled guesses, and the label is what makes that tolerable — but a labelled guess still
 * drives the decision. This file pins the guess to a measurement taken off mainnet and
 * checked into `docs/`, so the arithmetic in a report traces to a sample rather than to an
 * author's intuition.
 */

const ROOT = join(__dirname, '..');
const MODEL_FILE = join(ROOT, 'docs', 'calibrated-model-2026-10-21.json');

describe('the committed cost model is a measurement, not a copy of the defaults', () => {
  it('exists, parses, and carries the provenance its own format requires', () => {
    expect(existsSync(MODEL_FILE)).toBe(true);
    const raw = JSON.parse(readFileSync(MODEL_FILE, 'utf8')) as CostModel;
    expect(typeof raw.measuredAt).toBe('number');
    expect(raw.note).toMatch(/blocks sampled \d+\/\d+ at /);
    expect(raw.source).toContain('calibrated-model-2026-10-21.json');
  });

  it('disagrees with the defaults in both directions, which is why it was measured', async () => {
    const model = await loadCostModel(MODEL_FILE);
    // Mainnet blocks are smaller than the assumed 2000 tx and each fetched transaction is
    // far bigger than the assumed 6.5 kB, so the defaults were optimistic about batching on
    // one axis and pessimistic about the byte cost on the other. If a future calibration
    // flips either, this test failing is the correct outcome, not a nuisance.
    expect(model.avgBlockTransactions).toBeLessThan(UNVERIFIED_DEFAULTS.avgBlockTransactions);
    expect(model.avgTxnBytes).toBeGreaterThan(UNVERIFIED_DEFAULTS.avgTxnBytes);
    expect(model.source).not.toMatch(/defaults_unverified/);
  });

  it('keeps the density floor as a policy choice, not a measurement', async () => {
    const model = await loadCostModel(MODEL_FILE);
    expect(model.densityFloor).toBe(UNVERIFIED_DEFAULTS.densityFloor);
  });
});

describe('the plan actually uses the numbers it was given', () => {
  const groups = [
    { slot: 100, signatures: ['a', 'b', 'c', 'd', 'e', 'f'] },
    { slot: 99, signatures: ['g', 'h', 'i', 'j', 'k', 'l'] },
    { slot: 98, signatures: ['m', 'n', 'o', 'p', 'q', 'r'] },
  ];

  function batcherFor(model: CostModel) {
    const budget = new Budget({ maxRpcCalls: 1_000, maxSignatures: 1_000, maxLlmTokens: 0, maxWallMs: 60_000 });
    const transport = new FakeTransport([]);
    const client = new SolanaClient({ transport, budget, commitment: 'finalized' });
    return new BlockBatcher(client, model, budget);
  }

  it('names the model source in the rationale, so a report can be audited', async () => {
    const model = await loadCostModel(MODEL_FILE);
    const plan = batcherFor(model).plan(groups);
    expect(plan.rationale).toContain('Cost model: ');
    expect(plan.rationale).toContain('calibrated-model-2026-10-21.json');
    expect(plan.costModel?.measuredAt).toBe(model.measuredAt);
  });

  it('computes a different byte amplification from the measured bytes than from the defaults', async () => {
    const measured = batcherFor(await loadCostModel(MODEL_FILE)).plan(groups);
    const assumed = batcherFor(UNVERIFIED_DEFAULTS).plan(groups);
    // Same 18 transactions, same 3 blocks: only the measured inputs changed. Amplification is
    // avgBlockTransactions, so a smaller real block size makes batching *cheaper* in bytes than
    // the defaults implied — the direction a reviewer needs to be able to check.
    expect(measured.byteAmplification).not.toBe(assumed.byteAmplification);
    expect(measured.byteAmplification).toBeLessThan(assumed.byteAmplification);
    expect(measured.est.bytesPerBlock).toBeCloseTo(3 * measured.costModel!.avgBlockTransactions * measured.costModel!.avgTxnBytes, 0);
  });

  it('still refuses to batch when density says it is a bad trade', () => {
    const sparse = [
      { slot: 100, signatures: ['a'] },
      { slot: 90, signatures: ['b'] },
      { slot: 80, signatures: ['c'] },
    ];
    const plan = batcherFor(UNVERIFIED_DEFAULTS).plan(sparse);
    expect(plan.density).toBeLessThan(UNVERIFIED_DEFAULTS.densityFloor);
    expect(plan.chosen).toBe('per_signature');
  });
});

describe('where the model comes from', () => {
  it('prefers the flag, then DOT_COST_MODEL, then the labelled defaults', () => {
    expect(resolveCostModelPath('--flag.json', { DOT_COST_MODEL: 'env.json' })).toBe('--flag.json');
    expect(resolveCostModelPath(undefined, { DOT_COST_MODEL: 'env.json' })).toBe('env.json');
    expect(resolveCostModelPath(undefined, {})).toBeUndefined();
  });

  it('never silently adopts a file that is not there', async () => {
    const model = await loadCostModel(join(ROOT, 'docs', 'does-not-exist.json'));
    expect(model.source).toMatch(/unreadable/);
    expect(model.avgTxnBytes).toBe(UNVERIFIED_DEFAULTS.avgTxnBytes);
  });

  it('falls back to the defaults only when nothing was configured, and says so', async () => {
    const model = await loadCostModel(undefined);
    expect(model.source).toMatch(/defaults_unverified/);
    expect(model.measuredAt).toBeNull();
  });
});
