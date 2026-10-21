import type { UpgradeContext } from '../agent/decision.js';

export type ExposureSignals = {
  directCallers: number;
  transitiveCallers: number;
  edges: number;
  cpiOccurrences: number;
  failedCpiOccurrences: number;
  distinctTransactions: number;
  /** Sum of per-edge attributions. NOT a total: repeated across calls that share an account. */
  lamportsRouted: number;
  /** Each receiving account counted once per transaction. This is the headline number. */
  lamportsMovedDeduped: number;
  mintsTouched: number;
  selfCpi: boolean;
};

export type EvidenceSignals = {
  signaturesPlanned: number;
  signaturesFound: number;
  signaturesPruned: number;
  fetchErrors: number;
  duplicateSignatures: number;
  /** Fraction of the planned sample the node actually gave back. */
  sampleCoverage: number;
  attributionQuality: 'stackHeight' | 'logs' | 'flat';
  flattenedFrames: number;
  logTruncated: boolean;
  historySpanDays: number | null;
};

export type RiskTier = 'P0' | 'P1' | 'P2' | 'P3';

export type RiskComponent = {
  name: string;
  points: number;
  max: number;
  why: string;
};

export type RiskAssessment = {
  score: number;
  tier: RiskTier;
  /** Independent of severity: how much of the picture Dot was actually allowed to see. */
  confidence: 'high' | 'medium' | 'low';
  components: RiskComponent[];
  cappedBy: string | null;
};

const POSTURE_POINTS: Record<string, { max: number; why: string }> = {
  eoa: { max: 30, why: 'a single key can replace the program with no threshold and no delay' },
  unknown: { max: 26, why: 'authority not classifiable from chain data' },
  program_derived: { max: 18, why: 'authority is a PDA: gated by code Dot has not reviewed' },
  renounced: { max: 6, why: 'authority renounced: this may be the last upgrade this program ever sees' },
  multisig: { max: 8, why: 'threshold-held authority, as reported by the operator map' },
};

/** Log-scaled sub-score so one whale program cannot pin the meter at 40 dependents. */
function logScore(value: number, reference: number, max: number): number {
  if (value <= 0) return 0;
  return Math.round(Math.min(1, Math.log10(value + 1) / Math.log10(reference + 1)) * max);
}

/**
 * Triage ranking, not a vulnerability claim.
 *
 * The score answers "which of these upgrades should a human open first today".
 * It is built from posture, observed blast radius and change magnitude, and it is
 * reported alongside a separate `confidence` describing how much of that picture
 * the RPC was willing to show. A P1 at low confidence is a different task from a
 * P1 at high confidence, and collapsing the two into one number is the failure
 * mode this table exists to prevent.
 */
export function scoreRisk(
  ctx: UpgradeContext,
  exposure: ExposureSignals,
  evidence: EvidenceSignals,
): RiskAssessment {
  const components: RiskComponent[] = [];
  const posture = POSTURE_POINTS[ctx.authority.posture] ?? POSTURE_POINTS['unknown']!;

  let posturePoints = posture.max;
  if (ctx.change.authorityChanged) posturePoints = posture.max;
  else if (ctx.authority.posture === 'renounced') posturePoints = posture.max;
  else if (ctx.authority.posture === 'multisig') posturePoints = Math.round(posture.max * 0.6);
  components.push({ name: 'authority_posture', points: posturePoints, max: posture.max, why: posture.why });

  let eventPoints = 0;
  let eventWhy = 'bytecode-only change';
  if (ctx.kind === 'program_data_closed') {
    eventPoints = 24;
    eventWhy = 'ProgramData account closed: further upgrades are impossible and dependent calls may start failing';
  } else if (ctx.kind === 'program_data_reopened') {
    eventPoints = 16;
    eventWhy = 'ProgramData reappeared after being absent — Dot missed whatever happened in between';
  } else if (ctx.change.authorityChanged) {
    eventPoints = 22;
    eventWhy = 'upgrade authority changed hands';
  } else if (ctx.change.sizeChanged) {
    eventPoints = 10;
    eventWhy = 'bytecode size moved';
  }
  components.push({ name: 'change_magnitude', points: eventPoints, max: 24, why: eventWhy });

  const dependents = exposure.directCallers + exposure.transitiveCallers;
  const depPoints = logScore(dependents, 200, 22);
  components.push({ name: 'dependents', points: depPoints, max: 22, why: `${exposure.directCallers} direct, ${exposure.transitiveCallers} transitive attributed callers` });

  const volumePoints = logScore(exposure.cpiOccurrences, 100_000, 12);
  components.push({ name: 'cpi_volume', points: volumePoints, max: 12, why: `${exposure.cpiOccurrences} attributed CPI occurrences in the sample` });

  // 1e12 lamports ~= 1000 SOL as the reference point for "a lot routed through here".
  // Score on the deduped figure. Scoring on the edge sum would let a program with a
  // chatty but low-value graph outrank a quiet one moving real size.
  const valueBasis = exposure.lamportsMovedDeduped || exposure.lamportsRouted;
  const valuePoints = logScore(valueBasis, 1e12, 14);
  components.push({
    name: 'value_routed',
    points: valuePoints,
    max: 14,
    why: `${valueBasis} lamports moved (deduped per account per transaction; edge-sum attribution totals ${exposure.lamportsRouted}, which overcounts) across ${exposure.mintsTouched} mint(s)`,
  });

  if (exposure.selfCpi) {
    components.push({ points: 4, max: 4, name: 'self_cpi', why: 'program CPIs into itself: an upgrade changes re-entrancy behaviour' });
  }

  const raw = components.reduce((s, c) => s + c.points, 0);
  const cap = components.reduce((s, c) => s + c.max, 0);
  const normalized = Math.round((raw / cap) * 100);

  const coverage = evidence.sampleCoverage;
  const confidence: RiskAssessment['confidence'] = coverage >= 0.75 && evidence.attributionQuality !== 'flat'
    ? 'high'
    : coverage >= 0.4
      ? 'medium'
      : 'low';

  const cappedBy =
    evidence.attributionQuality === 'flat'
      ? 'attribution was flattened (no stackHeight, no logs): nested callers are credited to the top-level program, so dependent counts are an upper bound'
      : coverage < 0.4
        ? `only ${(coverage * 100).toFixed(0)}% of the planned sample was retrievable from the node`
        : null;

  const tier = tierFor(normalized, confidence);

  return { score: normalized, tier, confidence, components, cappedBy };
}

export function tierFor(score: number, confidence: RiskAssessment['confidence']): RiskTier {
  // Low confidence never mints a P0: an agent that could not see the graph does
  // not get to declare an emergency, it gets to declare a blind spot.
  if (confidence === 'low') return score >= 60 ? 'P1' : score >= 35 ? 'P2' : 'P3';
  if (score >= 68) return 'P0';
  if (score >= 45) return 'P1';
  if (score >= 25) return 'P2';
  return 'P3';
}

export const TIER_MEANING: Record<RiskTier, string> = {
  P0: 'Stop-and-verify. An attributed blast radius plus a posture that could have pushed this unilaterally. Treat the upgrade as hostile until the operator says otherwise.',
  P1: 'Review today. Either the exposure or the posture is significant; a human should read the diff and notify integrators.',
  P2: 'Queue for review. Real change, bounded exposure, or a gap in what the node would return.',
  P3: 'Informational. Logged, aggregated, no action expected.',
};
