import type { BudgetSnapshot } from './agent/budget.js';
import type { Evidence } from './agent/evidence.js';
import type { Graph } from './graph/builder.js';
import type { RiskComponent, RiskTier } from './score/risk.js';
import type { LimitNote } from './limits.js';
import type { ClientStats } from './rpc/client.js';

export type StageTrace = {
  stage: 'perceive' | 'decide' | 'act' | 'evaluate' | 'report';
  atMs: number;
  note: string;
  rpcCallsAfter: number;
};

export type Narrative = {
  whatChanged: string;
  likelyImpactOnCallers: string;
  cannotDetermine: string;
  cites: string[];
  tokensUsed: number;
  refused?: string;
  /** Advisory fields: what downstream operators should *do*. Present on the blast-radius path. */
  mostLikelyImpact?: string;
  whatOperatorsShouldDo?: string;
  /** Which of the four required inputs the advisory actually had. */
  inputs?: { valueRouted: boolean; dependents: boolean; idlDelta: boolean; posture: boolean };
};

export type DotReport = {
  schema: 'dot.report.v1';
  generatedAt: string;
  program: string;
  label?: string;
  mode: 'rules' | 'real';
  programData: string;
  event: string;
  tier: RiskTier;
  /**
   * What the tier is a statement about. `exposure` is the ordinary reading: posture
   * and blast radius. `integrity` means the tool's own inputs contradicted each
   * other and the run halted — a P0 of attention, never a verdict on the program.
   */
  tierSource: 'exposure' | 'integrity' | 'not_assessed';
  score: number;
  confidence: 'high' | 'medium' | 'low';
  components: RiskComponent[];
  cappedBy: string | null;
  /** Which stage ended the run. `decide` means Dot declined to spend on a trace pull. */
  stoppedAt: 'perceive' | 'decide' | 'act' | 'evaluate' | 'report';
  stopNote: string;
  decision: Record<string, unknown> | null;
  /** Programs co-invoked with the upgrade authority, when the widen path ran. Not dependents. */
  coControlledPrograms?: string[];
  widenNote?: string | null;
  blastRadius: {
    directCallers: number;
    transitiveCallers: number;
    edges: number;
    cpiOccurrences: number;
    failedCpiOccurrences: number;
    lamportsRouted: number;
    mintsTouched: number;
    tracesAnalyzed: number;
    tracesFailed: number;
    attributionQuality: 'stackHeight' | 'logs' | 'flat';
    historySpanDays: number | null;
    topDependents: Array<{ program: string; count: number; transactions: number; lamportsRouted: number }>;
    transitiveByDepth: Array<{ depth: number; program: string; via: string; count: number; lamportsRouted: number }>;
  } | null;
  graph: Graph | null;
  evidence: Evidence[];
  integrity?: { agreement: string; reason: string; endpoints: unknown[] };
  ingest?: {
    strategy: 'per_block' | 'per_signature';
    rationale: string;
    groups: number;
    byteAmplification?: number;
    callSavingRatio?: number;
    summary?: unknown;
  };
  limits: LimitNote[];
  narrative?: Narrative;
  budget: BudgetSnapshot;
  rpc: ClientStats;
  wallMs: number;
};

/**
 * The escalation line. Printed *after* the report is emitted, because the partial
 * answer is still the answer Dot has; the ask is what it would need to make the
 * answer stronger. Wording matters here: it must read as "I could not confirm", not
 * as "nothing found".
 */
export function formatEscalation(r: DotReport): string | null {
  const esc = (r.decision as { escalation?: { kind: string; requestedRpcCalls?: number; reason?: string; whatItWouldConfirm?: string } } | null)?.escalation;
  if (esc?.kind !== 'needs_more_budget') return null;
  const n = esc.requestedRpcCalls ?? 0;
  return [
    `Dot needs ${n} more RPC call(s) to confirm the blast radius for program ${r.program}.`,
    `Reason: ${esc.reason ?? 'unspecified'}`,
    `It would use them on: ${esc.whatItWouldConfirm ?? 'a larger trace sample'}.`,
    `Re-run with --budget-rpc +${n} (current ceiling ${r.budget.limits.maxRpcCalls}, spent ${r.budget.spent.rpcCalls}).`,
    `Until then this tier is capped by coverage: ${r.cappedBy ?? 'not stated'}.`,
  ].join('\n');
}

const SOL = 1_000_000_000;

export function renderMarkdown(r: DotReport): string {
  const L: string[] = [];
  const tierFlag =
    r.tier === 'P0' && r.tierSource === 'integrity'
      ? ' ← DATA INTEGRITY, not a program verdict'
      : r.tier === 'P0'
        ? ' ← act now'
        : '';
  L.push(`# Dot · ${r.label ? `${r.label} · ` : ''}${r.program}`);
  L.push('');
  L.push(`**${r.tier}** (tier source: ${r.tierSource}, score ${r.score}/100, confidence ${r.confidence})${tierFlag} — event \`${r.event}\`, mode \`${r.mode}\`, run ended at \`${r.stoppedAt}\``);
  if (r.integrity) {
    L.push('');
    L.push(`**Endpoint corroboration: \`${r.integrity.agreement}\`** — ${r.integrity.reason}`);
    for (const e of r.integrity.endpoints as Array<{ url: string; ok: boolean; slot: number | null; error?: string }>) {
      L.push(`- \`${e.url}\` ${e.ok ? `ok @ slot ${e.slot}` : `FAILED: ${e.error ?? 'unknown'}`}`);
    }
  }
  if (r.ingest) {
    L.push('');
    L.push(`Trace ingestion: \`${r.ingest.strategy}\` — ${r.ingest.rationale}`);
  }
  if (r.cappedBy) L.push('');
  if (r.cappedBy) L.push(`> Tier capped by a blind spot: ${r.cappedBy}`);
  L.push('');
  L.push(`ProgramData \`${r.programData}\``);
  L.push('');

  L.push('## Blast radius');
  if (!r.blastRadius) {
    L.push('');
    L.push('Not measured — the run stopped before the trace pull. Nothing here should be read as "no dependents".');
  } else {
    const b = r.blastRadius;
    L.push('');
    L.push('| metric | value |');
    L.push('| --- | --- |');
    L.push(`| direct callers attributed | ${b.directCallers} |`);
    L.push(`| transitive callers (≤3 hops) | ${b.transitiveCallers} |`);
    L.push(`| edges | ${b.edges} |`);
    L.push(`| CPI occurrences in sample | ${b.cpiOccurrences} (${b.failedCpiOccurrences} failed) |`);
    L.push(`| traces analyzed | ${b.tracesAnalyzed} (${b.tracesFailed} transactions that failed outright) |`);
    L.push(`| lamports inbound-attributed | ${b.lamportsRouted} (${(b.lamportsRouted / SOL).toFixed(3)} SOL) |`);
    L.push(`| distinct mints touched | ${b.mintsTouched} |`);
    L.push(`| attribution | \`${b.attributionQuality}\`${b.attributionQuality === 'flat' ? ' — dependent counts are an UPPER BOUND' : ''} |`);
    L.push(`| history span of sample | ${b.historySpanDays === null ? 'unknown' : `${b.historySpanDays.toFixed(2)} days`} |`);
    if (b.topDependents.length > 0) {
      L.push('');
      L.push('Top attributed callers:');
      L.push('');
      L.push('| caller | cpi | txs | lamports |');
      L.push('| --- | ---: | ---: | ---: |');
      for (const d of b.topDependents) L.push(`| \`${short(d.program)}\` | ${d.count} | ${d.transactions} | ${d.lamportsRouted} |`);
    }
    if (b.transitiveByDepth.filter((t) => t.depth > 1).length > 0) {
      L.push('');
      L.push('Transitive (who breaks if the thing that calls this breaks):');
      for (const t of b.transitiveByDepth.filter((x) => x.depth > 1).slice(0, 10)) {
        L.push(`- depth ${t.depth}: \`${short(t.program)}\` via \`${short(t.via)}\` (${t.count} CPI)`);
      }
    }
  }

  L.push('');
  L.push('## Why this tier');
  for (const c of r.components) L.push(`- **${c.name}** ${c.points}/${c.max} — ${c.why}`);

  L.push('');
  L.push('## Decision');
  if (r.decision) {
    const d = r.decision as Record<string, unknown>;
    L.push(`source \`${String(d.source)}\`, proceed \`${String(d.proceed)}\`, plan \`${JSON.stringify(d.plan)}\``);
    L.push(`> ${String(d.rationale)}`);
    if (d.rejected) L.push(`LLM answer discarded: ${JSON.stringify(d.rejected)}`);
    if (d.escalation) L.push(`**Escalation:** ${JSON.stringify(d.escalation)}`);
    if (r.widenNote) L.push(`Widen path: ${r.widenNote} — co-controlled programs: ${(r.coControlledPrograms ?? []).length}`);
  } else {
    L.push('No decision record.');
  }

  if (r.narrative) {
    L.push('');
    L.push('## Model advisory (what it means for callers)');
    if (r.narrative.refused) {
      L.push(`No narrative produced (${r.narrative.refused}). ${r.narrative.cannotDetermine}`);
    } else {
      L.push(`- changed: ${r.narrative.whatChanged}`);
      L.push(`- impact on callers: ${r.narrative.likelyImpactOnCallers}`);
      L.push(`- **cannot determine: ${r.narrative.cannotDetermine}**`);
      L.push(`- cites: ${r.narrative.cites.join(', ')} (${r.narrative.tokensUsed} tokens)`);
      if (r.narrative.mostLikelyImpact) {
        L.push('');
        L.push(`**Most likely impact:** ${r.narrative.mostLikelyImpact}`);
        L.push(`**What dependent operators should do:** ${r.narrative.whatOperatorsShouldDo}`);
        if (r.narrative.inputs) {
          const i = r.narrative.inputs;
          L.push(`_Advisory inputs present: value ${i.valueRouted ? 'yes' : 'NO'}, dependents ${i.dependents ? 'yes' : 'NO'}, IDL delta ${i.idlDelta ? 'yes' : 'NO'}, posture ${i.posture ? 'yes' : 'NO'}._`);
        }
      }
    }
  }

  L.push('');
  L.push('## Budget');
  const s = r.budget;
  L.push('');
  L.push('| | spent | limit |');
  L.push('| --- | ---: | ---: |');
  L.push(`| RPC calls | ${s.spent.rpcCalls} | ${s.limits.maxRpcCalls} |`);
  L.push(`| signatures | ${s.spent.signatures} | ${s.limits.maxSignatures} |`);
  L.push(`| LLM tokens | ${s.spent.llmTokensSettled} | ${s.limits.maxLlmTokens} |`);
  L.push(`| wall | ${s.elapsedMs}ms | ${s.limits.maxWallMs}ms |`);
  L.push('');
  L.push(`RPC: ${r.rpc.calls} calls (${r.rpc.retries} retries, ${r.rpc.pruned} pruned reads, ${r.rpc.failed} failures)`);

  L.push('');
  L.push('## Evidence');
  for (const e of r.evidence) L.push(`- \`${e.id}\` [${e.kind}] ${e.summary}`);

  L.push('');
  L.push('## What Dot could not see');
  for (const lim of r.limits) {
    L.push('');
    L.push(`### ${lim.title}`);
    L.push(`_${lim.blind}_`);
    L.push(`→ ${lim.mitigation}`);
  }

  L.push('');
  L.push('---');
  L.push(
    `Dot ranks where a human should look first. It does not establish that this upgrade is malicious, and a low tier is a statement about the evidence Dot was able to gather — not an absence of risk. Generated ${r.generatedAt}.`,
  );
  return L.join('\n');
}

function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}
