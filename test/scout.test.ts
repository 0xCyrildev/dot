import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { PublicKey } from '@solana/web3.js';
import { Budget } from '../src/agent/budget.js';
import { RuleBasedDecision } from '../src/agent/rules.js';
import { Scout } from '../src/agent/scout.js';
import { HttpTransport } from '../src/rpc/transport.js';
import { SolanaClient } from '../src/rpc/client.js';
import { BPF_LOADER_UPGRADEABLE } from '../src/ids.js';
import { renderMarkdown } from '../src/report.js';
import { FakeTransport, txFixture } from './helpers.js';

const TARGET = '5PjDJaGfSPJj4tFzMRCiuuAasKg5n8dJKXKenhuwZexx';
const AUTH = 'FnSCQX1CYdGkGgd7RSScZzVij7nfKhYK5VcjaAozv3d5';

function programDataBytes(authority: string | null): Buffer {
  return Buffer.concat([
    Buffer.from([3, 0, 0, 0]),
    (() => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(423_977_638n);
      return b;
    })(),
    authority ? Buffer.from([1]) : Buffer.from([0]),
    authority ? new PublicKey(authority).toBuffer() : Buffer.alloc(32, 0),
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]),
  ]);
}

function stack(routes: Parameters<typeof FakeTransport.prototype.route>[0][]) {
  const transport = new FakeTransport();
  routes.forEach((r) => transport.route(r));
  const budget = new Budget({ maxRpcCalls: 500, maxSignatures: 500, maxLlmTokens: 0, maxWallMs: 600_000 });
  return { transport, budget };
}

function makeScout(
  transport: FakeTransport,
  budget: Budget,
  opts: Partial<{ prior: Map<string, { at: number; knownDependents: number; lamportsRouted: number; tier: string }>; multisigs: string[] }> = {},
) {
  const client = new SolanaClient({ transport, budget, commitment: 'finalized' });
  return new Scout({
    client,
    budget,
    decision: new RuleBasedDecision({}),
    mode: 'rules',
    ...(opts.multisigs ? { knownMultisigs: opts.multisigs } : {}),
    ...(opts.prior ? { prior: opts.prior } : {}),
  });
}

const accountRoute = (authority: string | null) => ({
  match: (m: string) => m === 'getAccountInfo',
  result: {
    context: { slot: 1 },
    value: { lamports: 12_633_600, owner: BPF_LOADER_UPGRADEABLE, executable: false, data: [programDataBytes(authority).toString('base64'), 'base64'] },
  },
});

const sigsRoute = (n: number) => ({
  match: (m: string) => m === 'getSignaturesForAddress',
  result: Array.from({ length: n }, (_, i) => ({ signature: `sig${i}`, slot: 400_000_000 + i, err: null, memo: null, blockTime: 1_760_000_000 - i * 400, confirmationStatus: 'finalized' })),
});

const txRoute = (tx: unknown) => ({
  match: (m: string) => m === 'getTransaction',
  result: tx,
});

describe('Scout: the bounded loop', () => {
  it('stops in Decide for a multisig-held program with a known zero blast radius, and still reports', async () => {
    const { transport, budget } = stack([accountRoute(AUTH), sigsRoute(50), txRoute(txFixture('tx-depth3'))]);
    const prior = new Map([[TARGET, { at: Date.now() - 1000, knownDependents: 0, lamportsRouted: 0, tier: 'P3' }]]);
    const scout = makeScout(transport, budget, { prior, multisigs: [AUTH] });
    const report = await scout.run({ program: TARGET });

    expect(report.stoppedAt).toBe('decide');
    expect(report.blastRadius).toBeNull();
    // The whole point: it read state, decided, and paid for exactly one RPC call.
    expect(budget.snapshot().spent.rpcCalls).toBe(1);
    expect(transport.calls.map((c) => c.method)).toEqual(['getAccountInfo']);
    expect(report.tier).toBe('P3');
    expect(report.decision?.source).toBe('rules');
    expect(renderMarkdown(report)).toContain('Not measured');
  });

  it('treats an unobserved dependent count as unknown, not as zero', async () => {
    const { transport, budget } = stack([accountRoute(AUTH), sigsRoute(2), txRoute(txFixture('tx-depth3'))]);
    const scout = makeScout(transport, budget, { multisigs: [AUTH] });
    const report = await scout.run({ program: TARGET });
    // No prior graph, so Decide must proceed even though the authority is a multisig.
    expect(report.stoppedAt).not.toBe('decide');
    expect(report.decision?.rationale).toMatch(/unobserved/);
  });

  it('keeps a partial graph and names the budget that stopped it when the trace pull runs dry', async () => {
    const transport = new FakeTransport();
    transport.route(accountRoute(AUTH));
    transport.route(sigsRoute(40));
    transport.route(txRoute(txFixture('tx-depth3')));
    const budget = new Budget({ maxRpcCalls: 4, maxSignatures: 40, maxLlmTokens: 0, maxWallMs: 600_000 });
    const scout = makeScout(transport, budget);
    const report = await scout.run({ program: TARGET });

    expect(report.stoppedAt).toBe('act');
    expect(report.budget.spent.rpcCalls).toBeLessThanOrEqual(4);
    expect(report.blastRadius).not.toBeNull();
    expect(report.blastRadius!.tracesAnalyzed).toBeGreaterThan(0);
    expect(report.cappedBy).not.toBeNull();
    expect(report.limits.length).toBeGreaterThan(0);
    // 1 read + 1 signature walk + 2 transaction fetches, then refused.
    expect(transport.methodCounts().getTransaction).toBeLessThanOrEqual(3);
  });

  it('records pruned history as a limit rather than as an absent dependency', async () => {
    const transport = new FakeTransport();
    transport.route(accountRoute(AUTH));
    transport.route(sigsRoute(3));
    let served = 0;
    transport.route({
      match: (m: string) => m === 'getTransaction',
      resultFn: () => (served++ === 0 ? txFixture('tx-depth3') : null),
    });
    const budget = new Budget({ maxRpcCalls: 100, maxSignatures: 100 });
    const scout = makeScout(transport, budget);
    const report = await scout.run({ program: TARGET });
    expect(report.rpc.pruned).toBeGreaterThan(0);
    expect(report.evidence.some((e) => e.kind === 'limit' && /pruned|unavailable/.test(e.summary))).toBe(true);
    expect(report.limits.some((l) => l.code === 'HISTORY_RETENTION')).toBe(true);
  });

  it('surfaces the fold on real captured data through the full pipeline', async () => {
    const tx = txFixture('tx-nested');
    const transport = new FakeTransport();
    transport.route(accountRoute(AUTH));
    transport.route({ match: (m: string) => m === 'getSignaturesForAddress', result: [{ signature: 'real', slot: tx.slot, err: null, blockTime: tx.blockTime, confirmationStatus: 'finalized' }] });
    transport.route(txRoute(tx));
    const budget = new Budget({ maxRpcCalls: 50, maxSignatures: 50 });
    const report = await makeScout(transport, budget).run({ program: TARGET });
    expect(report.graph?.attributionQuality).toBe('stackHeight');
    expect(report.graph?.tracesAnalyzed).toBe(1);
    expect(report.blastRadius!.cpiOccurrences).toBe(11);
    expect(renderMarkdown(report)).toContain('attribution');
  });
});

describe('node history refusals are classified as blindness, not as errors', () => {
  it('counts -32015 as pruned so the report says the node has no history', async () => {
    const transport = new FakeTransport([
      accountRoute(AUTH),
      sigsRoute(3),
      { match: (m: string) => m === 'getTransaction', error: { code: -32015, message: 'Transaction history is not available from the configured region' } },
    ]);
    const budget = new Budget({ maxRpcCalls: 100, maxSignatures: 100 });
    const report = await makeScout(transport, budget).run({ program: TARGET });
    expect(report.rpc.pruned).toBe(3);
    expect(report.rpc.failed).toBe(0);
    expect(report.rpc.rpcErrorCodes['-32015']).toBe(3);
    expect(report.blastRadius).not.toBeNull();
    expect(report.blastRadius!.tracesAnalyzed).toBe(0);
    expect(report.confidence).toBe('low');
    expect(report.limits.filter((l) => l.code === 'HISTORY_RETENTION')).toHaveLength(1);
    expect(report.evidence.some((e) => /pruned of|were unavailable/.test(e.summary) || /unavailable/.test(e.summary))).toBe(true);
  });
});
