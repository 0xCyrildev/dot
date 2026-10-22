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
 * 3. **The axes sum to 180, not 100** (40 + 30 + 30 + 20 queue-position axes, plus 30 + 20 + 10
 *    malice-signature axes). The total is clamped at 100 and `rawScore` is kept next to it, because a
 *    reader who sees 100/100 should be able to tell that several axes were maxed out and the ceiling is
 *    arithmetic, not evidence.
 *
 * The three malice axes are named *signature* axes on purpose. Dot does not classify intent —
 * `NO_MALICE_DETECTION` says so and still does. What it can now do is notice that a program is being
 * upgraded by a key whose funding is minutes old and whose new bytecode answers to a selector the
 * published interface denies, and shout. The shout is a routing decision with a written-down reason,
 * not a verdict about a person: an honest team with a fresh ops wallet and a stale IDL will trigger it,
 * and the output says that in the same breath as it says `SUSPECTED_MALICIOUS`.
 *
 * Two overlaps are deliberate and are printed rather than hidden, because a reviewer adding up the
 * axes will otherwise find the same fact charged twice: an `unscannable` image costs 5 points in
 * `codeDelta` (you cannot verify a change) and 10 more in `codeAnomaly` (you cannot rule one out);
 * and `behavior` measures "is this the first upgrade Dot has seen" while `timingAnomaly` measures
 * "does when it happened fit the program's own cadence" — related, not the same question.
 */

export type DangerCategory = 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW';
export type DangerAxisId =
  | 'authority'
  | 'codeDelta'
  | 'blastRadius'
  | 'behavior'
  | 'authorityIntegrity'
  | 'codeAnomaly'
  | 'timingAnomaly';

/** The malice-signature axes, as opposed to the four queue-position axes. */
export const MALICE_AXES = ['authorityIntegrity', 'codeAnomaly', 'timingAnomaly'] as const satisfies readonly DangerAxisId[];

/**
 * What the funding probe actually established about the upgrade authority. The states are ordered by
 * how much they are worth accusing anyone of, and `unverified` is a state a *refusal* puts you in —
 * never a clean bill.
 */
export type FundingEvidence =
  | { state: 'flagged_source'; detail: string; fromAddress: string }
  | {
      state: 'recent_funding_observed';
      detail: string;
      ageMs: number;
      /** True when the node's retention could be hiding earlier history, which is what makes the
       *  wallet look freshly created. Freshness is then *apparent*, and the +30 is not awarded. */
      retentionBounded: boolean;
    }
  | { state: 'established'; detail: string }
  | { state: 'unverified'; detail: string };

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

/**
 * Where the clock on the timing axis came from, in decreasing order of how much it is worth.
 * `analysis-clock` is the honest label for "Dot did not know when this upgrade happened, and is
 * measuring against the moment somebody ran the tool".
 */
export type TimingReference = 'watcher-detected' | 'newest-observed-trace' | 'analysis-clock';

export const TIMING_REFERENCE_NOTE: Record<TimingReference, string> = {
  'watcher-detected': 'the moment the watcher saw the account change, which is within one poll interval of the upgrade transaction',
  'newest-observed-trace': 'the block time of the newest transaction Dot sampled for this program, not the upgrade transaction itself',
  'analysis-clock': "Dot's own clock: this run had no upgrade timestamp, so proximity here is proximity to *now*, not to the upgrade",
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
    accountChanges: Array<{ instruction: string; addedSigner: string[]; addedWritable: string[]; existing: boolean }>;
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
  /**
   * Malice signature 1 — where the authority's money came from. Null when the probe was never run,
   * which is the default: it costs RPC calls, so `dot analyze` only pays for it when asked
   * (`--check-funding`), and an operator's suspect-address list is the only source of the
   * `flagged_source` state because Dot ships no such list of its own.
   */
  integrity: {
    funding: FundingEvidence | null;
    /**
     * A multisig's `m` of `n` cannot be read by Dot — the threshold lives inside the multisig
     * account, which Dot does not decode. An operator who knows it can declare it; without a
     * declaration this axis is unmeasured for a multisig and never guesses.
     */
    declaredThreshold: { m: number; n: number } | null;
    /**
     * A quorum read from the node's own parser (`getAccountInfo` with `jsonParsed`), which outranks an
     * operator declaration because it is the chain talking. Null when the read did not produce one; the
     * reason is in `quorumRead` rather than inferred from the absence.
     */
    quorum?: { m: number; n: number } | null;
    /** Which outcome the quorum read had. `not_read` and `raw_bytes` are both "unknown", not "single key". */
    quorumRead?: 'measured' | 'absent' | 'raw_bytes' | 'other_type' | 'labelled_without_quorum_fields' | 'not_read' | null;
    /** The detail line that came with a non-`measured` read, verbatim, so the report can show it. */
    quorumDetail?: string | null;
    /**
     * How recently any signer of this multisig was seen in a transaction, when `--check-signers` paid for
     * the read. This is the brief's other half of the +10 band — "a stale signer set" — and unlike the
     * funding axis its absence must *not* raise the score: an unread signer set is unknown, not dormant.
     */
    signerActivity?: {
      state: 'stale' | 'active' | 'unverified';
      detail: string;
      probed: number;
      of: number;
    } | null;
    /** Operator-declared timelock on the authority. The brief's 0-point case needs one, and it is not on-chain. */
    timelockDeclared: boolean;
    /** How the funding evidence was obtained, for the reader's trust calibration. */
    fundingProbe: { callsSpent: number; signaturesSeen: number } | null;
    /**
     * How many suspect funding sources the operator named. Omitted or 0 means the `flagged_source` band
     * was unreachable *by construction* — Dot ships no mixer or obfuscation list of its own — so
     * "clean" here can only ever mean "no fresh funding observed", never "not funded by a mixer". The
     * default is the pessimistic reading, which is the only safe default for an optional field.
     */
    suspectAddressesSeen?: number;
  } | null;
  /** Malice signature 3 — when this upgrade happened relative to this program's own history. */
  timing: {
    /** Unix ms of upgrades Dot has observed for this program before this one. */
    priorUpgradeTimesMs: number[];
    /** Unix ms of this upgrade, measured against whatever `upgradeTimeSource` names. */
    upgradeTimeMs: number | null;
    /**
     * What the clock behind `upgradeTimeMs` and the two gaps actually is. This is not decoration: the
     * brief asks whether *the upgrade* happened within an hour of a governance proposal, and a run of
     * `dot analyze` on a program that last moved a year ago has no upgrade timestamp of its own. If the
     * only clock available is "when Dot was run", the axis says so, because comparing a year-old
     * upgrade to a governance program's *current* activity would otherwise print a +10 that means
     * "this analysis happened recently" and nothing else.
     */
    upgradeTimeSource?: TimingReference;
    /**
     * Distance in ms to the nearest signature on an operator-supplied governance program, when one
     * was supplied. Null when no governance program was named: "near a governance proposal" is then
     * not a false alarm, it is not measured at all.
     */
    governanceGapMs: number | null;
    /** Distance in ms to an operator-declared incident window. Dot has no incident feed. */
    incidentGapMs: number | null;
  } | null;
};

const AXIS_MAX: Record<DangerAxisId, number> = {
  authority: 40,
  codeDelta: 30,
  blastRadius: 30,
  behavior: 20,
  authorityIntegrity: 30,
  codeAnomaly: 20,
  timingAnomaly: 10,
};

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
  /** The malice heuristic's own verdict, separate from `category` so a queue position and an
   *  accusation can never be confused for one number. */
  malice: MaliceAssessment;
};

export type MaliceAssessment = {
  /** True only when the gate below is fully satisfied. A routing scream, not a finding. */
  flagged: boolean;
  /**
   * The sentence the brief specifies, verbatim, emitted only when `flagged`. It is a constant rather
   * than a template so the ranking block, the markdown banner and the watch line cannot drift into
   * three slightly different alarms — and so `SUSPECTED_MALICIOUS` can only ever be printed by the
   * gate that decided it, never by a caller formatting its own guess.
   */
  verdictLine: string | null;
  /** Sum of the three signature axes in their own units, max 60. */
  maliceScore: number;
  gate: {
    /** The threshold the brief sets on the *overall* danger score. */
    totalScoreAtLeast: number;
    totalScore: number;
    authorityIntegrityPositive: boolean;
    /** Positive evidence of one of the two kinds Dot can observe, not merely an unmeasured risk. */
    positiveEvidence: boolean;
    /** False when the signature axes were never measured — then the flag is not "off", it is unknown. */
    measured: boolean;
  };
  /** One sentence of evidence, built only from observed facts. */
  evidence: string;
  disclaimer: string;
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

function authorityAxis(i: DangerInputs['authority'], integrity: DangerInputs['integrity']): DangerAxis {
  const s = AUTHORITY_SCORE[i.posture] ?? AUTHORITY_SCORE['unknown']!;
  // A measured quorum lets this axis take one of the two bands the model defines instead of sitting at
  // the alarming end of both. Without one, 25 and the printed assumption are the honest answer: a 1-of-2
  // and a 5-of-9 are not the same risk, and pretending otherwise would be a guess with a number on it.
  const measured = i.posture === 'multisig' ? integrity?.quorum ?? null : null;
  const points = measured ? (measured.m === 1 ? 25 : 10) : s.points;
  const label = `${s.label}${measured ? ` (${measured.m}-of-${measured.n})` : ''}${i.address ? `${measured ? '' : ' '}(${i.address.slice(0, 6)}…)` : ''}`;
  const detail = [label];
  if (points === null) {
    return { id: 'authority', points: null, max: AXIS_MAX.authority, label: s.label, detail, notAssessed: [s.why] };
  }
  if (measured) detail.push(`band chosen from a quorum the node parsed, not from the alarming end of two unread bands`);
  else if (i.posture === 'multisig') detail.push('threshold not readable from chain data — scored as 1-of-N');
  return { id: 'authority', points, max: AXIS_MAX.authority, label, detail, notAssessed: [] };
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
    label: `${r.direct} direct, ${r.transitive} transitive${r.lamportsRouted !== null ? `, routing ${formatLamports(r.lamportsRouted, r.usdPerSol)} in the sample (a per-transaction proxy, not a TVL figure)` : ', value routing unobserved'}`,
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

/**
 * Malice signature 1 — authority integrity (0–30).
 *
 * The bands come from the brief. What matters here is what they are *allowed* to stand on: the +30
 * needs observed funding evidence, either an inbound transfer from an address an operator named, or a
 * funding transaction seen at the very start of a wallet's history. A refusal, a retention-limited
 * walk, or a probe that never ran scores the authority as an ordinary single key (20) and says which
 * of those it was — a missing check is not a clean check, and it is not evidence either.
 */
function integrityAxis(i: NonNullable<DangerInputs['integrity']>, posture: AuthorityPosture): DangerAxis {
  const max = AXIS_MAX.authorityIntegrity;
  const mk = (points: number | null, label: string, detail: string[], notAssessed: string[]): DangerAxis => ({
    id: 'authorityIntegrity',
    points,
    max,
    label,
    detail,
    notAssessed,
  });

  if (posture === 'renounced') {
    return mk(0, 'immutable (authority renounced)', ['0: no key can author a further upgrade, so no funding history is relevant'], []);
  }

  if (posture === 'multisig') {
    const sa = i.signerActivity ?? null;
    const stale = sa?.state === 'stale';
    // The two halves of the brief's +10 band, kept separate because only one of them is now measurable.
    const gaps: string[] = sa
      ? [
          sa.state === 'unverified'
            ? `stale signer set: not established either way — ${sa.detail}. Idleness that cannot be read adds no points; a check that did not run is not evidence of a cold key set`
            : `stale signer set: ${sa.detail}; the threshold and the idleness are the same +10 band in the brief, so they are not added`,
        ]
      : [
          'stale signer set: the brief puts it in the same +10 band as a 2-of-3, and it was not measured on this run — `--check-signers` pays for one read per signer',
        ];
    if (sa && sa.probed < sa.of) {
      gaps.push(`only ${sa.probed} of ${sa.of} signers were read, so a set that looks idle may simply have an active member further down the list`);
    }
    if (i.funding) {
      gaps.push(`funding evidence was collected (${i.funding.state}) and is deliberately not scored here: the brief\'s top band is a *single EOA* funded from a suspect source, and a multisig is not that. Read the evidence ledger line — it is still worth knowing even though no axis credits it`);
    }
    // A measured quorum outranks a declared one; a declaration still beats a guess.
    const threshold = i.quorum ?? i.declaredThreshold ?? null;
    const how = i.quorum ? 'quorum read from the node\'s own parser' : i.declaredThreshold ? 'threshold declared by the operator' : null;
    if (!threshold) {
      const why = i.quorumRead && i.quorumRead !== 'not_read'
        ? `the quorum read came back \`${i.quorumRead}\`${i.quorumDetail ? `: ${i.quorumDetail}` : ''}`
        : 'the quorum was never read';
      // A stale set is worth the band on its own even when the threshold is unread, but the axis as a
      // whole stays unmeasured if the quorum is unknown, because 10 points of "multisig-ish" with no
      // threshold is a weaker statement than saying which part is unknown.
      return mk(stale ? 10 : null, stale ? `multisig with a stale signer set, threshold unread (${sa?.detail ?? ''})` : 'multisig authority, threshold unread', stale ? [`+10: ${sa?.detail ?? 'signer set idle beyond the staleness window'}`] : [], [
        'the brief\'s low-threshold band (10 for a 2-of-3 or a stale signer set) cannot be evaluated in full: `m` of `n` lives inside the multisig account',
        `quorum not measured: ${why}. An unread quorum is not a single key, and it is not a clean authority either`,
        ...gaps,
      ]);
    }
    const { m, n } = threshold;
    const label = `${m}-of-${n}${how ? ` (${how})` : ''}`;
    const low = m <= 2;
    if (!low && i.timelockDeclared && !stale) {
      return mk(0, `high-threshold multisig (${label}) behind a declared timelock`, ['0: the brief\'s 0-point case, and the only case where a timelock was declared — Dot cannot read one from chain data'], gaps);
    }
    if (!low && i.timelockDeclared && stale) {
      // The brief's clean case is "high threshold *with* timelock". A quorum nobody has signed with in
      // two years is not that case, whatever the delay in front of it is.
      return mk(10, `high-threshold multisig (${label}) behind a declared timelock, but the signer set reads as stale`, [`+10: ${sa?.detail ?? ''}. A timelock in front of keys that have not moved is a delay, not a control`], gaps);
    }
    if (low) {
      return mk(10, `low-threshold multisig (${label})`, [`+10: ${m} signatures move this program, and ${m} is 2 or fewer${stale ? ', and the signer set also reads as idle' : ''}`], [...(i.timelockDeclared ? [] : ['no timelock declared, so the 0-point "high threshold with timelock" case does not apply']), ...gaps]);
    }
    return mk(10, `multisig (${label}), no timelock`, ['+10: the brief\'s 0-point case requires a timelock as well as a high threshold, and none was declared'], gaps);
  }

  if (posture === 'program_derived' || posture === 'unknown') {
    return mk(null, posture === 'unknown' ? 'authority not classifiable' : 'PDA authority', [], [
      posture === 'unknown'
        ? 'the authority bytes did not decode, so there is nothing for any funding claim to attach to'
        : 'the signer is a program address: who can move it is decided by code Dot has not read, and "funded by a mixer" has no meaning for a PDA. This axis stays unmeasured rather than assuming the answer',
    ]);
  }

  // posture === 'eoa'
  const notAssessed: string[] = [];
  // Worth saying on every single-key path: the mixer half of the brief's +30 has no data source inside
  // Dot, so a 20 here is "nothing fresh turned up", and a reader must not hear it as "not mixer-funded".
  const noList =
    (i.suspectAddressesSeen ?? 0) === 0
      ? 'no suspect funding addresses were supplied (`--suspect`), so the flagged-source band was unreachable by construction — Dot ships no mixer or obfuscation list of its own. This axis can report "no fresh funding observed"; it cannot report "not mixer-funded"'
      : null;
  const f = i.funding;
  if (!f) {
    notAssessed.push('funding was not probed (it costs RPC calls; run with --check-funding). Scored as an ordinary single key, not as an innocent one');
    if (noList) notAssessed.push(noList);
    return mk(20, 'single EOA, funding unprobed', ['+20: one key controls this program'], notAssessed);
  }
  if (f.state === 'flagged_source') {
    return mk(30, 'single EOA funded by a named suspect address', [`+30: ${f.detail}`], []);
  }
  if (noList) notAssessed.push(noList);
  if (f.state === 'recent_funding_observed') {
    const age = f.ageMs < 86_400_000 ? `${Math.max(1, Math.round(f.ageMs / 3_600_000))} hour(s) ago` : `${Math.round(f.ageMs / 86_400_000)} day(s) ago`;
    if (f.retentionBounded) {
      notAssessed.push(`the wallet looks young (${age}) but the node could be hiding older history, so "fresh" is not established and the +30 is withheld`);
      return mk(20, `single EOA, funding ${age} (retention-bounded)`, ['+20: standard single-key risk'], notAssessed);
    }
    return mk(30, `single EOA funded ${age}`, [`+30: ${f.detail}`], []);
  }
  if (f.state === 'unverified') {
    notAssessed.push(`funding probe inconclusive: ${f.detail}. An unverified authority is not a verified one`);
    return mk(20, 'single EOA, funding unverified', ['+20: standard single-key risk'], notAssessed);
  }
  return mk(20, 'single EOA with an established history', ['+20: standard single-key risk; the funding walk found long-standing activity, which removes the freshness signal and nothing else'], notAssessed);
}

/**
 * Malice signature 2 — code anomaly (0–20). Both awards are structural facts the diff already
 * reports; neither is an inference about why the change was made.
 */
function anomalyAxis(d: NonNullable<DangerInputs['delta']>): DangerAxis {
  const max = AXIS_MAX.codeAnomaly;
  const detail: string[] = [];
  const notAssessed: string[] = [];
  const widening = d.accountChanges.filter((a) => a.existing && (a.addedSigner.length > 0 || a.addedWritable.length > 0));
  let points = 0;
  if (d.undeclaredEntrypoints.length > 0) {
    points += 20;
    detail.push(`+20: selector${d.undeclaredEntrypoints.length === 1 ? '' : 's'} reachable in the bytecode and absent from the published interface (${d.undeclaredEntrypoints.map((n) => `\`${n}\``).join(', ')})`);
  } else if (widening.length > 0) {
    points += 20;
    for (const a of widening) {
      detail.push(`+20: \`${a.instruction}\` now takes${a.addedSigner.length ? ` a signer (${a.addedSigner.join(', ')})` : ''}${a.addedWritable.length ? ` a writable account (${a.addedWritable.join(', ')})` : ''} it did not before`);
    }
  }
  if (d.confidence === 'unscannable') {
    points += 10;
    detail.push('+10: the image could not be scanned, so nothing here rules a hidden handler out');
  }
  if (points === 0) detail.push('0: additive, or at least nothing the diff flags as a signature');
  if (d.confidence === 'partial' || d.confidence === 'bytecode_only') {
    notAssessed.push(`confidence is \`${d.confidence}\`: one side of the comparison was missing, so "no anomaly found" is weaker than it looks`);
  }
  return {
    id: 'codeAnomaly',
    points: Math.min(points, max),
    max,
    label: points > 0 ? detail[0]!.replace(/^\+\d+: /, '') : 'no anomaly signature located',
    detail,
    notAssessed,
  };
}

/**
 * Malice signature 3 — timing (0–10). Two of the brief's three cases need data Dot does not have by
 * default, so the axis is honest about being unmeasured instead of scoring 0 and reading as routine.
 */
function timingAxis(t: NonNullable<DangerInputs['timing']>): DangerAxis {
  const max = AXIS_MAX.timingAnomaly;
  const detail: string[] = [];
  const notAssessed: string[] = [];
  // A caller that does not say where its clock came from is treated as having nothing better than its
  // own wristwatch, because that is the reading which cannot overstate the proximity claim.
  const ref = t.upgradeTimeSource ?? 'analysis-clock';

  if (t.governanceGapMs !== null && t.governanceGapMs <= 3_600_000) {
    detail.push(`+10: a signature on the declared governance program landed ${Math.max(1, Math.round(t.governanceGapMs / 60_000))} minute(s) from this upgrade${ref === 'analysis-clock' ? ' (against Dot\'s own clock — see the caveat below)' : ''}`);
  } else if (t.governanceGapMs !== null) {
    notAssessed.push(`the nearest governance-program signature was ${Math.round(t.governanceGapMs / 3_600_000)} hour(s) away, outside the 1-hour band`);
  } else {
    notAssessed.push('governance proximity not measured: no governance program was supplied, so this is neither clear nor suspicious');
  }
  notAssessed.push(`what a signature on that program means: Dot counts any transaction, and cannot tell a governance *proposal* from an ordinary call on the same program. Measured against ${TIMING_REFERENCE_NOTE[ref]}.`);
  if (t.incidentGapMs !== null && t.incidentGapMs <= 3 * 3_600_000) {
    detail.push(`+10: ${Math.max(1, Math.round(t.incidentGapMs / 60_000))} minute(s) from an incident window an operator declared`);
  } else if (t.incidentGapMs !== null) {
    notAssessed.push(`the declared incident window was ${(t.incidentGapMs / 3_600_000).toFixed(1)} hour(s) away, outside the 3-hour band`);
  } else {
    notAssessed.push('"during a known network incident" is not checkable by default: Dot ships no incident feed and fetches none, so it is only ever measured when an operator declares a time (--incident-at)');
  }

  if (t.upgradeTimeMs !== null && t.priorUpgradeTimesMs.length >= 3) {
    // Intervals between consecutive observed upgrades, not the timestamps themselves: the median of
    // a list of dates is a date, and comparing "days since the last one" against it is meaningless.
    const sorted = [...t.priorUpgradeTimesMs].sort((a, b) => a - b);
    const intervals = sorted.slice(1).map((x, k) => x - sorted[k]!).filter((x) => x > 0).sort((a, b) => a - b);
    const since = t.upgradeTimeMs - sorted[sorted.length - 1]!;
    if (intervals.length >= 2 && since > 0) {
      const median = intervals[Math.floor(intervals.length / 2)]!;
      const days = (ms: number) => Math.max(1, Math.round(ms / 86_400_000));
      if (since > median * 3) {
        detail.push(`+5: this upgrade comes ${days(since)} day(s) after the last one Dot observed, against a typical interval near ${days(median)} day(s) (Dot's own observation times, not the chain's upgrade history)`);
      } else if (since < median / 3) {
        detail.push(`+5: ${days(since)} day(s) since the last observed upgrade, well under this program's typical ${days(median)} day(s) (Dot's own observation times, not the chain's)`);
      }
    }
  } else {
    notAssessed.push('off-cadence requires 3 prior upgrades with block times; this run had fewer, so "routine cadence" is not established either');
  }

  const awarded = detail.reduce((sum, line) => sum + (line.startsWith('+10') ? 10 : line.startsWith('+5') ? 5 : 0), 0);
  const measurable = t.governanceGapMs !== null || t.incidentGapMs !== null || t.priorUpgradeTimesMs.length >= 3;
  // Cadence is computed against Dot's own observations of this program, never against the chain's upgrade history, and the detail line says so.
  if (!measurable) {
    return { id: 'timingAnomaly', points: null, max, label: 'no timing evidence available', detail: [], notAssessed };
  }
  return {
    id: 'timingAnomaly',
    points: Math.min(awarded, max),
    max,
    label: awarded > 0 ? detail[0]!.replace(/^\+\d+: /, '') : 'timing fits this program\'s own history',
    detail: awarded > 0 ? detail : ['0: routine on the evidence that exists'],
    notAssessed,
  };
}

function formatLamports(lamports: number, usdPerSol: number | null): string {
  const sol = lamports / 1e9;
  const solText = sol >= 1 ? `${sol.toLocaleString(undefined, { maximumFractionDigits: 2 })} SOL` : `${lamports.toLocaleString(undefined, { maximumFractionDigits: 0 })} lamports`;
  // No USD on an observed zero: "~$0" of routing is a formatting artifact, not a measurement.
  return usdPerSol && usdPerSol > 0 && lamports > 0 ? `${solText} (~$${Math.round(sol * usdPerSol).toLocaleString()})` : solText;
}

function verdictFor(i: DangerInputs, axes: DangerAxis[], category: DangerCategory, unassessed: DangerAxisId[]): string {
  const a = new Map(axes.map((x) => [x.id, x]));
  const auth = a.get('authority')!;
  const parts: string[] = [];
  parts.push(
    `An upgrade of \`${i.program}\` by ${auth.points === null ? 'an authority Dot could not classify' : auth.label}` +
      ` (${auth.points === null ? 'posture not assessed' : `${auth.points}/${auth.max} posture points`}).`,
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
const MALICE_TOTAL_SCORE_GATE = 90;

/** The alarm text the brief specifies. Only ever printed beside the gate that produced it. */
export const SUSPECTED_MALICIOUS_VERDICT =
  'VERDICT: SUSPECTED_MALICIOUS — This upgrade has the structural signature of an attack. Immediate human review required. Do not trust the new bytecode.';

export function scoreDanger(i: DangerInputs): DangerAssessment {
  const axes: DangerAxis[] = [
    authorityAxis(i.authority, i.integrity),
    !i.delta
      ? { id: 'codeDelta', points: null, max: AXIS_MAX.codeDelta, label: 'no bytecode diff performed', detail: [], notAssessed: ['the diff was never run, so the axis has no data'] }
      : deltaAxis(i.delta),
    !i.radius
      ? { id: 'blastRadius', points: null, max: AXIS_MAX.blastRadius, label: 'no dependency graph built', detail: [], notAssessed: ['no graph, so dependents and routed value are unknown rather than zero'] }
      : radiusAxis(i.radius),
    !i.behavior
      ? { id: 'behavior', points: null, max: AXIS_MAX.behavior, label: 'no behavioural data supplied', detail: [], notAssessed: ['the caller had neither a state file nor a prior digest'] }
      : behaviorAxis(i.behavior),
    !i.integrity
      ? { id: 'authorityIntegrity', points: null, max: AXIS_MAX.authorityIntegrity, label: 'authority integrity not assessed', detail: [], notAssessed: ['no funding probe and no declared multisig threshold: the axis has nothing to stand on'] }
      : integrityAxis(i.integrity, i.authority.posture),
    !i.delta
      ? { id: 'codeAnomaly', points: null, max: AXIS_MAX.codeAnomaly, label: 'no bytecode diff performed', detail: [], notAssessed: ['the diff never ran, so no structural signature was checked'] }
      : anomalyAxis(i.delta),
    !i.timing
      ? { id: 'timingAnomaly', points: null, max: AXIS_MAX.timingAnomaly, label: 'no timing evidence supplied', detail: [], notAssessed: ['the caller passed neither a governance program nor prior upgrade timestamps'] }
      : timingAxis(i.timing),
  ];

  const scored = axes.filter((x) => x.points !== null) as Array<DangerAxis & { points: number }>;
  const rawScore = scored.reduce((s, x) => s + x.points, 0);
  const possible = scored.reduce((s, x) => s + x.max, 0);
  const score = Math.min(100, rawScore);
  const uncappedCategory = categoryFor(score);

  // The ceiling rule applies to the four queue-position axes only. The three signature axes are
  // opt-in evidence that costs RPC calls: withholding CRITICAL because an operator did not run
  // `--check-funding` would make the default ranking unable to top out, which is the same
  // mistake as a score that reads high on a run that measured nothing.
  const QUEUE: readonly DangerAxisId[] = ['authority', 'codeDelta', 'blastRadius', 'behavior'];
  const unassessedAxes = axes.filter((x) => x.points === null).map((x) => x.id);
  const unassessedQueue = unassessedAxes.filter((id) => QUEUE.includes(id));
  let category = uncappedCategory;
  let ceiling: string | null = null;
  if (unassessedQueue.length > 0 && category === 'CRITICAL') {
    category = oneBandLower(uncappedCategory);
    ceiling = `CRITICAL withheld: ${unassessedQueue.join(', ')} not assessed (max possible from measured queue axes was ${possible}/180 including signature axes)`;
  }

  const byId = new Map(axes.map((a) => [a.id, a]));
  const integrity = byId.get('authorityIntegrity')!;
  const anomaly = byId.get('codeAnomaly')!;
  const timing = byId.get('timingAnomaly')!;
  const signatureAxes = [integrity, anomaly, timing];
  const maliceScore = signatureAxes.reduce((sum, a) => sum + (a.points ?? 0), 0);
  const measured = signatureAxes.some((a) => a.points !== null);
  const authorityIntegrityPositive = (integrity.points ?? 0) > 0;
  // The brief's gate is `score >= 90 AND authorityIntegrity > 0`. Applied literally it fired on the
  // first ordinary case tried — a single-key program with an established history, an unscannable
  // image and a widened account set scored 110 raw and screamed — which constraint 2 forbids. The
  // tightened gate below is that deviation, and the rarity test in test/danger.test.ts is its evidence:
  // a non-zero integrity axis is not enough, the run needs *positive* malice evidence, of exactly two
  // kinds Dot can observe. The 30-point integrity band is reachable only from funding evidence, never
  // from posture, and an undeclared selector is a selector the published interface denies. Absence of
  // verification is deliberately neither: `unscannable` says Dot could not look, and a heuristic that
  // reads blindness as evidence of wrongdoing will be loud on exactly the programs nobody can verify.
  const integrityFromEvidence = (integrity.points ?? 0) >= AXIS_MAX.authorityIntegrity;
  const undeclaredSelector = (i.delta?.undeclaredEntrypoints.length ?? 0) > 0;
  const flagged =
    measured && score >= MALICE_TOTAL_SCORE_GATE && authorityIntegrityPositive && (integrityFromEvidence || undeclaredSelector);

  const evidenceParts: string[] = [];
  if (integrity.points !== null && integrity.points > 0) evidenceParts.push(`Authority integrity ${integrity.points}/${integrity.max}: ${integrity.detail.join('; ') || integrity.label}.`);
  if (anomaly.points !== null && anomaly.points > 0) evidenceParts.push(`Code anomaly ${anomaly.points}/${anomaly.max}: ${anomaly.detail.join('; ')}.`);
  if (timing.points !== null && timing.points > 0) evidenceParts.push(`Timing ${timing.points}/${timing.max}: ${timing.detail.join('; ')}.`);
  const unmeasured = signatureAxes.filter((a) => a.points === null).map((a) => a.id);
  // When the clamp bit, say so inside the accusation: "Score: 100/100" is the one number a reader
  // is most likely to take as a measurement, and here it is arithmetic — three axes maxed out and the
  // ceiling reached, which rawScore is the only figure that shows.
  const clampNote = rawScore > 100 ? ` (raw ${rawScore}/180 before the clamp)` : '';
  const evidence = flagged
    ? `${evidenceParts.join(' ')}${unmeasured.length ? ` Not measured: ${unmeasured.join(', ')}.` : ''} Score: ${score}/100${clampNote}.`
    : measured
      ? `Signature axes total ${maliceScore}/${AXIS_MAX.authorityIntegrity + AXIS_MAX.codeAnomaly + AXIS_MAX.timingAnomaly}; the gate needs the overall score at or above ${MALICE_TOTAL_SCORE_GATE}${authorityIntegrityPositive ? '' : ' with a non-zero authority-integrity axis'}.`
      : 'No malice signature axis was measurable on this run, so the heuristic reports nothing — which is not a clean result.';

  return {
    malice: {
      flagged,
      verdictLine: flagged ? SUSPECTED_MALICIOUS_VERDICT : null,
      maliceScore,
      gate: { totalScoreAtLeast: MALICE_TOTAL_SCORE_GATE, totalScore: score, authorityIntegrityPositive, positiveEvidence: integrityFromEvidence || undeclaredSelector, measured },
      evidence,
      disclaimer:
        'This is a heuristic over structural and behavioural signatures, not a judgement about intent. Dot does not classify malice (see NO_MALICE_DETECTION); a team with a fresh ops wallet, a stale IDL and an honest upgrade produces the same signature as an attacker, and that is the accepted cost of a scream that is tuned to be rare.',
    },
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
  if (d.rawScore > 100) L.push(`  raw ${d.rawScore} before the 100 clamp; the seven axes sum to 180, not 100`);
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
  L.push(maliceBlock(d));
  L.push('');
  L.push(`VERDICT: ${d.verdict}`);
  return L.join('\n');
}

/**
 * The malice section. The label says what it is — a heuristic over signatures — before any of the
 * evidence does the shouting, because the whole value of a rare scream is that a reader can tell it
 * apart from a finding without having to know how this number was made.
 */
function maliceBlock(d: DangerAssessment): string {
  const m = d.malice;
  const total = AXIS_MAX.authorityIntegrity + AXIS_MAX.codeAnomaly + AXIS_MAX.timingAnomaly;
  const L: string[] = [];
  if (!m.gate.measured) {
    L.push(`MALICE HEURISTIC: not assessed — no signature axis had data on this run (${m.evidence})`);
    return L.join('\n');
  }
  if (m.flagged) {
    L.push('MALICE HEURISTIC: **SUSPECTED_MALICIOUS** — a scream, not a proof');
    // The brief's alarm sentence, unindented and verbatim, immediately under its own heading. There are
    // now two `VERDICT:` lines in this block — this one, and the queue-position verdict at the bottom
    // of the ranking. That is what the two briefs asked for; the heading above is what tells them apart,
    // so do not "resolve" the duplication by deleting either one.
    L.push(m.verdictLine!);
    L.push(`  ${m.evidence}`);
    const parts = d.axes
      .filter((a) => (MALICE_AXES as readonly string[]).includes(a.id))
      .map((a) => `${a.id} ${a.points ?? 0}/${a.max}`);
    L.push(`  signature axes: ${parts.join(', ')} = ${m.maliceScore}/${total}`);
    L.push(`  gate: overall score ${m.gate.totalScore} >= ${m.gate.totalScoreAtLeast} AND authority integrity ${m.gate.authorityIntegrityPositive ? '> 0' : '= 0 (gate not satisfied)'}`);
    L.push(`  ${m.disclaimer}`);
    return L.join('\n');
  }
  L.push(`MALICE HEURISTIC: not flagged. ${m.evidence}`);
  return L.join('\n');
}

const cap = (id: DangerAxisId) =>
  ({
    authority: 'Authority',
    codeDelta: 'Code Delta',
    blastRadius: 'Blast Radius',
    behavior: 'Behavior',
    authorityIntegrity: 'Authority Integrity',
    codeAnomaly: 'Code Anomaly',
    timingAnomaly: 'Timing Anomaly',
  })[id];
