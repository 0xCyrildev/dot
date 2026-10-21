import { afterAll, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { PublicKey } from '@solana/web3.js';
import { buildHypothesis, judgeHypothesis, loadHypothesisFile, priorAsk, renderHypothesis, type Hypothesis, type ReTestObservation } from '../src/agent/hypothesis.js';
import { DotError, isDotError } from '../src/errors.js';
import type { UpgradeContext } from '../src/agent/decision.js';
import type { BytecodeDiff } from '../src/state/bytecodeDiff.js';
import { Budget } from '../src/agent/budget.js';
import { RuleBasedDecision } from '../src/agent/rules.js';
import { SolanaClient } from '../src/rpc/client.js';
import { Scout } from '../src/agent/scout.js';
import { RealLlmDecision, type LlmConfig } from '../src/agent/llm.js';
import { EvidenceLedger } from '../src/agent/evidence.js';
import { renderMarkdown } from '../src/report.js';
import { FakeTransport, txFixture } from './helpers.js';

const AUTH = 'FnSCQX1CYdGkGgd7RSScZzVij7nfKhYK5VcjaAozv3d5';
const TARGET = '5PjDJaGfSPJj4tFzMRCiuuAasKg5n8dJKXKenhuwZexx';

const ctx = (over: Partial<UpgradeContext> = {}): UpgradeContext => ({
  program: TARGET,
  programData: 'PD',
  kind: 'upgrade',
  change: { bytecodeChanged: true, authorityChanged: false, sizeChanged: true, beforeBytes: 1_000_000, afterBytes: 1_000_000 },
  authority: { before: AUTH, after: AUTH, posture: 'eoa' },
  history: { signaturesAvailable: null, lastAnalysisAt: null, knownDependents: null, lamportsRoutedLast: null },
  idl: { available: false },
  ...over,
});

const diff = (over: Partial<BytecodeDiff>): BytecodeDiff => ({
  confidence: 'structural',
  anchor: { idlAvailable: true, reason: 'names supplied' },
  limits: [],
  ...over,
});

describe('hypothesis is derived from the trigger, not chosen from a menu', () => {
  const noDiff = diff({});

  it('an undeclared selector produces an exposure claim, not an authority claim', () => {
    const h = buildHypothesis({
      ctx: ctx(),
      wantedSignatures: 25,
      affordableSignatures: 3,
      bytecode: diff({
        instructions: {
          added: [],
          removed: [],
          persisting: [],
          persistingNote: '',
          undeclaredEntrypoints: [{ name: 'sweep', hex: 'aabbccddeeff0011', why: '' }],
          idlClaimedNotFound: [],
        },
      }),
    });
    expect(h.claimKind).toBe('new_entrypoint_exposure');
    expect(h.claim).toContain('does not declare');
    expect(h.evidenceFor.join(' ')).toContain('sweep');
    expect(h.falsifier).toContain('previous image');
    void noDiff;
  });

  it('a single-key authority with no code surface produces an authority claim', () => {
    const h = buildHypothesis({ ctx: ctx(), wantedSignatures: 25, affordableSignatures: 2, bytecode: noDiff });
    expect(h.claimKind).toBe('authority_risk');
    expect(h.claim).toContain('the key, not the code');
    expect(h.evidenceFor.join(' ')).toContain('single key');
    expect(h.testPlan.some((t) => t.action.includes('authority'))).toBe(true);
  });

  it('a removed instruction produces a breakage claim, which is an outage story not an attack story', () => {
    const h = buildHypothesis({
      ctx: ctx({ authority: { before: AUTH, after: AUTH, posture: 'multisig' } }),
      wantedSignatures: 25,
      affordableSignatures: 4,
      bytecode: diff({
        instructions: {
          added: [],
          removed: [{ name: 'withdraw', hex: 'b712469c946da122' }],
          persisting: [],
          persistingNote: '',
          undeclaredEntrypoints: [],
          idlClaimedNotFound: [],
        },
      }),
    });
    expect(h.claimKind).toBe('interface_breakage');
    expect(h.falsifier).toContain('dead-code cleanup');
  });

  it('a boring multisig upgrade is allowed to look routine, with a falsifier that can say otherwise', () => {
    const h = buildHypothesis({
      ctx: ctx({ authority: { before: 'M', after: 'M', posture: 'multisig' }, history: { signaturesAvailable: 500, lastAnalysisAt: 1, knownDependents: 0, lamportsRoutedLast: 0 } }),
      wantedSignatures: 25,
      affordableSignatures: 25,
      bytecode: noDiff,
    });
    expect(h.claimKind).toBe('routine_upgrade');
    expect(h.evidenceAgainst.join(' ')).toContain('multisig');
  });

  it('refuses to guess when there is nothing to say', () => {
    const h = buildHypothesis({
      ctx: ctx({ authority: { before: null, after: null, posture: 'renounced' } }),
      wantedSignatures: 25,
      affordableSignatures: 25,
      bytecode: diff({ confidence: 'bytecode_only', anchor: { idlAvailable: false, reason: 'no IDL' } }),
    });
    expect(h.claimKind).toBe('unknown_coverage');
    expect(h.claim).toContain('cannot form a claim');
    expect(h.falsifier).toContain('no claim to falsify');
  });

  it('every claim carries all five fields and a priced plan', () => {
    const h = buildHypothesis({ ctx: ctx(), wantedSignatures: 30, affordableSignatures: 5, bytecode: noDiff });
    expect(h.claim.length).toBeGreaterThan(20);
    expect(h.falsifier.length).toBeGreaterThan(20);
    expect(h.evidenceFor.length).toBeGreaterThan(0);
    expect(h.evidenceAgainst.length).toBeGreaterThan(0);
    expect(h.testPlan.length).toBeGreaterThan(0);
    expect(h.testPlan[0]!.requestedRpcCalls).toBe(25);
    expect(h.derivedFrom.posture).toBe('eoa');
    expect(renderHypothesis(h)).toMatch(/falsifier/i);
  });

  it('prices the ask so the escalation carries a number, not a mood', () => {
    const h = buildHypothesis({ ctx: ctx(), wantedSignatures: 30, affordableSignatures: 5, bytecode: noDiff });
    const ask = priorAsk(h);
    expect(ask.signatures).toBe(30);
    expect(ask.rpcCalls).toBe(h.testPlan.reduce((s, t) => s + t.requestedRpcCalls, 0));
    expect(ask.rpcCalls).toBeGreaterThan(0);
  });

  it('names the missing instruction-level view as evidence against its own claim', () => {
    const h = buildHypothesis({
      ctx: ctx(),
      wantedSignatures: 25,
      affordableSignatures: 1,
      bytecode: diff({ confidence: 'bytecode_only', anchor: { idlAvailable: false, reason: 'no IDL' } }),
    });
    expect(h.evidenceAgainst.join(' ')).toMatch(/bytecode_only|no instruction-level view/);
  });
});

describe('re-testing a carried hypothesis', () => {
  const obs = (over: Partial<ReTestObservation> = {}): ReTestObservation => ({
    signaturesPulled: 40,
    addedSelectorMatches: 0,
    removedSelectorMatches: 0,
    coControlled: 0,
    observed: { entrypointSurface: true, authorityHistory: true },
    ...over,
  });

  // A claim that asked for 40 traces; the re-test below either got them or did not.
  const prior = buildHypothesis({ ctx: ctx(), wantedSignatures: 40, affordableSignatures: 3, bytecode: diff({}) });
  const authority = buildHypothesis({ ctx: ctx(), wantedSignatures: 40, affordableSignatures: 2, bytecode: diff({}) });
  const exposure = buildHypothesis({
    ctx: ctx(),
    wantedSignatures: 40,
    affordableSignatures: 2,
    bytecode: diff({
      instructions: {
        added: [{ name: 'withdraw', hex: 'b712469c946da122', offsetsInNew: [12] }],
        removed: [],
        persisting: [],
        persistingNote: '',
        undeclaredEntrypoints: [],
        idlClaimedNotFound: [],
      },
    }),
  });

  it('refuses to judge when this run did not pull the sample the claim asked for', () => {
    expect(prior.claimKind).toBe('authority_risk');
    const o = judgeHypothesis(prior, obs({ signaturesPulled: 3 })).outcome!;
    expect(o.status).toBe('not_testable');
    expect(o.against).toContain('3 trace(s) against the 40');
  });

  it('refuses to infer an ask the carried claim never recorded', () => {
    const blind = { ...prior, derivedFrom: { posture: 'eoa' } } as Hypothesis;
    const o = judgeHypothesis(blind, obs({ signaturesPulled: 500 })).outcome!;
    expect(o.status).toBe('not_testable');
    expect(o.against).toMatch(/no sample size/);
  });

  it('confirms an authority-risk claim only when the widened sample actually found co-control', () => {
    const o = judgeHypothesis(authority, obs({ coControlled: 3 })).outcome!;
    expect(o.status).toBe('confirmed');
    expect(o.against).toContain('3 other program');
    expect(o.subject?.claimKind).toBe('authority_risk');
  });

  it('denies it when the authority history was sampled and showed only this program', () => {
    expect(judgeHypothesis(authority, obs({ coControlled: 0 })).outcome?.status).toBe('denied');
  });

  it('does not read an unsampled authority history as a denial', () => {
    // This is the lie the flag exists to stop: 0 co-controlled programs because Dot
    // never looked is not evidence that the key controls one program.
    const o = judgeHypothesis(authority, obs({ coControlled: 0, observed: { entrypointSurface: true, authorityHistory: false } })).outcome!;
    expect(o.status).toBe('not_testable');
    expect(o.against).toMatch(/never sampled the authority history/);
  });

  it('judges an exposure claim by whether real traffic already carries the new selector', () => {
    expect(exposure.claimKind).toBe('new_entrypoint_exposure');
    expect(judgeHypothesis(exposure, obs({ addedSelectorMatches: 2 })).outcome?.status).toBe('confirmed');
    expect(judgeHypothesis(exposure, obs({ addedSelectorMatches: 0 })).outcome?.status).toBe('denied');
  });

  it('does not judge a selector claim with no entrypoint view to match against', () => {
    const o = judgeHypothesis(exposure, obs({ addedSelectorMatches: 0, observed: { entrypointSurface: false, authorityHistory: false } })).outcome!;
    expect(o.status).toBe('not_testable');
    expect(o.against).toMatch(/no selector was ever looked for/);
  });

  it('lets a routine claim be denied by a selector the larger sample located', () => {
    const routine = buildHypothesis({
      ctx: ctx({ authority: { before: 'M', after: 'M', posture: 'multisig' } }),
      wantedSignatures: 40,
      affordableSignatures: 1,
      bytecode: diff({ confidence: 'bytecode_only', anchor: { idlAvailable: false, reason: 'no IDL' } }),
    });
    expect(routine.claimKind).toBe('routine_upgrade');
    expect(judgeHypothesis(routine, obs({ addedSelectorMatches: 1 })).outcome?.status).toBe('denied');
    expect(judgeHypothesis(routine, obs({ addedSelectorMatches: 0 })).outcome?.status).toBe('confirmed');
    expect(judgeHypothesis(routine, obs({ addedSelectorMatches: 0, observed: { entrypointSurface: false, authorityHistory: false } })).outcome?.status).toBe('not_testable');
  });
});

describe('the escalation carries the hypothesis end to end', () => {
  const accountRoute = () => ({
    match: (m: string) => m === 'getAccountInfo',
    result: {
      context: { slot: 1 },
      value: {
        lamports: 12_633_600,
        owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
        executable: false,
        data: [
          Buffer.concat([
            Buffer.from([3, 0, 0, 0]),
            (() => {
              const b = Buffer.alloc(8);
              b.writeBigUInt64LE(423_977_638n);
              return b;
            })(),
            Buffer.from([1]),
            new PublicKey(AUTH).toBuffer(),
            Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]),
          ]).toString('base64'),
          'base64',
        ],
      },
    },
  });

  const OTHER = '5TeWSsjg2gbxCyWVniXeCmwM7UtHTCK7svzJr5xYJzHf';

  /**
   * `thin` — the program's own history is 8 signatures deep and every trace calls TARGET.
   * `foreign` — a long history whose traces touch the authority and one other program but
   * never TARGET, which is what makes the widen path run.
   */
  async function runWithBudget(maxRpcCalls: number, maxSignatures: number, carry?: Hypothesis, scenario: 'thin' | 'foreign' = 'thin') {
    const foreign = txFixture('tx-depth3');
    foreign.transaction.message.instructions = [
      { programId: OTHER, accounts: [], data: 'x', stackHeight: 1 },
      { programId: AUTH, accounts: [], data: 'y', stackHeight: 1 },
    ];
    foreign.meta.innerInstructions = null;
    const transport = new FakeTransport([
      accountRoute(),
      {
        match: (m: string) => m === 'getSignaturesForAddress',
        resultFn: () =>
          Array.from({ length: scenario === 'foreign' ? 60 : 8 }, (_, i) => ({
            signature: `${scenario}${i}`,
            slot: 400 + i,
            err: null,
            blockTime: 1_760_000_000,
            confirmationStatus: 'finalized',
          })),
      },
      { match: (m: string) => m === 'getTransaction', result: scenario === 'foreign' ? foreign : txFixture('tx-depth3') },
    ]);
    const budget = new Budget({ maxRpcCalls, maxSignatures, maxLlmTokens: 0, maxWallMs: 600_000 });
    const scout = new Scout({
      client: new SolanaClient({ transport, budget, commitment: 'finalized' }),
      budget,
      decision: new RuleBasedDecision({}),
      mode: 'rules',
      ...(carry ? { carryHypothesis: carry } : {}),
    });
    return { report: await scout.run({ program: TARGET }), budget };
  }

  it('attaches a full hypothesis to the escalation and prints it in the report', async () => {
    const { report } = await runWithBudget(4, 4);
    const h = report.hypothesis;
    expect(h).toBeDefined();
    expect(h!.claimKind).toBe('authority_risk');
    expect(h!.falsifier.length).toBeGreaterThan(20);
    expect(h!.testPlan.length).toBeGreaterThan(0);
    expect(report.decision?.escalation).toBeDefined();
    const md = renderMarkdown(report);
    expect(md).toContain('## Hypothesis');
    expect(md).toContain('Falsifier.');
    expect(md).toContain('What more budget would test');
  });

  it('does not call an unaffordable sample a verdict', async () => {
    const carried = buildHypothesis({ ctx: ctx(), wantedSignatures: 40, affordableSignatures: 2, bytecode: diff({}) });
    const { report } = await runWithBudget(6, 6, carried);
    const o = report.hypothesis?.outcome;
    expect(o?.status).toBe('not_testable');
    expect(o?.against).toMatch(/against the 40/);
    expect(renderMarkdown(report)).toContain('Re-test outcome');
  });

  it('refuses to judge co-control it never sampled, even on a run that pulled the whole ask', async () => {
    // The funded version of the trap: the sample gate passes (8 of 8 traces), and a
    // naive re-test would read `coControlled = 0` as "this key controls one program".
    // The widen path declined on coverage grounds, so the only honest answer is
    // not_testable with the reason.
    const carried = buildHypothesis({ ctx: ctx(), wantedSignatures: 8, affordableSignatures: 2, bytecode: diff({}) });
    const { report } = await runWithBudget(300, 300, carried);
    const o = report.hypothesis?.outcome;
    expect(o?.status).toBe('not_testable');
    expect(o?.against).toMatch(/never sampled the authority history/);
    expect(o?.subject?.claimKind).toBe('authority_risk');
    expect(report.widenNote).toMatch(/widen skipped/);
    expect(report.evidence.some((e) => /prior hypothesis re-tested/.test(e.summary))).toBe(true);
  });

  it('settles a carried authority claim once the widen path has actually run', async () => {
    const carried = buildHypothesis({ ctx: ctx(), wantedSignatures: 8, affordableSignatures: 2, bytecode: diff({}) });
    const { report } = await runWithBudget(200, 200, carried, 'foreign');
    expect(report.coControlledPrograms).toContain(OTHER);
    const o = report.hypothesis?.outcome;
    expect(o?.status).toBe('confirmed');
    expect(o?.against).toMatch(/other program/);
    expect(o?.subject?.claim).toBe(carried.claim);
    expect(renderMarkdown(report)).toContain('carried claim');
  });
});

describe('the carried claim file is validated as input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dot-hyp-'));

  it('round-trips what --hypothesis-out writes', async () => {
    const h = buildHypothesis({ ctx: ctx(), wantedSignatures: 30, affordableSignatures: 5, bytecode: diff({}) });
    // The CLI writes `{ program, ...hypothesis }`; the loader must ignore the extra key,
    // not choke on it or trust it.
    const file = join(dir, 'carried.json');
    await writeFile(file, JSON.stringify({ program: TARGET, ...h }, null, 2));
    const back = await loadHypothesisFile(file);
    expect(back.claimKind).toBe(h.claimKind);
    expect(back.falsifier).toBe(h.falsifier);
    expect(back.derivedFrom.wanted_signatures).toBe(30);
    expect(back.testPlan).toEqual(h.testPlan);
    expect((back as Hypothesis & { program?: string }).program).toBeUndefined();
  });

  it('refuses a claim that is missing the field the re-test would have been judged against', async () => {
    const h = buildHypothesis({ ctx: ctx(), wantedSignatures: 30, affordableSignatures: 5, bytecode: diff({}) }) as Record<string, unknown>;
    delete h.falsifier;
    const file = join(dir, 'no-falsifier.json');
    await writeFile(file, JSON.stringify(h));
    const e = await loadHypothesisFile(file).catch((x) => x);
    expect(isDotError(e)).toBe(true);
    expect((e as DotError).code).toBe('BAD_HYPOTHESIS_FILE');
    expect(JSON.stringify((e as DotError).details)).toContain('falsifier');
  });

  it('refuses a file that is not there and a file that is not JSON', async () => {
    for (const [name, contents] of [['missing.json', null], ['junk.json', '{not json']] as Array<[string, string | null]>) {
      const p = join(dir, name);
      if (contents !== null) await writeFile(p, contents);
      const e = await loadHypothesisFile(p).catch((x) => x);
      expect(isDotError(e)).toBe(true);
      expect((e as DotError).code).toBe('BAD_HYPOTHESIS_FILE');
    }
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});

describe('a model-supplied hypothesis is subject to the same gate', () => {
  // The chat-completions payload, exactly as `complete()` reads it: choices[0].message.content
  // is a JSON string and the usage field is what settles the token reservation.
  const reply = (content: unknown) => ({
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 200, completion_tokens: 40 },
  });

  function harness(fetchImpl: typeof fetch) {
    const cfg: LlmConfig = { baseUrl: 'http://fake.test/v1', apiKey: 'sk-nope', model: 'm', maxOutputTokens: 200, fetchImpl };
    const budget = new Budget({ maxLlmTokens: 6000, maxRpcCalls: 50, maxSignatures: 50 });
    const ledger = new EvidenceLedger();
    const ev = ledger.add({ kind: 'posture', summary: 'authority=FnSC… posture=eoa' });
    return { cfg, budget, ledger, ev };
  }

  const fetchFor = (body: unknown) =>
    ((() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => body,
      })) as unknown as typeof fetch);

  it('accepts a cited hypothesis and turns it into an escalation', async () => {
    const h = harness(
      fetchFor(
        reply({
          proceed: true,
          confidence: 'high',
          rationale: 'single-key authority with an unreviewed new entrypoint',
          cites: ['EV-1'],
          planned_signatures: 20,
          hypothesis: {
            claim: 'the added withdraw entrypoint is reachable by at least one existing caller',
            falsifier: 'no transaction in a full sample carries the withdraw selector',
            evidence_for: ['selector located in the new image only'],
            evidence_against: ['sample was too small to test it'],
            test_plan: [
              { action: 'sample 20 transactions and match selectors', requested_rpc_calls: 18 },
              { action: 'look up the callers of the withdraw selector', requested_rpc_calls: 7 },
            ],
            cites: ['EV-1'],
          },
        }),
      ),
    );
    const d = await new RealLlmDecision(h.cfg, new RuleBasedDecision({}), h.budget).decide(ctx(), h.ledger);
    expect(d.rejected).toBeUndefined();
    expect(d.source).toBe('llm');
    expect(d.escalation?.kind).toBe('needs_more_budget');
    expect(d.escalation?.hypothesis?.claim).toContain('withdraw');
    expect(d.escalation?.hypothesis?.testPlan[0]?.requestedRpcCalls).toBe(18);
    // The escalation asks for the sum of the plan, which is what actually gets priced.
    expect(d.escalation?.requestedRpcCalls).toBe(25);
    // It records the model's own citation, so a later reader can see what it was allowed to point at.
    expect(d.escalation?.hypothesis?.derivedFrom.source).toBe('llm');
    expect(d.escalation?.hypothesis?.derivedFrom.cites).toBe('EV-1');
  });

  it('discards the hypothesis along with an answer that cites evidence that does not exist', async () => {
    const h = harness(
      fetchFor(
        reply({
          proceed: true,
          confidence: 'high',
          rationale: 'invented confidence',
          cites: ['EV-42'],
          hypothesis: {
            claim: 'a confident invented claim about the new entrypoint',
            falsifier: 'anything at all, apparently',
            evidence_for: ['nothing observed'],
            evidence_against: ['no fuller sample was affordable'],
            test_plan: [{ action: 'resample the authority history', requested_rpc_calls: 40 }],
            cites: ['EV-42'],
          },
        }),
      ),
    );
    const d = await new RealLlmDecision(h.cfg, new RuleBasedDecision({}), h.budget).decide(ctx(), h.ledger);
    expect(d.source).toBe('rules');
    expect(d.rejected?.reason).toMatch(/never issued/);
    // The invented hypothesis is gone with the answer that carried it — not trimmed, not kept
    // as a "suspicion". What survives is the rule engine's own escalation, priced by rules.
    expect(d.escalation?.hypothesis).toBeUndefined();
    expect(d.escalation?.kind).toBe('widen_to_authority');
    expect(d.escalation?.requestedRpcCalls ?? 0).toBeLessThan(40);
  });
});
