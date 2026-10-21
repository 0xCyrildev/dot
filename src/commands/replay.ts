import { readFile } from 'node:fs/promises';
import { GraphBuilder, directDependents } from '../graph/builder.js';
import { analyzeTrace } from '../graph/normalize.js';
import { resolveAccountKeys } from '../graph/keys.js';
import { labelOf } from '../ids.js';
import type { WireGetTransactionResult } from '../rpc/wire.js';

/**
 * Replay a captured `getTransaction` response through the real analyzer, offline.
 *
 * The reason this command exists is credibility: it lets a reviewer run the fold, the
 * key resolution and the attribution logic on **bytes that came off mainnet** with no
 * RPC endpoint, no API key and no network at all. The numbers it prints are derived
 * from a real transaction, and the transaction's own provenance is recorded beside
 * them. It is not a substitute for a live sweep — it is exactly one transaction, and
 * it says so.
 */
export type ReplayResult = {
  source: string;
  provenance: string;
  slot: number;
  version: string;
  succeeded: boolean;
  outerInstructions: number;
  innerGroups: number;
  innerInstructions: number;
  attributionQuality: string;
  keyResolution: string;
  frames: Array<{ depth: number; caller: string | null; callee: string; via: string; calleeLabel?: string }>;
  edges: Array<{ from: string; to: string; count: number; lamportsRouted: number; transactions: number }>;
  directDependentsOf: { program: string; callers: Array<{ program: string; count: number; lamportsRouted: number }> };
};

export async function replayTransaction(
  path: string,
  target: string,
  provenance = 'provenance not supplied; pass --provenance',
): Promise<ReplayResult> {
  const tx = JSON.parse(await readFile(path, 'utf8')) as WireGetTransactionResult;
  const resolution = resolveAccountKeys(tx);
  const analysis = analyzeTrace(tx, resolution);
  const builder = new GraphBuilder(target);
  const signature = tx.transaction.signatures[0] ?? 'replayed';
  builder.addTrace(signature, tx, analysis);
  const graph = builder.finalize();
  const deps = directDependents(graph, target);
  return {
    source: path,
    provenance,
    slot: tx.slot,
    version: String(tx.version),
    succeeded: tx.meta?.err == null,
    outerInstructions: tx.transaction.message.instructions.length,
    innerGroups: tx.meta?.innerInstructions?.length ?? 0,
    innerInstructions: (tx.meta?.innerInstructions ?? []).reduce((s, g) => s + g.instructions.length, 0),
    attributionQuality: analysis.quality,
    keyResolution: resolution.method,
    frames: analysis.frames.map((f) => ({
      depth: f.depth,
      caller: f.parentProgramId,
      callee: f.programId,
      via: f.establishedBy,
      ...(labelOf(f.programId) ? { calleeLabel: labelOf(f.programId) } : {}),
    })),
    edges: graph.detailedEdges.map((e) => ({
      from: e.from,
      to: e.to,
      count: e.count,
      lamportsRouted: e.lamportsRouted,
      transactions: e.transactions,
    })),
    directDependentsOf: { program: target, callers: deps.map((d) => ({ program: d.from, count: d.count, lamportsRouted: d.lamportsRouted })) },
  };
}

export function renderReplay(r: ReplayResult): string {
  const L: string[] = [];
  L.push(`Replayed ${r.source} — ${r.provenance}`);
  L.push(`slot ${r.slot}  version ${r.version}  ${r.succeeded ? 'succeeded' : 'FAILED (rolled back)'}  keys via ${r.keyResolution}`);
  L.push(`${r.outerInstructions} outer instruction(s), ${r.innerGroups} inner group(s), ${r.innerInstructions} CPI instruction(s), attribution ${r.attributionQuality}`);
  L.push('');
  L.push('Call frames (caller -> callee, and how the caller was established):');
  for (const f of r.frames) {
    L.push(`  depth ${f.depth}  ${short(f.caller ?? '(outer)')} -> ${short(f.callee)}${f.calleeLabel ? ` [${f.calleeLabel}]` : ''}  via ${f.via}`);
  }
  L.push('');
  L.push('Aggregated edges:');
  for (const e of r.edges) L.push(`  ${short(e.from)} -> ${short(e.to)}  count=${e.count} lamports=${e.lamportsRouted} txs=${e.transactions}`);
  L.push('');
  L.push(`Direct dependents of ${short(r.directDependentsOf.program)}: ${r.directDependentsOf.callers.length}`);
  for (const c of r.directDependentsOf.callers) L.push(`  ${short(c.program)} (${c.count} CPI, ${c.lamportsRouted} lamports)`);
  L.push('');
  L.push('One transaction, replayed from captured bytes. It is not a sweep and does not stand for one.');
  return L.join('\n');
}

function short(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}
