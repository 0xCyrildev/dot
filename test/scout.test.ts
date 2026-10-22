import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { PublicKey } from '@solana/web3.js';
import { Budget } from '../src/agent/budget.js';
import { RuleBasedDecision } from '../src/agent/rules.js';
import { Scout } from '../src/agent/scout.js';
import { HttpTransport } from '../src/rpc/transport.js';
import { SolanaClient } from '../src/rpc/client.js';
import { BPF_LOADER_UPGRADEABLE } from '../src/ids.js';
import { formatEscalation, renderMarkdown } from '../src/report.js';
import type { UpgradeEvent } from '../src/watcher/watcher.js';
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
  opts: Partial<{ prior: Map<string, { at: number; knownDependents: number; lamportsRouted: number; tier: string }>; multisigs: string[]; usdPerSol: number; stateFileUsed: boolean; governanceProgram: string; checkFunding: boolean; suspectAddresses: string[] }> = {},
) {
  const client = new SolanaClient({ transport, budget, commitment: 'finalized' });
  return new Scout({
    client,
    budget,
    decision: new RuleBasedDecision({}),
    mode: 'rules',
    ...(opts.multisigs ? { knownMultisigs: opts.multisigs } : {}),
    ...(opts.prior ? { prior: opts.prior } : {}),
    ...(opts.usdPerSol !== undefined ? { usdPerSol: opts.usdPerSol } : {}),
    ...(opts.stateFileUsed !== undefined ? { stateFileUsed: opts.stateFileUsed } : {}),
    ...(opts.governanceProgram ? { governanceProgram: opts.governanceProgram } : {}),
    ...(opts.checkFunding ? { checkFunding: true } : {}),
    ...(opts.suspectAddresses ? { suspectAddresses: opts.suspectAddresses } : {}),
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

  it('plans inside the budget it has instead of running dry mid-pull', async () => {
    const transport = new FakeTransport();
    transport.route(accountRoute(AUTH));
    transport.route(sigsRoute(40));
    transport.route(txRoute(txFixture('tx-depth3')));
    const budget = new Budget({ maxRpcCalls: 4, maxSignatures: 40, maxLlmTokens: 0, maxWallMs: 600_000 });
    const report = await makeScout(transport, budget).run({ program: TARGET });

    // Four calls left at Decide means the plan is ~2 signatures, so the run finishes
    // within the ceiling. A constant-25 plan would have started a pull it could not
    // complete and reported a partial graph as if the agent had chosen to stop.
    const plan = report.decision!.plan as { signatures: number };
    expect(plan.signatures).toBeLessThanOrEqual(3);
    expect(report.budget.spent.rpcCalls).toBeLessThanOrEqual(4);
    expect(report.stoppedAt).toBe('report');
    expect(report.decision!.escalation).toBeDefined();
  });

  it('keeps a partial graph and names the ceiling when the wall clock binds mid-pull', async () => {
    // A derived plan fits its own call budget by construction, so the realistic
    // partial case is time: each trace fetch burns wall clock, the run stops with a
    // partial graph, and the report says so instead of calling itself complete.
    let now = 1_000_000;
    const clock = { now: () => now };
    const transport = new FakeTransport();
    transport.route(accountRoute(AUTH));
    transport.route(sigsRoute(60));
    transport.route({
      match: (m: string) => m === 'getTransaction',
      resultFn: () => {
        now += 400;
        return txFixture('tx-depth3');
      },
    });
    const budget = new Budget({ maxRpcCalls: 200, maxSignatures: 200, maxLlmTokens: 0, maxWallMs: 1_500 }, clock);
    const report = await makeScout(transport, budget).run({ program: TARGET });
    expect(report.stoppedAt).toBe('act');
    expect(report.blastRadius).not.toBeNull();
    expect(report.blastRadius!.tracesAnalyzed).toBeGreaterThan(0);
    expect(report.blastRadius!.tracesAnalyzed).toBeLessThan(25);
    expect(report.cappedBy).not.toBeNull();
    expect(report.limits.length).toBeGreaterThan(0);
  });

  it('asks for more budget rather than returning a thin answer it calls complete', async () => {
    const transport = new FakeTransport();
    transport.route(accountRoute(AUTH));
    transport.route(sigsRoute(40));
    transport.route(txRoute(txFixture('tx-depth3')));
    const tight = new Budget({ maxRpcCalls: 3, maxSignatures: 3, maxLlmTokens: 0, maxWallMs: 600_000 });
    const report = await makeScout(transport, tight).run({ program: TARGET });
    const esc = report.decision!.escalation as { kind: string; requestedRpcCalls: number; reason: string };
    expect(esc.kind).toBe('needs_more_budget');
    expect(esc.requestedRpcCalls).toBeGreaterThan(0);
    expect(esc.reason).toMatch(/single key|authority/);
    expect(esc.reason).toMatch(/cannot distinguish/);
    expect(['P2', 'P3']).toContain(report.tier);
    expect(report.confidence).toBe('low');
    expect(report.cappedBy).not.toBeNull();
  });

  it('derives a smaller plan from a smaller budget — the plan is not a constant', async () => {
    const run = async (maxRpcCalls: number, maxSignatures: number) => {
      const transport = new FakeTransport();
      transport.route(accountRoute(AUTH));
      transport.route(sigsRoute(300));
      transport.route(txRoute(txFixture('tx-depth3')));
      const budget = new Budget({ maxRpcCalls, maxSignatures, maxLlmTokens: 0, maxWallMs: 600_000 });
      return await makeScout(transport, budget).run({ program: TARGET });
    };
    const small = await run(10, 10);
    const large = await run(400, 400);
    const sp = small.decision!.plan as { signatures: number };
    const lp = large.decision!.plan as { signatures: number };
    expect(sp.signatures).toBeLessThan(lp.signatures);
    // And the widened plan is capped by what a single key without prior graph wants,
    // not by the 400 calls on offer.
    expect(lp.signatures).toBeLessThanOrEqual(25);
    expect(sp.signatures).toBeLessThanOrEqual(9);
  });

  it('widens to the authority history when a single-key program shows no dependents', async () => {
    const transport = new FakeTransport();
    transport.route(accountRoute(AUTH));
    transport.route({
      match: (m) => m === 'getSignaturesForAddress',
      resultFn: () => Array.from({ length: 60 }, (_, i) => ({ signature: `a${i}`, slot: 4000 + i, err: null, blockTime: 1_760_000_000, confirmationStatus: 'finalized' })),
    });
    // A trace that touches the authority and one other program, but never TARGET.
    const foreign = txFixture('tx-depth3');
    const otherProgram = '5TeWSsjg2gbxCyWVniXeCmwM7UtHTCK7svzJr5xYJzHf';
    foreign.transaction.message.instructions = [
      { programId: otherProgram, accounts: [], data: 'x', stackHeight: 1 },
      { programId: AUTH, accounts: [], data: 'y', stackHeight: 1 },
    ];
    foreign.meta.innerInstructions = null;
    transport.route({ match: (m) => m === 'getTransaction', result: foreign });

    const budget = new Budget({ maxRpcCalls: 200, maxSignatures: 200, maxLlmTokens: 0, maxWallMs: 600_000 });
    const report = await makeScout(transport, budget).run({ program: TARGET });
    expect(report.blastRadius!.directCallers).toBe(0);
    expect(report.widenNote).toContain('co-invoked');
    expect(report.coControlledPrograms).toContain(otherProgram);
    expect(report.evidence.some((e) => /widening to the authority/.test(e.summary))).toBe(true);
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

describe('endpoint disagreement halts rather than reports', () => {
  it('emits a P0 whose source is integrity, not exposure, and never runs a trace pull', async () => {
    const transport = new FakeTransport([accountRoute(AUTH), sigsRoute(20), txRoute(txFixture('tx-depth3'))]);
    const budget = new Budget({ maxRpcCalls: 100, maxSignatures: 100 });
    const scout = new Scout({
      client: new SolanaClient({ transport, budget, commitment: 'finalized' }),
      budget,
      decision: new RuleBasedDecision({}),
      mode: 'rules',
      resilient: {
        quorum: async () => ({
          agreement: 'disagreed' as const,
          account: null,
          endpoints: [
            { url: 'https://a.test', ok: true, slot: 4000 },
            { url: 'https://b.test', ok: true, slot: 4000 },
          ],
          reason: 'endpoints agree on slot 4000 but disagree on the account bytes',
          halt: true,
        }),
      },
    });
    const report = await scout.run({ program: TARGET });
    expect(report.tier).toBe('P0');
    expect(report.tierSource).toBe('integrity');
    expect(report.stoppedAt).toBe('perceive');
    expect(report.blastRadius).toBeNull();
    expect(report.decision).toBeNull();
    expect(report.integrity?.agreement).toBe('disagreed');
    expect(report.components[0]?.name).toBe('endpoint_disagreement');
    // The trace pull never happened: a halt is not a partial analysis.
    expect(transport.calls.filter((c) => c.method === 'getSignaturesForAddress')).toHaveLength(0);
    expect(renderMarkdown(report)).toContain('DATA INTEGRITY');
  });

  it('carries on when the endpoints merely answered at different slots', async () => {
    const transport = new FakeTransport([accountRoute(AUTH), sigsRoute(1), txRoute(txFixture('tx-depth3'))]);
    const budget = new Budget({ maxRpcCalls: 100, maxSignatures: 100 });
    let calls = 0;
    const scout = new Scout({
      client: new SolanaClient({ transport, budget, commitment: 'finalized' }),
      budget,
      decision: new RuleBasedDecision({}),
      mode: 'rules',
      resilient: {
        quorum: async () => {
          calls++;
          const account = { address: 'PD', lamports: 1, owner: BPF_LOADER_UPGRADEABLE, data: programDataBytes(AUTH) };
          return { agreement: 'slot_mismatch' as const, account, endpoints: [], reason: 'different slots; inconclusive', halt: false };
        },
      },
    });
    const report = await scout.run({ program: TARGET });
    expect(report.tierSource).toBe('exposure');
    expect(report.integrity?.agreement).toBe('slot_mismatch');
    expect(report.evidence.some((e) => /slot_mismatch/.test(e.summary))).toBe(true);
    expect(calls).toBe(1);
  });
});

describe('cursor walk termination', () => {
  it('stops paying when the provider returns an overlapping window', async () => {
    const transport = new FakeTransport([
      accountRoute(AUTH),
      sigsRoute(3),
      txRoute(txFixture('tx-depth3')),
    ]);
    const budget = new Budget({ maxRpcCalls: 100, maxSignatures: 100 });
    const report = await makeScout(transport, budget).run({ program: TARGET });
    const sigCalls = transport.calls.filter((c) => c.method === 'getSignaturesForAddress').length;
    // Without the no-progress guard this loop spends the entire 100-call budget
    // re-reading the same three signatures.
    expect(sigCalls).toBeLessThanOrEqual(3);
    expect(report.evidence.some((e) => /no progress/.test(e.summary))).toBe(true);
    expect(report.budget.spent.rpcCalls).toBeLessThan(20);
  });
});

describe('escalation is phrased as an ask, not a finding', () => {
  it('prints the number of calls needed and the flag to raise', async () => {
    const transport = new FakeTransport();
    transport.route(accountRoute(AUTH));
    transport.route(sigsRoute(30));
    transport.route(txRoute(txFixture('tx-depth3')));
    const budget = new Budget({ maxRpcCalls: 3, maxSignatures: 3, maxLlmTokens: 0, maxWallMs: 600_000 });
    const report = await makeScout(transport, budget).run({ program: TARGET });
    const line = formatEscalation(report);
    expect(line).not.toBeNull();
    expect(line).toContain('Dot needs');
    expect(line).toContain('more RPC call(s) to confirm the blast radius');
    expect(line).toContain('--budget-rpc +');
    expect(line).toContain('this tier is capped by coverage');
    // A run with no escalation must print nothing at all.
    const wide = new FakeTransport();
    wide.route(accountRoute(AUTH));
    wide.route(sigsRoute(3));
    wide.route(txRoute(txFixture('tx-depth3')));
    const ok = await makeScout(wide, new Budget({ maxRpcCalls: 200, maxSignatures: 200 })).run({ program: TARGET });
    expect(formatEscalation(ok)).toBeNull();
  });
});

describe('Scout: the Upgrade Danger Ranking rides the same report', () => {
  const axisOf = (d: NonNullable<Awaited<ReturnType<Scout['run']>>['danger']>, id: string) => d.axes.find((a) => a.id === id)!;

  it('scores the authority it read from ProgramData and refuses to guess the rest', async () => {
    // No --state, no --multisig: the authority is a plain key, so posture is the full 40 — and
    // the behavioural axis must come back null rather than "first upgrade", because without a
    // state file "no prior digest" is not evidence of anything.
    const { transport, budget } = stack([accountRoute(AUTH), sigsRoute(2), txRoute(txFixture('tx-depth3'))]);
    const report = await makeScout(transport, budget).run({ program: TARGET });
    const d = report.danger!;
    expect(axisOf(d, 'authority').points).toBe(40);
    expect(axisOf(d, 'authority').label).toMatch(/Single-key EOA/);
    expect(d.unassessedAxes).toContain('behavior');
    expect(d.category).not.toBe('CRITICAL');
    // No withholding note on this run: the score was nowhere near CRITICAL, so the ceiling rule
    // had nothing to clamp. test/danger.test.ts pins the clamp itself.
    expect(d.ceiling).toBeNull();
    const md = renderMarkdown(report);
    expect(md).toContain('## Upgrade danger ranking');
    expect(md).toContain('UPGRADE DANGER RANKING:');
    expect(md).toContain('├── Behavior:');
    // The three signature axes ride along even when nothing probed them, labelled as unassessed —
    // their absence from the tree would read as "checked and clean".
    expect(md).toContain('├── Authority Integrity:');
    expect(md).toContain('├── Code Anomaly:');
    expect(md).toContain('└── Timing Anomaly:');
  });

  it('reads a declared multisig authority as 25 with the threshold gap stated', async () => {
    const { transport, budget } = stack([accountRoute(AUTH), sigsRoute(2), txRoute(txFixture('tx-depth3'))]);
    const report = await makeScout(transport, budget, { multisigs: [AUTH] }).run({ program: TARGET });
    const a = axisOf(report.danger!, 'authority');
    expect(a.points).toBe(25);
    expect(a.detail.join(' ')).toMatch(/threshold not readable/i);
  });

  it('does not call a repeat upgrade a first sighting when --state remembers it', async () => {
    const { transport, budget } = stack([accountRoute(AUTH), sigsRoute(50), txRoute(txFixture('tx-depth3'))]);
    const prior = new Map([[TARGET, { at: Date.now() - 86_400_000, knownDependents: 0, lamportsRouted: 0, tier: 'P3' }]]);
    const report = await makeScout(transport, budget, { prior, multisigs: [AUTH] }).run({ program: TARGET });
    const a = axisOf(report.danger!, 'behavior');
    expect(a.points).toBe(0);
    expect(a.label).toMatch(/previously observed/);
  });

  it('keeps the operator-declared price out of a sample that routed nothing', async () => {
    // The fixture graph attributes zero lamports, so even with --sol-usd supplied the ranking
    // must print no dollar figure. The USD path itself is pinned in test/danger.test.ts, where
    // the value is not zero; this is the integration case where the artifact would appear.
    const { transport, budget } = stack([accountRoute(AUTH), sigsRoute(2), txRoute(txFixture('tx-depth3'))]);
    const report = await makeScout(transport, budget, { usdPerSol: 150 }).run({ program: TARGET });
    const label = axisOf(report.danger!, 'blastRadius').label;
    expect(label).toMatch(/routing 0 lamports/);
    expect(label).not.toMatch(/\$/);
  });

  // The timing axis is the one malice signature whose answer changes with the question "when?", and the
  // first wiring answered it with the operator's clock. These two tests are the difference.
  const GOV = 'G1ovProgTxXz2rBfbvH4sF7fjXvPjqKTXf3gDvXvjfb';
  const govActiveNowRoute = () => ({
    match: (m: string, p: unknown[]) => m === 'getSignaturesForAddress' && p[0] === GOV,
    result: [{ signature: 'gov0', slot: 400_000_900, err: null, memo: null, blockTime: Math.floor(Date.now() / 1000) - 60, confirmationStatus: 'finalized' }],
  });

  it('measures governance proximity against the upgrade, not against the moment Dot was run', async () => {
    // Regression: comparing the governance program's *current* signatures to Date.now() awarded +10 to
    // every historical `analyze` of any program whose sampled activity is old, against a busy
    // governance program. The reference is now the newest sampled transaction, so a 2025 upgrade and a
    // governance call from a minute ago are a year apart and score nothing.
    const { transport, budget } = stack([govActiveNowRoute(), accountRoute(AUTH), sigsRoute(2), txRoute(txFixture('tx-depth3'))]);
    const report = await makeScout(transport, budget, { governanceProgram: GOV }).run({ program: TARGET });
    const a = axisOf(report.danger!, 'timingAnomaly');
    expect(a.points).toBe(0);
    expect(a.notAssessed.join(' ')).toMatch(/outside the 1-hour band/);
    expect(a.detail.join(' ')).not.toMatch(/\+10/);
  });

  it('awards the +10 when a watcher saw the change minutes after governance moved, and names its clock', async () => {
    const { transport, budget } = stack([govActiveNowRoute(), accountRoute(AUTH), sigsRoute(2), txRoute(txFixture('tx-depth3'))]);
    const event = {
      kind: 'upgrade',
      program: TARGET,
      programData: 'HZcJwcJ2njPDxZtpPoKnF8v2w9QAx2rS7TdJPSRkbEhu',
      before: null,
      after: null,
      changed: { bytecode: true, authority: false, size: false },
      detectedAt: Date.now(),
      source: 'poll',
    } satisfies UpgradeEvent;
    const report = await makeScout(transport, budget, { governanceProgram: GOV }).run({ program: TARGET, event });
    const a = axisOf(report.danger!, 'timingAnomaly');
    expect(a.points).toBe(10);
    expect(a.detail.join(' ')).toMatch(/minute\(s\) from this upgrade/);
    expect(a.detail.join(' ')).not.toMatch(/Dot's own clock/);
    expect(a.notAssessed.join(' ')).toMatch(/cannot tell a governance \*proposal\*/);
  });

  it('pays for the funding probe only when asked, and records what it refused', async () => {
    const refused = new FakeTransport();
    refused.route(accountRoute(AUTH));
    refused.route({ match: (m: string) => m === 'getSignaturesForAddress', error: { code: -32006, message: 'Transaction history is not available' } });
    refused.route(sigsRoute(2));
    refused.route(txRoute(txFixture('tx-depth3')));
    const report = await makeScout(refused, new Budget({ maxRpcCalls: 500, maxSignatures: 500 }), { checkFunding: true }).run({ program: TARGET });
    const a = axisOf(report.danger!, 'authorityIntegrity');
    expect(a.points).toBe(20);
    expect(a.notAssessed.join(' ')).toMatch(/An unverified authority is not a verified one/);
    expect(report.evidence.map((e) => e.summary).join(' ')).toMatch(/authority funding unverified/);
    // No suspect list was supplied, so the +30 band was unreachable before the node even refused.
    expect(a.notAssessed.join(' ')).toMatch(/unreachable by construction/);

    const untouched = await makeScout(new FakeTransport([
      accountRoute(AUTH),
      sigsRoute(2),
      txRoute(txFixture('tx-depth3')),
    ]), new Budget({ maxRpcCalls: 500, maxSignatures: 500 })).run({ program: TARGET });
    expect(axisOf(untouched.danger!, 'authorityIntegrity').notAssessed.join(' ')).toMatch(/funding was not probed/);
  });
});
