import { z } from 'zod';
import type { Narrative } from '../report.js';
import { Budget } from './budget.js';
import { EvidenceLedger } from './evidence.js';
import type { Decision, DecisionEngine, UpgradeContext } from './decision.js';
import { DotError } from '../errors.js';

export type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const apiKey = env.DOT_LLM_API_KEY ?? env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return {
    baseUrl: (env.DOT_LLM_BASE_URL ?? env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey,
    model: env.DOT_LLM_MODEL ?? 'gpt-4o-mini',
    maxOutputTokens: Number(env.DOT_LLM_MAX_OUTPUT_TOKENS ?? 700),
    ...(env.DOT_LLM_TIMEOUT_MS ? { timeoutMs: Number(env.DOT_LLM_TIMEOUT_MS) } : {}),
  };
}

const LlmDecisionSchema = z.object({
  proceed: z.boolean(),
  confidence: z.enum(['low', 'medium', 'high']),
  rationale: z.string().min(8),
  cites: z.array(z.string()).min(1),
  planned_signatures: z.number().int().min(0).max(1000).optional(),
  // The model may propose the hypothesis in the same schema the rule engine uses.
  // It is not privileged: every field must be backed by cited evidence ids, and an
  // unresolvable citation discards the whole answer including this part of it.
  hypothesis: z
    .object({
      claim: z.string().min(12),
      falsifier: z.string().min(12),
      evidence_for: z.array(z.string()).min(1),
      evidence_against: z.array(z.string()).min(1),
      test_plan: z.array(z.object({ action: z.string().min(8), requested_rpc_calls: z.number().int().min(0).max(5000) })).min(1),
      cites: z.array(z.string()).min(1),
    })
    .optional(),
});

const LlmNarrativeSchema = z.object({
  what_changed: z.string().min(8),
  likely_impact_on_callers: z.string().min(8),
  cannot_determine: z.string().min(8),
  cites: z.array(z.string()).min(1),
});

const SYSTEM = [
  'You are the Decide stage of Dot, a Solana blast-radius analyzer. You are given a ledger of OBSERVED evidence, each item with an id.',
  'You may only assert facts covered by those ids. Cite at least one id for every claim. Do not invent program ids, do not assume an authority is a multisig, and do not describe code behaviour you were not given an IDL or disassembly for.',
  'If the IDL diff is absent or truncated, you must say that the semantics of the change cannot be determined, and base your decision on posture and observed call-graph evidence only.',
  'Your output does not set severity directly. It is checked: unresolved citations are discarded.',
  'Return JSON only.',
].join(' ');

function evidenceBlock(ledger: EvidenceLedger): string {
  return ledger
    .all()
    .map((e) => `${e.id} [${e.kind}] ${e.summary}${e.ref?.signature ? ` sig=${e.ref.signature.slice(0, 16)}…` : ''}`)
    .join('\n');
}

function estimateTokens(text: string): number {
  // 3.5 chars/token is the pessimistic-but-not-absurd English heuristic; the real
  // number is settled from the API's usage field afterwards.
  return Math.ceil(text.length / 3.5);
}

type Completion = { content: string; promptTokens: number; completionTokens: number };

/** Minimal OpenAI-compatible chat completions client. No SDK, no streaming. */
async function complete(cfg: LlmConfig, user: string): Promise<Completion> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
    temperature: 0,
    max_tokens: cfg.maxOutputTokens,
    response_format: { type: 'json_object' },
  };
  const res = await doFetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 45_000),
  });
  if (!res.ok) {
    // The API key is in the Authorization header, never in this string.
    throw new DotError('LLM_UNAVAILABLE', `chat/completions returned HTTP ${res.status}`, { status: res.status });
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new DotError('LLM_UNAVAILABLE', 'chat/completions returned no message content', {});
  }
  return {
    content,
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
  };
}

const BlastNarrativeSchema = z.object({
  most_likely_impact: z.string().min(8),
  what_dependent_operators_should_do: z.string().min(8),
  cannot_determine: z.string().min(8),
  cites: z.array(z.string()).min(1),
});

export type BlastAdvisory = {
  mostLikelyImpact: string;
  whatOperatorsShouldDo: string;
  cannotDetermine: string;
  cites: string[];
  tokensUsed: number;
  inputs: { valueRouted: boolean; dependents: boolean; idlDelta: boolean; posture: boolean };
  refused?: string;
};

/**
 * The blast-radius advisory.
 *
 * Different question from the IDL narrator: not "what changed in the code" but "what
 * should the operators downstream do about it". Four inputs are required, and the
 * return records which of them were actually present, so an advisory produced without
 * an IDL cannot be quoted later as though it had one.
 *
 * The same citation gate applies. This is an advisory, not a finding: it has no path
 * into the tier, and a discarded answer is reported as discarded.
 */
export async function narrateBlastRadius(
  cfg: LlmConfig,
  budget: Budget,
  ledger: EvidenceLedger,
  ctx: UpgradeContext,
  graph: {
    program: string;
    valueRoutedLamports: number;
    mintsTouched: number;
    dependents: Array<{ program: string; count: number; lamportsRouted: number }>;
    idlDiff?: string;
    posture: string;
    authorityRotated: boolean;
  },
): Promise<BlastAdvisory> {
  const inputs = {
    valueRouted: Number.isFinite(graph.valueRoutedLamports),
    dependents: graph.dependents.length > 0,
    idlDelta: Boolean(graph.idlDiff && graph.idlDiff.trim() !== ''),
    posture: Boolean(graph.posture),
  };

  const user = [
    'You are the advisory stage of Dot, a Solana blast-radius analyzer. Answer two questions: the most likely impact of this upgrade on programs that call this one, and what those programs\' operators should do.',
    '',
    `1. VALUE ROUTED THROUGH ${graph.program} (upper-bound proxy, per transaction, NOT TVL and NOT custody): ` +
      `${graph.valueRoutedLamports} lamports across ${graph.mintsTouched} mint(s).`,
    `2. DEPENDENT PROGRAMS, each with its own attributed value: ${
      graph.dependents.length > 0
        ? graph.dependents
            .slice(0, 20)
            .map((d) => `${d.program} (${d.count} CPI(s), ${d.lamportsRouted} lamports)`)
            .join('; ')
        : 'NONE ATTRIBUTED — say so; do not describe this as safe'
    }`,
    `3. IDL DELTA: ${inputs.idlDelta ? graph.idlDiff : 'NOT AVAILABLE — the semantics of the change cannot be determined; reason only from posture and the observed graph'}`,
    `4. UPGRADE AUTHORITY POSTURE: ${graph.posture}${graph.authorityRotated ? ' (ROTATED in this event — the party who can push the next change is a different party than before)' : ' (unchanged)'}`,
    '',
    'Rules: you may only assert facts covered by the evidence ids below. Name the thing the evidence does not cover in "cannot_determine" — being specific is the deliverable. Do not convert proxy value into a dollar or TVL figure. Do not advise a course of action that requires information you were not given.',
    '',
    'EVIDENCE:',
    evidenceBlock(ledger),
    '',
    'Schema: {"most_likely_impact":str,"what_dependent_operators_should_do":str,"cannot_determine":str,"cites":["EV-n"]}',
  ].join('\n');

  const estimate = estimateTokens(user) + cfg.maxOutputTokens;
  try {
    budget.reserveTokens(estimate);
  } catch (e) {
    if (e instanceof DotError && e.code === 'BUDGET_EXHAUSTED_TOKENS') {
      return { mostLikelyImpact: '', whatOperatorsShouldDo: '', cannotDetermine: 'no advisory produced', cites: [], tokensUsed: 0, inputs, refused: 'token budget refused the advisory call' };
    }
    throw e;
  }

  try {
    const c = await complete(cfg, user);
    const parsed = BlastNarrativeSchema.parse(extractJson(c.content));
    budget.settleTokens(c.promptTokens + c.completionTokens);
    const { ok, bad } = ledger.resolveCitations(parsed.cites);
    if (bad.length > 0) {
      return {
        mostLikelyImpact: '',
        whatOperatorsShouldDo: '',
        cannotDetermine: 'advisory discarded',
        cites: ok,
        tokensUsed: c.promptTokens + c.completionTokens,
        inputs,
        refused: `discarded: cited ${bad.length} non-existent evidence id(s); the whole answer was dropped, not trimmed`,
      };
    }
    return {
      mostLikelyImpact: parsed.most_likely_impact,
      whatOperatorsShouldDo: parsed.what_dependent_operators_should_do,
      cannotDetermine: parsed.cannot_determine,
      cites: ok,
      tokensUsed: c.promptTokens + c.completionTokens,
      inputs,
    };
  } catch (e) {
    budget.settleTokens(estimate);
    return {
      mostLikelyImpact: '',
      whatOperatorsShouldDo: '',
      cannotDetermine: 'no advisory produced',
      cites: [],
      tokensUsed: estimate,
      inputs,
      refused: e instanceof DotError ? `${e.code}: ${e.message}` : String(e),
    };
  }
}

/** Advisory → report narrative. The advisory's own fields are kept, not flattened away. */
export function advisoryToNarrative(a: BlastAdvisory): Narrative {
  return {
    whatChanged: a.mostLikelyImpact,
    likelyImpactOnCallers: a.whatOperatorsShouldDo,
    cannotDetermine: a.cannotDetermine,
    cites: a.cites,
    tokensUsed: a.tokensUsed,
    mostLikelyImpact: a.mostLikelyImpact,
    whatOperatorsShouldDo: a.whatOperatorsShouldDo,
    inputs: a.inputs,
    ...(a.refused ? { refused: a.refused } : {}),
  };
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    if (fence?.[1]) return JSON.parse(fence[1]);
    const brace = /{[\s\S]*}/.exec(text);
    if (brace) return JSON.parse(brace[0]);
    throw new DotError('LLM_UNAVAILABLE', 'model reply was not JSON', { preview: text.slice(0, 160) });
  }
}

/**
 * `mode: real` decision backend.
 *
 * Wraps a model, but is not a wrapper that trusts it:
 *   - the token reservation happens before the request and reconciles against
 *     the billed `usage` after it, so `overrun` is visible instead of implicit;
 *   - citations are checked against the evidence ledger and an answer that cites
 *     an id that was never issued is discarded wholesale, not truncated;
 *   - any failure degrades to the rule engine with the reason recorded.
 * A model that is unavailable must never turn into a silent "no risk found".
 */
export class RealLlmDecision implements DecisionEngine {
  readonly name = 'llm';

  constructor(
    private readonly cfg: LlmConfig,
    private readonly fallback: DecisionEngine,
    private readonly budget: Budget,
  ) {}

  async decide(ctx: UpgradeContext, ledger: EvidenceLedger): Promise<Decision> {
    const rules = await this.fallback.decide(ctx, ledger);
    const user = [
      'DECIDE whether to spend the trace-pull budget on this upgrade.',
      `PROGRAM ${ctx.label ? `${ctx.label} ` : ''}${ctx.program}`,
      `EVENT ${ctx.kind}`,
      `AUTHORITY before=${ctx.authority.before ?? 'none'} after=${ctx.authority.after ?? 'none'} posture=${ctx.authority.posture}`,
      `BYTECODE ${ctx.change.beforeBytes ?? '?'} -> ${ctx.change.afterBytes ?? '?'} bytes (changed=${ctx.change.bytecodeChanged}, sizeChanged=${ctx.change.sizeChanged})`,
      `PRIOR GRAPH dependents=${ctx.history.knownDependents ?? 'unobserved'} availableSignatures=${ctx.history.signaturesAvailable ?? 'unobserved'}`,
      `IDL ${ctx.idl.available ? `AVAILABLE (${ctx.idl.source ?? 'unknown source'})\n${clip(ctx.idl.diffText ?? '', 3000)}` : 'NOT AVAILABLE — semantics of the change cannot be determined'}`,
      `REMAINING BUDGET rpcCalls=${this.budget.snapshot().remaining.rpcCalls} signatures=${this.budget.snapshot().remaining.signatures}`,
      '',
      'EVIDENCE:',
      evidenceBlock(ledger),
      '',
      'Schema: {"proceed":bool,"confidence":"low|medium|high","rationale":str,"cites":["EV-n"],"planned_signatures":int,"hypothesis":{"claim":str,"falsifier":str,"evidence_for":[str],"evidence_against":[str],"test_plan":[{"action":str,"requested_rpc_calls":int}],"cites":["EV-n"]}}',
    'If you supply a hypothesis it must be falsifiable in one observation, and every field of it must be backed by the evidence ids you cite.',
    ].join('\n');

    const estimate = estimateTokens(user) + this.cfg.maxOutputTokens;
    try {
      this.budget.reserveTokens(estimate);
    } catch (e) {
      if (e instanceof DotError && e.code === 'BUDGET_EXHAUSTED_TOKENS') {
        return { ...rules, rejected: { reason: 'token budget refused the LLM call', detail: e.details } };
      }
      throw e;
    }

    try {
      const c = await complete(this.cfg, user);
      const parsed = LlmDecisionSchema.parse(extractJson(c.content));
      const { ok, bad } = ledger.resolveCitations(parsed.cites);
      this.budget.settleTokens(c.promptTokens + c.completionTokens);

      if (bad.length > 0) {
        return {
          ...rules,
          rejected: {
            reason: `model cited ${bad.length} evidence id(s) that Dot never issued`,
            detail: { bad, known: ledger.knownIds().length, accepted: ok },
          },
        };
      }
      if (parsed.cites.length > ok.length) {
        return { ...rules, rejected: { reason: 'model returned no resolvable citations' } };
      }

      const signatures = Math.min(
        parsed.planned_signatures ?? rules.plan.signatures,
        this.budget.affordableSignatures(1),
        1000,
      );
      return {
        proceed: parsed.proceed,
        rationale: parsed.rationale,
        confidence: parsed.confidence,
        signals: { ...rules.signals, llm_cites: ok.join(','), engine: 'llm' },
        source: 'llm',
        plan: {
        signatures,
        rpcCalls: signatures,
        useLlm: parsed.proceed && ctx.idl.available,
        wantedSignatures: Math.max(rules.plan.wantedSignatures, signatures),
      },
      llmTokensUsed: c.promptTokens + c.completionTokens,
      ...(parsed.hypothesis
        ? {
            escalation: {
              kind: 'needs_more_budget' as const,
              requestedRpcCalls: parsed.hypothesis.test_plan.reduce((s2, t) => s2 + t.requested_rpc_calls, 0),
              reason: parsed.hypothesis.claim,
              whatItWouldConfirm: parsed.hypothesis.falsifier,
              hypothesis: {
                claimKind: 'unknown_coverage' as const,
                claim: parsed.hypothesis.claim,
                evidenceFor: parsed.hypothesis.evidence_for,
                evidenceAgainst: parsed.hypothesis.evidence_against,
                testPlan: parsed.hypothesis.test_plan.map((t) => ({
                  action: t.action,
                  requestedRpcCalls: t.requested_rpc_calls,
                  outcomeIfPositive: 'the claim would be tested; the falsifier names what would deny it',
                })),
                falsifier: parsed.hypothesis.falsifier,
                derivedFrom: { ...rules.signals, source: 'llm', cites: ok.join(',') },
              },
            },
          }
        : {}),
    };
    } catch (e) {
      this.budget.settleTokens(estimate);
      if (e instanceof z.ZodError) {
        return { ...rules, rejected: { reason: 'model reply failed schema validation', detail: { issues: e.issues.slice(0, 3) } } };
      }
      if (e instanceof DotError) {
        return { ...rules, rejected: { reason: `model call failed (${e.code})`, detail: e.details } };
      }
      return { ...rules, rejected: { reason: 'model call failed', detail: { message: String(e) } } };
    }
  }
}

/**
 * The IDL-diff reader. Produces prose for the report and nothing else: it has no
 * path into the tier, which is computed from posture + graph evidence in code.
 * A narrative that cannot cite is returned as a refusal, not as an empty string
 * that a reader might mistake for "no impact".
 */
export async function narrateIdlDiff(
  cfg: LlmConfig,
  budget: Budget,
  ledger: EvidenceLedger,
  ctx: UpgradeContext,
  graphSummary: string,
): Promise<Narrative> {
  const user = [
    'Explain what this Solana program upgrade means for the programs that call it, using ONLY the evidence ids given.',
    `IDL DIFF (may be truncated or absent):\n${ctx.idl.available ? clip(ctx.idl.diffText ?? '', 6000) : 'NONE AVAILABLE'}`,
    `OBSERVED CALL GRAPH:\n${graphSummary}`,
    '',
    'EVIDENCE:',
    evidenceBlock(ledger),
    '',
    'Schema: {"what_changed":str,"likely_impact_on_callers":str,"cannot_determine":str,"cites":["EV-n"]}',
    '"cannot_determine" is mandatory and must name the specific thing the evidence does not cover.',
  ].join('\n');

  const estimate = estimateTokens(user) + cfg.maxOutputTokens;
  budget.reserveTokens(estimate);
  try {
    const c = await complete(cfg, user);
    const parsed = LlmNarrativeSchema.parse(extractJson(c.content));
    budget.settleTokens(c.promptTokens + c.completionTokens);
    const { ok, bad } = ledger.resolveCitations(parsed.cites);
    if (bad.length > 0) {
      return {
        whatChanged: '',
        likelyImpactOnCallers: '',
        cannotDetermine: 'narrative discarded',
        cites: ok,
        tokensUsed: c.promptTokens + c.completionTokens,
        refused: `discarded: cited ${bad.length} non-existent evidence id(s)`,
      };
    }
    return {
      whatChanged: parsed.what_changed,
      likelyImpactOnCallers: parsed.likely_impact_on_callers,
      cannotDetermine: parsed.cannot_determine,
      cites: ok,
      tokensUsed: c.promptTokens + c.completionTokens,
    };
  } catch (e) {
    budget.settleTokens(estimate);
    return {
      whatChanged: '',
      likelyImpactOnCallers: '',
      cannotDetermine: 'no narrative produced',
      cites: [],
      tokensUsed: estimate,
      refused: e instanceof DotError ? `${e.code}: ${e.message}` : String(e),
    };
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…[${s.length - n} chars clipped by Dot]` : s;
}
