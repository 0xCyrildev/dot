import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { PublicKey } from '@solana/web3.js';
import type { SolanaClient } from './rpc/client.js';

export type IdlResolution = {
  available: boolean;
  source?: string;
  diffText?: string;
  reason?: string;
};

export type IdlOptions = {
  /** Current interface definition, local path or URL. */
  idl?: string;
  /** The interface as it was before this upgrade, for a real diff. */
  priorIdl?: string;
  /** Attempt the legacy Anchor `anchor:idl` PDA read. Off by default; see `reason`. */
  tryOnchain?: boolean;
};

/**
 * Resolve what Dot is allowed to say about the *meaning* of a change.
 *
 * Solana has no mandatory interface. Anchor's on-chain IDL account moved between
 * versions (single account, then chunked for IDLs over the 10k-byte account cap,
 * then embedded in the executable itself in later toolchains), so an on-chain IDL
 * read that "succeeds" can hand you a truncated JSON document that parses as
 * something else entirely. Dot therefore treats the operator-supplied IDL pair as
 * the only trustworthy source, and reports the on-chain attempt as best-effort
 * with the reason it was skipped when it is not conclusive.
 */
export async function resolveIdl(program: string, opts: IdlOptions, client?: SolanaClient): Promise<IdlResolution> {
  if (opts.idl && opts.priorIdl) {
    const [now, before] = await Promise.all([loadDoc(opts.idl), loadDoc(opts.priorIdl)]);
    if (!now.ok) return { available: false, reason: `current IDL unreadable: ${now.error}` };
    if (!before.ok) return { available: false, reason: `prior IDL unreadable: ${before.error}` };
    const diff = diffIdl(before.doc, now.doc);
    if (diff.trim() === '') {
      return { available: true, source: 'operator-supplied pair', diffText: 'No interface-level difference: the change is inside instruction handlers, which an IDL cannot show. Semantics are undetermined from this evidence.' };
    }
    return { available: true, source: 'operator-supplied pair', diffText: diff };
  }

  if (opts.tryOnchain && client) {
    const found = await tryAnchorIdlPda(program, client);
    if (found) {
      return {
        available: true,
        source: 'anchor:idl PDA (best-effort, no prior version available)',
        diffText: `On-chain IDL recovered for ${program}. There is no prior version to diff against, so this describes the interface as it stands after the upgrade and says nothing about what changed.`,
      };
    }
    return {
      available: false,
      reason:
        'no IDL account at the legacy anchor:idl PDA. Either the program is not Anchor, the toolchain embeds the IDL in the executable, or the IDL is chunked. Pass --idl and --prior-idl for a real diff.',
    };
  }

  return {
    available: false,
    reason: 'no --idl supplied. Dot has no on-chain interface contract to read; see the NO_IDL_CONTRACT limit note.',
  };
}

async function loadDoc(ref: string): Promise<{ ok: true; doc: unknown } | { ok: false; error: string }> {
  try {
    const text = ref.startsWith('http')
      ? await (await fetch(ref, { signal: AbortSignal.timeout(15_000) })).text()
      : await readFile(ref, 'utf8');
    return { ok: true, doc: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Anchor's legacy IDL account: PDA seeded with "anchor:idl" under the program itself. */
export function anchorIdlPda(program: string): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('anchor:idl'), new PublicKey(program).toBuffer()],
    new PublicKey(program),
  );
  return pda.toBase58();
}

async function tryAnchorIdlPda(program: string, client: SolanaClient): Promise<string | null> {
  const pda = anchorIdlPda(program);
  const acct = await client.getAccountInfo(pda).catch(() => null);
  if (!acct || acct.data.length < 8) return null;
  // Anchor prefixes the account with an 8-byte discriminator, then a bool flag for
  // base/flush, then a 4-byte length, then partial IDL bytes. Parsing that
  // reliably across toolchain versions is out of scope here; require that the tail
  // looks like a JSON object before claiming it is an IDL.
  const text = acct.data.subarray(13).toString('utf8');
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    JSON.parse(text.slice(start));
    return text.slice(start);
  } catch {
    return null;
  }
}

type IdlShape = { instructions?: Array<Record<string, unknown>>; accounts?: unknown[]; types?: unknown[]; errors?: unknown[] };

/**
 * Structural IDL diff, deliberately not a text diff: an added field in the 40th
 * account of an unrelated instruction should not read as a breaking change, and a
 * removed instruction should.
 */
export function diffIdl(before: unknown, after: unknown): string {
  const b = (before ?? {}) as IdlShape;
  const a = (after ?? {}) as IdlShape;
  const lines: string[] = [];
  const byName = (arr?: Array<Record<string, unknown>>) => new Map((arr ?? []).map((x) => [String(x.name ?? x.type ?? '?'), x]));

  const bi = byName(b.instructions);
  const ai = byName(a.instructions);
  for (const [name] of ai) if (!bi.has(name)) lines.push(`+ instruction ${name} (new entrypoint: callers written against the old interface cannot reach it)`);
  for (const [name] of bi) if (!ai.has(name)) lines.push(`- instruction ${name} (REMOVED: any integrator still encoding this selector now fails)`);
  for (const [name, ins] of ai) {
    const prev = bi.get(name);
    if (!prev) continue;
    const pd = describeAccounts(prev);
    const nd = describeAccounts(ins);
    if (pd !== nd) lines.push(`~ instruction ${name} accounts: [${pd}] -> [${nd}]${isSignerOrWritableShift(prev, ins) ? ' (SIGNER/WRITABLE semantics moved)' : ''}`);
    const pa = describeArgs(prev);
    const na = describeArgs(ins);
    if (pa !== na) lines.push(`~ instruction ${name} args: [${pa}] -> [${na}]`);
  }

  const bt = new Map(((b.types ?? []) as Array<Record<string, unknown>>).map((t) => [String(t.name ?? '?'), JSON.stringify(t)]));
  const at = new Map(((a.types ?? []) as Array<Record<string, unknown>>).map((t) => [String(t.name ?? '?'), JSON.stringify(t)]));
  for (const [name, j] of at) {
    if (!bt.has(name)) lines.push(`+ type ${name}`);
    else if (bt.get(name) !== j) lines.push(`~ type ${name} (layout change: any account or event encoded with the old layout mis-parses)`);
  }
  for (const [name] of bt) if (!at.has(name)) lines.push(`- type ${name}`);

  const ba = new Set(((b.accounts ?? []) as Array<Record<string, unknown>>).map((x) => String(x.name ?? '?')));
  const aa = new Set(((a.accounts ?? []) as Array<Record<string, unknown>>).map((x) => String(x.name ?? '?')));
  for (const name of aa) if (!ba.has(name)) lines.push(`+ account struct ${name}`);
  for (const name of ba) if (!aa.has(name)) lines.push(`- account struct ${name}`);

  const be = new Set(((b.errors ?? []) as Array<Record<string, unknown>>).map((x) => String(x.name ?? '?')));
  const ae = new Set(((a.errors ?? []) as Array<Record<string, unknown>>).map((x) => String(x.name ?? '?')));
  for (const name of ae) if (!be.has(name)) lines.push(`+ error ${name}`);

  return lines.join('\n');
}

function describeAccounts(ins: Record<string, unknown>): string {
  const arr = (ins.accounts ?? []) as Array<unknown>;
  return arr
    .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? `${String((x as Record<string, unknown>).name ?? '?')}${(x as Record<string, unknown>).isMut || (x as Record<string, unknown>).writable ? '(w)' : ''}${(x as Record<string, unknown>).isSigner || (x as Record<string, unknown>).signer ? '(s)' : ''}` : String(x)))
    .join(', ');
}

function describeArgs(ins: Record<string, unknown>): string {
  const arr = (ins.args ?? []) as Array<Record<string, unknown>>;
  return arr.map((x) => `${String(x.name ?? '?')}:${String(x.type ?? '?')}`).join(', ');
}

function isSignerOrWritableShift(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const norm = (ins: Record<string, unknown>) =>
    ((ins.accounts ?? []) as Array<Record<string, unknown>>)
      .map((x) => `${String(x.name ?? '?')}=${String(x.isMut ?? x.writable ?? '?')}/${String(x.isSigner ?? x.signer ?? '?')}`)
      .join('|');
  return norm(before) !== norm(after);
}
