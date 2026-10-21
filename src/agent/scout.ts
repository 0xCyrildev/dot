import { Budget } from './budget.js';
import { EvidenceLedger, type Evidence } from './evidence.js';
import type { Decision, DecisionEngine, UpgradeContext } from './decision.js';
import { decisionTrace } from './decision.js';
import type { DotReport, StageTrace } from '../report.js';
import { limitsFor, type LimitNote } from '../limits.js';
import { GraphBuilder, dependentsByDepth, directDependents, type Graph } from '../graph/builder.js';
import { analyzeTrace } from '../graph/normalize.js';
import { resolveAccountKeys } from '../graph/keys.js';
import type { SolanaClient } from '../rpc/client.js';
import { classifyAuthority, deriveProgramData, decodeProgramData } from '../state/programdata.js';
import { BudgetExhaustedError, DotError, describeError, isDotError } from '../errors.js';
import { scoreRisk, type ExposureSignals, type EvidenceSignals } from '../score/risk.js';
import type { UpgradeEvent, WatchTarget } from '../watcher/watcher.js';

export type PriorDigest = {
  at: number;
  knownDependents: number;
  lamportsRouted: number;
  tier: string;
};

export type ActResult = {
  graph: Graph;
  planned: number;
  found: number;
  pruned: number;
  fetchErrors: number;
  stoppedReason: string | null;
  spanDays: number | null;
  budgetLimited: boolean;
  duplicates: number;
};

export type ScoutOptions = {
  client: SolanaClient;
  decision: DecisionEngine;
  budget: Budget;
  mode: 'rules' | 'real';
  /** Narrative producer, only consulted in `real` mode when an IDL exists. */
  narrate?: (ctx: UpgradeContext, graph: string, ledger: EvidenceLedger) => Promise<DotReport['narrative']>;
  idlResolver?: (program: string) => Promise<{ available: boolean; source?: string; diffText?: string }>;
  prior?: Map<string, PriorDigest>;
  knownMultisigs?: string[];
  /** Max transitive depth reported; deep graphs are mostly re-exports of the same DEX. */
  maxDepth?: number;
};

/**
 * The bounded agent. One run = perceive -> decide -> act -> evaluate -> report,
 * and any stage may end the run early.
 *
 * The early exit is the point. `act` is the only expensive stage (N signature
 * reads plus a transaction fetch each), so `decide` exists to avoid it, and a run
 * that stops in `decide` still produces a full report with a budget snapshot
 * showing what was *not* spent. A tool that always does all five steps is a
 * script with a for-loop; the trace of which steps were skipped, and why, is the
 * evidence that something decided.
 */
export class Scout {
  readonly ledger = new EvidenceLedger();
  private readonly trace: StageTrace[] = [];
  private readonly o: Required<Pick<ScoutOptions, 'maxDepth'>> & ScoutOptions;
  private stoppedAt: DotReport['stoppedAt'] = 'report';

  constructor(opts: ScoutOptions) {
    this.o = { maxDepth: 3, ...opts };
  }

  private mark(stage: StageTrace['stage'], note: string): void {
    this.trace.push({
      stage,
      atMs: this.o.budget.elapsedMs,
      note,
      rpcCallsAfter: this.o.budget.snapshot().spent.rpcCalls,
    });
  }

  async run(req: { program: string; label?: string; event?: UpgradeEvent; forceFullTrace?: boolean }): Promise<DotReport> {
    const t0 = Date.now();
    const ctx = await this.perceive(req);
    if (!ctx) {
      return this.report(req.program, req.label, null, null, null, t0, 'perceive', 'ProgramData could not be read or decoded');
    }

    const decision = await this.o.decision.decide(ctx, this.ledger);
    this.mark('decide', `${decision.source}: proceed=${decision.proceed} plan=${JSON.stringify(decision.plan)}`);
    if (!decision.proceed) {
      this.stoppedAt = 'decide';
      this.o.budget.stop('decided to stop before the trace pull');
      return this.report(req.program, req.label, ctx, decision, null, t0, 'decide', decision.rationale);
    }

    const built = await this.act(ctx.program, decision);
    // A trace pull cut short by the budget is reported as ending in `act` even
    // when some edges were found: the plan was not completed, and a reader who
    // sees `report` would assume it was.
    if (built.budgetLimited) this.stoppedAt = 'act';
    const evaluated = this.evaluate(ctx, built);
    // Do not clobber a stop recorded by `act`: a run that ran out of budget
    // mid-sample completed its *pipeline* but not its *plan*, and a reader who
    // sees stoppedAt "report" would assume the sample was whole.
    if (!built.budgetLimited) this.stoppedAt = 'report';
    this.o.budget.stop(built.budgetLimited ? 'budget exhausted during act' : undefined);
    const narrative = await this.maybeNarrate(ctx, built.graph);
    // Report the stage the run actually ended at, and the reason `act` recorded,
    // instead of a hardcoded "report/completed" that would describe a plan that
    // was never finished as one that was.
    return this.report(
      req.program,
      req.label,
      ctx,
      decision,
      { ...built, ...evaluated },
      t0,
      this.stoppedAt,
      built.stoppedReason ?? 'completed',
      narrative,
    );
  }

  /**
   * PERCEIVE. One `getAccountInfo` on the derived ProgramData PDA, decoded with
   * structural validation. Costs one RPC call by construction, which is what
   * makes it legal to run on every event before any expensive decision.
   */
  private async perceive(req: { program: string; label?: string; event?: UpgradeEvent; forceFullTrace?: boolean }): Promise<UpgradeContext | null> {
    this.mark('perceive', `reading ProgramData for ${req.program}`);
    const programData = deriveProgramData(req.program);
    const knownMultisigs = new Set([...(req.event ? [] : []), ...(this.o.knownMultisigs ?? [])]);
    let state: ReturnType<typeof decodeProgramData> | null = null;
    try {
      const acct = await this.o.client.getAccountInfo(programData);
      if (!acct) {
        this.ledger.add({ kind: 'upgrade', summary: `ProgramData ${programData} has no account data (closed or never existed)`, ref: { program: req.program } });
        if (req.event?.kind !== 'program_data_closed') {
          return null;
        }
      } else {
        state = decodeProgramData(acct, req.program);
      }
    } catch (e) {
      if (isDotError(e) && e.code === 'UNKNOWN_PROGRAMDATA_LAYOUT') {
        this.ledger.add({ kind: 'limit', summary: `ProgramData layout unrecognised for ${programData}: ${e.message}`, ref: { program: req.program } });
        return null;
      }
      throw e;
    }

    if (state) {
      const posture = classifyAuthority(state.authority, knownMultisigs);
      this.ledger.add({
        kind: 'posture',
        summary: `authority=${state.authority ?? 'RENOUNCED'} posture=${posture} bytecode=${state.bytecodeLen}B at offset ${state.bytecodeOffset} discriminant=${state.discriminant} layout=${state.layout} sha256=${state.bytecodeHash.slice(0, 16)}…`,
        ref: { program: req.program },
      });
    }

    const prior = this.o.prior?.get(req.program) ?? null;
    const idl = (await this.o.idlResolver?.(req.program)) ?? { available: false };
    const ev = req.event;
    const ctx: UpgradeContext = {
      program: req.program,
      programData,
      ...(req.label ? { label: req.label } : {}),
      kind: ev?.kind ?? 'upgrade',
      change: {
        bytecodeChanged: ev ? ev.changed.bytecode : state !== null,
        authorityChanged: ev ? ev.changed.authority : false,
        sizeChanged: ev ? ev.changed.size : state !== null,
        beforeBytes: ev?.before?.bytecodeLen ?? null,
        afterBytes: ev?.after?.bytecodeLen ?? state?.bytecodeLen ?? null,
      },
      authority: {
        before: ev?.before?.authority ?? null,
        after: state?.authority ?? ev?.after?.authority ?? null,
        posture: classifyAuthority(state?.authority ?? null, knownMultisigs),
      },
      history: {
        signaturesAvailable: null,
        lastAnalysisAt: prior?.at ?? null,
        knownDependents: prior?.knownDependents ?? null,
        lamportsRoutedLast: prior?.lamportsRouted ?? null,
      },
      idl,
      ...(req.forceFullTrace ? { forceFullTrace: true } : {}),
    };
    this.mark('perceive', `posture=${ctx.authority.posture} authority=${ctx.authority.after ?? 'renounced'} priorDependents=${ctx.history.knownDependents ?? 'unobserved'}`);
    return ctx;
  }

  /**
   * ACT. Pull signatures for the program id, parse each transaction, fold the
   * inner lists onto their outer parent and accumulate edges.
   *
   * Note what this can and cannot do. `getSignaturesForAddress` indexes every
   * account key in a transaction, and a program called via CPI must appear in
   * that key list, so this does find transactions where the target was called
   * indirectly. It tells us *which* transactions touched the program — never
   * *from whom*. The caller is recovered entirely from the inner-instruction
   * fold, which is why that step has to be right.
   */
  private async act(program: string, decision: Decision): Promise<ActResult> {
    const builder = new GraphBuilder(program);
    const budget = this.o.budget;
    let planned = decision.plan.signatures;
    let cursor: string | undefined = undefined;
    let found = 0;
    let pruned = 0;
    let errors = 0;
    let stoppedReason: string | null = null;
    /**
     * A cursor walk can be handed overlapping windows by a provider that ignores
     * or mis-honours `until`. Re-reading a signature would double-count its edges
     * and quietly inflate the blast radius, so duplicates are dropped and counted.
     */
    const seenSignatures = new Set<string>();
    let duplicates = 0;
    let budgetLimited = false;
    let oldestBlockTime: number | null = null;
    let newestBlockTime: number | null = null;

    this.mark('act', `planned sample ${planned} signatures`);

    while (found + pruned + errors < planned) {
      const want = Math.min(50, planned - found - pruned - errors);
      let sigs: Awaited<ReturnType<SolanaClient['getSignaturesForAddress']>>;
      try {
        const affordable = budget.affordableSignatures(1);
        if (affordable < 1) {
          stoppedReason = `budget refuses any further signature pull (rpcCalls ${budget.snapshot().spent.rpcCalls}/${budget.limits.maxRpcCalls})`;
          budgetLimited = true;
          break;
        }
        sigs = await this.o.client.getSignaturesForAddress(program, {
          limit: Math.min(want, affordable),
          ...(cursor ? { until: cursor } : {}),
        });
      } catch (e) {
        if (e instanceof BudgetExhaustedError) {
          stoppedReason = `budget exhausted during signature walk: ${e.kind}`;
          budgetLimited = true;
          break;
        }
        stoppedReason = `signature walk failed: ${(e as Error).message}`;
        this.ledger.add({ kind: 'limit', summary: stoppedReason, ref: { program } });
        break;
      }
      if (sigs.length === 0) {
        stoppedReason = 'the node returned no older signatures: Dot has reached the end of available history';
        break;
      }

      for (const s of sigs) {
        if (found + pruned + errors >= planned) {
          stoppedReason = 'planned sample size reached';
          break;
        }
        if (seenSignatures.has(s.signature)) {
          duplicates++;
          continue;
        }
        seenSignatures.add(s.signature);
        try {
          budget.spendSignatures(1);
        } catch (e) {
          if (e instanceof BudgetExhaustedError) {
            stoppedReason = `signature cap ${e.limit} reached`;
            budgetLimited = true;
            break;
          }
          throw e;
        }
        let res;
        try {
          res = await this.o.client.getTransaction(s.signature);
        } catch (e) {
          // A budget stop here must degrade into a partial graph with a stated
          // reason, not into a crashed run: the analysis that got 40% of the way
          // through a sample is still the most useful thing Dot can say tonight.
          if (e instanceof BudgetExhaustedError) {
            stoppedReason = `budget exhausted mid-trace: ${e.kind} at ${found} trace(s)`;
            budgetLimited = true;
            break;
          }
          throw e;
        }
        if (res.status === 'pruned') {
          pruned++;
          continue;
        }
        if (res.status === 'error') {
          errors++;
          this.ledger.add({ kind: 'limit', summary: `getTransaction failed: ${JSON.stringify(res.error)}`, ref: { signature: s.signature } });
          continue;
        }
        const tx = res.tx;
        const resolution = resolveAccountKeys(tx);
        const analysis = analyzeTrace(tx, resolution);
        builder.addTrace(s.signature, tx, analysis);
        found++;
        if (tx.blockTime !== null && tx.blockTime !== undefined) {
          oldestBlockTime = oldestBlockTime === null ? tx.blockTime : Math.min(oldestBlockTime, tx.blockTime);
          newestBlockTime = newestBlockTime === null ? tx.blockTime : Math.max(newestBlockTime, tx.blockTime);
        }
        if (found === 1 || found % 25 === 0) {
          this.ledger.add({
            kind: 'trace',
            summary: `trace ${found}: slot=${tx.slot} version=${String(tx.version)} outer=${tx.transaction.message.instructions.length} innerGroups=${tx.meta?.innerInstructions?.length ?? 0} attribution=${analysis.quality} keys=${resolution.method}`,
            ref: { signature: s.signature, slot: tx.slot },
          });
        }
      }
      if (stoppedReason) break;
      cursor = sigs[sigs.length - 1]?.signature;
      if (!cursor) break;
    }

    const graph = builder.finalize();
    this.mark('act', `traces=${found} pruned=${pruned} errors=${errors} edges=${graph.detailedEdges.length} quality=${graph.attributionQuality}${stoppedReason ? ` stopped: ${stoppedReason}` : ''}`);
    if (pruned > 0) {
      this.ledger.add({
        kind: 'limit',
        summary: `${pruned} of ${found + pruned} sampled signatures were unavailable from the node (pruned history or retention window). The graph is built from what was retrievable, not from what happened.`,
        ref: { program },
      });
    }
    if (graph.attributionQuality === 'flat') {
      this.ledger.add({
        kind: 'limit',
        summary: `${graph.flattenedFrames} nested CPI(s) had no stackHeight and no usable logs; attributed to the outer instruction. Dependent counts are an upper bound.`,
        ref: { program },
      });
    }
    for (const a of graph.anomalies) this.ledger.add({ kind: 'limit', summary: a, ref: { program } });

    if (duplicates > 0) {
      this.ledger.add({ kind: 'limit', summary: `${duplicates} duplicate signature(s) returned by the cursor walk were dropped before they could double-count edges`, ref: { program } });
    }
    const spanDays = oldestBlockTime !== null && newestBlockTime !== null ? (newestBlockTime - oldestBlockTime) / 86_400 : null;
    return { graph, planned, found, pruned, fetchErrors: errors, stoppedReason, spanDays, budgetLimited, duplicates };
  }

  /** EVALUATE. Digest the graph into exposure, then price it against evidence quality. */
  private evaluate(ctx: UpgradeContext, built: ActResult): {
    exposure: ExposureSignals;
    evidence: EvidenceSignals;
    risk: ReturnType<typeof scoreRisk>;
    transitive: ReturnType<typeof dependentsByDepth>;
  } {
    const { graph } = built;
    const direct = directDependents(graph, ctx.program);
    const transitive = dependentsByDepth(graph, ctx.program, this.o.maxDepth);
    const exposure: ExposureSignals = {
      directCallers: direct.length,
      transitiveCallers: transitive.filter((t) => t.depth > 1).length,
      edges: graph.detailedEdges.length,
      cpiOccurrences: graph.detailedEdges.reduce((s, e) => s + e.count, 0),
      failedCpiOccurrences: graph.detailedEdges.reduce((s, e) => s + e.failed, 0),
      distinctTransactions: graph.tracesAnalyzed,
      lamportsRouted: graph.detailedEdges.reduce((s, e) => s + e.lamportsRouted, 0),
      mintsTouched: new Set(graph.detailedEdges.flatMap((e) => e.tokenMintsTouched)).size,
      selfCpi: graph.nodeMeta.some((n) => n.selfCpi && n.id === ctx.program),
    };
    const evidence: EvidenceSignals = {
      signaturesPlanned: built.planned,
      signaturesFound: built.found,
      signaturesPruned: built.pruned,
      fetchErrors: built.fetchErrors,
      duplicateSignatures: built.duplicates,
      sampleCoverage: built.planned === 0 ? 1 : Math.min(1, built.found / built.planned),
      attributionQuality: graph.attributionQuality,
      flattenedFrames: graph.flattenedFrames,
      logTruncated: graph.anomalies.some((a) => a.includes('truncated')),
      historySpanDays: built.spanDays,
    };
    const risk = scoreRisk(ctx, exposure, evidence);
    this.mark('evaluate', `score=${risk.score} tier=${risk.tier} confidence=${risk.confidence} direct=${exposure.directCallers} transitive=${exposure.transitiveCallers}`);
    for (const e of direct.slice(0, 5)) {
      this.ledger.add({
        kind: 'edge',
        summary: `${e.from} -> ${e.to}: ${e.count} CPI(s), ${e.transactions} tx(s), ${e.lamportsRouted} lamports inbound-attributed${e.failed ? `, ${e.failed} failed` : ''}`,
        ref: { from: e.from, to: e.to },
      });
    }
    return { exposure, evidence, risk, transitive };
  }

  private async maybeNarrate(ctx: UpgradeContext, graph: Graph): Promise<DotReport['narrative']> {
    if (this.o.mode !== 'real' || !this.o.narrate) return undefined;
    if (!ctx.idl.available) {
      return {
        whatChanged: '',
        likelyImpactOnCallers: '',
        cannotDetermine: 'no IDL was resolvable for this program, so Dot has no source-level view of the change; the tier comes from posture and the observed call graph only',
        cites: [],
        tokensUsed: 0,
        refused: 'idl_unavailable',
      };
    }
    const summary = graph.detailedEdges
      .slice(0, 12)
      .map((e) => `${e.from} -> ${e.to} count=${e.count} lamports=${e.lamportsRouted}`)
      .join('\n');
    return this.o.narrate(ctx, summary, this.ledger);
  }

  private report(
    program: string,
    label: string | undefined,
    ctx: UpgradeContext | null,
    decision: Decision | null,
    built: (ActResult & ReturnType<Scout['evaluate']>) | null,
    t0: number,
    stoppedAt: DotReport['stoppedAt'],
    stopNote: string,
    narrative?: DotReport['narrative'],
  ): DotReport {
    const limits: LimitNote[] = limitsFor({
      pruned: built?.pruned ?? 0,
      attributionQuality: built?.graph.attributionQuality ?? 'stackHeight',
      idlAvailable: ctx?.idl.available ?? false,
      logTruncated: built?.evidence.logTruncated ?? false,
    });
    const evidenceList: Evidence[] = this.ledger.all();
    return {
      schema: 'dot.report.v1',
      generatedAt: new Date().toISOString(),
      program,
      ...(label ? { label } : {}),
      mode: this.o.mode,
      programData: ctx?.programData ?? deriveProgramData(program),
      event: ctx?.kind ?? 'upgrade',
      tier: built?.risk.tier ?? 'P3',
      score: built?.risk.score ?? 0,
      confidence: built?.risk.confidence ?? 'low',
      components: built?.risk.components ?? [],
      cappedBy: built?.risk.cappedBy ?? stopNote,
      stoppedAt,
      stopNote,
      decision: decision ? decisionTrace(decision) : null,
      blastRadius: built
        ? {
            directCallers: built.exposure.directCallers,
            transitiveCallers: built.exposure.transitiveCallers,
            edges: built.exposure.edges,
            cpiOccurrences: built.exposure.cpiOccurrences,
            failedCpiOccurrences: built.exposure.failedCpiOccurrences,
            lamportsRouted: built.exposure.lamportsRouted,
            mintsTouched: built.exposure.mintsTouched,
            tracesAnalyzed: built.graph.tracesAnalyzed,
            tracesFailed: built.graph.tracesFailed,
            attributionQuality: built.graph.attributionQuality,
            historySpanDays: built.spanDays,
            topDependents: built.graph.detailedEdges
              .filter((e) => e.to === program)
              .slice(0, 15)
              .map((e) => ({ program: e.from, count: e.count, transactions: e.transactions, lamportsRouted: e.lamportsRouted })),
            transitiveByDepth: built.transitive.slice(0, 25),
          }
        : null,
      graph: built?.graph ?? null,
      evidence: evidenceList,
      limits,
      ...(narrative ? { narrative } : {}),
      budget: this.o.budget.snapshot(),
      rpc: this.o.client.statsView(),
      wallMs: Date.now() - t0,
    };
  }
}

export function isBudgetStop(e: unknown): boolean {
  return e instanceof BudgetExhaustedError || (isDotError(e) && e.code.startsWith('BUDGET'));
}

export type { WatchTarget };
export { DotError };
