import { readFile } from 'node:fs/promises';
import type { SolanaClient } from '../rpc/client.js';
import type { WireGetTransactionResult } from '../rpc/wire.js';
import { BPF_LOADER_UPGRADEABLE, isNoiseProgram } from '../ids.js';
import { deriveProgramData } from '../state/programdata.js';
import { BudgetExhaustedError } from '../errors.js';

/**
 * Ecosystem-level blast radius.
 *
 * `dot analyze <program>` answers "what depends on this one program". The question an
 * incident review actually asks is the plural one: **of everything that upgraded in
 * this window, which upgrade should a human open first?** That requires the upgrade
 * history, and history is exactly what core JSON-RPC does not offer as a stream.
 *
 * Discovery, honestly: every `upgrade`, `deploy`, `set-authority` and `close`
 * instruction names `BPFLoaderUpgradeable` as an account key, so
 * `getSignaturesForAddress(loader)` *is* the chain-wide upgrade ledger, over plain
 * RPC, with no indexer. The cost is that the index mixes instruction types, and the
 * response does not label them. So the (program, programdata) pair is proven
 * structurally instead of by decoding a discriminator: for every key in the
 * transaction, re-derive its programdata PDA locally and check whether that PDA is
 * also present in the same transaction. Two keys that satisfy the relation are a
 * real program/programdata pair — a check that needs no RPC call, no instruction
 * layout knowledge, and no trust in the node's own parsing.
 *
 * What this cannot do is stated in the output, not hidden: `--since` is bounded by
 * node retention, the loader index also contains authority changes and closes, and
 * no field anywhere in this report is a USD figure unless the operator supplied a
 * price.
 */

export type UpgradeRecord = {
  signature: string;
  slot: number;
  blockTime: number | null;
  program: string;
  programData: string;
  /** Lamports held by the program's accounts at read time — a floor, not a TVL. */
  lamportsTouched: number;
};

/** A directed call edge as observed by any analysis in this run. */
export type ObservedEdge = {
  from: string;
  to: string;
  count: number;
  lamportsRouted: number;
  /** Leading 8 bytes of the calls on this edge; for Anchor, the instruction selectors. */
  selectors: string[];
};

export type AddedEntrypoint = { name: string; selector: string | null };

/**
 * A caller reached through the global graph, with its hop distance.
 *
 * A transitive dependent is genuinely less exposed than a direct one — the upgrade
 * reaches it through an intermediary that may absorb the change — but it is not zero,
 * because behaviour changes propagate through callers that assume the old behaviour.
 * So depth is carried into the weighting as 1/depth and printed alongside every count,
 * never folded into a single "dependents" number.
 */
export type ReachedProgram = { program: string; depth: number; via: string; count: number; lamportsRouted: number; weight: number };

/** Reach set for one upgraded program, computed over the union of all observed edges. */
export function multiHop(edges: ObservedEdge[], target: string, depth: number): { direct: ReachedProgram[]; transitive: ReachedProgram[]; byDepth: Map<number, ReachedProgram[]> } {
  const callersOf = new Map<string, ObservedEdge[]>();
  for (const e of edges) {
    const list = callersOf.get(e.to) ?? [];
    list.push(e);
    callersOf.set(e.to, list);
  }
  // The target is marked seen before the walk: with a call cycle in the graph
  // (A -> B -> A, or a program that calls a sibling which calls back), an
  // unseeded set lets the upgraded program reappear as one of its own transitive
  // dependents, which would inflate both the count and the ranking.
  const seen = new Map<string, ReachedProgram>([[target, { program: target, depth: 0, via: target, count: 0, lamportsRouted: 0, weight: 0 }]]);
  const byDepth = new Map<number, ReachedProgram[]>();
  let frontier = [target];
  for (let d = 1; d <= Math.max(1, depth) && frontier.length > 0; d++) {
    const found: ReachedProgram[] = [];
    const next: string[] = [];
    for (const node of frontier) {
      for (const e of callersOf.get(node) ?? []) {
        if (e.from === node || seen.has(e.from) || isNoiseProgram(e.from)) continue;
        const reached: ReachedProgram = {
          program: e.from,
          depth: d,
          via: node,
          count: e.count,
          lamportsRouted: e.lamportsRouted,
          weight: 1 / d,
        };
        seen.set(e.from, reached);
        found.push(reached);
        next.push(e.from);
      }
    }
    if (found.length > 0) byDepth.set(d, found);
    frontier = next;
  }
  return {
    direct: byDepth.get(1) ?? [],
    transitive: [...byDepth.entries()].filter(([d]) => d > 1).flatMap(([, v]) => v),
    byDepth,
  };
}

/** Which callers reach the target *through a specific instruction selector*. */
export function callersViaSelector(edges: ObservedEdge[], target: string, selector: string, depth: number): ReachedProgram[] {
  const direct = edges.filter((e) => e.to === target && e.selectors.includes(selector)).map((e) => ({
    program: e.from,
    depth: 1,
    via: target,
    count: e.count,
    lamportsRouted: e.lamportsRouted,
    weight: 1,
  }));
  const directSet = new Set(direct.map((d) => d.program));
  const deeper = multiHop(edges, target, depth).transitive.filter((t) => !directSet.has(t.program));
  void deeper;
  return direct;
}

export type ProgramAssessment = {
  program: string;
  upgrades: number;
  lastSlot: number;
  lastBlockTime: number | null;
  dependents: number;
  transitiveDependents: number;
  lamportsRouted: number;
  mintsTouched: number;
  authority: string | null;
  authorityLabel: string;
  /** Composite rank, with its arithmetic exposed rather than multiplied away. */
  rank: { dependentsScore: number; valueScore: number; composite: number; formula: string };
  /** Depth-aware reach, when a global edge pool was supplied. */
  reach?: { direct: number; transitive: number; byDepth: Record<number, string[]>; weightedDependents: number };
  /** Correlation between a newly added entrypoint and who actually calls it. */
  addedEntrypointExposure?: Array<{
    name: string;
    selector: string | null;
    directCallersOnSelector: number;
    note: string;
  }>;
  detail?: Record<string, unknown>;
};

export type AuthorityDeclaration = { label: string };

export type ScanOptions = {
  /** Max loader signatures to examine. This is the discovery budget, not the analysis budget. */
  maxRecords: number;
  /** Only rank programs with at least this much attributed value. */
  minValueLamports: number;
  /** Only rank programs with at least this many dependents. */
  minDependents: number;
  /** Restrict to a program list instead of discovering from the loader index. */
  programs?: string[];
  /** Hops of dependent reach to compute. 1 is the old direct-only behaviour. */
  depth?: number;
  /** Union of edges seen across all analyses in this run; enables multi-hop without new calls. */
  edgePool?: ObservedEdge[];
  addedEntrypointsByProgram?: Map<string, AddedEntrypoint[]>;
  solUsd?: number | null;
  authorityMap?: Map<string, AuthorityDeclaration>;
};

export type AnalyzeProgram = (program: string) => Promise<{
  dependents: number;
  transitiveDependents: number;
  lamportsRouted: number;
  mintsTouched: number;
  authority: string | null;
  detail?: Record<string, unknown>;
  /** Observed call edges, so the scanner can build multi-hop reach across programs. */
  edges?: ObservedEdge[];
  /** Entrypoints the Section-1 bytecode diff found added, with their selectors. */
  addedEntrypoints?: AddedEntrypoint[];
}>;

export type ScanResult = {
  records: UpgradeRecord[];
  ranked: ProgramAssessment[];
  /** Union of every observed edge; lets a caller re-derive reach without new RPC. */
  edgePool?: ObservedEdge[];
  skipped: { noProgramPair: number; pruned: number; errors: number; belowThreshold: number; budgetStops: number };
  discovery: {
    method: string;
    scanned: number;
    /** Retention is the reason a "since" window comes back short, and it must be visible. */
    oldestSeenBlockTime: number | null;
    requestedSince: number | null;
    sinceSatisfied: boolean | null;
    stoppedReason: string | null;
  };
  value: { unit: 'lamports'; usdPerSol: number | null; note: string };
};

export class BlastRadiusScanner {
  constructor(
    private readonly client: SolanaClient,
    private readonly analyze: AnalyzeProgram,
  ) {}

  async discover(opts: { maxRecords: number; since?: number | null }): Promise<{ records: UpgradeRecord[]; discovery: ScanResult['discovery']; skipped: ScanResult['skipped'] }> {
    const records: UpgradeRecord[] = [];
    const skipped = { noProgramPair: 0, pruned: 0, errors: 0, belowThreshold: 0, budgetStops: 0 };
    let cursor: string | undefined;
    let scanned = 0;
    let oldestSeenBlockTime: number | null = null;
    let stoppedReason: string | null = null;
    let sinceSatisfied: boolean | null = null;
    let previousRecordCount = 0;

    while (records.length < opts.maxRecords) {
      const want = Math.min(50, opts.maxRecords - records.length);
      let sigs;
      try {
        sigs = await this.client.getSignaturesForAddress(BPF_LOADER_UPGRADEABLE, {
          limit: want,
          ...(cursor ? { until: cursor } : {}),
        });
      } catch (e) {
        if (e instanceof BudgetExhaustedError) {
          stoppedReason = `discovery budget exhausted at ${records.length} record(s)`;
          skipped.budgetStops++;
          break;
        }
        stoppedReason = `loader signature walk failed: ${(e as Error).message}`;
        break;
      }
      if (sigs.length === 0) {
        stoppedReason = 'the loader index is empty beyond this point: Dot has reached the end of what this node retains';
        // Three states, not two. Nothing observed at all is *unknown*, which is not
        // the same claim as "observed history that did not reach back far enough".
        sinceSatisfied =
          opts.since === null || opts.since === undefined
            ? null
            : scanned === 0 || oldestSeenBlockTime === null
              ? null
              : oldestSeenBlockTime <= opts.since;
        break;
      }

      for (const s of sigs) {
        scanned++;
        if (opts.since && s.blockTime && s.blockTime < opts.since) {
          sinceSatisfied = true;
          stoppedReason = 'reached the requested --since boundary';
          break;
        }
        const res = await this.client.getTransaction(s.signature);
        if (res.status === 'pruned') {
          skipped.pruned++;
          continue;
        }
        if (res.status === 'error') {
          skipped.errors++;
          continue;
        }
        const pair = extractProgramPair(res.tx);
        if (pair === null) {
          // Loader touched without a program/programdata pair: initialize on a
          // fresh buffer, a close, or an authority change. Not an upgrade of a
          // deployed program, so it is counted and left out rather than guessed in.
          skipped.noProgramPair++;
          continue;
        }
        if (s.blockTime !== null && s.blockTime !== undefined) {
          oldestSeenBlockTime = oldestSeenBlockTime === null ? s.blockTime : Math.min(oldestSeenBlockTime, s.blockTime);
        }
        records.push({
          signature: s.signature,
          slot: s.slot,
          blockTime: s.blockTime ?? null,
          program: pair.program,
          programData: pair.programData,
          lamportsTouched: sumPositiveDelta(res.tx),
        });
        if (records.length >= opts.maxRecords) break;
      }
      if (stoppedReason) break;
      const before = sigs.length === 0 ? 0 : scanned;
      cursor = sigs[sigs.length - 1]?.signature;
      if (!cursor) break;
      // A window that added no new signature is the provider ignoring `until`.
      // Without this the walk re-reads the same ledger until the budget dies.
      if (records.length > 0 && previousRecordCount === records.length) {
        stoppedReason = 'the loader cursor made no progress: the provider returned an overlapping window';
        break;
      }
      previousRecordCount = records.length;
      void before;
    }
    if (stoppedReason === null && records.length >= opts.maxRecords) {
      stoppedReason = `maxRecords ${opts.maxRecords} reached; the walk may not have covered the whole window`;
    }

    return {
      records,
      skipped,
      discovery: {
        method: 'getSignaturesForAddress(BPFLoaderUpgradeable) + local PDA re-derivation of the program/programdata pair',
        scanned,
        oldestSeenBlockTime,
        requestedSince: opts.since ?? null,
        sinceSatisfied,
        stoppedReason,
      },
    };
  }

  /**
   * Rank by exposure, not by a single multiplied number.
   *
   * "dependents × value" is not a unit, so it is not printed as one: each axis is
   * log-scaled against a stated reference, the composite is their product, and the
   * three numbers appear together in the report. A reader can disagree with the
   * weighting without having to reverse-engineer it.
   */
  async rank(records: UpgradeRecord[], opts: ScanOptions): Promise<{ ranked: ProgramAssessment[]; belowThreshold: number; pool: ObservedEdge[] }> {
    const byProgram = new Map<string, UpgradeRecord[]>();
    for (const r of records) {
      const list = byProgram.get(r.program) ?? [];
      list.push(r);
      byProgram.set(r.program, list);
    }
    if (opts.programs) {
      for (const key of [...byProgram.keys()]) {
        if (!opts.programs.includes(key)) byProgram.delete(key);
      }
    }
    const depth = Math.max(1, opts.depth ?? 1);

    // Pass 1: analyse each program and grow a shared edge pool. Multi-hop has to be
    // computed after the pool exists, or the second program's view of the graph is
    // whatever the first program happened to observe.
    type Partial = { program: string; list: UpgradeRecord[]; assessed: Awaited<ReturnType<AnalyzeProgram>> };
    const collected: Partial[] = [];
    const pool: ObservedEdge[] = [...(opts.edgePool ?? [])];
    let belowThreshold = 0;
    for (const [program, list] of byProgram) {
      let assessed;
      try {
        assessed = await this.analyze(program);
      } catch (e) {
        if (e instanceof BudgetExhaustedError) break;
        continue;
      }
      for (const e of assessed.edges ?? []) pool.push(e);
      const live = assessed.dependents + assessed.transitiveDependents;
      const dedupedValue = assessed.lamportsRouted;
      if (dedupedValue < opts.minValueLamports && live < opts.minDependents) {
        belowThreshold++;
        continue;
      }
      collected.push({ program, list, assessed });
    }

    // Pass 2: reach over the whole pool, then score.
    const out: ProgramAssessment[] = [];
    for (const { program, list, assessed } of collected) {
      const reach = multiHop(pool, program, depth);
      const reachSeen = reach.direct.length + reach.transitive.length;
      /**
       * Weighting. When the pooled edges produced a reach set, use it. When they did
       * not -- an analysis that only reported counts, or a run where the graph came
       * from a different program's traces -- fall back to that program's own numbers
       * rather than scoring zero, because a missing edge pool is an absence of data
       * and must not read as an absence of dependents. Transitive dependents from the
       * per-program view carry no known depth, so they get the depth-2 weight.
       */
      const weighted =
        reachSeen > 0
          ? reach.direct.length + reach.transitive.reduce((sum, t) => sum + t.weight, 0)
          : assessed.dependents + assessed.transitiveDependents / 2;
      const dependentsScore = logScale(weighted, 200);
      const valueScore = valueScale(assessed.lamportsRouted);
      const composite = valueScore * (1 + dependentsScore);
      const declared = assessed.authority ? opts.authorityMap?.get(assessed.authority)?.label ?? null : null;
      const added = assessed.addedEntrypoints ?? opts.addedEntrypointsByProgram?.get(program) ?? [];
      out.push({
        program,
        upgrades: list.length,
        lastSlot: Math.max(...list.map((x) => x.slot)),
        lastBlockTime: list.map((x) => x.blockTime).filter((x): x is number => typeof x === 'number').sort((a, b) => b - a)[0] ?? null,
        dependents: reach.direct.length || assessed.dependents,
        transitiveDependents: reach.direct.length > 0 || reach.transitive.length > 0 ? reach.transitive.length : assessed.transitiveDependents,
        lamportsRouted: assessed.lamportsRouted,
        mintsTouched: assessed.mintsTouched,
        authority: assessed.authority,
        authorityLabel: declared ?? authorityFallback(assessed.authority),
        rank: { dependentsScore, valueScore, composite, formula: RANK_FORMULA },
        reach: {
          direct: reach.direct.length,
          transitive: reach.transitive.length,
          byDepth: Object.fromEntries([...reach.byDepth.entries()].map(([d, v]) => [d, v.map((x) => x.program)])),
          weightedDependents: Math.round(weighted * 100) / 100,
        },
        addedEntrypointExposure: added.map((a) => {
          const onSelector = a.selector ? callersViaSelector(pool, program, a.selector, depth) : [];
          return {
            name: a.name,
            selector: a.selector,
            directCallersOnSelector: onSelector.length,
            note:
              !a.selector
                ? 'selector unknown (no IDL name to hash, or no name to derive one from): cannot tell who already calls this entrypoint'
                : onSelector.length > 0
                  ? `${onSelector.length} observed caller(s) already send this selector — the new path has live traffic on it`
                  : 'no observed caller sends this selector yet: the path is reachable but currently unused in the sample',
          };
        }),
        detail: { ...(assessed.detail ?? {}), reach },
      });
    }
    return {
      ranked: out.sort((a, b) => b.rank.composite - a.rank.composite || b.lamportsRouted - a.lamportsRouted),
      belowThreshold,
      pool,
    };
  }

  async run(opts: ScanOptions & { since?: number | null }): Promise<ScanResult> {
    const { records, discovery, skipped } = await this.discover({ maxRecords: opts.maxRecords, ...(opts.since ? { since: opts.since } : {}) });
    const { ranked, belowThreshold, pool } = await this.rank(records, opts);
    return {
      records,
      ranked,
      skipped: { ...skipped, belowThreshold },
      edgePool: pool,
      discovery,
      value: {
        unit: 'lamports',
        usdPerSol: opts.solUsd ?? null,
        note:
          opts.solUsd && opts.solUsd > 0
            ? `USD figures are lamports × an operator-supplied price of ${opts.solUsd}; Dot has no price oracle`
            : 'no USD figure is printed: Dot has no price oracle and will not invent one',
      },
    };
  }
}

/**
 * Prove the (program, programdata) relation from the key list alone.
 *
 * `deriveProgramData` is local and deterministic, so a pair is confirmed without
 * trusting the node's parsing, the instruction discriminator, or account ordering.
 */
export function extractProgramPair(tx: WireGetTransactionResult): { program: string; programData: string } | null {
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  const keySet = new Set(keys);
  if (!keySet.has(BPF_LOADER_UPGRADEABLE)) return null;
  for (const candidate of keys) {
    if (isNoiseProgram(candidate)) continue;
    let derived: string;
    try {
      derived = deriveProgramData(candidate);
    } catch {
      continue;
    }
    if (derived !== candidate && keySet.has(derived)) return { program: candidate, programData: derived };
  }
  return null;
}

function sumPositiveDelta(tx: WireGetTransactionResult): number {
  const meta = tx.meta;
  if (!meta) return 0;
  let sum = 0;
  for (let i = 0; i < Math.min(meta.preBalances.length, meta.postBalances.length); i++) {
    const d = (meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0);
    if (d > 0) sum += d;
  }
  return sum;
}

function logScale(value: number, reference: number): number {
  if (value <= 0) return 0;
  return Math.round((Math.log10(value + 1) / Math.log10(reference + 1)) * 1000) / 1000;
}

/**
 * Value is scored linearly, capped at the 1e12-lamports reference, while the
 * dependent count is log-scaled. That asymmetry is deliberate and it is the whole
 * ranking model: **$400M routed through 2 dependents outranks $40M through 14**, because
 * lamports are additive and absolute, whereas each additional caller adds less new
 * breadth than the one before it. Log-scaling both axes, which is the obvious thing
 * to do, silently inverts that: it compresses a 10x value difference into noise and
 * lets breadth win. Anyone who disagrees should be able to see exactly what to
 * change, which is why the formula is printed with every score.
 */
const VALUE_REFERENCE_LAMPORTS = 1e12;
export const RANK_FORMULA =
  `composite = valueScore × (1 + dependentsScore); valueScore = min(1, lamportsRouted / ${VALUE_REFERENCE_LAMPORTS}) (linear, absolute); ` +
  'dependentsScore = log10(direct+transitive+1) / log10(201) (diminishing breadth)';

function valueScale(lamports: number): number {
  if (lamports <= 0) return 0;
  return Math.round(Math.min(1, lamports / VALUE_REFERENCE_LAMPORTS) * 1000) / 1000;
}

/**
 * The authority line, honestly labelled. No RPC call reveals an m-of-n threshold, so
 * unless the operator declared this key in --authority-map, Dot prints the posture
 * it can derive and says the rest is undeclared. Printing "3-of-5 multisig" here
 * would be the single most load-bearing fabrication this command could make.
 */
function authorityFallback(authority: string | null): string {
  if (authority === null) return 'renounced (no authority present on chain)';
  return `undeclared key ${authority.slice(0, 8)}… (threshold/multisig structure is not readable from chain data; declare it in --authority-map)`;
}

export async function loadProgramList(path: string): Promise<string[]> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (Array.isArray(raw)) {
    return raw.map((x) => (typeof x === 'string' ? x : String((x as { program?: string }).program ?? ''))).filter(Boolean);
  }
  return [];
}

export async function loadAuthorityMap(path: string): Promise<Map<string, AuthorityDeclaration>> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, { label?: string; m?: number; n?: number }>;
  const map = new Map<string, AuthorityDeclaration>();
  for (const [key, v] of Object.entries(raw)) {
    const label = v.label ?? (v.m && v.n ? `${v.m}-of-${v.n} multisig (operator-declared)` : undefined);
    if (label) map.set(key, { label });
  }
  return map;
}

/**
 * The actionable object is a **warning list**, not a ranking table. A ranking tells
 * someone what to read; this tells someone who to contact. The party to notify for a
 * dependent program is whoever holds *its* upgrade authority, which Dot can read from
 * that program's own ProgramData account — so `notify` is a real address, or
 * `unobserved` when the budget did not allow the read. It is never a guessed name.
 */
export type Warning = {
  program: string;
  reason: string;
  dependents: Array<{ program: string; authority: string | null; lamportsRouted: number }>;
  notify: string[];
  unobservedAuthorities: number;
};

export function toWarnings(r: ScanResult): Warning[] {
  return r.ranked.map((a) => {
    const deps = (a.detail?.['dependents'] as Array<{ program: string; authority?: string | null; lamportsRouted?: number }> | undefined) ?? [];
    const notify = deps.map((d) => d.authority ?? null).filter((x): x is string => Boolean(x));
    return {
      program: a.program,
      reason:
        a.authorityLabel.startsWith('undeclared key')
          ? `single-key-or-undeclared authority with ${a.dependents} dependent program(s)`
          : `authority ${a.authorityLabel} with ${a.dependents} dependent program(s)`,
      dependents: deps.map((d) => ({ program: d.program, authority: d.authority ?? null, lamportsRouted: d.lamportsRouted ?? 0 })),
      notify: [...new Set(notify)],
      unobservedAuthorities: deps.filter((d) => !d.authority).length,
    };
  });
}

export function renderBlastRadius(r: ScanResult): string {
  const L: string[] = [];
  L.push(`# Ecosystem blast radius — ${r.records.length} loader transaction(s) examined, ${new Set(r.records.map((x) => x.program)).size} program(s) upgraded`);
  L.push('');
  L.push(`Discovery: ${r.discovery.method}`);
  L.push(`Scanned ${r.discovery.scanned} loader transaction(s); stopped: ${r.discovery.stoppedReason ?? 'no stop'}`);
  if (r.discovery.requestedSince !== null) {
    L.push(
      `--since ${new Date(r.discovery.requestedSince * 1000).toISOString()}: ` +
        (r.discovery.sinceSatisfied === true
          ? `reached (oldest observed ${r.discovery.oldestSeenBlockTime ? new Date(r.discovery.oldestSeenBlockTime * 1000).toISOString() : 'n/a'})`
          : r.discovery.sinceSatisfied === false
            ? `**NOT reached — the node ran out of history first.** Anything before ${r.discovery.oldestSeenBlockTime ? new Date(r.discovery.oldestSeenBlockTime * 1000).toISOString() : 'unknown'} was never examined`
            : 'undetermined'),
    );
  }
  L.push(
    `Skipped: ${r.skipped.noProgramPair} loader tx without a program pair, ${r.skipped.pruned} pruned, ${r.skipped.errors} errors, ${r.skipped.belowThreshold} below threshold`,
  );
  L.push(`Value: ${r.value.note}`);
  L.push('');
  if (r.ranked.length === 0) {
    L.push('Nothing ranked. This is a statement about what this node would return, not about the chain.');
    return L.join('\n');
  }
  L.push('| rank | program | upgrades | direct | transitive | weighted | lamports routed | mints | authority |');
  L.push('| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  r.ranked.forEach((a, i) => {
    const usd = r.value.usdPerSol ? ` ($${((a.lamportsRouted / 1e9) * r.value.usdPerSol).toLocaleString(undefined, { maximumFractionDigits: 0 })})` : '';
    L.push(
      `| ${i + 1} | \`${short(a.program)}\` | ${a.upgrades} | ${a.reach?.direct ?? a.dependents} | ${a.reach?.transitive ?? a.transitiveDependents} | ${(a.reach?.weightedDependents ?? a.dependents).toFixed(2)} | ${a.lamportsRouted.toLocaleString()}${usd} | ${a.mintsTouched} | ${a.authorityLabel} |`,
    );
  });
  L.push('');
  L.push(`Rank arithmetic: ${r.ranked[0]?.rank.formula ?? RANK_FORMULA}`);
  for (const a of r.ranked.slice(0, 5)) {
    L.push(`- \`${short(a.program)}\` at slot ${a.lastSlot}: value ${a.rank.valueScore} × (1 + deps ${a.rank.dependentsScore}) = ${a.rank.composite.toFixed(3)}`);
  }

  const warnings = toWarnings(r);
  L.push('');
  L.push('## Operators who should be notified');
  for (const w of warnings.slice(0, 10)) {
    L.push(`- \`${short(w.program)}\` — ${w.reason}: ` + (w.notify.length > 0 ? w.notify.map((n) => `\`${short(n)}\``).join(', ') : 'no authorities observed') + (w.unobservedAuthorities > 0 ? ` (${w.unobservedAuthorities} dependent authorit${w.unobservedAuthorities === 1 ? 'y' : 'ies'} not read)` : ''));
  }
  L.push('');
  L.push('Dot ranks where a human looks first. It does not establish that any of these upgrades is malicious, and a low rank is a statement about observable evidence.');
  return L.join('\n');
}

function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}
