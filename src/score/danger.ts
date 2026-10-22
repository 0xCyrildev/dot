import type { AuthorityPosture } from '../state/programdata.js';
import type { DiffConfidence } from '../state/bytecodeDiff.js';

/**
 * Upgrade Danger Ranking — a 0–100 queue position for one upgrade.
 *
 * This is NOT the P0–P3 tier. `scoreRisk()` answers "how much of this program's exposure did
 * Dot see, and what does that imply for the ecosystem right now"; it is what the tier and the
 * report header are built from and it is unchanged by this file. The danger score answers a
 * narrower operator question with a single number: *how soon should a human open this specific
 * upgrade*. Both can disagree, and that is informative rather than a bug — a program with a
 * boring history and 200 dependents is P1 by exposure and CRITICAL by danger posture.
 *
 * Three rules this module does not bend, because the rest of Dot is worth nothing without them:
 *
 * 1. **An axis with no data is `null`, not 0.** Zero is a score; `null` is an absence of one.
 *    A run that never built a graph does not get 0 blast-radius points and a clean total — it
 *    gets a partial total, says which axes are missing, and cannot top out at CRITICAL.
 * 2. **The brief asks for things Solana chain data does not answer, and they are reported as
 *    unmeasured instead of invented.** Concretely: (a) the *threshold* of a multisig authority
 *    (1-of-N vs M-of-N) is not readable by Dot, so multisig is scored at the alarming end and
 *    says so; (b) "upgrade within 24h of a major ecosystem event" has no feed in Dot at all, so
 *    it is never awarded; (c) routed *token* value is not attributable — the graph records which
 *    mints were touched, not how much — so the >10M multiplier applies to observed lamports only.
 * 3. **The axes sum to 120, not 100** (40 + 30 + 30 + 20). The total is clamped at 100 and
 *    `rawScore` is kept next to it, because a reader who sees 100/100 should be able to tell that
 *    several axes were maxed out and the ceiling is arithmetic, not evidence.
 */

export type DangerCategory = 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW';
export type DangerAxisId = 'authority' | 'codeDelta' | 'blastRadius' | 'behavior';

export type DangerAxis = {
  id: DangerAxisId;
  /** Points awarded, or null when the input needed to score this axis does not exist. */
  points: number | null;
  max: number;
  /** The one line that names what the axis is standing on. */
  label: string;
  /** The component awards that made up `points`, in the order the brief lists them. */
  detail: string[];
  /** Why this is `null`, or why a sub-claim inside the axis was not scored. */
  notAssessed: string[];
};

export type DangerInputs = {
  program: string;
  authority: {
    posture: AuthorityPosture;
    /** The authority address as read, when there was one. */
    address: string | null;
  };
  /** From `diffBytecode`. Null when no bytecode diff was performed at all. */
  delta: {
    confidence: DiffConfidence;
    addedEntrypoints: string[];
    undeclaredEntrypoints: string[];
    /** Instructions whose account set gained a signer or a writable non-signer. */
    accountChanges: Array<{ instruction: string; addedSigner: string[]; addedWritable: string[] }>;
  } | null;
  /** From the dependency graph. Null when the run never built one. */
  radius: {
    direct: number;
    transitive: number;
    /** Sum of per-edge attributions. Null means value routing was not observed — NOT that it was zero. */
    lamportsRouted: number | null;
    /** Operator-declared price (`--sol-usd`). Dot never fetches one, so USD appears only when supplied. */
    usdPerSol: number | null;
    mintsTouched: number;
  } | null;
  /** Dot's own memory of this program, from `--state`. Null when the state file was not in use. */
  behavior: {
    /** ISO timestamp of the last analysis Dot persisted for this program, or null if there is none. */
    priorDigestAt: string | null;
    /** True when `--state` was not supplied, so "no prior digest" carries no information at all. */
    stateFileUsed: boolean;
  } | null;
};

const AXIS_MAX: Record<DangerAxisId, number> = { authority: 40, codeDelta: 30, blastRadius: 30, behavior: 20 };

/** Above this many lamports routed through the dependents, the blast-radius axis doubles. */
const VALUE_MULTIPLIER_FLOOR_LAMPORTS = 10_000_000;

const AUTHORITY_SCORE: Record<AuthorityPosture, { points: number; label: string; why: string } | { points: null; label: string; why: string }> = {
  eoa: { points: 40, label: 'Single-key EOA', why: 'one signature replaces the program: no threshold, no delay, no on-chain gate between a stolen key and new code' },
  multisig: {
    points: 25,
    label: 'Multisig',
    why: 'held by a multisig the operator declared. Dot cannot read m-of-n, so it takes the alarming end of the brief\'s two multisig bands (1-of-N = 25, M-of-N = 10) rather than guessing the middle',
  },
  program_derived: { points: 10, label: 'PDA authority', why: 'the signer is a program address: gated by code Dot has not read, which could be a governance program or a bare bump seed' },
  renounced: { points: 0, label: 'Immutable (authority renounced)', why: 'this account cannot author another upgrade, so no future code can arrive by this path' },
  unknown: { points: null, label: 'Authority not classifiable', why: 'posture was not readable from the account data; scoring it would be a guess dressed as a finding' },
};

export type DangerAssessment = {
  /** min(100, rawScore) — the number the categories are defined against. */
  score: number;
  /** Before the clamp. Can reach 120, because the axes do. */
  rawScore: number;
  category: DangerCategory;
  /** The band the score would have been in, when a missing axis held it down. */
  uncappedCategory: DangerCategory;
  ceiling: string | null;
  axes: DangerAxis[];
  unassessedAxes: DangerAxisId[];
  /** Raw total of the axes that *were* scored, over the max of those axes only. */
  coverage: { scored: number; possible: number };
  verdict: string;
};

export function categoryFor(score: number): DangerCategory {
  if (score >= 80) return 'CRITICAL';
  if (score >= 60) return 'HIGH';
  if (score >= 40) return 'MODERATE';
  return 'LOW';
}

const BANDS: DangerCategory[] = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'];

function oneBandLower(c: DangerCategory): DangerCategory {
  const i = BANDS.indexOf(c);
  return i <= 0 ? c : BANDS[i - 1]!;
}

function authorityAxis(i: DangerInputs['authority']): DangerAxis {
  const s = AUTHORITY_SCORE[i.posture] ?? AUTHORITY_SCORE['unknown']!;
  const label = `${s.label}${i.address ? ` (${i.address.slice(0, 6)}…)` : ''}`;
  const detail = [label];
  if (s.points === null) {
    return { id: 'authority', points: null, max: AXIS_MAX.authority, label: s.label, detail, notAssessed: [s.why] };
  }
  if (i.posture === 'multisig') detail.push('threshold not readable from chain data — scored as 1-of-N');
  return { id: 'authority', points: s.points, max: AXIS_MAX.authority, label, detail, notAssessed: [] };
}

function deltaAxis(d: NonNullable<DangerInputs['delta']>): DangerAxis {
  const detail: string[] = [];
  const notAssessed: string[] = [];
  let points = 0;
  if (d.addedEntrypoints.length > 0) {
    points += 15;
    detail.push(`added entr${d.addedEntrypoints.length === 1 ? 'ypoint' : 'ypoints'} ${d.addedEntrypoints.map((n) => `\`${n}\``).join(', ')}`);
  }
  if (d.accountChanges.length > 0) {
    points += 10;
    for (const a of d.accountChanges) {
      const bits = [
        a.addedSigner.length ? `signer ${a.addedSigner.join(', ')}` : null,
        a.addedWritable.length ? `writable ${a.addedWritable.join(', ')}` : null,
      ].filter(Boolean).join(', ');
      detail.push(`\`${a.instruction}\` now takes ${bits || 'a changed account set'}`);
    }
  }
  if (d.confidence === 'unscannable') {
    points += 5;
    detail.push('bytecode unscannable: the entrypoint set could not be verified, and an unverifiable diff is a reason to look, not a reason to relax');
  }
  if (d.undeclaredEntrypoints.length > 0) {
    // Named in the brief's output but not in its arithmetic, so it is reported and not scored.
    notAssessed.push(`${d.undeclaredEntrypoints.length} undeclared entr${d.undeclaredEntrypoints.length === 1 ? 'ypoint' : 'ypoints'} (${d.undeclaredEntrypoints.map((n) => `\`${n}\``).join(', ')}) — present in the image, absent from the published interface. The brief gives this no points; it is listed because it is the most interesting line in the diff and silently dropping it would be a design decision smuggled into arithmetic.`);
  }
  if (points > AXIS_MAX.codeDelta) {
    notAssessed.push(`code delta capped from ${points} to ${AXIS_MAX.codeDelta}`);
    points = AXIS_MAX.codeDelta;
  }
  return { id: 'codeDelta', points, max: AXIS_MAX.codeDelta, label: detail[0] ?? 'no entrypoint or account-set change located', detail, notAssessed };
}

function radiusAxis(r: NonNullable<DangerInputs['radius']>): DangerAxis {
  const direct = Math.min(r.direct, 2) * 10;
  const transitive = Math.min(r.transitive, 2) * 5;
  const base = direct + transitive;
  const detail: string[] = [`+${direct} for ${r.direct} direct depend${r.direct === 1 ? 'ent' : 'ents'} (10 each, capped at 20)`, `+${transitive} for ${r.transitive} transitive (5 each, capped at 10)`];
  const notAssessed: string[] = [];
  let points = base;
  if (r.lamportsRouted === null) {
    notAssessed.push('value routing not observed, so the ×2 multiplier could not be evaluated — this is an absence of data, not a reading of zero');
  } else if (r.lamportsRouted > VALUE_MULTIPLIER_FLOOR_LAMPORTS) {
    points = Math.min(AXIS_MAX.blastRadius, base * 2);
    detail.push(`×2 for routing ${formatLamports(r.lamportsRouted, r.usdPerSol)} (> ${formatLamports(VALUE_MULTIPLIER_FLOOR_LAMPORTS, null)} floor), capped at ${AXIS_MAX.blastRadius}`);
  } else {
    detail.push(`no multiplier: routed ${formatLamports(r.lamportsRouted, r.usdPerSol)} is under the ${formatLamports(VALUE_MULTIPLIER_FLOOR_LAMPORTS, null)} floor`);
  }
  if (r.mintsTouched > 0) {
    notAssessed.push(`${r.mintsTouched} token mint(s) touched — the graph records which mints a call moved, not how much, so token value cannot enter the multiplier`);
  }
  return {
    id: 'blastRadius',
    points: Math.min(points, AXIS_MAX.blastRadius),
    max: AXIS_MAX.blastRadius,
    label: `${r.direct} direct, ${r.transitive} transitive${r.lamportsRouted !== null ? `, routing ${formatLamports(r.lamportsRouted, r.usdPerSol)}` : ', value routing unobserved'}`,
    detail,
    notAssessed,
  };
}

function behaviorAxis(b: NonNullable<DangerInputs['behavior']>): DangerAxis {
  const notAssessed = ['"upgrade within 24h of a major ecosystem event" (+10): Dot has no event feed of any kind, so this award is never given and no score in this build has ever included it'];
  if (!b.stateFileUsed) {
    return {
      id: 'behavior',
      points: null,
      max: AXIS_MAX.behavior,
      label: 'no state file: Dot has no memory of this program',
      detail: ['--state was not supplied, so "no prior upgrade" would mean nothing'],
      notAssessed: ['no `--state` file: first-observed status carries no information', ...notAssessed],
    };
  }
  if (b.priorDigestAt === null) {
    return {
      id: 'behavior',
      points: 20,
      max: AXIS_MAX.behavior,
      label: 'first upgrade Dot has observed for this program',
      detail: ['+20: no prior digest in the state file. This is Dot\'s own memory of a first sighting, not a claim that the program has never been upgraded — a program upgraded a hundred times before Dot was pointed at it reads exactly the same here'],
      notAssessed,
    };
  }
  return {
    id: 'behavior',
    points: 0,
    max: AXIS_MAX.behavior,
    label: `previously observed (last analysis ${b.priorDigestAt})`,
    detail: ['0: not a first sighting. The brief\'s third case is "routine cadence", which needs the timestamps of prior upgrades; Dot has the timestamp of its own last look, so this axis distinguishes "first seen" from "seen before" and nothing finer'],
    notAssessed,
  };
}

function formatLamports(lamports: number, usdPerSol: number | null): string {
  const sol = lamports / 1e9;
  const solText = sol >= 1 ? `${sol.toLocaleString(undefined, { maximumFractionDigits: 2 })} SOL` : `${lamports.toLocaleString(undefined, { maximumFractionDigits: 0 })} lamports`;
  return usdPerSol && usdPerSol > 0 ? `${solText} (~$${Math.round(sol * usdPerSol).toLocaleString()})` : solText;
}

function verdictFor(i: DangerInputs, axes: DangerAxis[], category: DangerCategory, unassessed: DangerAxisId[]): string {
  const a = new Map(axes.map((x) => [x.id, x]));
  const auth = a.get('authority')!;
  const parts: string[] = [];
  parts.push(
    `An upgrade of \`${i.program}\` by ${auth.points === null ? 'an authority Dot could not classify' : `a ${auth.label.toLowerCase()} authority`}` +
      ` (${auth.points === null ? 'not assessed' : `${auth.points}/${auth.max}`} posture points).`,
  );
  const d = a.get('codeDelta')!;
  if (d.points === null) parts.push('No bytecode diff was performed, so nothing is known about what the new code can be asked to do.');
  else if (d.points > 0) parts.push(`The diff ${d.detail.length ? d.detail[0] : 'changed'}.`);
  else parts.push('No new entrypoint and no new account requirement was located in the diff.');
  const r = a.get('blastRadius')!;
  if (r.points === null) parts.push('No dependency graph was built, so the number of callers this could break is unknown rather than small.');
  else parts.push(`${r.label}.`);
  const b = a.get('behavior')!;
  if (b.points !== null && b.points > 0) parts.push('It is the first upgrade Dot has observed for this program.');
  const action =
    category === 'CRITICAL' || category === 'HIGH'
      ? 'Open it before the weekend: read the added entrypoints and the accounts they take, and check who signs.'
      : category === 'MODERATE'
        ? 'Queue it for the next working pass; nothing here says hurry, and nothing here says safe either.'
        : 'No immediate action implied. A LOW is a statement about the evidence Dot was allowed to gather, not an all-clear.';
  const caveat = unassessed.length > 0 ? ` Held below its own ceiling because ${unassessed.length} axis/axes had no data (${unassessed.join(', ')}).` : '';
  return `${parts.join(' ')} ${action}${caveat}`;
}

/**
 * The ranking. Pure, synchronous, and driven only by the inputs it is handed: nothing here
 * fetches, prices, or infers a threshold. Callers map their own state into `DangerInputs` and
 * pass `null` for anything they do not have — that `null` is the whole difference between a
 * LOW that means "small" and a LOW that means "unmeasured".
 */
export function scoreDanger(i: DangerInputs): DangerAssessment {
  const axes: DangerAxis[] = [
    authorityAxis(i.authority),
    i.delta === null
      ? { id: 'codeDelta', points: null, max: AXIS_MAX.codeDelta, label: 'no bytecode diff performed', detail: [], notAssessed: ['the diff was never run, so the axis has no data'] }
      : deltaAxis(i.delta),
    i.radius === null
      ? { id: 'blastRadius', points: null, max: AXIS_MAX.blastRadius, label: 'no dependency graph built', detail: [], notAssessed: ['no graph, so dependents and routed value are unknown rather than zero'] }
      : radiusAxis(i.radius),
    i.behavior === null
      ? { id: 'behavior', points: null, max: AXIS_MAX.behavior, label: 'no behavioural data supplied', detail: [], notAssessed: ['the caller had neither a state file nor a prior digest'] }
      : behaviorAxis(i.behavior),
  ];

  const scored = axes.filter((x) => x.points !== null) as Array<DangerAxis & { points: number }>;
  const rawScore = scored.reduce((s, x) => s + x.points, 0);
  const possible = scored.reduce((s, x) => s + x.max, 0);
  const score = Math.min(100, rawScore);
  const uncappedCategory = categoryFor(score);
  const unassessedAxes = axes.filter((x) => x.points === null).map((x) => x.id);

  // A missing axis is a reason not to top out. The brief's own worst case (40+30+30+20) is
  // unreachable if one of the four was never measured, and a reader who sees CRITICAL with a
  // null blast radius has been told nothing about who depends on the program.
  let category = uncappedCategory;
  let ceiling: string | null = null;
  if (unassessedAxes.length > 0 && category === 'CRITICAL') {
    category = oneBandLower(uncappedCategory);
    ceiling = `CRITICAL withheld: ${unassessedAxes.join(', ')} not assessed (max possible from measured axes was ${possible}/120)`;
  }

  return {
    score,
    rawScore,
    category,
    uncappedCategory,
    ceiling,
    axes,
    unassessedAxes,
    coverage: { scored: rawScore, possible },
    verdict: verdictFor(i, axes, category, unassessedAxes),
  };
}

/**
 * The operator-facing block. Box-drawing lines, one per axis, then the verdict — the shape the
 * brief specified, kept to facts Dot measured: no USD without `--sol-usd`, no bracket for an
 * axis that produced nothing, and an explicit `not assessed` line instead of a silent 0.
 */
export function renderDanger(d: DangerAssessment): string {
  const L: string[] = [];
  L.push(`UPGRADE DANGER RANKING: ${d.category} (Score: ${d.score}/100)`);
  if (d.rawScore > 100) L.push(`  raw ${d.rawScore} before the 100 clamp; the four axes sum to 120, not 100`);
  if (d.unassessedAxes.length > 0) {
    L.push(`  scored on ${d.coverage.scored} of ${d.coverage.possible} measurable axis points; no data for: ${d.unassessedAxes.join(', ')}`);
  }
  if (d.ceiling) L.push(`  ${d.ceiling}`);
  const lines = d.axes.map((a) => {
    const pts = a.points === null ? `not assessed/${a.max}` : `+${a.points}/${a.max}`;
    return `├── ${cap(a.id)}: ${a.label} [${pts}]`;
  });
  for (let i = 0; i < lines.length; i++) {
    L.push(i === lines.length - 1 ? lines[i]!.replace('├──', '└──') : lines[i]!);
  }
  for (const a of d.axes) {
    for (const n of a.notAssessed) L.push(`      · ${a.id}: ${n}`);
  }
  L.push('');
  L.push(`VERDICT: ${d.verdict}`);
  return L.join('\n');
}

const cap = (id: DangerAxisId) => ({ authority: 'Authority', codeDelta: 'Code Delta', blastRadius: 'Blast Radius', behavior: 'Behavior' })[id];
