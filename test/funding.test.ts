import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { Budget } from '../src/agent/budget.js';
import { SolanaClient } from '../src/rpc/client.js';
import { probeAuthorityFunding } from '../src/agent/funding.js';
import { FakeTransport } from './helpers.js';
import { scoreDanger, type DangerInputs, type FundingEvidence } from '../src/score/danger.js';

/**
 * The authority-funding probe, and the one thing it exists to protect: **a refused check is never a
 * clean check.** Every path that cannot establish something returns a state the scorer refuses to
 * reward with the top band, and the top band is the only route to the malice scream that does not
 * need the diff's cooperation.
 */
const AUTH = new PublicKey('FnSCQX1CYdGkGgd7RSScZzVij7nfKhYK5VcjaAozv3d5').toBase58();
const DONOR = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM').toBase58();
const OTHER = new PublicKey('BQ6gmp3zE9dL2R4gkDnBqQ6gmp3zE9dL2R4gkDnBqQ6g').toBase58();
const NOW = 1_760_000_000_000;
const HOUR = 3_600_000;

const sig = (n: number, minutesAgo: number) => ({
  signature: `sig${n}`,
  slot: 400_000_000 - n,
  err: null,
  memo: null,
  blockTime: Math.floor((NOW - minutesAgo * 60_000) / 1000),
  confirmationStatus: 'finalized',
});

/** A transaction in which `index`'s balance rises by `amount` and the largest faller pays for it. */
function fundingTx(keys: string[], index: number, amount: number) {
  const pre = keys.map(() => 1_000_000_000);
  const post = keys.map(() => 1_000_000_000);
  post[index] = pre[index]! + amount;
  const donor = index === 0 ? 1 : 0;
  pre[donor] = pre[donor]! + amount;
  return {
    slot: 400_000_000,
    transaction: {
      message: {
        accountKeys: keys.map((k, i) => ({ pubkey: k, signer: i === 0, source: 'transaction', writable: true })),
        instructions: [{ programIdIndex: 0, data: '', accounts: [] }],
      },
      signatures: [],
    },
    meta: {
      err: null,
      preBalances: pre,
      postBalances: post,
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [],
      logMessages: [],
      computeUnitsConsumed: '150',
    },
    blockTime: Math.floor(NOW / 1000),
  } as never;
}

function client(routes: Parameters<typeof FakeTransport.prototype.route>[0][]) {
  const transport = new FakeTransport();
  routes.forEach((r) => transport.route(r));
  const budget = new Budget({ maxRpcCalls: 500, maxSignatures: 500, maxLlmTokens: 0, maxWallMs: 600_000 });
  return { client: new SolanaClient({ transport, budget, commitment: 'finalized' }), transport };
}

const sigsRoute = (list: unknown[]) => ({ match: (m: string) => m === 'getSignaturesForAddress', result: list });
const txRoute = (result: unknown) => ({ match: (m: string) => m === 'getTransaction', result });

async function run(routes: Parameters<typeof FakeTransport.prototype.route>[0][], over: Partial<Parameters<typeof probeAuthorityFunding>[1]> = {}) {
  const { client: c, transport } = client(routes);
  const r = await probeAuthorityFunding(c, { authority: AUTH, suspectAddresses: new Set(), nowMs: NOW, ...over });
  return { ...r, calls: transport.calls.length };
}

describe('authority funding probe', () => {
  it('reports unverified when the node refuses the signature walk', async () => {
    const r = await run([{ match: (m: string) => m === 'getSignaturesForAddress', error: { code: -32006, message: 'Transaction history is not available' } }]);
    expect(r.evidence.state).toBe('unverified');
    expect(r.evidence.detail).toMatch(/-320|history|failed/i);
    expect(r.signaturesSeen).toBe(0);
  });

  it('reports unverified when the authority has no listed signatures at all', async () => {
    const r = await run([sigsRoute([])]);
    expect(r.evidence.state).toBe('unverified');
    // The sentence matters: an empty list looks like a brand-new wallet and is equally likely to be
    // a node that dropped the history. Saying "fresh" here would be the invention this file forbids.
    expect(r.evidence.detail).toMatch(/indistinguishable/i);
  });

  it('flags a transfer from an operator-named suspect address', async () => {
    const routes = [sigsRoute([sig(1, 5)]), txRoute(fundingTx([AUTH, DONOR], 0, 500_000_000))];
    const p = await run(routes, { suspectAddresses: new Set([DONOR]) });
    expect(p.evidence.state).toBe('flagged_source');
    if (p.evidence.state === 'flagged_source') expect(p.evidence.fromAddress).toBe(DONOR);
    // One signature walk plus one transaction read. The probe's cost is part of the claim, since
    // these calls come out of the same budget the analysis is capped by.
    expect(p.calls).toBe(2);
  });

  it('does not flag the same transfer when no suspect list was supplied', async () => {
    // The `flagged_source` state is unreachable by default, and that is deliberate: Dot ships no
    // mixer list, so an accusation of this kind needs an operator's source, not a heuristic's guess.
    const routes = [sigsRoute([sig(1, 5)]), txRoute(fundingTx([AUTH, DONOR], 0, 500_000_000))];
    const p = await run(routes);
    expect(p.evidence.state).toBe('recent_funding_observed');
  });

  it('calls a wallet fresh only when the walk reached its beginning', async () => {
    const p = await run([sigsRoute([sig(1, 90)]), txRoute(fundingTx([AUTH, DONOR], 0, 500_000_000))]);
    expect(p.evidence.state).toBe('recent_funding_observed');
    if (p.evidence.state === 'recent_funding_observed') {
      expect(p.evidence.retentionBounded).toBe(false);
      expect(p.evidence.ageMs).toBeLessThan(24 * HOUR);
    }
    expect(p.walkReachedBeginning).toBe(true);
  });

  it('marks the same wallet retention-bounded when the walk filled the page', async () => {
    const many = Array.from({ length: 3 }, (_, i) => sig(i, 90 + i * 10));
    const p = await run(
      [sigsRoute(many), txRoute(fundingTx([AUTH, DONOR], 0, 500_000_000))],
      { limit: 3 },
    );
    expect(p.evidence.state).toBe('recent_funding_observed');
    if (p.evidence.state === 'recent_funding_observed') expect(p.evidence.retentionBounded).toBe(true);
    expect(p.evidence.detail).toMatch(/may exist|older history/i);
  });

  it('calls a long-lived authority established', async () => {
    const p = await run([sigsRoute([sig(1, 60), sig(2, 60 + 43_200)]), txRoute(fundingTx([AUTH, OTHER], 0, 1))]);
    expect(p.evidence.state).toBe('established');
    expect(p.signaturesSeen).toBe(2);
  });

  it('never invents a donor when the inflow cannot be attributed', async () => {
    // A fee refund raises the authority with nobody falling: the probe reports the funding event with
    // a null source rather than pointing at the largest balance-holder.
    const keys = [AUTH, DONOR, OTHER];
    const pre = keys.map(() => 1_000_000_000);
    const post = keys.map(() => 1_000_000_000);
    post[0] = pre[0]! + 5_000;
    const tx = {
      slot: 1,
      transaction: { message: { accountKeys: keys.map((k) => ({ pubkey: k, signer: false, source: 'transaction', writable: true })), instructions: [] }, signatures: [] },
      meta: { err: null, preBalances: pre, postBalances: post, preTokenBalances: [], postTokenBalances: [], innerInstructions: [], logMessages: [] },
      blockTime: Math.floor(NOW / 1000),
    } as never;
    const p = await run([sigsRoute([sig(1, 10)]), txRoute(tx)], { suspectAddresses: new Set([DONOR]) });
    expect(p.evidence.state).toBe('recent_funding_observed');
    expect(p.evidence.detail).toMatch(/unattributed sender/);
  });
});

describe('malice scoring over the funding states', () => {
  const base = (over: Partial<DangerInputs> = {}): DangerInputs => ({
    program: 'Pg11111111111111111111111111111111111111',
    authority: { posture: 'eoa', address: AUTH },
    delta: { confidence: 'structural', addedEntrypoints: [], undeclaredEntrypoints: [], accountChanges: [] },
    radius: { direct: 8, transitive: 20, lamportsRouted: 50_000_000, usdPerSol: null, mintsTouched: 0 },
    behavior: { priorDigestAt: null, stateFileUsed: true },
    integrity: null,
    timing: null,
    ...over,
  });
  const withFunding = (funding: FundingEvidence) => ({ funding, declaredThreshold: null, timelockDeclared: false, fundingProbe: { callsSpent: 2, signaturesSeen: 1 } });

  it('awards 30 only to funding evidence, never to an unverified or established authority', () => {
    const axis = (f: FundingEvidence) => scoreDanger(base({ integrity: withFunding(f) })).axes.find((a) => a.id === 'authorityIntegrity')!.points;
    expect(axis({ state: 'flagged_source', fromAddress: DONOR, detail: 'x' })).toBe(30);
    expect(axis({ state: 'recent_funding_observed', ageMs: 2 * HOUR, retentionBounded: false, detail: 'x' })).toBe(30);
    expect(axis({ state: 'recent_funding_observed', ageMs: 2 * HOUR, retentionBounded: true, detail: 'funded 2 hours ago but older history may exist' })).toBe(20);
    expect(axis({ state: 'established', detail: 'two years of signatures' })).toBe(20);
    expect(axis({ state: 'unverified', detail: 'the node refused' })).toBe(20);
  });

  it('records the refusal as an unassessed claim rather than a clean one', () => {
    const d = scoreDanger(base({ integrity: withFunding({ state: 'unverified', detail: 'getSignaturesForAddress refused' }) }));
    const a = d.axes.find((x) => x.id === 'authorityIntegrity')!;
    expect(a.points).toBe(20);
    expect(a.notAssessed.join(' ')).toMatch(/An unverified authority is not a verified one/);
  });
});
