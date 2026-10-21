import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { BlockBatcher, UNVERIFIED_DEFAULTS, loadCostModel, type CostModel } from '../src/graph/batcher.js';
import { GraphBuilder } from '../src/graph/builder.js';
import { UpgradeDispatcher } from '../src/watcher/dispatcher.js';
import { SolanaClient } from '../src/rpc/client.js';
import { Budget } from '../src/agent/budget.js';
import { FakeTransport, txFixture } from './helpers.js';
import type { WireSignatureInfo } from '../src/rpc/wire.js';
import type { UpgradeEvent, ObservedState } from '../src/watcher/watcher.js';

const TARGET = '5PjDJaGfSPJj4tFzMRCiuuAasKg5n8dJKXKenhuwZexx';

const sig = (slot: number, i: number): WireSignatureInfo => ({
  signature: `s${slot}-${i}`,
  slot,
  err: null,
  blockTime: 1_760_000_000,
  confirmationStatus: 'finalized',
});

describe('block batching cost model', () => {
  const batcherFor = (budget = new Budget({ maxRpcCalls: 1000, maxSignatures: 1000 }), model: CostModel = UNVERIFIED_DEFAULTS) =>
    new BlockBatcher(new SolanaClient({ transport: new FakeTransport([]), budget }), model, budget);

  it('groups signatures by slot newest-first without spending a call', () => {
    const groups = batcherFor().groupBySlot([sig(10, 0), sig(12, 0), sig(10, 1), sig(11, 0)]);
    expect(groups.map((g) => g.slot)).toEqual([12, 11, 10]);
    expect(groups[2]?.signatures).toHaveLength(2);
  });

  it('prints both sides of the trade: fewer calls, more bytes', () => {
    const groups = batcherFor().groupBySlot(Array.from({ length: 20 }, (_, i) => sig(100 - (i % 5), i)));
    const plan = batcherFor().plan(groups);
    expect(plan.relevantTransactions).toBe(20);
    expect(plan.distinctBlocks).toBe(5);
    expect(plan.density).toBe(4);
    expect(plan.est.callsPerBlock).toBe(5);
    expect(plan.est.callsPerSignature).toBe(20);
    expect(plan.callSavingRatio).toBe(4);
    // 5 blocks x 2000 txs each vs 20 txs: the amplification is the honest number.
    expect(plan.byteAmplification).toBe(500);
    expect(plan.rationale).toContain('amplification');
    expect(plan.rationale).toContain('unverified');
    expect(plan.chosen).toBe('per_block');
  });

  it('refuses to batch a sparse program, because one block per transaction is all cost', () => {
    const groups = batcherFor().groupBySlot(Array.from({ length: 10 }, (_, i) => sig(200 - i, 0)));
    const plan = batcherFor().plan(groups);
    expect(plan.density).toBe(1);
    expect(plan.chosen).toBe('per_signature');
    expect(plan.rationale).toContain('floor');
  });

  it('batches when the call budget is the binding constraint even if density is low', () => {
    const tight = new Budget({ maxRpcCalls: 20, maxSignatures: 100 });
    tight.spendRpc(19, 'setup');
    const groups = batcherFor(tight).groupBySlot(Array.from({ length: 12 }, (_, i) => sig(300 - i, i)));
    const plan = batcherFor(tight).plan(groups);
    expect(plan.chosen).toBe('per_block');
    expect(plan.rationale).toContain('binding constraint');
  });

  it('loads a calibration file and names it as the source', async () => {
    const m = await loadCostModel(undefined);
    expect(m.source).toContain('defaults_unverified');
    const missing = await loadCostModel('/nope/does-not-exist.json');
    expect(missing.source).toContain('unreadable');
  });

  it('ingests a block, skipping transactions that never touched the target', async () => {
    const tx = txFixture('tx-depth3');
    const other = JSON.parse(JSON.stringify(tx));
    other.transaction.message.accountKeys = other.transaction.message.accountKeys.filter(
      (k: { pubkey: string }) => k.pubkey !== TARGET,
    );
    other.transaction.message.instructions = [{ programId: other.transaction.message.accountKeys[0].pubkey, accounts: [], data: 'x', stackHeight: 1 }];
    other.meta.innerInstructions = null;

    const transport = new FakeTransport([
      {
        match: (m) => m === 'getBlock',
        result: {
          blockhash: 'b',
          previousBlockhash: 'p',
          parentSlot: 0,
          slot: 400_000_100,
          blockTime: 1_760_000_000,
          transactions: [
            { slot: 400_000_100, ...tx },
            { slot: 400_000_100, ...other },
          ],
        },
      },
    ]);
    const client = new SolanaClient({ transport, budget: new Budget({ maxRpcCalls: 50, maxSignatures: 50 }) });
    const batcher = new BlockBatcher(client, { ...UNVERIFIED_DEFAULTS, maxBlockBytes: 10_000_000 });
    const builder = new GraphBuilder(TARGET);
    const sum = await batcher.ingest(TARGET, [{ slot: 400_000_100, signatures: ['a', 'b'] }], builder, {});
    expect(sum.transactionsScanned).toBe(2);
    expect(sum.transactionsRelevant).toBe(1);
    expect(sum.blocksFetched).toBe(1);
    expect(sum.bytes).toBeGreaterThan(0);
    const g = builder.finalize();
    expect(g.detailedEdges.length).toBeGreaterThan(1);
  });

  it('counts a null block as unavailable, never as a provider failure', async () => {
    const transport = new FakeTransport([{ match: (m) => m === 'getBlock', result: null }]);
    const client = new SolanaClient({ transport, budget: new Budget({ maxRpcCalls: 5 }) });
    const batcher = new BlockBatcher(client);
    const sum = await batcher.ingest(TARGET, [{ slot: 1, signatures: ['x'] }], new GraphBuilder(TARGET), {});
    expect(sum.blocksNull).toBe(1);
    expect(sum.errors).toBe(0);
  });

  it('stops cleanly when the block budget runs out mid-sweep', async () => {
    const transport = new FakeTransport([{ match: (m) => m === 'getBlock', result: { blockhash: 'b', previousBlockhash: 'p', parentSlot: 0, transactions: [] } }]);
    const client = new SolanaClient({ transport, budget: new Budget({ maxRpcCalls: 2, maxSignatures: 10 }) });
    const batcher = new BlockBatcher(client);
    const groups = [1, 2, 3, 4].map((slot) => ({ slot, signatures: [`s${slot}`] }));
    const sum = await batcher.ingest(TARGET, groups, new GraphBuilder(TARGET), {});
    expect(sum.stoppedReason).toMatch(/budget exhausted/);
    // Two blocks fit in 2 calls; the third is refused. Counting the refusals as
    // fetched is how a partial sweep starts looking like a complete one.
    expect(sum.blocksFetched).toBe(2);
    expect(groups.length - sum.blocksFetched).toBe(2);
  });
});

const state = (over: Partial<ObservedState> = {}): ObservedState => ({
  programData: 'PD',
  bytecodeHash: 'aaa',
  fullAccountHash: 'bbb',
  authority: 'AUTH',
  bytecodeLen: 1_000_000,
  accountLen: 1_000_050,
  headerU64: 1,
  observedAt: 1,
  closed: false,
  ...over,
});

const ev = (kind: UpgradeEvent['kind'], program: string, over: Partial<UpgradeEvent> = {}): UpgradeEvent => ({
  kind,
  program,
  programData: 'PD',
  before: state(),
  after: state(over.kind === 'authority_change' ? { authority: 'NEW' } : { bytecodeHash: 'zzz' }),
  changed: { bytecode: true, authority: kind === 'authority_change', size: true },
  detectedAt: Date.now(),
  source: 'ws',
  ...over,
});

describe('UpgradeDispatcher fairness', () => {
  it('caps one investigation at maxPerEvent regardless of the daily pool', async () => {
    const seen: number[] = [];
    const d = new UpgradeDispatcher(
      async (_e, limits) => {
        seen.push(limits.maxRpcCalls);
        return { program: _e.program, tier: 'P2', stoppedAt: 'report', rpcCalls: 4 };
      },
      { maxPerEvent: 50, dailyRpcTotal: 5000 },
    );
    d.offer(ev('upgrade', 'A'));
    await d.idle();
    expect(seen).toEqual([50]);
    expect(d.stats().rpcSpentToday).toBe(4);
  });

  it('never lets one program take the whole day', async () => {
    const seen: number[] = [];
    const d = new UpgradeDispatcher(
      async (e, limits) => {
        seen.push(limits.maxRpcCalls);
        return { program: e.program, tier: 'P3', stoppedAt: 'report', rpcCalls: limits.maxRpcCalls };
      },
      { maxPerEvent: 50, dailyRpcTotal: 120, minViable: 12 },
    );
    for (const p of ['A', 'B', 'C', 'D', 'E', 'F']) d.offer(ev('upgrade', p));
    await d.idle();
    expect(seen[0]).toBe(50);
    expect(seen[1]).toBe(50);
    // Third event sees 20 left, so its own cap shrinks instead of the pool being overdrawn.
    expect(seen[2]).toBe(20);
    const st = d.stats();
    expect(st.dropped.daily_pool + st.dropped.below_minimum).toBeGreaterThan(0);
    expect(st.rpcRemainingToday).toBeLessThan(12);
  });

  it('serves an authority handover before a routine bytecode write', async () => {
    const order: string[] = [];
    const d = new UpgradeDispatcher(
      async (e) => {
        order.push(e.program);
        return { program: e.program, tier: 'P3', stoppedAt: 'report', rpcCalls: 1 };
      },
      { maxPerEvent: 100, dailyRpcTotal: 10_000 },
    );
    // The pump starts on the first offer, so queue three while it is running.
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const blocked = new UpgradeDispatcher(
      async (e) => {
        await gate;
        order.push(e.program);
        return { program: e.program, tier: 'P3', stoppedAt: 'report', rpcCalls: 1 };
      },
      { maxPerEvent: 100, dailyRpcTotal: 10_000 },
    );
    void d;
    blocked.offer(ev('upgrade', 'routine-1'));
    blocked.offer(ev('upgrade', 'routine-2'));
    blocked.offer(ev('authority_change', 'HANDOVER'));
    releaseFirst();
    await blocked.idle();
    expect(order[1]).toBe('HANDOVER');
    expect(order).toHaveLength(3);
  });

  it('drops with a counted reason instead of queueing without bound', async () => {
    const d = new UpgradeDispatcher(
      async (e) => ({ program: e.program, tier: 'P3', stoppedAt: 'report', rpcCalls: 0 }),
      { maxQueue: 1, maxPerEvent: 50, dailyRpcTotal: 5000 },
    );
    let outcome = '';
    for (let i = 0; i < 8; i++) outcome = d.offer(ev('upgrade', `P${i}`));
    expect(outcome).toContain('dropped:queue_full');
    expect(d.stats().dropped.queue_full).toBeGreaterThan(0);
    await d.idle();
  });
});
