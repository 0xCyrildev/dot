import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { PublicKey } from '@solana/web3.js';
import { ChainVerifier, digest, transactionFingerprint } from '../src/rpc/verifier.js';
import { SolanaClient } from '../src/rpc/client.js';
import { Budget } from '../src/agent/budget.js';
import { Scout } from '../src/agent/scout.js';
import { RuleBasedDecision } from '../src/agent/rules.js';
import { renderMarkdown } from '../src/report.js';
import { FakeTransport, type FakeRoute, txFixture } from './helpers.js';
import type { WireGetTransactionResult } from '../src/rpc/wire.js';

const PROGRAM = '5PjDJaGfSPJj4tFzMRCiuuAasKg5n8dJKXKenhuwZexx';
const PROGRAM_DATA = '2QQrQARD1JhwC4jYg8zNBpescSDMQhZLEZ3xBDtsg4xw';
const AUTH = 'FnSCQX1CYdGkGgd7RSScZzVij7nfKhYK5VcjaAozv3d5';
const SIGS = ['sigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE1', 'sigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE2'];

const accountResult = (bytes: number[], slot: number) => ({
  context: { slot },
  value: {
    lamports: 12_633_600,
    owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
    executable: false,
    rentEpoch: null,
    space: bytes.length,
    data: [Buffer.from(bytes).toString('base64'), 'base64'],
  },
});

type Lie = {
  /** The bytes this endpoint claims the ProgramData holds. */
  pd?: number[];
  pdSlot?: number;
  prog?: number[];
  tx?: WireGetTransactionResult;
  /** null = the node has no copy of the transaction (pruned). */
  txNull?: boolean;
  statuses?: Array<{ slot: number; confirmations: number | null; err: unknown; confirmationStatus: string } | null>;
  dead?: boolean;
};

function routes(lie: Lie): FakeRoute[] {
  const tx = lie.tx ?? txFixture('tx-depth3');
  return [
    {
      match: (m, p) => m === 'getAccountInfo' && p[0] === PROGRAM_DATA,
      ...(lie.dead
        ? { error: { code: -32000, message: 'gone' } }
        : { result: accountResult(lie.pd ?? [3, 0, 0, 0, 0x7f, 0x45, 0x4c, 0x46], lie.pdSlot ?? 300) }),
    },
    {
      match: (m, p) => m === 'getAccountInfo' && p[0] === PROGRAM,
      ...(lie.dead ? { error: { code: -32000, message: 'gone' } } : { result: accountResult(lie.prog ?? [1, 0, 0, 0, 9], 300) }),
    },
    {
      match: (m) => m === 'getTransaction',
      ...(lie.dead ? { error: { code: -32000, message: 'gone' } } : lie.txNull ? { result: null } : { result: tx }),
    },
    {
      match: (m) => m === 'getSignatureStatuses',
      result: { value: lie.statuses ?? SIGS.map(() => ({ slot: 290, confirmations: null, err: null, confirmationStatus: 'finalized' })) },
    },
  ];
}

function mk(lies: Lie[], limits: { maxRpcCalls?: number } = {}) {
  const endpoints = lies.map((lie, i) => {
    const transport = new FakeTransport(routes(lie));
    const budget = new Budget({ maxRpcCalls: limits.maxRpcCalls ?? 100, maxSignatures: 100, maxLlmTokens: 0, maxWallMs: 600_000 });
    const client = new SolanaClient({ transport, budget, commitment: 'finalized' });
    return { client, url: `https://endpo${i}.test/rpc`, transport, budget };
  });
  const verifier = new ChainVerifier(
    endpoints.map((e) => ({ client: e.client, url: e.url })),
    endpoints[0]!.budget,
    { sample: 2 },
  );
  return { verifier, endpoints };
}

const check = (v: { checks: Array<{ name: string; passed: boolean; coverage: string; detail: string }> }, name: string) =>
  v.checks.find((c) => c.name === name)!;

describe('chain verification is two endpoints agreeing, and says so when they cannot', () => {
  it('passes every check when two endpoints describe the same chain', async () => {
    const { verifier } = mk([{}, {}]);
    const v = await verifier.verify({ program: PROGRAM, programData: PROGRAM_DATA, signatures: SIGS });
    expect(v.verified).toBe(true);
    expect(v.reason).toBeNull();
    expect(v.slot).toBe(300);
    expect(v.checks.map((c) => c.name)).toEqual(['programdata_bytes', 'program_pointer', 'transaction_roundtrip', 'signature_finality']);
    expect(v.checks.every((c) => c.passed && c.coverage === 'corroborated')).toBe(true);
    expect(v.sampledSignatures).toBe(2);
    // The flag travels with its own limit, so a reader cannot lift it out of context.
    expect(v.cannotProve).toMatch(/inclusion proof/);
    expect(v.cannotProve).toMatch(/provider/);
    // The measured reason the account checks come back inconclusive against public nodes.
    expect(v.cannotProve).toMatch(/minContextSlot/);
  });

  it('is false, and says which check contradicted, when the second endpoint lies about the bytes', async () => {
    const { verifier } = mk([{}, { pd: [3, 0, 0, 0, 0x7f, 0x45, 0x4c, 0x99] }]);
    const v = await verifier.verify({ program: PROGRAM, programData: PROGRAM_DATA, signatures: SIGS });
    expect(v.verified).toBe(false);
    expect(check(v, 'programdata_bytes').passed).toBe(false);
    expect(check(v, 'programdata_bytes').coverage).toBe('corroborated');
    expect(check(v, 'programdata_bytes').detail).toMatch(/CONTRADICTION/);
    expect(v.reason).toContain('programdata_bytes');
    // The other checks are unaffected: a lie about one account is not a lie about all data,
    // and flattening them into one verdict would hide which one to go and question.
    expect(check(v, 'transaction_roundtrip').passed).toBe(true);
  });

  it('reads a differing slot as chain progress, not as a contradiction', async () => {
    const { verifier } = mk([{}, { pdSlot: 341 }]);
    const v = await verifier.verify({ program: PROGRAM, programData: PROGRAM_DATA, signatures: SIGS });
    expect(check(v, 'programdata_bytes').detail).toMatch(/different slots/);
    // The distinction is the whole point: "we could not compare" and "they disagree about
    // the same slot" lead a reviewer to completely different actions.
    expect(check(v, 'programdata_bytes').verdict).toBe('inconclusive');
    expect(check(v, 'programdata_bytes').passed).toBe(false);
    expect(v.reason).not.toMatch(/contradict each other/);
    expect(v.reason).toMatch(/absence of a contradiction is not agreement/);
    expect(v.verified).toBe(false);
  });

  it('spends nothing and refuses when there is no second source to ask', async () => {
    const { verifier, endpoints } = mk([{}]);
    const v = await verifier.verify({ program: PROGRAM, programData: PROGRAM_DATA, signatures: SIGS });
    expect(v.verified).toBe(false);
    expect(v.reason).toMatch(/second source/);
    expect(v.checks).toHaveLength(0);
    expect(endpoints[0]!.transport.calls).toHaveLength(0);
  });

  it('refuses on price before spending, rather than half-verifying', async () => {
    const { verifier, endpoints } = mk([{}, {}], { maxRpcCalls: 4 });
    const v = await verifier.verify({ program: PROGRAM, programData: PROGRAM_DATA, signatures: SIGS });
    expect(v.verified).toBe(false);
    expect(v.reason).toMatch(/refused/);
    // The primary budget is the one checked; it must not have been touched by a refusal.
    expect(endpoints[0]!.transport.calls).toHaveLength(0);
  });

  it('reports single_source rather than agreement when one endpoint is unreachable', async () => {
    const { verifier } = mk([{}, { dead: true }]);
    const v = await verifier.verify({ program: PROGRAM, programData: PROGRAM_DATA, signatures: SIGS });
    expect(v.verified).toBe(false);
    expect(check(v, 'programdata_bytes').coverage).toBe('single_source');
    expect(v.reason).toMatch(/not every check had two sources/);
  });

  it('treats a pruned transaction as the absence of corroboration, not as agreement', async () => {
    const { verifier } = mk([{}, { txNull: true }]);
    const v = await verifier.verify({ program: PROGRAM, programData: PROGRAM_DATA, signatures: SIGS });
    const c = check(v, 'transaction_roundtrip');
    expect(c.passed).toBe(false);
    expect(c.verdict).toBe('inconclusive');
    expect(c.detail).toMatch(/pruned or refused history is not corroboration/);
    expect(v.verified).toBe(false);
  });

  it('catches a lie about balances, because the value proxy is built from them', async () => {
    const tampered = structuredClone(txFixture('tx-depth3'));
    tampered.meta!.postBalances = tampered.meta!.postBalances.map((b: number, i: number) => (i === 0 ? b + 1_000_000 : b));
    const { verifier } = mk([{}, { tx: tampered }]);
    const v = await verifier.verify({ program: PROGRAM, programData: PROGRAM_DATA, signatures: SIGS });
    expect(check(v, 'transaction_roundtrip').verdict).toBe('contradict');
    expect(v.reason).toMatch(/contradict each other about the same slot on: transaction_roundtrip/);
    expect(transactionFingerprint(tampered).hex).not.toBe(transactionFingerprint(txFixture('tx-depth3')).hex);
  });

  it('does not call a differently-truncated log a contradiction', async () => {
    const truncated = structuredClone(txFixture('tx-depth3'));
    truncated.meta!.logMessages = (truncated.meta!.logMessages ?? []).slice(0, 1);
    expect(transactionFingerprint(truncated).hex).toBe(transactionFingerprint(txFixture('tx-depth3')).hex);
    const { verifier } = mk([{}, { tx: truncated }]);
    const v = await verifier.verify({ program: PROGRAM, programData: PROGRAM_DATA, signatures: SIGS });
    expect(check(v, 'transaction_roundtrip').passed).toBe(true);
  });

  it('is insensitive to JSON key order, which is not part of the value', () => {
    expect(digest({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(digest({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });

  it('calls a provider retention gap a gap, not a contradiction', async () => {
    // Measured live on 2026-10-21: two providers answered getSignatureStatuses for the same
    // sample and one of them did not know one signature at all. "One node cannot see it"
    // and "two nodes disagree about it" lead to opposite actions, so they must not share a
    // verdict word.
    const half: Lie['statuses'] = [{ slot: 290, confirmations: null, err: null, confirmationStatus: 'finalized' }, null];
    const { verifier } = mk([{}, { statuses: half as never }]);
    const v = await verifier.verify({ program: PROGRAM, programData: PROGRAM_DATA, signatures: SIGS });
    const c = check(v, 'signature_finality');
    expect(c.verdict).toBe('inconclusive');
    expect(c.detail).toMatch(/not visible to at least one endpoint/);
    expect(v.verified).toBe(false);
  });

  it('calls a same-signature disagreement about finality a contradiction', async () => {
    const other: Lie['statuses'] = [
      { slot: 290, confirmations: null, err: null, confirmationStatus: 'finalized' },
      { slot: 291, confirmations: null, err: null, confirmationStatus: 'confirmed' },
    ];
    const { verifier } = mk([{}, { statuses: other }]);
    const v = await verifier.verify({ program: PROGRAM, programData: PROGRAM_DATA, signatures: SIGS });
    expect(check(v, 'signature_finality').verdict).toBe('contradict');
    expect(v.reason).toMatch(/signature_finality/);
  });

  it('names the absence of a sample instead of inventing a check', async () => {
    const { verifier } = mk([{}, {}]);
    const v = await verifier.verify({ program: PROGRAM, programData: PROGRAM_DATA, signatures: [] });
    expect(check(v, 'transaction_roundtrip').coverage).toBe('unavailable');
    expect(check(v, 'transaction_roundtrip').detail).toMatch(/built no edges/);
    expect(v.verified).toBe(false);
  });
});

describe('the report carries chain_verified', () => {
  /** A ProgramData body the decoder accepts: disc 3, data_len, a slot flag, authority, ELF. */
  const programDataBytes = () => [
    3, 0, 0, 0,
    ...(() => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(423_977_638n);
      return [...b];
    })(),
    1,
    ...new PublicKey(AUTH).toBuffer(),
    0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4,
  ];

  /** One route table, used by both endpoints: identical answers are the point. */
  function sharedRoutes(): FakeRoute[] {
    return [
      { match: (m) => m === 'getAccountInfo', resultFn: () => accountResult(programDataBytes(), 300) },
      {
        match: (m) => m === 'getSignaturesForAddress',
        resultFn: () => Array.from({ length: 8 }, (_, i) => ({ signature: SIGS[i % 2]! + i, slot: 290 + i, err: null, blockTime: 1_760_000_000, confirmationStatus: 'finalized' })),
      },
      { match: (m) => m === 'getTransaction', result: txFixture('tx-depth3') },
      {
        match: (m) => m === 'getSignatureStatuses',
        // One answer per sampled slot; the verifier indexes by position, so eight covers
        // any sample this test can produce.
        result: {
          value: Array.from({ length: 8 }, () => ({ slot: 290, confirmations: null, err: null, confirmationStatus: 'finalized' })),
        },
      },
    ];
  }

  it('runs the cross-check after the sample and prints what it found', async () => {
    const budget = new Budget({ maxRpcCalls: 300, maxSignatures: 300, maxLlmTokens: 0, maxWallMs: 600_000 });
    const transport = new FakeTransport(sharedRoutes());
    const client = new SolanaClient({ transport, budget, commitment: 'finalized' });
    const secondBudget = new Budget({ maxRpcCalls: 300, maxSignatures: 300, maxLlmTokens: 0, maxWallMs: 600_000 });
    const secondTransport = new FakeTransport(sharedRoutes());
    const second = new SolanaClient({ transport: secondTransport, budget: secondBudget, commitment: 'finalized' });
    const verifier = new ChainVerifier(
      [
        { client, url: 'https://one.test/rpc' },
        { client: second, url: 'https://two.test/rpc?api_key=secret' },
      ],
      budget,
      { sample: 2 },
    );

    const scout = new Scout({
      client,
      budget,
      decision: new RuleBasedDecision({}),
      mode: 'rules',
      verify: (a) => verifier.verify(a),
    });
    const report = await scout.run({ program: PROGRAM });

    expect(report.chainVerified).toBeDefined();
    expect(report.chainVerified!.reason).toBeNull();
    expect(report.chainVerified!.verified).toBe(true);
    // The key in the query string must not reach the report.
    expect(report.chainVerified!.endpoints).toEqual(['https://one.test/rpc', 'https://two.test/rpc?<redacted>']);
    expect(report.evidence.some((e) => /chain_verified=true/.test(e.summary))).toBe(true);
    expect(report.stages.filter((s) => s.stage === 'verify')).toHaveLength(1);
    // The second endpoint is asked after the sample, not before: verification of a run that
    // never produced an edge would spend calls on nothing.
    const order = report.stages.map((s) => s.stage);
    expect(order.indexOf('act')).toBeLessThan(order.indexOf('verify'));

    const md = renderMarkdown(report);
    expect(md).toContain('## Chain verification');
    expect(md).toContain('chain_verified: true');
    expect(md).toContain('inclusion proof');
    expect(md).toContain('## Run stages');
    expect(md).not.toMatch(/secret/);
  });

  it('says so in the report when the second endpoint contradicts the first', async () => {
    const budget = new Budget({ maxRpcCalls: 300, maxSignatures: 300, maxLlmTokens: 0, maxWallMs: 600_000 });
    const transport = new FakeTransport(sharedRoutes());
    const client = new SolanaClient({ transport, budget, commitment: 'finalized' });
    const lying = new FakeTransport([
      ...sharedRoutes().filter((r) => !r.match('getAccountInfo', [PROGRAM_DATA, {}])),
      { match: (m) => m === 'getAccountInfo', resultFn: () => accountResult([3, 0, 0, 0, 0x7f, 0x45, 0x4c, 0x99], 300) },
    ]);
    const second = new SolanaClient({ transport: lying, budget: new Budget({ maxRpcCalls: 300, maxSignatures: 300, maxLlmTokens: 0, maxWallMs: 600_000 }), commitment: 'finalized' });
    const verifier = new ChainVerifier(
      [
        { client, url: 'https://one.test/rpc' },
        { client: second, url: 'https://two.test/rpc' },
      ],
      budget,
      { sample: 2 },
    );
    const report = await new Scout({ client, budget, decision: new RuleBasedDecision({}), mode: 'rules', verify: (a) => verifier.verify(a) }).run({ program: PROGRAM });
    expect(report.chainVerified!.verified).toBe(false);
    const md = renderMarkdown(report);
    expect(md).toMatch(/chain_verified: false/);
    expect(md).toMatch(/contradict|inconclusive/);
    // Whichever it is, the reader is told which check to go and question.
    expect(md).toMatch(/programdata_bytes|program_pointer/);
  });
});
