import { isNoiseProgram } from '../ids.js';
import type {
  WireAnyInstruction,
  WireGetTransactionResult,
  WireInnerInstructionGroup,
} from '../rpc/wire.js';
import { accountPubkey, type KeyResolution } from './keys.js';

/** The critical rule of `meta.innerInstructions`. */
export type FoldResult = {
  /** outer instruction index -> the CPI instructions that ran beneath it, in execution order. */
  groups: Map<number, WireAnyInstruction[]>;
  anomalies: string[];
};

/**
 * Fold the inner instruction lists back onto their parent outer instruction.
 *
 * `innerInstructions[].index` is a position in `transaction.message.instructions`,
 * not an offset into a flat list of all instructions, and the same `index` never
 * repeats across groups — but a node that is lying to you, or a transaction that
 * hit the CPI-depth ceiling, can produce an out-of-range or duplicate index.
 * Both are recorded instead of being papered over, because an out-of-range index
 * means every edge in that group would be attributed to the wrong caller.
 */
export function foldInnerInstructions(
  inner: WireInnerInstructionGroup[] | null | undefined,
  outerCount: number,
): FoldResult {
  const groups = new Map<number, WireAnyInstruction[]>();
  const anomalies: string[] = [];
  if (!inner || inner.length === 0) return { groups, anomalies };

  inner.forEach((g, position) => {
    if (typeof g.index !== 'number' || !Number.isInteger(g.index)) {
      anomalies.push(`group at position ${position} has non-integer index ${String(g.index)}`);
      return;
    }
    if (g.index < 0 || g.index >= outerCount) {
      anomalies.push(
        `group index ${g.index} is outside the outer instruction range [0, ${outerCount - 1}] — its ${g.instructions.length} CPI(s) are unattributable and are dropped from the graph`,
      );
      return;
    }
    const existing = groups.get(g.index);
    if (existing) {
      anomalies.push(`group index ${g.index} appeared twice; lists concatenated in wire order`);
      groups.set(g.index, [...existing, ...g.instructions]);
      return;
    }
    groups.set(g.index, g.instructions);
  });

  return { groups, anomalies };
}

export type LogFrame = {
  programId: string;
  depth: number;
  outcome: 'ok' | 'failed' | 'unknown';
  failure?: string;
};

const INVOKE_RE = /^Program (\S+) invoke \[(\d+)\]$/;
const SUCCESS_RE = /^Program (\S+) success$/;
const FAILED_RE = /^Program (\S+) failed: (.*)$/;

/**
 * Rebuild the call tree from `meta.logMessages`.
 *
 * The log collector emits `invoke [depth]` / `success` / `failed` in true DFS
 * order, so a stack reproduces the nesting exactly — including depth 3+, which
 * `innerInstructions` alone cannot give you. This is the fallback attribution
 * source, and the cross-check against `stackHeight`.
 */
export function treeFromLogs(logMessages: string[] | null | undefined): {
  frames: LogFrame[];
  truncated: boolean;
  unbalanced: number;
} {
  const frames: LogFrame[] = [];
  if (!logMessages || logMessages.length === 0) return { frames, truncated: false, unbalanced: 0 };

  const stack: LogFrame[] = [];
  let truncated = false;
  let unbalanced = 0;

  for (const line of logMessages) {
    if (line === 'Log truncated' || line.startsWith('Log truncated')) {
      truncated = true;
      continue;
    }
    const invoke = INVOKE_RE.exec(line);
    if (invoke) {
      const depth = Number(invoke[2]);
      const frame: LogFrame = { programId: invoke[1] as string, depth, outcome: 'unknown' };
      // A depth jump greater than one means we never saw the intermediate
      // invoke line: truncation, or a node that dropped logs.
      const top = stack[stack.length - 1];
      if (top && depth > top.depth + 1) unbalanced++;
      stack.push(frame);
      frames.push(frame);
      continue;
    }
    const success = SUCCESS_RE.exec(line);
    if (success) {
      const popped = stack.pop();
      if (!popped || popped.programId !== success[1]) {
        unbalanced++;
        if (popped) frames[frames.indexOf(popped)] = { ...popped, outcome: 'unknown' };
      } else {
        popped.outcome = 'ok';
      }
      continue;
    }
    const failed = FAILED_RE.exec(line);
    if (failed) {
      const popped = stack.pop();
      if (!popped || popped.programId !== failed[1]) {
        unbalanced++;
      } else {
        popped.outcome = 'failed';
        popped.failure = failed[2];
      }
      continue;
    }
    // `Program log:`, `Program data:`, `Program return: <pid> ...`,
    // `Instruction consumed ...`, `Execute...` — none of these open or close a call.
  }

  for (const open of stack) {
    // Never closed: the trace was cut mid-call. Leave it unknown rather than
    // guessing success, which would inflate "confirmed interactions".
    open.outcome = 'unknown';
  }

  return { frames, truncated, unbalanced };
}

export type CallFrame = {
  outerIndex: number;
  ordinal: number;
  programId: string;
  depth: number;
  parentProgramId: string | null;
  instruction: WireAnyInstruction;
  /** Which mechanism established the parent, because each has different blast-radius honesty. */
  establishedBy: 'stackHeight' | 'logs' | 'flat';
  accountSource: 'accounts' | 'parsed_info' | 'none';
  /** Resolved pubkeys regardless of which encoding the node used. */
  accountPubkeys: string[];
  /** Table positions, when the encoding supplied them or they could be recovered. */
  accountIndexes: number[];
  outcome: 'ok' | 'failed' | 'unknown';
};

export type AttributionQuality = 'stackHeight' | 'logs' | 'flat';

export type TraceAnalysis = {
  frames: CallFrame[];
  quality: AttributionQuality;
  /** CPI frames whose parent could only be guessed by flattening. */
  flattenedFrames: number;
  /** Instructions with no recoverable account set, so no lamports can be attributed to them. */
  accountlessInstructions: number;
  anomalies: string[];
  logTruncated: boolean;
  logUnbalanced: number;
  /** stackHeight and the log tree disagreed about how many nested calls happened. */
  attributionDisagreement: { stackHeightNested: number; logNested: number } | null;
};

/**
 * Some nodes omit `accounts` on parsed instructions (it is inside `parsed.info`),
 * and CPI'd program-owned accounts are what carry value. Pull any string that is
 * a known account key out of the parsed blob so a token CPI still resolves
 * accounts. Heuristic, and labelled as such via `accountSource`.
 */
function accountsFromParsedInfo(info: unknown, keys: string[]): number[] {
  if (!info || typeof info !== 'object') return [];
  const index = new Map(keys.map((k, i) => [k, i]));
  const found = new Set<number>();
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (node === null || node === undefined || seen.has(node)) return;
    if (typeof node === 'string') {
      const at = index.get(node);
      if (at !== undefined) found.add(at);
      return;
    }
    if (typeof node !== 'object') return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const v of Object.values(node as Record<string, unknown>)) walk(v);
  };
  walk(info);
  return [...found].sort((a, b) => a - b);
}

function instructionAccounts(
  ins: WireAnyInstruction,
  resolution: KeyResolution,
): { pubkeys: string[]; indexes: number[]; source: CallFrame['accountSource'] } {
  const pubkeys: string[] = [];
  const indexes: number[] = [];
  if (Array.isArray(ins.accounts) && ins.accounts.length > 0) {
    for (const entry of ins.accounts) {
      const pk = accountPubkey(entry, resolution);
      if (pk === null) continue;
      pubkeys.push(pk);
      const at = resolution.indexOf.get(pk);
      if (at !== undefined) indexes.push(at);
    }
    return { pubkeys, indexes, source: 'accounts' };
  }
  const parsed = ins.parsed;
  if (parsed && typeof parsed === 'object' && 'info' in parsed) {
    const found = accountsFromParsedInfo((parsed as { info: unknown }).info, resolution.keys);
    if (found.length > 0) return { pubkeys: found.map((i) => resolution.keys[i]).filter((k): k is string => Boolean(k)), indexes: found, source: 'parsed_info' };
  }
  return { pubkeys: [], indexes: [], source: 'none' };
}

/**
 * Produce one `CallFrame` per CPI with its caller resolved.
 *
 * Attribution is attempted in descending order of honesty:
 *   1. `stackHeight` (exact; present on current mainnet, absent on older nodes)
 *   2. the log tree (exact; but logs truncate)
 *   3. flat attribution — every CPI in a group is credited to the outer program.
 *      This is what a naive analyzer does, and at CPI depth >= 3 it *overcounts*
 *      the top-level program's direct dependencies. Dot keeps the count but
 *      reports `quality: "flat"` so a reader knows the graph is approximate.
 */
export function analyzeTrace(tx: WireGetTransactionResult, resolution: KeyResolution): TraceAnalysis {
  const anomalies: string[] = [];
  const outer = tx.transaction.message.instructions;
  const outerProgramAt = (i: number): string | null => outer[i]?.programId ?? null;
  if (resolution.offTablePubkeys.length > 0) {
    anomalies.push(
      `${resolution.offTablePubkeys.length} instruction account(s) named a pubkey outside the resolved key table (e.g. ${resolution.offTablePubkeys[0]?.pubkey}) — value attribution for those accounts is skipped, not guessed`,
    );
  }

  if (resolution.unresolvedIndexes.length > 0) {
    anomalies.push(
      `${resolution.unresolvedIndexes.length} instruction account index(es) exceeded the resolved key table (${resolution.keys.length} keys, method=${resolution.method})`,
    );
  }

  const { groups, anomalies: foldAnomalies } = foldInnerInstructions(
    tx.meta?.innerInstructions,
    outer.length,
  );
  anomalies.push(...foldAnomalies);

  const logTree = treeFromLogs(tx.meta?.logMessages);
  if (logTree.truncated) anomalies.push('meta.logMessages were truncated by the log collector');
  if (logTree.unbalanced > 0) {
    anomalies.push(`${logTree.unbalanced} log frame(s) did not balance against their invoke lines`);
  }

  const allInner: Array<{ outerIndex: number; ordinal: number; ins: WireAnyInstruction }> = [];
  for (const [outerIndex, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    list.forEach((ins, ordinal) => allInner.push({ outerIndex, ordinal, ins }));
  }

  const hasStackHeights = allInner.length > 0 && allInner.every((e) => typeof e.ins.stackHeight === 'number');
  let quality: AttributionQuality;
  if (hasStackHeights) quality = 'stackHeight';
  else if (logTree.frames.length > 0) quality = 'logs';
  else quality = allInner.length > 0 ? 'flat' : 'stackHeight';

  // Cross-check the two exact sources. Disagreement is itself a finding: it means
  // one of the two views is being filtered by the RPC provider.
  let attributionDisagreement: TraceAnalysis['attributionDisagreement'] = null;
  if (hasStackHeights && logTree.frames.length > 0) {
    const fromHeight = allInner.filter((e) => (e.ins.stackHeight ?? 1) >= 2).length;
    const fromLogs = logTree.frames.filter((f) => f.depth >= 2).length;
    if (fromHeight !== fromLogs) attributionDisagreement = { stackHeightNested: fromHeight, logNested: fromLogs };
  }

  const frames: CallFrame[] = [];
  let flattenedFrames = 0;
  let accountless = 0;

  // Parent resolution cursor: last-seen frame at each depth, reset per outer group.
  const scoped = groupLogFramesByOuter(logTree.frames, outer);
  if (scoped.unmatchedInvokes > 0 && quality === 'logs') {
    anomalies.push(`${scoped.unmatchedInvokes} depth-1 log invoke line(s) could not be matched to an outer instruction by program id and ordinal`);
  }
  for (const [outerIndex, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const lastAtDepth = new Map<number, string>();
    lastAtDepth.set(1, outerProgramAt(outerIndex) ?? '');

    // Log-based attribution walks only the nested frames belonging to *this* outer
    // instruction, so a transaction that invokes the same program twice still
    // attributes each group to its own subtree.
    const logFrames = scoped.byOuterIndex.get(outerIndex) ?? [];
    if (quality === 'logs' && logFrames.length !== list.length) {
      anomalies.push(
        `outer[${outerIndex}] has ${list.length} inner instruction(s) but ${logFrames.length} nested log frame(s); the surplus is attributed flat`,
      );
    }

    list.forEach((ins, ordinal) => {
      const programId = ins.programId;
      const depth = typeof ins.stackHeight === 'number' ? ins.stackHeight : 1;
      let parent: string | null;
      let establishedBy: CallFrame['establishedBy'];

      if (quality === 'stackHeight' && depth >= 2) {
        parent = lastAtDepth.get(depth - 1) ?? outerProgramAt(outerIndex) ?? null;
        establishedBy = 'stackHeight';
      } else if (quality === 'logs' && logFrames[ordinal] && logFrames[ordinal]?.programId === programId) {
        parent = logFrames[ordinal]?.parent ?? outerProgramAt(outerIndex);
        establishedBy = 'logs';
      } else {
        parent = outerProgramAt(outerIndex);
        establishedBy = 'flat';
        flattenedFrames++;
      }

      lastAtDepth.set(depth, programId);
      for (const d of [...lastAtDepth.keys()]) if (d > depth) lastAtDepth.delete(d);

      const { pubkeys, indexes, source } = instructionAccounts(ins, resolution);
      if (source === 'none') accountless++;

      frames.push({
        outerIndex,
        ordinal,
        programId,
        depth,
        parentProgramId: parent,
        instruction: ins,
        establishedBy,
        accountSource: source,
        accountPubkeys: pubkeys,
        accountIndexes: indexes,
        outcome: outcomeFromLogs(logTree.frames, parent, programId),
      });
    });
  }

  return {
    frames,
    quality,
    flattenedFrames,
    accountlessInstructions: accountless,
    anomalies,
    logTruncated: logTree.truncated,
    logUnbalanced: logTree.unbalanced,
    attributionDisagreement,
  };
}

function outcomeFromLogs(frames: LogFrame[], parent: string | null, programId: string): CallFrame['outcome'] {
  // A failed nested call is real evidence of attempted integration, but no value
  // moved: the runtime rolled the CPI checkpoint back.
  const matches = frames.filter((f) => f.programId === programId && f.depth >= 2);
  if (matches.length === 0) return 'unknown';
  const underParent = parent ? matches.filter((m) => m.outcome === 'failed') : [];
  if (underParent.length === matches.length && matches.every((m) => m.outcome === 'failed')) return 'failed';
  return 'ok';
}

/**
 * Scope the log tree to outer instruction indexes, so a group's k-th inner
 * instruction lines up with the k-th nested frame *of that group*.
 *
 * The join is by ordinal, not by program id: a transaction can invoke the same
 * program as two separate top-level instructions (measured in
 * `test/fixtures/tx-nested.json`, where `ATokenGP…` is outer index 2 and 3).
 * Matching on id would attribute the second call's CPIs to the first. Matching on
 * "the n-th `invoke [1]` line for program P belongs to the n-th outer instruction
 * naming P" is sound because top-level instructions execute in message order.
 */
export function groupLogFramesByOuter(
  frames: LogFrame[],
  outer: Array<{ programId: string }>,
): { byOuterIndex: Map<number, AttributedLogFrame[]>; unmatchedInvokes: number } {
  const positionsByProgram = new Map<string, number[]>();
  outer.forEach((ins, i) => {
    const list = positionsByProgram.get(ins.programId) ?? [];
    list.push(i);
    positionsByProgram.set(ins.programId, list);
  });

  const seenCount = new Map<string, number>();
  const byOuterIndex = new Map<number, AttributedLogFrame[]>();
  const stack: LogFrame[] = [];
  let currentOuter: number | null = null;
  let unmatchedInvokes = 0;

  for (const f of frames) {
    while (stack.length > 0 && (stack[stack.length - 1] as LogFrame).depth >= f.depth) stack.pop();

    if (f.depth === 1) {
      const seen = seenCount.get(f.programId) ?? 0;
      seenCount.set(f.programId, seen + 1);
      const candidates = positionsByProgram.get(f.programId);
      const idx = candidates && seen < candidates.length ? candidates[seen] : undefined;
      currentOuter = idx ?? null;
      if (idx === undefined) unmatchedInvokes++;
      else byOuterIndex.set(idx, []);
    } else if (f.depth >= 2) {
      if (currentOuter === null) continue;
      const bucket = byOuterIndex.get(currentOuter);
      if (!bucket) continue;
      bucket.push({ ...f, parent: stack[stack.length - 1]?.programId ?? null });
    }
    stack.push(f);
  }

  return { byOuterIndex, unmatchedInvokes };
}

export type AttributedLogFrame = LogFrame & { parent: string | null };

/** Edges carry supply-chain meaning only for real programs; system/token noise is kept but flagged. */
export function isSupplyChainEdge(from: string, to: string): boolean {
  if (from === to) return true; // self CPI is meaningful (re-entrancy / program-version coupling)
  return !isNoiseProgram(from) && !isNoiseProgram(to);
}
