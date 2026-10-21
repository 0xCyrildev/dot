import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { DotError } from '../errors.js';
import type { UpgradeContext } from './decision.js';
import type { BytecodeDiff } from '../state/bytecodeDiff.js';

/**
 * The ask, written as a claim that could be wrong.
 *
 * `needs_more_budget` on its own is a complaint: "I ran out of calls". The useful
 * version is a hypothesis with a stated falsifier, because that converts an
 * unfinished run into a reviewable scientific claim — and because a claim that can be
 * re-tested later lets the next, better-funded run answer the question
 * `"was the earlier suspicion right?"` instead of starting from zero.
 *
 * Five fields, all derived from observed signals rather than chosen from a menu:
 * `claim`, `evidenceFor`, `evidenceAgainst`, `testPlan` (what the extra budget buys,
 * with the cost of each step), and `falsifier` — the single observation that would
 * knock the claim down. A hypothesis without a falsifier is a vibe, and this module
 * refuses to emit one: it degrades to `claimKind: "unknown_coverage"` and says the
 * claim is only about Dot's own visibility.
 *
 * The rule engine produces these deterministically. The model may produce the same
 * shape, and if it does it must cite evidence ids or the rules version stands.
 */

export type ClaimKind =
  | 'new_entrypoint_exposure'
  | 'interface_breakage'
  | 'authority_risk'
  | 'routine_upgrade'
  | 'unknown_coverage';

export type TestStep = {
  action: string;
  /** Signatures/reads the step needs, so the ask has a price attached. */
  requestedRpcCalls: number;
  /** What this step decides if it comes back positive. */
  outcomeIfPositive: string;
};

export type Hypothesis = {
  claimKind: ClaimKind;
  claim: string;
  evidenceFor: string[];
  evidenceAgainst: string[];
  testPlan: TestStep[];
  falsifier: string;
  /** The signals the claim was built from, so a reviewer can re-derive it. */
  derivedFrom: Record<string, string | number | boolean | null>;
  /** Set when the claim was carried from a previous run and re-tested. */
  outcome?: {
    status: 'confirmed' | 'denied' | 'not_testable';
    against: string;
    at: string;
    /** The claim this verdict is about — not necessarily the one printed next to it. */
    subject?: { claimKind: ClaimKind; claim: string };
  };
};

export type HypothesisInputs = {
  ctx: UpgradeContext;
  wantedSignatures: number;
  affordableSignatures: number;
  bytecode?: BytecodeDiff | null;
  /** Other programs the same upgrade authority was seen touching, if the widen path ran. */
  coControlled?: string[];
  /** Direct dependents counted in this run, when any were counted. */
  directDependents?: number | null;
};

const addedEntrypoints = (d?: BytecodeDiff | null) => d?.instructions?.added ?? [];
const removedEntrypoints = (d?: BytecodeDiff | null) => d?.instructions?.removed ?? [];
const undeclared = (d?: BytecodeDiff | null) => d?.instructions?.undeclaredEntrypoints ?? [];

export function buildHypothesis(i: HypothesisInputs): Hypothesis {
  const { ctx } = i;
  const added = addedEntrypoints(i.bytecode);
  const removed = removedEntrypoints(i.bytecode);
  const undeclaredEntrypoints = undeclared(i.bytecode);
  const diffConfidence = i.bytecode?.confidence ?? 'absent';
  const posture = ctx.authority.posture;
  const rotated = ctx.change.authorityChanged;
  const direct = i.directDependents ?? null;
  const price = Math.max(1, i.wantedSignatures - i.affordableSignatures);

  const derivedFrom = {
    posture,
    authority_rotated: rotated,
    bytecode_confidence: diffConfidence,
    entrypoints_added: added.length,
    entrypoints_removed: removed.length,
    undeclared_entrypoints: undeclaredEntrypoints.length,
    direct_dependents: direct,
    co_controlled: i.coControlled?.length ?? null,
    wanted_signatures: i.wantedSignatures,
    affordable_signatures: i.affordableSignatures,
  };

  const evidenceFor: string[] = [];
  const evidenceAgainst: string[] = [];

  if (undeclaredEntrypoints.length > 0) {
    evidenceFor.push(
      `${undeclaredEntrypoints.length} selector(s) reachable in the new image but absent from the new IDL (${undeclaredEntrypoints.map((u) => u.name).join(', ')})`,
    );
  }
  if (added.length > 0) evidenceFor.push(`bytecode diff located ${added.length} new entr(y|ies)point(s): ${added.map((a) => a.name).join(', ')}`);
  if (removed.length > 0) evidenceFor.push(`bytecode diff shows ${removed.length} entrypoint(s) gone: ${removed.map((r) => r.name).join(', ')}`);
  if (rotated) evidenceFor.push('the upgrade authority changed hands in this same event');
  if (posture === 'eoa') evidenceFor.push('a single key can sign the next replacement with no threshold and no delay');
  if (posture === 'program_derived') evidenceFor.push('the authority is a PDA gated by code Dot has not reviewed');
  if (posture === 'unknown') evidenceFor.push('the authority could not be classified, so no governance assumption is justified either way');
  if ((direct ?? 0) > 0) evidenceFor.push(`${direct} attributed direct caller(s) observed in this sample`);
  if ((i.coControlled?.length ?? 0) > 0) evidenceFor.push(`the same authority also appears with ${i.coControlled!.length} other program(s)`);

  if (diffConfidence === 'bytecode_only' || diffConfidence === 'absent') {
    evidenceAgainst.push(
      'no instruction-level view: the bytecode diff is bytecode_only or absent, so nothing here distinguishes a new entrypoint from a recompiled constant',
    );
  }
  if (diffConfidence === 'partial') evidenceAgainst.push('no prior image: "new" may mean "first time Dot looked"');
  if (posture === 'multisig') evidenceAgainst.push('authority is a declared multisig, which raises the bar for unilateral action');
  if (posture === 'renounced') evidenceAgainst.push('authority is renounced: this is likely the last upgrade the program will ever see');
  if (direct === 0) evidenceAgainst.push('no dependents were attributed in this sample — but that is what a thin sample always looks like');
  if (i.wantedSignatures > i.affordableSignatures) {
    evidenceAgainst.push(`the sample Dot could afford (${i.affordableSignatures}) is below the ${i.wantedSignatures} its own risk rule asked for`);
  }

  // Highest-signal trigger wins. Undeclared entrypoints outrank a merely added one
  // because the published interface actively fails to describe what is reachable.
  if (undeclaredEntrypoints.length > 0) {
    return {
      claimKind: 'new_entrypoint_exposure',
      claim: `the new image exposes ${undeclaredEntrypoints.length} entr(y|ies)point(s) the published interface does not declare, so callers and auditors are reasoning about a smaller attack surface than the program actually has`,
      evidenceFor,
      evidenceAgainst,
      testPlan: [
        {
          action: `pull a larger trace sample and check whether any observed call carries the undeclared selector (${undeclaredEntrypoints.map((u) => u.hex).join(', ')})`,
          requestedRpcCalls: price,
          outcomeIfPositive: 'a caller is already reaching an entrypoint nobody documented — escalate to those integrators, not just the program owner',
        },
        {
          action: 'fetch the prior image from Dot vault and re-run the selector scan against it',
          requestedRpcCalls: 0,
          outcomeIfPositive: 'the undeclared selector is new in this upgrade rather than long-standing',
        },
      ],
      falsifier:
        'if the selector also appears in the previous image and in older traces, it is not newly exposed — the interface was always incomplete and this is a documentation gap, not an upgrade risk',
      derivedFrom,
    };
  }

  if (added.length > 0) {
    return {
      claimKind: 'new_entrypoint_exposure',
      claim: `the upgrade added ${added.map((a) => `\`${a.name}\``).join(', ')}; whether that is exploitable depends on accounts it accepts and who can already reach it`,
      evidenceFor,
      evidenceAgainst,
      testPlan: [
        {
          action: `sample ${i.wantedSignatures} transactions and test whether any caller sends the new selector(s) ${added.map((a) => a.hex).join(', ')}`,
          requestedRpcCalls: price,
          outcomeIfPositive: 'live traffic already uses the new path, so a flaw in it is reachable today',
        },
        {
          action: 'compare the account requirements of the new entrypoint against handlers with the same shape in the prior IDL',
          requestedRpcCalls: 0,
          outcomeIfPositive: 'the new entrypoint accepts a writable non-signer account, the shape behind a class of Solana findings',
        },
      ],
      falsifier:
        'if no transaction in a full sample sends the new selector, the path is currently unreachable in practice and this is a review-later item, not an active exposure',
      derivedFrom,
    };
  }

  if (removed.length > 0) {
    return {
      claimKind: 'interface_breakage',
      claim: `the upgrade removed ${removed.map((r) => `\`${r.name}\``).join(', ')}; any integrator still encoding those selectors now fails, which looks like an outage rather than an attack`,
      evidenceFor,
      evidenceAgainst,
      testPlan: [
        {
          action: 'sample transactions to find callers still sending the removed selectors and count how many fail',
          requestedRpcCalls: price,
          outcomeIfPositive: 'a dependent is actively breaking right now and its operator is the one to notify',
        },
      ],
      falsifier: 'if no caller sends the removed selector, the removal is dead-code cleanup with no blast radius',
      derivedFrom,
    };
  }

  if (posture === 'eoa' || posture === 'unknown' || rotated) {
    return {
      claimKind: 'authority_risk',
      claim: `the exposure here is the key, not the code: ${rotated ? 'the upgrade authority changed hands and ' : ''}${posture === 'eoa' ? 'one signature can replace the program' : 'the governance path cannot be classified from chain data'}`,
      evidenceFor,
      evidenceAgainst,
      testPlan: [
        {
          action: 'widen the sample to the authority’s own transaction history to enumerate what else that key controls',
          requestedRpcCalls: Math.max(price, 10),
          outcomeIfPositive: `${(i.coControlled?.length ?? 0) > 0 ? `the key already reaches ${i.coControlled!.length} other program(s);` : 'the key reaches more programs than this one;'} compromise is a multi-protocol event, not a single-program one`,
        },
        {
          action: 'check whether this authority signed upgrades for the same programs in the previous epoch (habit vs anomaly)',
          requestedRpcCalls: Math.max(price, 10),
          outcomeIfPositive: 'the cadence is habitual, which weakens the anomaly claim and strengthens the routine one',
        },
      ],
      falsifier:
        'if the widened sample shows this authority signing upgrades for this program and no other program\'s ProgramData in the window, the blast radius is one program — the multi-protocol reading is denied',
      derivedFrom,
    };
  }

  if (posture === 'multisig' && removed.length === 0 && added.length === 0) {
    return {
      claimKind: 'routine_upgrade',
      claim: 'this looks like a routine maintenance release: threshold-held authority and no change to the entrypoint surface',
      evidenceFor,
      evidenceAgainst,
      testPlan: [
        {
          action: 'confirm the entrypoint surface over a larger sample, since a bytecode_only diff cannot distinguish a recompiled constant from a real change',
          requestedRpcCalls: price,
          outcomeIfPositive: 'nothing new: the routine claim holds and the event can be closed',
        },
      ],
      falsifier: 'any newly located selector, or a dependent set that grows with the larger sample, contradicts the routine reading',
      derivedFrom,
    };
  }

  return {
    claimKind: 'unknown_coverage',
    claim: 'Dot cannot form a claim here, and says so rather than picking a plausible one: the signals available are too thin to separate routine from anomalous',
    evidenceFor,
    evidenceAgainst,
    testPlan: [
      {
        action: 're-run with a budget that affords the sample the risk rule asked for, and with an IDL pair so the selector scan has names to work from',
        requestedRpcCalls: price,
        outcomeIfPositive: 'a claim becomes possible at all; this run could not make one',
      },
    ],
    falsifier: 'not applicable — there is no claim to falsify, only missing coverage',
    derivedFrom,
  };
}

/**
 * What the carried hypothesis needs before its claim can be judged at all.
 *
 * This is checked rather than assumed because the failure mode is silent and flattering
 * to Dot: a run that pulled 3 traces "re-tests" a claim that asked for 40, prints
 * `denied`, and a reader takes that for an answer. And when the carried claim records no
 * sample size at all, the honest answer is `not_testable` — Dot will not infer an ask
 * from the calls it happened to spend.
 */
export function priorAsk(h: Hypothesis): { signatures: number | null; rpcCalls: number } {
  const w = h.derivedFrom['wanted_signatures'];
  return {
    signatures: typeof w === 'number' && w > 0 ? w : null,
    rpcCalls: h.testPlan.reduce((s, t) => s + t.requestedRpcCalls, 0),
  };
}

export type ReTestObservation = {
  /** Signatures this run actually pulled. */
  signaturesPulled: number;
  /** Observed calls carrying a selector the diff located as newly added. */
  addedSelectorMatches: number;
  /** Observed calls carrying a selector the diff located as removed. */
  removedSelectorMatches: number;
  /** Other programs the same authority was seen touching in this run. */
  coControlled: number;
  /**
   * Whether this run took the observation each claim depends on. A count of 0 from a
   * check that never ran is not evidence of absence, and without this flag the re-test
   * would read `denied` for what is really "Dot did not look".
   */
  observed: { entrypointSurface: boolean; authorityHistory: boolean };
};

/**
 * Did a later, better-funded run settle the earlier claim?
 *
 * The judgement is made from the observation the falsifier names — otherwise the
 * falsifier is decoration and the `denied` answers a different question than the `claim`
 * asked. Claims Dot has no settling observation for come back `not_testable` with the
 * reason, never as a silent `denied`.
 */
export function judgeHypothesis(h: Hypothesis, now: ReTestObservation): Hypothesis {
  const at = new Date().toISOString();
  const subject = { claimKind: h.claimKind, claim: h.claim };
  const finish = (status: 'confirmed' | 'denied' | 'not_testable', against: string): Hypothesis => ({
    ...h,
    outcome: { status, against, at, subject },
  });

  const ask = priorAsk(h);
  if (ask.signatures === null) {
    return finish('not_testable', 'not re-tested — the carried claim records no sample size, and Dot will not infer one from the calls it happened to spend');
  }
  if (now.signaturesPulled < ask.signatures) {
    return finish('not_testable', `this run pulled ${now.signaturesPulled} trace(s) against the ${ask.signatures} the claim asked for, so the sample cannot settle it`);
  }

  if (h.claimKind === 'new_entrypoint_exposure' || h.claimKind === 'interface_breakage') {
    if (!now.observed.entrypointSurface) {
      return finish('not_testable', 'this run had no entrypoint view, so no selector was ever looked for — an empty match list here says nothing about callers');
    }
  }

  if (h.claimKind === 'new_entrypoint_exposure') {
    return now.addedSelectorMatches > 0
      ? finish('confirmed', `${now.addedSelectorMatches} observed call(s) already carry the new/undeclared selector`)
      : finish('denied', `no call in a ${now.signaturesPulled}-trace sample carries the new selector`);
  }
  if (h.claimKind === 'interface_breakage') {
    return now.removedSelectorMatches > 0
      ? finish('confirmed', `${now.removedSelectorMatches} observed call(s) still send a removed selector — a dependent is failing now`)
      : finish('denied', 'no caller in a full sample sends the removed selector: dead-code cleanup, no blast radius');
  }
  if (h.claimKind === 'authority_risk') {
    if (!now.observed.authorityHistory) {
      return finish('not_testable', 'this run never sampled the authority history, so it holds no observation about co-control — an empty co-control list here is a coverage gap, not a denial');
    }
    return now.coControlled > 0
      ? finish('confirmed', `${now.coControlled} other program(s) reached by the same authority in a ${now.signaturesPulled}-trace sample`)
      : finish('denied', `the widened sample shows this authority on ${now.signaturesPulled} trace(s) with no other program — blast radius is this program`);
  }
  if (h.claimKind === 'routine_upgrade') {
    if (!now.observed.entrypointSurface) {
      return finish('not_testable', 'this run had no entrypoint view, so "nothing new appeared" is about Dot\'s visibility rather than the program');
    }
    return now.addedSelectorMatches > 0
      ? finish('denied', `the larger sample located ${now.addedSelectorMatches} new selector(s): not routine after all`)
      : finish('confirmed', `nothing new appeared across ${now.signaturesPulled} trace(s) with an entrypoint view — the routine reading holds for this window, which is not a claim about the code`);
  }
  return finish('not_testable', 'this run made no claim, so there was nothing to settle');
}

export function renderHypothesis(h: Hypothesis, indent = ''): string {
  const L: string[] = [];
  L.push(`${indent}Hypothesis [${h.claimKind}]: ${h.claim}`);
  L.push(`${indent}  for:`);
  for (const e of h.evidenceFor) L.push(`${indent}    + ${e}`);
  L.push(`${indent}  against:`);
  for (const e of h.evidenceAgainst) L.push(`${indent}    - ${e}`);
  L.push(`${indent}  would test:`);
  for (const t of h.testPlan) L.push(`${indent}    * (${t.requestedRpcCalls} RPC) ${t.action} → ${t.outcomeIfPositive}`);
  L.push(`${indent}  falsifier: ${h.falsifier}`);
  if (h.outcome) L.push(`${indent}  OUTCOME of the carried claim [${h.outcome.subject?.claimKind ?? '?'}]: ${h.outcome.status} — ${h.outcome.against}`);
  return L.join('\n');
}

/**
 * A carried claim is input, so it is validated as input.
 *
 * The five fields are required because a re-test is only meaningful if the ask was
 * written down: `--hypothesis-file` accepting a half-stated claim would let a run print a
 * verdict against a falsifier nobody wrote. Anything malformed is refused with the field
 * names, not silently repaired.
 */
export const HypothesisSchema = z.object({
  claimKind: z.enum(['new_entrypoint_exposure', 'interface_breakage', 'authority_risk', 'routine_upgrade', 'unknown_coverage']),
  claim: z.string().min(12),
  evidenceFor: z.array(z.string()).min(1),
  evidenceAgainst: z.array(z.string()),
  testPlan: z
    .array(z.object({ action: z.string().min(8), requestedRpcCalls: z.number().int().min(0).max(100_000), outcomeIfPositive: z.string().min(4) }))
    .min(1),
  falsifier: z.string().min(12),
  derivedFrom: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  outcome: z
    .object({
      status: z.enum(['confirmed', 'denied', 'not_testable']),
      against: z.string(),
      at: z.string(),
      subject: z.object({ claimKind: z.string(), claim: z.string() }).optional(),
    })
    .optional(),
});

export function parseHypothesis(raw: unknown, from: string): Hypothesis {
  const parsed = HypothesisSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new DotError('BAD_HYPOTHESIS_FILE', `${from} is not a complete hypothesis — a carried claim needs all five fields`, { fields });
  }
  return parsed.data as Hypothesis;
}

/** `--hypothesis-file`: read, parse, validate. Unknown keys (the `program` the writer adds) are ignored. */
export async function loadHypothesisFile(path: string): Promise<Hypothesis> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    throw new DotError('BAD_HYPOTHESIS_FILE', `cannot read ${path}`, { reason: String(e) });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new DotError('BAD_HYPOTHESIS_FILE', `${path} is not JSON`, { reason: String(e) });
  }
  return parseHypothesis(json, path);
}
