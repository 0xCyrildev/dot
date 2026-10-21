import type { DecisionEngine, Decision, UpgradeContext } from './decision.js';

export type RuleThresholds = {
  /** Bytecode size delta (fraction) that counts as a large change. */
  largeSizeDelta: number;
  /** Dependents above which even a boring upgrade deserves a look. */
  manyDependents: number;
  sampleSmall: number;
  sampleMedium: number;
  sampleLarge: number;
  rpcPerSignature: number;
  /** Below this a sample cannot distinguish "no dependents" from "not in the sample". */
  confirmableSignatures: number;
};

const DEFAULTS: RuleThresholds = {
  largeSizeDelta: 0.15,
  manyDependents: 12,
  sampleSmall: 25,
  sampleMedium: 100,
  sampleLarge: 250,
  rpcPerSignature: 1,
  confirmableSignatures: 12,
};

/**
 * The deterministic decision engine. Default backend, and the one `mode: real`
 * falls back to when a model call fails or a model answer cannot be cited.
 *
 * The load-bearing rule is the `null` handling: an unobserved dependent count is
 * **not** a zero dependent count. Treating "we have never looked" as "nobody
 * depends on this" is how an early-exit agent gets a clean bill of health on its
 * very first sight of a program.
 */
export class RuleBasedDecision implements DecisionEngine {
  readonly name = 'rules';
  private readonly t: RuleThresholds;

  constructor(thresholds: Partial<RuleThresholds> = {}) {
    this.t = { ...DEFAULTS, ...thresholds };
  }

  async decide(ctx: UpgradeContext): Promise<Decision> {
    const signals: Record<string, string | number | boolean | null> = {
      kind: ctx.kind,
      authority_posture: ctx.authority.posture,
      bytecode_changed: ctx.change.bytecodeChanged,
      authority_changed: ctx.change.authorityChanged,
      size_changed: ctx.change.sizeChanged,
      size_delta_pct: sizeDeltaPct(ctx),
      dependents_known: ctx.history.knownDependents,
      signatures_available: ctx.history.signaturesAvailable,
      idl_available: ctx.idl.available,
      forced: ctx.forceFullTrace === true,
    };

    const blockers: string[] = [];
    if (ctx.forceFullTrace) blockers.push('operator forced a full trace');
    if (ctx.kind !== 'upgrade') {
      blockers.push(`${ctx.kind} is not a code change but is exactly the kind of state change that breaks integrators`);
    }
    if (ctx.change.authorityChanged) {
      blockers.push('upgrade authority rotated — whoever can push the next change is a different party than before');
    }
    if (ctx.authority.posture === 'eoa') {
      blockers.push('authority is a single key: a one-wallet compromise can push a replacement immediately, with no threshold to wait on');
    }
    if (ctx.authority.posture === 'unknown' || ctx.authority.posture === 'program_derived') {
      blockers.push('authority is not classifiable from chain data alone — an unverified governance path is treated as unreviewed, not as safe');
    }
    if (sizeDeltaPct(ctx) !== null && Math.abs(sizeDeltaPct(ctx) as number) >= this.t.largeSizeDelta) {
      blockers.push(`bytecode size moved by ${((sizeDeltaPct(ctx) as number) * 100).toFixed(1)}%`);
    }
    if (ctx.history.knownDependents === null) {
      blockers.push('no prior graph for this program: blast radius is unobserved, which is not the same as zero');
    } else if (ctx.history.knownDependents > 0) {
      blockers.push(`${ctx.history.knownDependents} attributed caller program(s) from prior traces`);
    }

    // The stop case, stated positively so it is auditable rather than an absence.
    if (blockers.length === 0 && ctx.authority.posture === 'multisig' && ctx.history.knownDependents === 0) {
      return {
        proceed: false,
        rationale:
          'Stopped in Decide. Multisig-held authority, no attributed dependents in prior traces, bytecode-only change with no size move. ' +
          'A trace pull here costs RPC and buys nothing a cached graph has not already answered.',
        confidence: 'medium',
        signals,
        source: 'rules',
        plan: { signatures: 0, rpcCalls: 0, useLlm: false, wantedSignatures: 0 },
        llmTokensUsed: 0,
      };
    }

    const dependents = ctx.history.knownDependents ?? 0;
    const want =
      dependents > 100 ? this.t.sampleLarge : dependents >= this.t.manyDependents ? this.t.sampleMedium : this.t.sampleSmall;

    // The plan is derived from what is actually left, not from a tier constant that
    // a later clamp overrides. One call is reserved for the signature walk itself and
    // the perceive read is already spent.
    const remaining = ctx.budget?.remainingRpcCalls ?? want;
    const remainingSignatures = ctx.budget?.remainingSignatures ?? want;
    const affordableSignatures = Math.max(0, Math.min(want, remainingSignatures, remaining - 1));
    const riskWarranted =
      ctx.authority.posture === 'eoa' || ctx.authority.posture === 'unknown' || ctx.change.authorityChanged || ctx.kind === 'program_data_closed';

    if (riskWarranted && affordableSignatures < this.t.confirmableSignatures) {
      return {
        proceed: affordableSignatures > 0,
        escalation: {
          kind: 'needs_more_budget',
          requestedRpcCalls: Math.max(want - affordableSignatures, 1),
          reason: `${ctx.authority.posture} authority${ctx.change.authorityChanged ? ' with the authority rotated' : ''} and ${
            ctx.history.knownDependents === null ? 'no prior graph' : `${ctx.history.knownDependents} attributed caller(s)`
          }: a sample of ${affordableSignatures} signature(s) cannot distinguish "no dependents" from "dependents outside the sample"`,
          whatItWouldConfirm: `a ${want}-signature sample of transactions touching ${ctx.program}`,
        },
        rationale: `Wants ${want} signature(s); only ${affordableSignatures} affordable. ${blockers.join('; ') || 'risk-warranted deep look'}`,
        confidence: 'low',
        signals: { ...signals, wanted_signatures: want, affordable_signatures: affordableSignatures, remaining_rpc: remaining },
        source: 'rules',
        plan: {
          signatures: affordableSignatures,
          rpcCalls: affordableSignatures * this.t.rpcPerSignature + 1,
          useLlm: false,
          wantedSignatures: want,
        },
        llmTokensUsed: 0,
      };
    }

    return {
      proceed: true,
      rationale: blockers.join('; ') || 'defaulting to a trace pull because nothing proved the blast radius is already known',
      confidence: ctx.authority.posture === 'eoa' || ctx.change.authorityChanged ? 'high' : 'medium',
      signals: { ...signals, wanted_signatures: want, affordable_signatures: affordableSignatures, remaining_rpc: remaining },
      source: 'rules',
      plan: {
        signatures: affordableSignatures,
        rpcCalls: affordableSignatures * this.t.rpcPerSignature + 1,
        useLlm: ctx.idl.available,
        wantedSignatures: want,
      },
      llmTokensUsed: 0,
      ...(riskWarranted && affordableSignatures < want
        ? {
            escalation: {
              kind: 'widen_to_authority' as const,
              reason: 'sample is smaller than the risk warrants; if the first pass finds no dependents, widen to the authority history',
            },
          }
        : {}),
    };
  }
}

export function sizeDeltaPct(ctx: UpgradeContext): number | null {
  const { beforeBytes, afterBytes } = ctx.change;
  if (beforeBytes === null || afterBytes === null || beforeBytes === 0) return null;
  return (afterBytes - beforeBytes) / beforeBytes;
}
