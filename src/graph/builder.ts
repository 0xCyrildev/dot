import { Buffer } from 'node:buffer';
import { isNoiseProgram } from '../ids.js';
import type { WireGetTransactionResult, WireTokenBalance } from '../rpc/wire.js';
import type { CallFrame, TraceAnalysis } from './normalize.js';

export type GraphEdge = {
  from: string;
  to: string;
  /** CPI occurrences attributed to this caller, including ones that later failed. */
  count: number;
  succeeded: number;
  failed: number;
  /** Distinct signatures; a program CPI'd 1000 times in one tx is one integrator, not 1000. */
  transactions: number;
  /**
   * Lamports *received* by accounts touched by this call, summed over traces.
   * Counted once on the receiving side (sum of positive balance deltas), so it is
   * a per-call upper bound and not a settlement total: a swap through a router
   * moves value across several accounts and Dot cannot attribute it to one leg.
   */
  lamportsRouted: number;
  tokenMintsTouched: string[];
  /** Frames whose parent was inferred by flattening rather than by stackHeight or logs. */
  flattenedAttributions: number;
  firstSeenSlot: number;
  lastSeenSlot: number;
  lastBlockTime: number | null;
  supplyChain: boolean;
};

export type ProgramNode = {
  id: string;
  inbound: number;
  outbound: number;
  noise: boolean;
  selfCpi: boolean;
};

export type Graph = {
  target: string;
  /** Flat program-id list, as the spec asks for. Sorted by dependency significance. */
  nodes: string[];
  edges: Array<{
    from: string;
    to: string;
    count: number;
    lamportsRouted: number;
  }>;
  detailedEdges: GraphEdge[];
  nodeMeta: ProgramNode[];
  tracesAnalyzed: number;
  tracesFailed: number;
  /** Attribution honesty for the whole graph, worst value across traces. */
  attributionQuality: 'stackHeight' | 'logs' | 'flat';
  flattenedFrames: number;
  anomalies: string[];
};

type TraceValue = {
  keyDelta: number[];
  tokenDeltasByMint: Map<string, bigint>;
};

/** Lamports and token movement per account index, derived from the balance arrays. */
export function traceValue(tx: WireGetTransactionResult, keyCount: number): TraceValue {
  const meta = tx.meta;
  const keyDelta: number[] = [];
  if (meta && meta.preBalances.length === meta.postBalances.length) {
    for (let i = 0; i < meta.preBalances.length; i++) {
      keyDelta.push((meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0));
    }
  }
  while (keyDelta.length < keyCount) keyDelta.push(0);
  const tokenDeltasByMint = new Map<string, bigint>();
  if (meta) {
    const pre: WireTokenBalance[] = meta.preTokenBalances ?? [];
    const post: WireTokenBalance[] = meta.postTokenBalances ?? [];
    // The two arrays are parallel by position in practice, but a token account
    // created mid-transaction appears only in `post`. Index by accountIndex+mint
    // so a mid-tx creation shows up as a real delta instead of being dropped.
    const key = (t: WireTokenBalance) => `${t.accountIndex}:${t.mint}`;
    const preMap = new Map(pre.map((t) => [key(t), BigInt(t.uiTokenAmount.amount || '0')]));
    for (const t of post) {
      const before = preMap.get(key(t)) ?? 0n;
      const after = BigInt(t.uiTokenAmount.amount || '0');
      const delta = after - before;
      if (delta !== 0n) {
        tokenDeltasByMint.set(t.mint, (tokenDeltasByMint.get(t.mint) ?? 0n) + delta);
      }
    }
    for (const [k, before] of preMap) {
      const inPost = post.some((t) => key(t) === k);
      if (!inPost && before !== 0n) {
        const mint = k.split(':')[1] as string;
        tokenDeltasByMint.set(mint, (tokenDeltasByMint.get(mint) ?? 0n) - before);
      }
    }
  }
  return { keyDelta, tokenDeltasByMint };
}

export class GraphBuilder {
  private readonly edges = new Map<string, GraphEdge & { txSet: Set<string>; mintSet: Set<string> }>();
  private readonly nodes = new Map<string, ProgramNode>();
  private tracesAnalyzed = 0;
  private tracesFailed = 0;
  private quality: Graph['attributionQuality'] = 'stackHeight';
  private flattenedFrames = 0;
  private anomalies = new Set<string>();

  constructor(readonly target: string) {}

  /** Absorb one transaction's normalized frames into the aggregate graph. */
  addTrace(signature: string, tx: WireGetTransactionResult, analysis: TraceAnalysis): void {
    this.tracesAnalyzed++;
    const failed = tx.meta?.err != null || (tx.meta?.status && 'Err' in tx.meta.status);
    if (failed) this.tracesFailed++;

    const rank: Record<Graph['attributionQuality'], number> = { stackHeight: 0, logs: 1, flat: 2 };
    if (rank[analysis.quality] > rank[this.quality]) this.quality = analysis.quality;
    this.flattenedFrames += analysis.flattenedFrames;
    analysis.anomalies.forEach((a) => this.anomalies.add(a));

    const keyCount = Math.max(tx.transaction.message.accountKeys.length, tx.meta?.preBalances.length ?? 0);
    const tv = traceValue(tx, keyCount);

    for (const frame of analysis.frames) {
      const from = frame.parentProgramId ?? this.target;
      const to = frame.programId;
      const id = `${from}\u0000${to}`;
      let edge = this.edges.get(id);
      if (!edge) {
        edge = {
          from,
          to,
          count: 0,
          succeeded: 0,
          failed: 0,
          transactions: 0,
          lamportsRouted: 0,
          tokenMintsTouched: [],
          flattenedAttributions: 0,
          firstSeenSlot: tx.slot,
          lastSeenSlot: tx.slot,
          lastBlockTime: tx.blockTime,
          supplyChain: !isNoiseProgram(from) && !isNoiseProgram(to),
          txSet: new Set<string>(),
          mintSet: new Set<string>(),
        };
        this.edges.set(id, edge);
      }

      edge.count++;
      if (frame.establishedBy === 'flat') edge.flattenedAttributions++;
      // A failed transaction is rolled back entirely; a failed CPI inside a
      // successful transaction is rolled back to its checkpoint. Either way no
      // value moved, so only successful frames contribute to `lamportsRouted`.
      if (frame.outcome === 'failed' || failed) {
        edge.failed++;
      } else if (frame.outcome === 'ok') {
        edge.succeeded++;
        let inbound = 0;
        for (const index of frame.accountIndexes) {
          const delta = tv.keyDelta[index];
          if (typeof delta === 'number' && delta > 0) inbound += delta;
        }
        edge.lamportsRouted += inbound;
        for (const [mint] of tv.tokenDeltasByMint) edge.mintSet.add(mint);
      } else {
        // Outcome unknown (no log evidence either way): the interaction happened,
        // but no value claim is made for it.
      }
      edge.txSet.add(signature);
      if (tx.slot < edge.firstSeenSlot) edge.firstSeenSlot = tx.slot;
      if (tx.slot > edge.lastSeenSlot) {
        edge.lastSeenSlot = tx.slot;
        edge.lastBlockTime = tx.blockTime;
      }

      this.touchNode(from, 'outbound');
      this.touchNode(to, 'inbound');
      if (from === to) {
        const n = this.nodes.get(to);
        if (n) n.selfCpi = true;
      }
    }
  }

  private touchNode(id: string, direction: 'inbound' | 'outbound'): void {
    let node = this.nodes.get(id);
    if (!node) {
      node = { id, inbound: 0, outbound: 0, noise: isNoiseProgram(id), selfCpi: false };
      this.nodes.set(id, node);
    }
    if (direction === 'inbound') node.inbound++;
    else node.outbound++;
  }

  finalize(): Graph {
    const detailed: GraphEdge[] = [...this.edges.values()]
      .map((e) => ({
        from: e.from,
        to: e.to,
        count: e.count,
        succeeded: e.succeeded,
        failed: e.failed,
        transactions: e.txSet.size,
        lamportsRouted: e.lamportsRouted,
        tokenMintsTouched: [...e.mintSet].sort(),
        flattenedAttributions: e.flattenedAttributions,
        firstSeenSlot: e.firstSeenSlot,
        lastSeenSlot: e.lastSeenSlot,
        lastBlockTime: e.lastBlockTime,
        supplyChain: e.supplyChain,
      }))
      .sort((a, b) => b.lamportsRouted - a.lamportsRouted || b.count - a.count || a.to.localeCompare(b.to));

    const nodeMeta = [...this.nodes.values()].sort(
      (a, b) => Number(a.noise) - Number(b.noise) || b.inbound - a.inbound || a.id.localeCompare(b.id),
    );

    return {
      target: this.target,
      nodes: nodeMeta.map((n) => n.id),
      edges: detailed.map((e) => ({ from: e.from, to: e.to, count: e.count, lamportsRouted: e.lamportsRouted })),
      detailedEdges: detailed,
      nodeMeta,
      tracesAnalyzed: this.tracesAnalyzed,
      tracesFailed: this.tracesFailed,
      attributionQuality: this.quality,
      flattenedFrames: this.flattenedFrames,
      anomalies: [...this.anomalies],
    };
  }
}

/** Programs that call `target`, with the shortest attributed call distance. */
export function directDependents(graph: Graph, target: string): GraphEdge[] {
  return graph.detailedEdges.filter((e) => e.to === target && e.from !== target && !isNoiseProgram(e.from));
}

export function dependentsByDepth(
  graph: Graph,
  target: string,
  maxDepth: number,
): Array<{ depth: number; program: string; via: string; count: number; lamportsRouted: number }> {
  const out: Array<{ depth: number; program: string; via: string; count: number; lamportsRouted: number }> = [];
  const seen = new Set<string>([target]);
  let frontier = [target];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const edge of graph.detailedEdges.filter((e) => e.to === node)) {
        if (seen.has(edge.from) || isNoiseProgram(edge.from)) continue;
        seen.add(edge.from);
        out.push({ depth, program: edge.from, via: node, count: edge.count, lamportsRouted: edge.lamportsRouted });
        next.push(edge.from);
      }
    }
    frontier = next;
  }
  return out.sort((a, b) => a.depth - b.depth || b.lamportsRouted - a.lamportsRouted);
}

export function graphDigest(graph: Graph): {
  uniqueCallers: number;
  supplyChainCallers: number;
  totalCpiCount: number;
  lamportsRouted: number;
  mintsTouched: number;
  selfCpiPrograms: string[];
} {
  const callers = directDependents(graph, graph.target);
  return {
    uniqueCallers: callers.length,
    supplyChainCallers: new Set(callers.map((c) => c.from)).size,
    totalCpiCount: graph.detailedEdges.reduce((s, e) => s + e.count, 0),
    lamportsRouted: graph.detailedEdges.reduce((s, e) => s + e.lamportsRouted, 0),
    mintsTouched: new Set(graph.detailedEdges.flatMap((e) => e.tokenMintsTouched)).size,
    selfCpiPrograms: graph.nodeMeta.filter((n) => n.selfCpi).map((n) => n.id),
  };
}

/** Helper for tests and reports: a stable base64->hex digest prefix of account bytes. */
export function shortDigest(bytes: Buffer): string {
  return bytes.subarray(0, 4).toString('hex');
}
