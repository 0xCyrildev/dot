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
import type { WireSignatureInfo } from '../rpc/wire.js';
import { diffBytecode, renderBytecodeDiff, type BytecodeDiff } from '../state/bytecodeDiff.js';
import type { BlockBatcher, IngestSummary } from '../graph/batcher.js';
import { classifyAuthority, deriveProgramData, decodeProgramData } from '../state/programdata.js';
import { BudgetExhaustedError, DotError, describeError, isDotError } from '../errors.js';
import { buildHypothesis, judgeHypothesis, type Hypothesis, type ReTestObservation } from './hypothesis.js';
import { CANNOT_PROVE, type ChainVerification } from '../rpc/verifier.js';
import { scoreRisk, type ExposureSignals, type EvidenceSignals } from '../score/risk.js';
import type { UpgradeEvent, WatchTarget } from '../watcher/watcher.js';

export type PriorDigest = {
  at: number;
  knownDependents: number;
  lamportsRouted: number;
  tier: string;
};

/** The sample the risk warranted; falls back to the planned size when unknown. */
function decisionPlanWanted(built: { wantedSignatures?: number; planned: number }): number {
  return built.wantedSignatures ?? built.planned;
}

export type ActResult = {
  wantedSignatures?: number;
  graph: Graph;
  planned: number;
  found: number;
  pruned: number;
  fetchErrors: number;
  stoppedReason: string | null;
  spanDays: number | null;
  budgetLimited: boolean;
  duplicates: number;
  ingest: IngestRecord;
  /** Which ledger was walked: the program's own, or its authority's. */
  source: 'program' | 'authority_history';
  /**
   * Distinct programs appearing as a top-level instruction target across the sample.
   * The CPI graph cannot answer "what else does this key touch" — two programs named
   * side by side in one transaction produce no edge between them — so the widen path
   * measures co-occurrence, which is the honest relation for co-control.
   */
  coInvokedPrograms: string[];
  /** The signatures this run actually got a transaction for, newest first. Verification samples from here. */
  signatures: string[];
};

/**
 * How the traces were paid for. Reported because "10x fewer RPC calls" and
 * "40x more bytes" are the same change, and a reader is entitled to both numbers
 * next to the strategy that produced them.
 */
export type IngestRecord = {
  strategy: 'per_block' | 'per_signature';
  rationale: string;
  groups: number;
  est?: { callsPerSignature: number; callsPerBlock: number; bytesPerSignature: number; bytesPerBlock: number };
  callSavingRatio?: number;
  byteAmplification?: number;
  summary?: IngestSummary;
};

export type ScoutOptions = {
  client: SolanaClient;
  decision: DecisionEngine;
  budget: Budget;
  mode: 'rules' | 'real';
  /** Narrative producer, only consulted in `real` mode when an IDL exists. */
  narrate?: (
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
    ledger: EvidenceLedger,
  ) => Promise<DotReport['narrative']>;
  idlResolver?: (program: string) => Promise<{ available: boolean; source?: string; diffText?: string }>;
  prior?: Map<string, PriorDigest>;
  /**
   * A hypothesis from an earlier, under-funded run. When this run can finally afford
   * the plan it is re-tested and marked confirmed/denied, so the record shows whether
   * the suspicion was worth the calls it asked for.
   */
  carryHypothesis?: Hypothesis | null;
  /** Batched block ingestion. Omit it and Dot stays on per-signature reads. */
  batcher?: BlockBatcher;
  ingest?: 'auto' | 'blocks' | 'signatures';
  batchOpts?: { includeLogs?: boolean; maxBlocks?: number };
  /**
   * Supplies the prior image and whichever IDLs exist. Injected rather than built here:
   * the engine should not know about a vault directory or a file flag, and the honest
   * answer to "where did the old bytecode come from?" differs per deployment.
   */
  bytecode?: (args: {
    program: string;
    programData: string;
    currentDigest: string;
    currentBytes: Buffer;
  }) => Promise<{ oldBytes: Buffer | null; oldIdl?: unknown | null; newIdl?: unknown | null; provenance: string } | null>;
  /** Store the observed image so a future upgrade has a "before". */
  recordBytecode?: (args: { program: string; programData: string; bytes: Buffer; slot: number | null }) => Promise<void>;
  /** Multi-endpoint corroboration for the read that decides whether an upgrade happened. */
  resilient?: { quorum: (address: string) => Promise<import('../rpc/resilient.js').QuorumRead> };
  /**
   * `--verify`: ask the second endpoint about the accounts and transactions the report is
   * built from. Injected as a function so the Scout stays out of transport construction,
   * and called only after `act` — there is nothing worth corroborating before a sample
   * exists, and the calls it would cost would be spent on a run that may still stop.
   */
  verify?: (args: { program: string; programData: string; signatures: string[] }) => Promise<import('../rpc/verifier.js').ChainVerification>;
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
  /**
   * Set when two endpoints contradicted each other. It is not a risk score and it
   * is not missing data: it is the tool's own input failing, which outranks every
   * finding it could have produced.
   */
  private integrityHalt: { agreement: string; reason: string; endpoints: unknown[] } | null = null;
  private lastQuorum: import('../rpc/resilient.js').QuorumRead | null = null;
  private bytecodeDiff: BytecodeDiff | null = null;
  private bytecodeProvenance: string | null = null;
  /** Programs co-invoked with the upgrade authority — the reach of that one key. */
  private coControlled: string[] = [];
  private widenRan = false;
  private widenNote: string | null = null;
  private hypothesis: Hypothesis | null = null;
  private chainVerified: ChainVerification | null = null;
  private wantedSignatures: number | null = null;

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
      if (this.integrityHalt) {
        // Deliberately not routed through scoreRisk: a disagreement between two
        // endpoints is not evidence about the program, it is evidence about the
        // tool's inputs. The tier is an escalation of *attention*, and `tierSource`
        // says so, so nobody files an incident against a program because a node lied.
        this.o.budget.stop('endpoint disagreement');
        return this.integrityReport(req.program, req.label, t0);
      }
      return this.report(req.program, req.label, null, null, null, t0, 'perceive', 'ProgramData could not be read or decoded');
    }

    // Decide is given the budget before it plans, so the sample size is derived from
    // what is left rather than picked from a tier and clamped afterwards.
    const snap = this.o.budget.snapshot();
    ctx.budget = {
      remainingRpcCalls: snap.remaining.rpcCalls,
      remainingSignatures: snap.remaining.signatures,
      elapsedMs: snap.elapsedMs,
      maxWallMs: snap.limits.maxWallMs,
    };

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

    // The hypothesis is assembled after the widen path, not here: Decide has the posture
    // and the diff but not the dependent counts, and the widen path is what learns what
    // else the key controls. A claim written before those exist would be a guess about a
    // sample this run had not finished taking.

    // The widen path. A zero-dependent result on a program held by a single key is
    // the weakest-looking and most dangerous combination in this tool, and the
    // honest second move is not "re-scan the same program harder" — it is to ask what
    // else the *same key* controls, because that is the actual blast radius of a
    // compromised authority. It is reported as a separate field: co-controlled
    // programs are not dependents, and merging them would be a category error.
    /**
     * Triggered by the finding, not by the escalation kind — but only when the sample
     * was thick enough to make an empty dependent set mean something. Widening on a
     * two-trace sample would be the agent reading significance into a gap in its own
     * coverage, so a thin sample declines explicitly and says why.
     */
    const sampleIsMeaningful = built.found >= 3 && evaluated.evidence.sampleCoverage >= 0.5;
    if (
      evaluated.exposure.directCallers === 0 &&
      ctx.authority.posture === 'eoa' &&
      ctx.authority.after
    ) {
      if (!sampleIsMeaningful) {
        this.widenNote = `widen skipped: ${built.found} trace(s) parsed at ${(evaluated.evidence.sampleCoverage * 100).toFixed(0)}% coverage — an empty dependent set here is a coverage gap, not a finding`;
        this.ledger.add({ kind: 'limit', summary: this.widenNote, ref: { program: ctx.program } });
      }
      const authority = ctx.authority.after;
      const widenBudgetOk = sampleIsMeaningful && this.o.budget.affordableSignatures(1) >= Math.min(10, decision.plan.signatures || 10);
      this.ledger.add({
        kind: 'limit',
        summary: widenBudgetOk
          ? `no attributed dependents for ${ctx.program} held by a single key; widening to the authority's own transaction history`
          : `widen declined: no budget left to sample the authority history`,
        ref: { program: ctx.program },
      });
      if (widenBudgetOk) {
        try {
          const widenPlan: Decision = {
            ...decision,
            plan: { ...decision.plan, signatures: Math.min(25, Math.max(10, decision.plan.signatures)) },
          };
          const widenBuilt = await this.act(authority, widenPlan, 'authority_history');
          // Two relations, kept in one list but named separately: programs that shared a
          // transaction with the authority (co-occurrence, the honest signal for
          // co-control), and CPI edges touching it. Neither is a dependent of the
          // program under review, and the field name says so.
          const others = new Set<string>(widenBuilt.coInvokedPrograms);
          for (const e of widenBuilt.graph.detailedEdges) {
            if (e.from === authority) others.add(e.to);
            if (e.to === authority) others.add(e.from);
          }
          others.delete(authority);
          this.coControlled = [...others].filter((x) => x && x !== ctx.program).slice(0, 50);
          this.widenRan = true;
          this.widenNote =
            `sampled ${widenBuilt.found} transaction(s) touching authority ${authority}; ` +
            `${this.coControlled.length} other program(s) co-invoked or CPI-adjacent — reported as co-control, NOT as dependents`;
          this.ledger.add({
            kind: 'trace',
            summary: this.widenNote,
            ref: { program: authority },
          });
        } catch (e) {
          if (!(e instanceof BudgetExhaustedError)) throw e;
          this.widenNote = 'widen aborted: budget exhausted mid-authority-sample';
        }
      }
    }

    // Now the ask, stated as a claim this run could not settle — see the note above
    // `act` for why it is built here rather than inside Decide.
    if (this.o.verify) {
      try {
        this.chainVerified = await this.o.verify({ program: ctx.program, programData: ctx.programData, signatures: built.signatures });
      } catch (e) {
        if (!(e instanceof BudgetExhaustedError)) throw e;
        this.chainVerified = {
          verified: false,
          reason: 'verification aborted: the budget ran out mid-cross-check, so the checks below are partial by construction',
          endpoints: [],
          slot: null,
          checks: [],
          sampledSignatures: 0,
          cannotProve: CANNOT_PROVE,
        };
      }
      const cv = this.chainVerified;
      this.ledger.add({
        kind: cv.verified ? 'trace' : 'limit',
        summary: `chain_verified=${cv.verified} — ${
          cv.verified
            ? `${cv.checks.length} check(s) corroborated by ${cv.endpoints.length} endpoints at slot ${cv.slot}, ${cv.sampledSignatures} signature(s) cross-checked. Corroboration, not an inclusion proof.`
            : `${cv.reason} (${cv.checks.map((x) => `${x.name}:${x.verdict}/${x.coverage}`).join(', ') || 'no check ran'})`
        }`,
        ref: { program: ctx.program },
      });
      this.mark('verify', cv.verified ? `true at slot ${cv.slot}, ${cv.sampledSignatures} signature(s) cross-checked` : `false: ${cv.reason}`);
    }

    if (decision.escalation?.kind === 'needs_more_budget') {
      const h = buildHypothesis({
        ctx,
        wantedSignatures: this.wantedSignatures ?? plannedOrZero(decision),
        affordableSignatures: decision.plan.signatures,
        bytecode: this.bytecodeDiff,
        directDependents: evaluated.exposure.directCallers,
        coControlled: this.coControlled,
      });
      // A funded run answers the earlier claim before it raises its own; the two are
      // printed together so the reader can see the loop close.
      if (this.o.carryHypothesis) {
        h.outcome = judgeHypothesis(this.o.carryHypothesis, retestObservation(built, ctx.program, this.bytecodeDiff, this.coControlled, this.widenRan)).outcome;
      }
      decision.escalation.hypothesis = h;
      this.hypothesis = h;
      this.ledger.add({ kind: 'limit', summary: `hypothesis [${h.claimKind}]: ${h.claim} — falsifier: ${h.falsifier}`, ref: { program: ctx.program } });
    } else if (this.o.carryHypothesis) {
      const judged = judgeHypothesis(this.o.carryHypothesis, retestObservation(built, ctx.program, this.bytecodeDiff, this.coControlled, this.widenRan));
      this.hypothesis = judged;
      this.ledger.add({
        kind: judged.outcome?.status === 'confirmed' ? 'edge' : 'limit',
        summary: `prior hypothesis re-tested: ${judged.outcome?.status} — ${judged.outcome?.against}`,
        ref: { program: ctx.program },
      });
    }

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
    let acct: Awaited<ReturnType<SolanaClient['getAccountInfo']>> = null;
    try {
      if (this.o.resilient) {
        const q = await this.o.resilient.quorum(programData);
        this.lastQuorum = q;
        if (q.halt) {
          if (q.agreement === 'disagreed') {
            this.integrityHalt = { agreement: q.agreement, reason: q.reason, endpoints: q.endpoints };
            this.mark('perceive', `INTEGRITY HALT: ${q.reason}`);
            return null;
          }
          this.ledger.add({ kind: 'limit', summary: `endpoint corroboration: ${q.agreement} — ${q.reason}` });
        } else if (q.agreement !== 'not_checked') {
          this.ledger.add({ kind: 'limit', summary: `endpoint corroboration ${q.agreement}: ${q.reason}` });
        }
        acct = q.account;
      } else {
        acct = await this.o.client.getAccountInfo(programData);
      }
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
      // Diff the bytecode first: it is derived from a read we already paid for, and it
      // is the only part of this run that can say what the upgrade *does*.
      try {
        if (!acct) throw new Error('no account bytes to diff');
        if (this.o.recordBytecode) {
          await this.o.recordBytecode({ program: req.program, programData, bytes: acct.data, slot: state.headerU64 });
        }
        const supplied = this.o.bytecode
          ? await this.o.bytecode({ program: req.program, programData, currentDigest: state.bytecodeHash, currentBytes: acct.data })
          : null;
        if (supplied) {
          this.bytecodeDiff = diffBytecode({
            oldBytes: supplied.oldBytes,
            newBytes: acct.data,
            ...(supplied.oldIdl !== undefined ? { oldIdl: supplied.oldIdl } : {}),
            ...(supplied.newIdl !== undefined ? { newIdl: supplied.newIdl } : {}),
          });
          this.bytecodeProvenance = supplied.provenance;
          const entryChanges = (this.bytecodeDiff.instructions?.added.length ?? 0) + (this.bytecodeDiff.instructions?.removed.length ?? 0);
          this.ledger.add({
            kind: entryChanges > 0 ? 'edge' : 'limit',
            summary:
              `bytecode diff (${this.bytecodeDiff.confidence}): +${this.bytecodeDiff.instructions?.added.length ?? 0} / -${this.bytecodeDiff.instructions?.removed.length ?? 0} entrypoint(s), ` +
              `${this.bytecodeDiff.instructions?.undeclaredEntrypoints.length ?? 0} undeclared, prior image ${supplied.oldBytes ? 'available' : 'UNAVAILABLE'} — ${supplied.provenance}`,
            ref: { program: req.program },
          });
          for (const a of this.bytecodeDiff.instructions?.added ?? []) {
            this.ledger.add({ kind: 'edge', summary: `entrypoint ADDED "${a.name}" selector=${a.hex} at offsets ${a.offsetsInNew.slice(0, 3).join(',')} — callers never had this path; a dependent that can be made to pass it hits new code`, ref: { program: req.program } });
          }
          for (const r of this.bytecodeDiff.instructions?.removed ?? []) {
            this.ledger.add({ kind: 'edge', summary: `entrypoint REMOVED "${r.name}" selector=${r.hex} — any integrator still encoding it now fails`, ref: { program: req.program } });
          }
          for (const u of this.bytecodeDiff.instructions?.undeclaredEntrypoints ?? []) {
            this.ledger.add({ kind: 'edge', summary: `UNDECLARED ENTRYPOINT reachable in new image, absent from the new IDL: ${u.name} ${u.hex}`, ref: { program: req.program } });
          }
        }
      } catch (e) {
        this.ledger.add({ kind: 'limit', summary: `bytecode diff not performed: ${(e as Error).message}`, ref: { program: req.program } });
      }
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
  private async act(program: string, decision: Decision, source: 'program' | 'authority_history' = 'program'): Promise<ActResult> {
    const budget = this.o.budget;
    const planned = decision.plan.signatures;
    this.wantedSignatures = decision.plan.wantedSignatures;
    void source;
    let stoppedReason: string | null = null;
    let budgetLimited = false;

    // ---- Phase 1: find the traces. `getSignaturesForAddress` returns the slot
    // alongside each signature, which is what makes block batching possible without
    // an extra call, and it means "which transactions touched this id" — never "from
    // whom". The caller comes only from the inner-instruction fold in phase 3.
    const collected: WireSignatureInfo[] = [];
    const seen = new Set<string>();
    let duplicates = 0;
    let cursor: string | undefined;
    while (collected.length < planned) {
      const before = collected.length;
      const batch = Math.min(250, planned - collected.length);
      if (budget.affordableSignatures(batch) < 1) {
        stoppedReason = `budget refuses a signature pull (rpcCalls ${budget.snapshot().spent.rpcCalls}/${budget.limits.maxRpcCalls})`;
        budgetLimited = true;
        break;
      }
      let sigs: WireSignatureInfo[];
      try {
        sigs = await this.o.client.getSignaturesForAddress(program, {
          limit: batch,
          ...(cursor ? { until: cursor } : {}),
        });
      } catch (e) {
        if (e instanceof BudgetExhaustedError) {
          stoppedReason = `budget exhausted during signature walk: ${e.kind}`;
          budgetLimited = true;
        } else {
          stoppedReason = `signature walk failed: ${(e as Error).message}`;
          this.ledger.add({ kind: 'limit', summary: stoppedReason, ref: { program } });
        }
        break;
      }
      if (sigs.length === 0) {
        stoppedReason = 'the node returned no older signatures: Dot has reached the end of available history';
        break;
      }
      for (const sig of sigs) {
        if (seen.has(sig.signature)) {
          duplicates++;
          continue;
        }
        seen.add(sig.signature);
        collected.push(sig);
        if (collected.length >= planned) break;
      }
      cursor = sigs[sigs.length - 1]?.signature;
      if (!cursor) break;
      // A provider that ignores `until`, or a window that is entirely duplicates,
      // would otherwise spin here spending one paid call per loop while collecting
      // nothing. No new work in a full window is the stop condition.
      if (collected.length === before) {
        stoppedReason = 'the signature cursor made no progress: the provider returned an overlapping window, so Dot stopped paying for it';
        this.ledger.add({ kind: 'limit', summary: stoppedReason, ref: { program } });
        break;
      }
    }
    if (duplicates > 0) {
      this.ledger.add({
        kind: 'limit',
        summary: `${duplicates} duplicate signature(s) from the cursor walk dropped before they could double-count edges`,
        ref: { program },
      });
    }

    const builder = new GraphBuilder(program);
    const coInvoked = new Set<string>();
    const fetched: string[] = [];
    let found = 0;
    let pruned = 0;
    let errors = 0;
    let oldestBlockTime: number | null = null;
    let newestBlockTime: number | null = null;
    let ingest: ActResult['ingest'] = { strategy: 'per_signature', rationale: 'no cost model supplied', groups: collected.length };

    // ---- Phase 2: choose how to pay for them.
    let chosen: 'per_block' | 'per_signature' = 'per_signature';
    if (this.o.batcher && this.o.ingest !== 'signatures') {
      const plan = this.o.batcher.plan(this.o.batcher.groupBySlot(collected));
      chosen = this.o.ingest === 'blocks' ? 'per_block' : plan.chosen;
      ingest = {
        strategy: chosen,
        rationale: plan.rationale,
        groups: plan.distinctBlocks,
        est: plan.est,
        callSavingRatio: plan.callSavingRatio,
        byteAmplification: plan.byteAmplification,
      };
      this.ledger.add({ kind: 'trace', summary: `ingestion plan: ${plan.rationale}`, ref: { program } });
    }

    // ---- Phase 3: read.
    if (chosen === 'per_block' && this.o.batcher) {
      const groups = this.o.batcher.groupBySlot(collected);
      const sum = await this.o.batcher.ingest(program, groups, builder, this.o.batchOpts ?? {});
      this.o.client.resetByteCounter();
      found = sum.transactionsRelevant;
      pruned = sum.blocksNull;
      errors = sum.errors;
      ingest.summary = sum;
      if (sum.stoppedReason) {
        stoppedReason = sum.stoppedReason;
        budgetLimited = /budget/.test(sum.stoppedReason);
      }
    } else {
      for (const sig of collected) {
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
          res = await this.o.client.getTransaction(sig.signature);
        } catch (e) {
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
          this.ledger.add({ kind: 'limit', summary: `getTransaction failed: ${JSON.stringify(res.error)}`, ref: { signature: sig.signature } });
          continue;
        }
        const tx = res.tx;
        for (const ins of tx.transaction.message.instructions) coInvoked.add(ins.programId);
        const resolution = resolveAccountKeys(tx);
        const analysis = analyzeTrace(tx, resolution);
        builder.addTrace(sig.signature, tx, analysis);
        found++;
        fetched.push(sig.signature);
        if (tx.blockTime !== null && tx.blockTime !== undefined) {
          oldestBlockTime = oldestBlockTime === null ? tx.blockTime : Math.min(oldestBlockTime, tx.blockTime);
          newestBlockTime = newestBlockTime === null ? tx.blockTime : Math.max(newestBlockTime, tx.blockTime);
        }
        if (found === 1 || found % 25 === 0) {
          this.ledger.add({
            kind: 'trace',
            summary: `trace ${found}: slot=${tx.slot} version=${String(tx.version)} outer=${tx.transaction.message.instructions.length} innerGroups=${tx.meta?.innerInstructions?.length ?? 0} attribution=${analysis.quality} keys=${resolution.method}`,
            ref: { signature: sig.signature, slot: tx.slot },
          });
        }
      }
      ingest.strategy = 'per_signature';
    }

    const graph = builder.finalize();
    this.mark('act', `strategy=${ingest.strategy} traces=${found} pruned=${pruned} errors=${errors} edges=${graph.detailedEdges.length} quality=${graph.attributionQuality}${stoppedReason ? ` stopped: ${stoppedReason}` : ''}`);
    if (pruned > 0) {
      this.ledger.add({
        kind: 'limit',
        summary:
          ingest.strategy === 'per_block'
            ? `${pruned} of ${groups_count(collected)} requested block(s) came back null: skipped slots and pruned history are indistinguishable from the response alone`
            : `${pruned} of ${found + pruned} sampled signatures were unavailable from the node (pruned history or retention window). The graph is built from what was retrievable, not from what happened.`,
        ref: { program },
      });
    }
    if (graph.attributionQuality === 'flat') {
      this.ledger.add({
        kind: 'limit',
        summary: `${graph.flattenedFrames} nested CPI(s) had neither stackHeight nor usable logs; attributed to the outer instruction. Dependent counts are an upper bound.`,
        ref: { program },
      });
    }
    for (const a of graph.anomalies) this.ledger.add({ kind: 'limit', summary: a, ref: { program } });

    const spanDays = oldestBlockTime !== null && newestBlockTime !== null ? (newestBlockTime - oldestBlockTime) / 86_400 : null;
    return {
      graph,
      planned,
      found,
      pruned,
      fetchErrors: errors,
      stoppedReason,
      spanDays,
      budgetLimited,
      duplicates,
      ingest,
      source,
      coInvokedPrograms: [...coInvoked],
      signatures: fetched,
      wantedSignatures: decision.plan.wantedSignatures,
    };
  }

  /** EVALUATE. Digest the graph into exposure, then price it against evidence quality. */
  private evaluate(ctx: UpgradeContext, built: ActResult & { wantedSignatures?: number }): {
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
      lamportsMovedDeduped: graph.lamportsMovedDeduped,
      mintsTouched: new Set(graph.detailedEdges.flatMap((e) => e.tokenMintsTouched)).size,
      selfCpi: graph.nodeMeta.some((n) => n.selfCpi && n.id === ctx.program),
    };
    const evidence: EvidenceSignals = {
      signaturesPlanned: built.planned,
      signaturesFound: built.found,
      signaturesPruned: built.pruned,
      fetchErrors: built.fetchErrors,
      duplicateSignatures: built.duplicates,
      // Against what the risk wanted, not what the budget allowed the plan to be.
      sampleCoverage: Math.min(1, built.found / Math.max(1, decisionPlanWanted(built))),
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
        cannotDetermine: 'no IDL was resolvable for this program, so Dot has no source-level view of the change; the advisory below reasons from posture and the observed call graph only',
        cites: [],
        tokensUsed: 0,
        refused: 'idl_unavailable',
      };
    }
    const direct = directDependents(graph, ctx.program);
    return this.o.narrate(
      ctx,
      {
        program: ctx.program,
        valueRoutedLamports: graph.detailedEdges.reduce((s2, e) => s2 + e.lamportsRouted, 0),
        mintsTouched: new Set(graph.detailedEdges.flatMap((e) => e.tokenMintsTouched)).size,
        dependents: direct.map((e) => ({ program: e.from, count: e.count, lamportsRouted: e.lamportsRouted })),
        idlDiff: ctx.idl.diffText,
        posture: ctx.authority.posture,
        authorityRotated: ctx.change.authorityChanged,
      },
      this.ledger,
    );
  }

  private integrityReport(program: string, label: string | undefined, t0: number): DotReport {
    const halt = this.integrityHalt!;
    this.ledger.add({ kind: 'limit', summary: `ENDPOINT DISAGREEMENT: ${halt.reason}`, ref: { program } });
    return {
      schema: 'dot.report.v1',
      generatedAt: new Date().toISOString(),
      program,
      ...(label ? { label } : {}),
      mode: this.o.mode,
      programData: deriveProgramData(program),
      event: 'upgrade',
      tier: 'P0',
      tierSource: 'integrity',
      score: 0,
      confidence: 'low',
      components: [
        {
          name: 'endpoint_disagreement',
          points: 0,
          max: 0,
          why: halt.reason,
        },
      ],
      cappedBy: 'halted: two endpoints contradict each other about the same account at the same slot',
      stoppedAt: 'perceive',
      stages: this.trace,
      stopNote: 'endpoint disagreement',
      decision: null,
      blastRadius: null,
      graph: null,
      evidence: this.ledger.all(),
      integrity: { agreement: halt.agreement, reason: halt.reason, endpoints: halt.endpoints },
      limits: limitsFor({
        pruned: 0,
        attributionQuality: 'stackHeight',
        idlAvailable: false,
        logTruncated: false,
      }),
      budget: this.o.budget.snapshot(),
      rpc: this.o.client.statsView(),
      wallMs: Date.now() - t0,
    };
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
      tierSource: 'exposure',
      score: built?.risk.score ?? 0,
      confidence: built?.risk.confidence ?? 'low',
      components: built?.risk.components ?? [],
      cappedBy: built?.risk.cappedBy ?? stopNote,
      stoppedAt,
      stopNote,
      stages: this.trace,
      ...(this.hypothesis ? { hypothesis: this.hypothesis } : {}),
      ...(this.chainVerified ? { chainVerified: this.chainVerified } : {}),
      ...(this.coControlled.length > 0 || this.widenNote
        ? { coControlledPrograms: this.coControlled, widenNote: this.widenNote }
        : {}),
      decision: decision ? decisionTrace(decision) : null,
      blastRadius: built
        ? {
            directCallers: built.exposure.directCallers,
            transitiveCallers: built.exposure.transitiveCallers,
            edges: built.exposure.edges,
            cpiOccurrences: built.exposure.cpiOccurrences,
            failedCpiOccurrences: built.exposure.failedCpiOccurrences,
            lamportsRouted: built.exposure.lamportsRouted,
            lamportsMovedDeduped: built.exposure.lamportsMovedDeduped,
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
      // Corroboration is reported whether or not it halted: "one endpoint's word"
      // is a property of every number below it, and hiding it unless it became an
      // emergency is how a tool trains its users to trust it too much.
      ...(this.lastQuorum
        ? {
            integrity: {
              agreement: this.lastQuorum.agreement,
              reason: this.lastQuorum.reason,
              endpoints: this.lastQuorum.endpoints,
            },
          }
        : {}),
      ...(built?.ingest ? { ingest: built.ingest } : {}),
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

function plannedOrZero(d: { plan: { signatures: number } }): number {
  return d.plan.signatures;
}

/**
 * The observation a carried claim is judged on, read off what this run *did*: the traces
 * it pulled, the selectors its edges actually carried, whether an entrypoint view existed
 * to match against, and whether the authority history was ever sampled. Each "no" here is
 * a check that did not run, which is why `observed` is reported separately from the counts
 * — a zero from a check that never ran must not come back as `denied`.
 */
export function retestObservation(
  built: { found: number; graph: Graph },
  program: string,
  bytecode: BytecodeDiff | null,
  coControlled: string[],
  authorityHistorySampled: boolean,
): ReTestObservation {
  const selectors = built.graph.detailedEdges
    .filter((e) => e.to === program)
    .flatMap((e) => (e.selectors ?? []).map((s) => s.hex));
  const count = (hexes: string[]) => hexes.reduce((n, hex) => n + selectors.filter((s) => s === hex).length, 0);
  const surface = bytecode?.instructions ?? null;
  return {
    signaturesPulled: built.found,
    addedSelectorMatches: count((surface?.added ?? []).map((a) => a.hex)),
    removedSelectorMatches: count((surface?.removed ?? []).map((r) => r.hex)),
    coControlled: coControlled.length,
    // `unscannable` means the scan is blind to this image's emission format, so an empty
    // added/removed list is not an observation about the program at all. Without this the
    // re-test would "confirm" a routine-upgrade claim from the absence of evidence.
    observed: {
      entrypointSurface: Boolean(surface) && bytecode?.confidence !== 'unscannable',
      authorityHistory: authorityHistorySampled,
    },
  };
}

function groups_count(sigs: Array<{ slot: number }>): number {
  return new Set(sigs.map((x) => x.slot)).size;
}
