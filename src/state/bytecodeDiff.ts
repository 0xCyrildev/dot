import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { findText, recoverSelectors } from './sbfSelectors.js';

/**
 * Structural bytecode diff for Anchor programs, and an honest fallback for the
 * rest.
 *
 * The value of this file is one sentence: an upgrade that adds an instruction is a
 * different event from an upgrade that changes one. A graph says who is exposed; only
 * the bytecode says what they are exposed *to*.
 *
 * The mechanism is that an Anchor instruction selector is `sha256("global:<name>")[0..8]`,
 * embedded as a constant in the compiled program. Given the *names* from an IDL, the
 * presence or absence of each corresponding 8-byte constant in the old and new
 * bytecode is a structural fact about the program's entrypoint set — no decompiler, no
 * BPF analysis, and nothing invented.
 *
 * Two design decisions that differ from the naive reading of the task, both because the
 * naive version hides the interesting case:
 *
 *  1. **A discriminator found in the bytecode that is NOT in the IDL is reported, not
 *     discarded.** "Reject anything not in the IDL" would delete exactly the signal an
 *     auditor most wants: an entrypoint that is reachable on-chain but absent from the
 *     published interface. `undeclaredEntrypoints` is a first-class output.
 *  2. **An instruction named in the new IDL but not found in the new bytecode is also
 *     reported.** That is either a dead entrypoint or a hole in this scan, and the two
 *     have opposite meanings. Silently dropping it would make the diff look more
 *     trustworthy than it is.
 *
 * And one limit that cannot be coded around: **the previous bytecode is gone.** RPC has
 * no historical account state — `getAccountInfo` takes `minContextSlot` as a floor, not
 * a time machine — so the "old" side of this diff comes from a `BytecodeVault` Dot
 * filled while watching, or from an operator who supplied a file. A first-ever look at a
 * program can report the new entrypoint set but not what it replaced, and says so.
 */

export const ANCHOR_DISCRIMINATOR_LEN = 8;
export type DiffConfidence = 'structural' | 'partial' | 'bytecode_only' | 'unscannable';

export type DiscriminatorNames = {
  /** instruction name → 8-byte hex */
  byName: Map<string, string>;
  /** 8-byte hex → names that hash to it (collision guard) */
  byHex: Map<string, string[]>;
};

export function anchorDiscriminator(name: string, programScope = 'global'): Buffer {
  return createHash('sha256').update(`${programScope}:${name}`).digest().subarray(0, ANCHOR_DISCRIMINATOR_LEN);
}

/** Instruction names come from IDL `instructions[].name`, camel or snake, unchanged. */
export function discriminatorsFromIdl(idl: unknown): DiscriminatorNames {
  const byName = new Map<string, string>();
  const byHex = new Map<string, string[]>();
  const instructions = (idl as { instructions?: Array<{ name?: string; discriminator?: unknown }> } | null)?.instructions;
  if (!Array.isArray(instructions)) return { byName, byHex };
  for (const ins of instructions) {
    const name = typeof ins?.name === 'string' ? ins.name : null;
    if (!name) continue;
    const hex = selectorFor(name, ins.discriminator);
    if (!hex) continue;
    byName.set(name, hex);
    byHex.set(hex, [...(byHex.get(hex) ?? []), name]);
  }
  return { byName, byHex };
}

/**
 * The 8 bytes a handler is dispatched on, named by an IDL instruction.
 *
 * Priority, and why each step is evidence rather than a guess:
 * 1. the IDL's own `discriminator` array, when present — the framework emitted these bytes and
 *    Dot does not need to reproduce them;
 * 2. `sha256("global:" + snake_case(name))[0..8]` when the name is camelCase, because
 *    anchor-lang-idl 0.1.4 `convert.rs` builds the IDL discriminator exactly that way
 *    (`let name = value.name.to_snake_case(); discriminator: get_disc("global", &name)`);
 * 3. `sha256("global:" + name)[0..8]` when the name is already snake_case — steps 2 and 3 are the
 *    same string then, so nothing is re-cased that does not need it.
 *
 * A name whose camelCase form came from an acronym run Rust would not have produced (`HTTPServer`)
 * hashes to bytes that are not in any image. Step 2 is a *candidate*: if it is wrong the selector
 * is simply not located, which the scan reports as a blind spot, never as a different instruction.
 */
function selectorFor(name: string, declared: unknown): string | null {
  if (Array.isArray(declared) && declared.length === ANCHOR_DISCRIMINATOR_LEN && declared.every((b) => Number.isInteger(b) && (b as number) >= 0 && (b as number) <= 255)) {
    return Buffer.from(declared as number[]).toString('hex');
  }
  const snake = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return anchorDiscriminator(snake).toString('hex');
}

export type SelectorLocation = 'contiguous' | 'immediate-pair' | 'compare-chain';

export type Scan = {
  searched: number;
  found: Array<{ hex: string; names: string[]; offsets: number[]; via: SelectorLocation[] }>;
  absent: string[];
  /** True when the image parsed as an ELF64 with a `.text` Dot could walk. False means the
   *  recovered half of the scan never ran, which is a different nothing from "no selector found". */
  decoded: boolean;
  /** Names located only after decoding the instruction stream — i.e. ones the old byte sweep
   *  would have reported as absent. Reported separately because it is the number the retired
   *  assumption was wrong about. */
  recoveredOnly: string[];
};

/**
 * Locate named discriminators in a bytecode image.
 *
 * Scanning is driven by a supplied name set precisely because a *blind* 8-byte sweep is
 * worthless: a hit with no name is not an instruction, it is eight bytes. Random
 * collision over a ~2 MB image against a 64-bit space is ~2^-41, so a named hit is
 * effectively certain to be the constant; an unnamed one is uninterpretable either way.
 *
 * Two passes, in this order: the contiguous sweep (which is where a selector lives when the
 * compiler kept the array together, and what Dot did before 2026-10-22), then SBF recovery
 * (`sbfSelectors.ts`) for the shapes that sweep cannot see — the `mov32`/`hor64` immediate pair
 * and the byte-wise compare chain anchor-lang emits. A name found by both is reported once, with
 * both locations, and its contiguous offsets.
 */
export function scanDiscriminators(bytecode: Buffer, candidates: Map<string, string>): Scan {
  const found: Scan['found'] = [];
  const byHex = new Map<string, Scan['found'][number]>();
  const contiguous = new Set<string>();
  for (const [name, hex] of candidates) {
    const needle = Buffer.from(hex, 'hex');
    const offsets: number[] = [];
    let at = bytecode.indexOf(needle);
    while (at !== -1 && offsets.length < 16) {
      offsets.push(at);
      at = bytecode.indexOf(needle, at + 1);
    }
    if (offsets.length === 0) continue;
    contiguous.add(name);
    const existing = byHex.get(hex);
    if (existing) {
      existing.names = [...new Set([...existing.names, name])];
      existing.offsets = [...new Set([...existing.offsets, ...offsets])].slice(0, 16);
    } else {
      const entry = { hex, names: [name], offsets, via: ['contiguous' as const] };
      byHex.set(hex, entry);
      found.push(entry);
    }
  }

  const recovered = recoverSelectors(bytecode, candidates);
  const decoded = findText(bytecode) !== null;
  const recoveredOnly: string[] = [];
  for (const r of recovered) {
    const entry = byHex.get(r.hex);
    if (entry) {
      if (!entry.via.includes(r.via)) entry.via = [...entry.via, r.via];
      if (!entry.names.includes(r.name)) entry.names = [...entry.names, r.name];
    } else {
      const created = { hex: r.hex, names: [r.name], offsets: [r.offset], via: [r.via] };
      byHex.set(r.hex, created);
      found.push(created);
    }
    if (!contiguous.has(r.name)) recoveredOnly.push(r.name);
  }

  const located = new Set(found.flatMap((f) => f.names));
  return {
    searched: candidates.size,
    found,
    absent: [...candidates.keys()].filter((n) => !located.has(n)),
    decoded,
    recoveredOnly,
  };
}

export type InstructionDiff = {
  /** Named, in new bytecode, absent from old: a new reachable entrypoint. */
  added: Array<{ name: string; hex: string; offsetsInNew: number[] }>;
  /** Named, in old bytecode, absent from new: callers still encoding this selector now fail. */
  removed: Array<{ name: string; hex: string }>;
  /** Named, present in both: entrypoint survives, body may or may not have changed. */
  persisting: string[];
  /**
   * `persisting` is deliberately NOT called "unchanged". Proving the handler body did
   * not move needs a real disassembly diff, which Dot does not do.
   */
  persistingNote: string;
  /** Present in new bytecode, named only by the OLD IDL: reachable, but dropped from the published interface. */
  undeclaredEntrypoints: Array<{ name: string; hex: string; why: string }>;
  /** Named by the NEW IDL but not found in the new bytecode: dead entrypoint, or a hole in this scan. */
  idlClaimedNotFound: Array<{ name: string; hex: string; why: string }>;
};

export type BytecodeMetric = {
  bytes: number;
  /** First 16 hex of sha256 over the image. */
  digest: string;
  shannonEntropy: number;
  /** 64 histograms used for the crude overlap score below. */
  histogram: number[];
};

export type BytecodeDiff = {
  /**
   * `structural`   — names available for both sides; added/removed are real.
   * `partial`      — names available for one side only, or one side's bytes missing.
   * `bytecode_only`— no names at all; only size/entropy/histogram movement, and no
   *                  instruction-level claim of any kind.
   */
  confidence: DiffConfidence;
  anchor: {
    /** Whether an IDL supplied instruction names at all. Not a guess about the program. */
    idlAvailable: boolean;
    reason: string;
  };
  old?: BytecodeMetric;
  new?: BytecodeMetric;
  instructions?: InstructionDiff;
  /**
   * Per-instruction account-requirement changes, from the IDL pair. This is the half of
   * "what does the new entrypoint accept" that bytecode alone cannot answer, and it is
   * only as good as the published interfaces — a program with no IDL gets nothing here,
   * and says so.
   */
  accounts?: AccountRequirementChange[];
  accountsNote?: string;
  /** Crude byte-overlap measure between two images. Ordering-sensitive; never a finding. */
  similarity?: { changedBuckets: number; totalBuckets: number; overlapPct: number; caveat: string };
  limits: string[];
};

function metric(bytes: Buffer): BytecodeMetric {
  const histogram = new Array(64).fill(0);
  const bucket = Math.max(1, Math.floor(bytes.length / 64));
  for (let i = 0; i < bytes.length; i++) histogram[Math.min(63, Math.floor(i / bucket))] += bytes[i];
  const freq = new Map<number, number>();
  for (const b of bytes) freq.set(b, (freq.get(b) ?? 0) + 1);
  let entropy = 0;
  for (const c of freq.values()) {
    const p = c / bytes.length;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return {
    bytes: bytes.length,
    digest: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
    shannonEntropy: Math.round(entropy * 1000) / 1000,
    histogram,
  };
}

function similarity(a: BytecodeMetric, b: BytecodeMetric) {
  let changed = 0;
  let totalAbs = 0;
  for (let i = 0; i < 64; i++) {
    const delta = Math.abs((a.histogram[i] ?? 0) - (b.histogram[i] ?? 0));
    if (delta > 0) changed++;
    totalAbs += delta;
  }
  const mass = a.histogram.reduce((s, v) => s + v, 0) + b.histogram.reduce((s, v) => s + v, 0);
  return {
    changedBuckets: changed,
    totalBuckets: 64,
    overlapPct: Math.round((1 - totalAbs / Math.max(1, mass)) * 1000) / 10,
    caveat:
      'a 64-bucket byte-sum comparison over the whole image: ordering-sensitive, easily fooled by a shifted section, and reported only so that "0% changed" is never claimed by accident',
  };
}

export function diffBytecode(input: {
  oldBytes: Buffer | null;
  newBytes: Buffer | null;
  oldIdl?: unknown | null;
  newIdl?: unknown | null;
}): BytecodeDiff {
  const limits: string[] = [];
  const oldNames = input.oldIdl ? discriminatorsFromIdl(input.oldIdl) : null;
  const newNames = input.newIdl ? discriminatorsFromIdl(input.newIdl) : null;
  const idlAvailable = Boolean(oldNames?.byName.size || newNames?.byName.size);

  const base: BytecodeDiff = {
    confidence: 'bytecode_only',
    anchor: {
      idlAvailable,
      reason: idlAvailable
        ? 'instruction names supplied; selectors derived as sha256("global:<name>")[0..8]'
        : 'no IDL supplied, so no name can be attached to any byte pattern; instruction-level diff not performed',
    },
    limits,
  };

  if (!input.newBytes) {
    limits.push('new bytecode unavailable: nothing to compare');
    return { ...base, confidence: 'partial', limits };
  }
  const newMetric = metric(input.newBytes);
  base.new = newMetric;

  if (!input.oldBytes) {
    limits.push(
      'previous bytecode unavailable. RPC has no historical account state (getAccountInfo has minContextSlot, which is a floor, not a time machine), so the old side exists only in a BytecodeVault Dot filled while watching, or in a file an operator supplied.',
    );
    if (idlAvailable && newNames) {
      const s = scanDiscriminators(input.newBytes, newNames.byName);
      base.instructions = {
        added: s.found.flatMap((f) => f.names.map((n) => ({ name: n, hex: f.hex, offsetsInNew: f.offsets }))),
        removed: [],
        persisting: [],
        persistingNote: 'no prior image: every entrypoint found is reported as "present", not as "added"',
        undeclaredEntrypoints: [],
        idlClaimedNotFound: s.absent.map((name) => ({
          name,
          hex: newNames.byName.get(name) ?? '',
          why: 'named in the IDL but not located in the image; cannot be called removed without a prior image',
        })),
      };
      base.confidence = 'partial';
      base.accountsNote = 'no prior image: the new interface can be listed, but nothing can be called changed';
      base.accounts = diffAccountRequirements(null, input.newIdl ?? null, new Set(s.found.flatMap((f) => f.names)));
      limits.push('without a prior image, "added" and "present" are indistinguishable and neither word is used loosely here');
    }
    return base;
  }

  const oldMetric = metric(input.oldBytes);
  base.old = oldMetric;
  base.similarity = similarity(oldMetric, newMetric);
  if (oldMetric.digest === newMetric.digest) {
    limits.push('bytecode identical between the two observations: this is not an upgrade, and the diff says so instead of reporting an empty one');
    base.confidence = idlAvailable ? 'structural' : 'bytecode_only';
    return base;
  }

  if (!idlAvailable) {
    base.accountsNote = 'no IDL pair supplied: account requirements not compared, so a new entrypoint can be named but not its accounts';
    limits.push(
      'non-Anchor or IDL-less program: only size, entropy and byte-overlap movement is reported. No entrypoint set, no added/removed claim, and nothing downstream should treat the numbers above as a security finding.',
    );
    return base;
  }

  // Names searched are the union of both interfaces: a name that only the old IDL knows
  // is precisely how a removed instruction is detected, and a name only the new IDL
  // knows is how an added one is.
  const unionNames = new Map<string, string>();
  for (const [n, h] of oldNames?.byName ?? []) unionNames.set(n, h);
  for (const [n, h] of newNames?.byName ?? []) unionNames.set(n, h);

  const inOld = scanDiscriminators(input.oldBytes, unionNames);
  const inNew = scanDiscriminators(input.newBytes, unionNames);
  const oldFound = new Set(inOld.found.flatMap((f) => f.names));
  const newFound = new Set(inNew.found.flatMap((f) => f.names));
  const added = inNew.found
    .flatMap((f) => f.names.map((n) => ({ name: n, hex: f.hex, offsetsInNew: f.offsets })))
    .filter((x) => !oldFound.has(x.name));
  const removed = [...oldFound].filter((n) => !newFound.has(n)).map((n) => ({ name: n, hex: oldNames?.byName.get(n) ?? inOld.found.find((f) => f.names.includes(n))?.hex ?? '' }));
  const persisting = [...oldFound].filter((n) => newFound.has(n)).sort();

  const undeclaredEntrypoints = [...new Set(inNew.found.flatMap((f) => f.names))]
    .filter((n) => !(newNames?.byName.has(n)))
    .map((n) => ({
      name: n,
      hex: oldNames?.byName.get(n) ?? '',
      why: 'reachable selector present in the new image but absent from the new IDL — an entrypoint the published interface does not declare',
    }));

  // Measured on 2026-10-22 against a real compiler-emitted SBF image (rustc 1.89.0-sbpf,
  // platform-tools v1.54, dispatch shaped the way anchor-lang's `#[program]` macro shapes
  // it): zero of ten `sha256("global:<name>")[0..8]` selectors appear contiguously, because
  // LLVM materializes each 8-byte constant as a `mov32 imm32` + `hor64 imm32` pair with the
  // instruction encoding between them. The bytes are in there — split across two immediates
  // eight bytes apart — but a contiguous scan cannot see them.
  //
  // So "located none of the declared selectors" has two very different meanings, and the
  // report must not present the second as the first: either the IDL describes instructions
  // this image does not contain, or Dot's scanner is blind to this image's emission format.
  // A program with three or more declared instructions that yields *nothing* is the second
  // case far more often than the first, and the cost of guessing wrong is a reader who takes
  // "no entrypoints added or removed" as "the interface is unchanged".
  const declaredNames = [...(newNames?.byName.keys() ?? [])];
  const locatedDeclared = declaredNames.filter((n) => newFound.has(n)).length;
  const scanBlind = declaredNames.length >= 3 && locatedDeclared === 0;

  const idlClaimedNotFound = inNew.absent
    .filter((n) => newNames?.byName.has(n))
    .map((n) => ({
      name: n,
      hex: newNames?.byName.get(n) ?? '',
      why: scanBlind
        ? `declared in the new IDL and not located — but the scan located 0 of ${declaredNames.length} declared selectors, which is the signature of a blind scan rather than an absent handler (see BYTECODE_SCAN_MISSES_SPLIT_IMMEDIATES). Treat as "not seen", not "not there"`
        : 'declared in the new IDL, no matching selector located in the new image',
    }));

  base.instructions = {
    added,
    removed,
    persisting,
    persistingNote:
      'present in both images. The selector surviving says nothing about the handler body: confirming "unchanged" needs a disassembly diff, which Dot does not perform.',
    undeclaredEntrypoints,
    idlClaimedNotFound,
  };
  const located = new Set(inNew.found.flatMap((f) => f.names));
  base.accounts = diffAccountRequirements(input.oldIdl ?? null, input.newIdl ?? null, located);
  const sharp = base.accounts.filter((a) => a.status === 'added' || a.status === 'accounts_changed');
  if (sharp.length > 0) {
    limits.push(
      'account requirements come from the published IDL pair, not from the handler: an added writable non-signer account is a question to ask the author, not a vulnerability finding',
    );
  }
  if (scanBlind) {
    // The honest label for "the scan saw nothing". Without this branch a blind scan and an
    // unchanged interface print the same line, and the reader concludes the attack surface
    // did not move.
    base.confidence = 'unscannable';
    limits.push(
      `scan located 0 of ${declaredNames.length} selectors the new IDL declares: measured against compiler-emitted SBF, discriminators are split across immediate pairs or dissolved into a byte-wise compare tree, so nothing here is located because nothing here can be — not because the entrypoints are absent`,
    );
  } else {
    base.confidence = 'structural';
    if (added.length === 0 && removed.length === 0) {
      limits.push('no entrypoint added or removed: any risk in this upgrade lives inside handlers, which this diff cannot see');
    }
  }
  return base;
}

type IdlAccount = { name?: string; isMut?: boolean; isSigner?: boolean; writable?: boolean; signer?: boolean; optional?: boolean; address?: string; pda?: unknown };

type NormalizedAccount = {
  name: string;
  writable: boolean;
  signer: boolean;
  optional: boolean;
  /** A hardcoded program address the account must equal, when the IDL declares one. */
  constrained: boolean;
};

/**
 * Anchor's two account encodings, unified: a bare string name (no permissions at all)
 * or an object using `isMut`/`isSigner` in older IDLs and `writable`/`signer` in newer
 * ones. Reading only the new keys silently reports every legacy account as immutable,
 * which is the exact false negative to avoid here.
 */
function normalizeAccounts(ins: { accounts?: unknown } | undefined): NormalizedAccount[] {
  const list = Array.isArray(ins?.accounts) ? (ins!.accounts as unknown[]) : [];
  return list.map((raw, i) => {
    if (typeof raw === 'string') {
      return { name: raw, writable: false, signer: false, optional: false, constrained: false };
    }
    const a = (raw ?? {}) as IdlAccount;
    return {
      name: String(a.name ?? `#account_${i}`),
      writable: Boolean(a.isMut ?? a.writable ?? false),
      signer: Boolean(a.isSigner ?? a.signer ?? false),
      optional: Boolean(a.optional ?? false),
      constrained: Boolean(a.address || a.pda),
    };
  });
}

export type AccountRequirementChange = {
  instruction: string;
  status: 'added' | 'removed' | 'accounts_changed' | 'unchanged_accounts';
  added: NormalizedAccount[];
  removed: NormalizedAccount[];
  /** Accounts whose mutability or signer-ness moved between the two interfaces. */
  shifts: Array<{ account: string; from: string; to: string }>;
  /**
   * The security-relevant shape, stated as a question and not a verdict: a writable
   * account that is not constrained to a signer and is new to this entrypoint is the
   * pattern behind a class of Solana foundry. Dot has not seen the handler.
   */
  writableNonSigner: string[];
  /** Whether this instruction's selector was actually located in the new image. */
  selectorLocated: boolean | null;
  note: string;
};

export function diffAccountRequirements(
  oldIdl: unknown | null,
  newIdl: unknown | null,
  locatedSelectors: Set<string> | null,
): AccountRequirementChange[] {
  const byName = (idl: unknown | null) => {
    const out = new Map<string, { accounts: NormalizedAccount[] }>();
    void idl;
    const list = (idl as { instructions?: Array<Record<string, unknown>> } | null)?.instructions;
    if (Array.isArray(list)) {
      for (const ins of list) {
        if (typeof ins.name === 'string') out.set(ins.name, { accounts: normalizeAccounts(ins) });
      }
    }
    return out;
  };
  const before = byName(oldIdl);
  const after = byName(newIdl);
  const out: AccountRequirementChange[] = [];
  const fmt = (a: NormalizedAccount) => `${a.name}${a.writable ? '(w)' : ''}${a.signer ? '(s)' : ''}${a.optional ? '?' : ''}`;
  // A bare-string account entry carries no permission flags at all. Calling that
  // "immutable" would be a false negative of exactly the kind this file exists to
  // catch, so unpermissioned accounts are named in the note instead.
  const unpermissioned = (idl: unknown | null) => {
    const list = (idl as { instructions?: Array<Record<string, unknown>> } | null)?.instructions;
    if (!Array.isArray(list)) return false;
    return list.some((i) => Array.isArray(i.accounts) && (i.accounts as unknown[]).some((a2) => typeof a2 === 'string'));
  };
  const flagsUnavailable = unpermissioned(oldIdl) || unpermissioned(newIdl);

  for (const [name, now] of after) {
    const was = before.get(name);
    const selectorLocated = locatedSelectors === null ? null : locatedSelectors.has(name);
    const permNote = flagsUnavailable ? ' Note: one interface lists accounts without permission flags, so mutability of those entries is unknown, not absent.' : '';
    if (!was) {
      const writableNonSigner = now.accounts.filter((a) => a.writable && !a.signer && !a.constrained).map((a) => a.name);
      out.push({
        instruction: name,
        status: 'added',
        added: now.accounts,
        removed: [],
        shifts: [],
        writableNonSigner,
        selectorLocated,
        note:
          writableNonSigner.length > 0
            ? `new entrypoint accepts ${writableNonSigner.length} writable account(s) not declared as signers or address-constrained (${writableNonSigner.join(', ')}). Whether the handler verifies ownership is not determinable from an IDL — this is the question to ask, not an answer.`
            : 'new entrypoint declares no writable non-signer accounts',
      });
      continue;
    }
    const beforeNames = new Map(was.accounts.map((a) => [a.name, a]));
    const afterNames = new Map(now.accounts.map((a) => [a.name, a]));
    const added = now.accounts.filter((a) => !beforeNames.has(a.name));
    const removed = was.accounts.filter((a) => !afterNames.has(a.name));
    const shifts: AccountRequirementChange['shifts'] = [];
    for (const a of now.accounts) {
      const p = beforeNames.get(a.name);
      if (!p) continue;
      if (p.writable !== a.writable || p.signer !== a.signer) {
        shifts.push({ account: a.name, from: fmt(p), to: fmt(a) });
      }
    }
    const writableNonSigner = [
      ...added.filter((a) => a.writable && !a.signer && !a.constrained).map((a) => a.name),
      ...shifts.filter((x) => x.to.includes('(w)') && !x.to.includes('(s)')).map((x) => x.account),
    ];
    if (added.length || removed.length || shifts.length) {
      out.push({
        instruction: name,
        status: 'accounts_changed',
        added,
        removed,
        shifts,
        writableNonSigner,
        selectorLocated,
        note:
          shifts.length > 0
            ? `permission changed on an existing account (${shifts.map((x) => `${x.account} ${x.from}->${x.to}`).join(', ')}) — every caller's account list is now wrong in a different way`
            : `account list grew or shrank${permNote}`,
      });
    } else {
      out.push({
        instruction: name,
        status: 'unchanged_accounts',
        added: [],
        removed: [],
        shifts: [],
        writableNonSigner: [],
        selectorLocated,
        note: `interface identical; the handler body may still have changed and this method cannot see it${permNote}`,
      });
    }
  }
  for (const [name] of before) {
    if (!after.get(name)) {
      out.push({
        instruction: name,
        status: 'removed',
        added: [],
        removed: before.get(name)!.accounts,
        shifts: [],
        writableNonSigner: [],
        selectorLocated: locatedSelectors === null ? null : locatedSelectors.has(name),
        note: 'declared only in the prior interface: callers encoding this selector now fail',
      });
    }
  }
  return out;
}

export function renderBytecodeDiff(d: BytecodeDiff, program: string): string {
  const L: string[] = [];
  L.push(`## Bytecode diff — ${program}`);
  L.push(`confidence: \`${d.confidence}\` · ${d.anchor.reason}`);
  if (d.old && d.new) {
    L.push(`old: ${d.old.bytes} bytes sha256=${d.old.digest}… entropy ${d.old.shannonEntropy}`);
    L.push(`new: ${d.new.bytes} bytes sha256=${d.new.digest}… entropy ${d.new.shannonEntropy} (Δ ${d.new.bytes - d.old.bytes >= 0 ? '+' : ''}${d.new.bytes - d.old.bytes} bytes)`);
  } else if (d.new) {
    L.push(`new: ${d.new.bytes} bytes sha256=${d.new.digest}… entropy ${d.new.shannonEntropy} — no prior image`);
  }
  if (d.similarity) L.push(`byte-overlap ${d.similarity.overlapPct}% across ${d.similarity.changedBuckets}/64 buckets — ${d.similarity.caveat}`);
  if (d.instructions) {
    const i = d.instructions;
    L.push('');
    L.push(`entrypoints added (${i.added.length}): ${i.added.map((a) => '`' + a.name + '`').join(', ') || 'none'}`);
    L.push(`entrypoints removed (${i.removed.length}): ${i.removed.map((r) => '`' + r.name + '`').join(', ') || 'none'}`);
    L.push(`persisting (${i.persisting.length}) — ${i.persistingNote}`);
    if (i.undeclaredEntrypoints.length > 0) {
      L.push('');
      L.push(`**undeclared entrypoints (${i.undeclaredEntrypoints.length})**`);
      for (const u of i.undeclaredEntrypoints) L.push(`- \`${u.name}\` ${u.hex} — ${u.why}`);
    }
    if (i.idlClaimedNotFound.length > 0) {
      L.push(`declared-but-not-located (${i.idlClaimedNotFound.length}): ${i.idlClaimedNotFound.map((x) => '`' + x.name + '`').join(', ')}`);
      for (const x of i.idlClaimedNotFound) L.push(`  - ${x.why}`);
    }
  }
  if (d.accounts) {
    const notable = d.accounts.filter((a) => a.status !== 'unchanged_accounts');
    L.push('');
    L.push(`Account requirements (from the IDL pair): ${d.accounts.length} instruction(s) compared, ${notable.length} with a changed interface`);
    for (const a of notable) {
      const tag = a.status === 'added' ? 'ADDED' : a.status === 'removed' ? 'REMOVED' : 'ACCOUNTS_CHANGED';
      L.push(`- \`${a.instruction}\` [${tag}]`);
      if (a.added.length > 0) L.push(`    + accounts: ${a.added.map((x) => `${x.name}${x.writable ? ' (writable)' : ''}${x.signer ? ' (signer)' : ''}`).join(', ')}`);
      if (a.removed.length > 0) L.push(`    - accounts: ${a.removed.map((x) => x.name).join(', ')}`);
      for (const sh of a.shifts) L.push(`    ~ ${sh.account}: ${sh.from} -> ${sh.to}`);
      if (a.writableNonSigner.length > 0) L.push(`    **writable, not a signer, not address-constrained: ${a.writableNonSigner.join(', ')}**`);
      if (a.selectorLocated === false) L.push('    (selector not located in the new image — the IDL declares it, the binary does not appear to implement it)');
      L.push(`    ${a.note}`);
    }
  } else if (d.accountsNote) {
    L.push('');
    L.push(`Account requirements: ${d.accountsNote}`);
  }
  for (const lim of d.limits) L.push(`- limit: ${lim}`);
  return L.join('\n');
}
