import { Buffer } from 'node:buffer';

/**
 * Recovering Anchor instruction discriminators from compiled SBF.
 *
 * The assumption this replaces was that `sha256("global:<name>")[0..8]` sits in the image as
 * eight contiguous bytes. Measured on 2026-10-22 with the Solana toolchain, it does not:
 *
 * - a hand-built dispatch over `const DISCRIMINATOR: [u8; 8]` compiles the constant into
 *   `mov32 wN, imm32` + `hor64 rN, imm32` pairs, so the eight bytes never appear together;
 * - a real anchor-lang 0.30.1 program compiles `match data[..8] { DISCRIMINATOR => … }` into a
 *   *byte-wise compare chain*: `jne r1, 0xb7` … `jne r1, 0x22`, with `data[0]` consumed first by
 *   an outer `jsgt`/`jeq` dispatch tree over the byte's value.
 *
 * Both shapes are recoverable deterministically, and the recovery is self-checking: a candidate is
 * only ever reported when it equals the hash of a name the IDL supplied, so a misaligned decode or
 * a wrong guess produces *no finding*, never a wrong one. That asymmetry is the whole design — a
 * located selector is a proof, an unlocated one is still only Dot not seeing.
 *
 * `objdump` is not required: the ELF section table and the eBPF instruction encoding are read
 * directly, so this works inside the package with no toolchain present.
 */

export type SbfCode = {
  /** File offset where the decoded instruction stream starts. */
  fileOffset: number;
  /** Virtual address of that first instruction, for reporting where a match was found. */
  vma: number;
  length: number;
};

export type DecodedInsn = {
  opcode: number;
  dst: number;
  src: number;
  offset: number;
  imm: number;
  /** Byte offset from the start of the decoded stream. */
  at: number;
};

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];

/**
 * Locate `.text`. Returns null for anything that is not a little-endian ELF64 with a readable
 * section table — deliberately, because "this is not an image Dot can decode" must be a different
 * answer from "Dot decoded it and found no selectors".
 */
export function findText(bytes: Buffer): SbfCode | null {
  if (bytes.length < 64) return null;
  for (let i = 0; i < 4; i++) if (bytes[i] !== ELF_MAGIC[i]) return null;
  if (bytes[4] !== 2 /* ELFCLASS64 */ || bytes[5] !== 1 /* ELFDATA2LSB */) return null;
  const shOff = Number(bytes.readBigUInt64LE(0x28));
  const shEntSize = bytes.readUInt16LE(0x3a);
  const shNum = bytes.readUInt16LE(0x3c);
  const shStrndx = bytes.readUInt16LE(0x3e);
  if (shEntSize < 0x40 || shNum === 0 || shOff + shEntSize * shNum > bytes.length) return null;
  const strTabOff = Number(bytes.readBigUInt64LE(shOff + shStrndx * shEntSize + 0x18));
  const nameAt = (off: number) => {
    let s = '';
    for (let p = strTabOff + off; p < bytes.length && bytes[p] !== 0; p++) s += String.fromCharCode(bytes[p]!);
    return s;
  };
  for (let i = 0; i < shNum; i++) {
    const base = shOff + i * shEntSize;
    if (nameAt(bytes.readUInt32LE(base)) !== '.text') continue;
    const addr = Number(bytes.readBigUInt64LE(base + 0x10));
    const off = Number(bytes.readBigUInt64LE(base + 0x18));
    const size = Number(bytes.readBigUInt64LE(base + 0x20));
    if (off + size > bytes.length || size < 8) return null;
    return { fileOffset: off, vma: addr, length: size };
  }
  return null;
}

const BPF_CLASS = 0x07;
const BPF_ALU = 0x04;
const BPF_ALU64 = 0x07;
const BPF_JMP = 0x05;
const BPF_JMP32 = 0x06;
// Codes are stored in the shifted form the decoder reads: (op >> 3) & 0x1f. The opcode constants
// are written unscaled (0xb0, 0x10, …) so they can be checked against linux/bpf.h at a glance.
// The first version of this file also declared `BPF_EXIT = 0x10 >> 3` — the real value is 0x90 —
// which aliased BPF_JEQ and quietly dropped every `jeq` from the compare stream. A whitelist of
// the two equality codes cannot fail that way: an unlisted code loses a match, never gains one.
const BPF_MOV = 0xb0 >> 3;
const BPF_JEQ = 0x10 >> 3;
const BPF_JNE = 0x50 >> 3;
/** Solana's SBF extends the ALU64 encoding with `hor64` (code 0x1e) to place the high half of a
 *  64-bit constant. It has no upstream eBPF equivalent, which is why a spec-derived decoder misses
 *  it: the pair that materialises every discriminator in a hand-written dispatch is 0xb4 + 0xf7. */
const SBF_HOR64 = 0x1e;

/** Decode the instruction stream. Unknown opcodes are still walked at 8 bytes to stay aligned. */
export function decode(code: Buffer): DecodedInsn[] {
  const out: DecodedInsn[] = [];
  for (let at = 0; at + 8 <= code.length; at += 8) {
    const opcode = code[at]!;
    const insn: DecodedInsn = {
      opcode,
      dst: code[at + 1]! & 0x0f,
      src: (code[at + 1]! >> 4) & 0x0f,
      offset: code.readInt16LE(at + 2),
      imm: code.readInt32LE(at + 4),
      at,
    };
    out.push(insn);
    // `lddw` (BPF_LD | BPF_IMM | BPF_DW = 0x18) is the only wide instruction: its 64-bit immediate
    // spans the next word, which is data, not an instruction.
    if (opcode === 0x18) at += 8;
  }
  return out;
}

/**
 * A branch that tests a register for (in)equality against an immediate. This is where a byte-wise
 * discriminator compare shows up — and only equality is accepted. Range branches (`jsgt`, `jle`,
 * the switch-lowering artifacts around each arm) also carry small immediates, but their immediate
 * is a bound, not a byte the program requires, so counting them would let a coincidental ordering
 * look like a selector.
 */
function isImmEquality(op: number): boolean {
  const cls = op & BPF_CLASS;
  if (cls !== BPF_JMP && cls !== BPF_JMP32) return false;
  const code = (op >> 3) & 0x1f;
  if (code !== BPF_JEQ && code !== BPF_JNE) return false;
  // For the jump family, bit 0x08 is BPF_X: the second operand is a register, not an immediate.
  return (op & 0x08) === 0;
}

function isMov(op: number, alu64: boolean): boolean {
  const cls = op & BPF_CLASS;
  const code = (op >> 3) & 0x1f;
  if (code !== BPF_MOV) return false;
  return cls === (alu64 ? BPF_ALU64 : BPF_ALU) && (op & 0x08) === 0;
}

/** The immediates of equality branches that test against a single byte value, in program order.
 *  Exported because a recovery that misses has to be diagnosable against the same stream the rule
 *  reads — a second copy of the predicate in the diagnostic would be a second opinion, not a check. */
export function collectByteCompares(insns: DecodedInsn[]): Array<{ value: number; at: number }> {
  const out: Array<{ value: number; at: number }> = [];
  for (const i of insns) {
    if (!isImmEquality(i.opcode)) continue;
    const v = i.imm >>> 0;
    if (v <= 0xff) out.push({ value: v, at: i.at });
  }
  return out;
}

export type RecoveredSelector = {
  name: string;
  hex: string;
  /**
   * How it was recovered. `contiguous` is the old byte scan; `immediate-pair` is a
   * mov32/hor64 materialisation; `compare-chain` is the anchor-lang shape (seven or eight
   * byte compares in order, the leading byte optionally taken from the dispatch branch).
   */
  via: 'contiguous' | 'immediate-pair' | 'compare-chain';
  offset: number;
};

/**
 * Recover every expected discriminator the image really dispatches on.
 *
 * `expected` maps a name to its 8-byte hash; nothing is ever reported that is not in it, which is
 * what makes a wrong decode safe: it costs a miss, never a false claim.
 */
export function recoverSelectors(image: Buffer, expected: Map<string, string>): RecoveredSelector[] {
  const found = new Map<string, RecoveredSelector>();
  const want = new Map<string, string>();
  for (const [name, hex] of expected) want.set(hex.toLowerCase(), name);
  if (want.size === 0) return [];

  const lower = image.toString('hex');
  for (const [hex, name] of want) {
    const at = lower.indexOf(hex);
    if (at >= 0) found.set(name, { name, hex, via: 'contiguous', offset: at / 2 });
  }

  const text = findText(image);
  if (!text) return [...found.values()];
  const insns = decode(image.subarray(text.fileOffset, text.fileOffset + text.length));

  // 1. mov32 + hor64 on the same register: the two immediates are the low and high halves.
  const live = new Map<number, { lo: number; hi?: number; at: number }>();
  for (const i of insns) {
    if (isMov(i.opcode, false) && i.offset === 0) {
      live.set(i.dst, { lo: i.imm >>> 0, at: i.at });
      continue;
    }
    if ((i.opcode & BPF_CLASS) === BPF_ALU64 && ((i.opcode >> 3) & 0x1f) === SBF_HOR64 && (i.opcode & 0x08) === 0) {
      const prev = live.get(i.dst);
      if (prev && prev.hi === undefined) {
        const value = BigInt.asUintN(64, BigInt(prev.lo >>> 0) | (BigInt(i.imm >>> 0) << 32n));
        // The register holds the *integer* LLVM loaded from the byte array; the discriminator is
        // those bytes in memory order, which on a little-endian target is the LE rendering.
        // Comparing `value.toString(16)` to the IDL hash instead is byte-swap nonsense: it found
        // 0/10 on an image where the pair is present 10 times.
        const buf = Buffer.alloc(8);
        buf.writeBigUInt64LE(value);
        const hex = buf.toString('hex');
        const name = want.get(hex);
        if (name && !found.has(name)) found.set(name, { name, hex, via: 'immediate-pair', offset: text.vma + prev.at });
      }
      live.delete(i.dst);
      continue;
    }
    if ((i.opcode & BPF_CLASS) === BPF_ALU64 || (i.opcode & BPF_CLASS) === BPF_ALU) live.delete(i.dst);
  }

  // 2. Byte-wise compare chain — what anchor-lang actually emits for `match data[..8]`.
  const byteCompares = collectByteCompares(insns);
  const bytesOf = (hex: string) => [0, 2, 4, 6, 8, 10, 12, 14].map((p) => parseInt(hex.slice(p, p + 2), 16));
  for (const [hex, name] of want) {
    if (found.has(name)) continue;
    const want8 = bytesOf(hex);
    for (let s = 0; s + 8 <= byteCompares.length; s++) {
      if (byteCompares.slice(s, s + 8).every((b, k) => b.value === want8[k])) {
        found.set(name, { name, hex, via: 'compare-chain', offset: text.vma + byteCompares[s]!.at });
        break;
      }
    }
    if (found.has(name)) continue;
    // The arm body tests data[1..8] — seven consecutive compares, each jumping to the next arm on
    // mismatch. `data[0]` is not in the arm: the outer switch that routes to it consumed that byte
    // much earlier in the stream (measured: ~87 instructions before the arm it selects). So the
    // head must *precede* the seven-byte run, and the run must be consecutive. Note what this does
    // and does not prove: seven ordered equality compares against seven bytes of a hash the IDL
    // supplied is not something a 135 KB .text produces by accident, but Dot is reading an
    // arm-plus-dispatch pair rather than one contiguous test, which is why `via` is recorded.
    for (let s = 0; s + 7 <= byteCompares.length; s++) {
      if (!byteCompares.slice(s, s + 7).every((b, k) => b.value === want8[k + 1])) continue;
      const head = byteCompares.slice(0, s).find((b) => b.value === want8[0]);
      if (head) {
        found.set(name, { name, hex, via: 'compare-chain', offset: text.vma + head.at });
        break;
      }
    }
  }

  return [...found.values()];
}
