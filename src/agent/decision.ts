import type { AuthorityPosture } from '../state/programdata.js';
import type { EvidenceLedger } from './evidence.js';
import type { Hypothesis } from './hypothesis.js';

/** Anything the Decide step is allowed to look at before spending on a trace pull. */
export type UpgradeContext = {
  program: string;
  programData: string;
  label?: string;
  kind: 'upgrade' | 'authority_change' | 'program_data_closed' | 'program_data_reopened';
  change: {
    bytecodeChanged: boolean;
    authorityChanged: boolean;
    sizeChanged: boolean;
    beforeBytes: number | null;
    afterBytes: number | null;
  };
  authority: {
    before: string | null;
    after: string | null;
    posture: AuthorityPosture;
  };
  /** Cached, cheap signals the watcher already knows. Null means "not looked yet". */
  history: {
    signaturesAvailable: number | null;
    lastAnalysisAt: number | null;
    knownDependents: number | null;
    lamportsRoutedLast: number | null;
  };
  idl: { available: boolean; source?: string; diffText?: string };
  /** Operator overrides that let a human force a deep look regardless of score. */
  forceFullTrace?: boolean;
  notes?: string;
  /**
   * The agent's own remaining resources, supplied by the Scout before Decide runs.
   * Without this the "plan" is a constant that a later clamp quietly overrides, and
   * nothing in the report shows the plan ever responded to the budget.
   */
  budget?: {
    remainingRpcCalls: number;
    remainingSignatures: number;
    elapsedMs: number;
    maxWallMs: number;
  };
};

export type Decision = {
  /** Proceed to the expensive phase: pull and parse historical traces. */
  proceed: boolean;
  rationale: string;
  confidence: 'low' | 'medium' | 'high';
  /** Every input that moved the needle, so a reviewer can re-derive the choice. */
  signals: Record<string, string | number | boolean | null>;
  source: 'rules' | 'llm' | 'rules_fallback';
  /**
   * How many signatures this run plans to pull, and how many RPC calls that
   * costs. The agent sets its own sample size from the context and the budget it
   * has left — this is the difference between a decision and a constant.
   */
  plan: {
    signatures: number;
    rpcCalls: number;
    useLlm: boolean;
    /**
     * What the risk warranted before the budget was consulted. Coverage is measured
     * against this, not against `signatures`: an agent that wanted 25 traces and
     * planned 1 must report 4% coverage, not a flattering 100%.
     */
    wantedSignatures: number;
  };
  /**
   * The agent asking for more than it was given, with the size of the ask and the
   * reason. This is the point at which a scanner would simply return a thin result;
   * an agent says what it could not confirm and how much it would need.
   */
  escalation?:
    | {
        kind: 'needs_more_budget';
        requestedRpcCalls: number;
        reason: string;
        whatItWouldConfirm: string;
        /** Attached by the Scout once it knows what the run actually observed. */
        hypothesis?: Hypothesis;
      }
    | { kind: 'widen_to_authority'; reason: string };
  llmTokensUsed: number;
  /** Populated when an LLM decision was refused for a structural reason. */
  rejected?: { reason: string; detail?: Record<string, unknown> };
};

/**
 * The Decide seam. One interface, two implementations: a deterministic rule
 * engine that is the default (and the fallback), and a real model behind
 * `mode: real`.
 *
 * The ledger is passed in rather than constructed by the engine, because the
 * engine must be able to cite the *same* evidence the report will print. An
 * engine holding its own ledger would reject every valid citation.
 *
 * The rule engine is not a stub to be embarrassed about. It is the version that
 * runs identically in CI, in a review, and on a machine with no API key, and the
 * LLM implementation is only allowed to differ from it in ways it can cite.
 */
export interface DecisionEngine {
  readonly name: string;
  decide(ctx: UpgradeContext, ledger: EvidenceLedger): Promise<Decision>;
}

export function decisionTrace(d: Decision): Record<string, unknown> {
  return {
    source: d.source,
    proceed: d.proceed,
    confidence: d.confidence,
    rationale: d.rationale,
    signals: d.signals,
    plan: d.plan,
    ...(d.escalation ? { escalation: d.escalation } : {}),
    llmTokensUsed: d.llmTokensUsed,
    ...(d.rejected ? { rejected: d.rejected } : {}),
  };
}
