import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import {
  anchorDiscriminator,
  diffBytecode,
  discriminatorsFromIdl,
  renderBytecodeDiff,
  scanDiscriminators,
} from '../src/state/bytecodeDiff.js';
import { BytecodeVault } from '../src/state/bytecodeVault.js';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Scope of what these tests can prove.
 *
 * They prove the derivation matches Anchor's published rule, that presence/absence of a
 * named 8-byte selector is detected correctly inside an image, and that the diff refuses
 * to overclaim when a side is missing. They do NOT prove that a real compiled Anchor
 * program lays its selectors out contiguously in `.rodata` — that needs a genuine `.so`,
 * and this environment cannot produce one: `cargo build-sbf` aborts with
 * `not a directory: ~/.cache/solana/v1.54/platform-tools/rust/lib` and the toolchain
 * bootstrap needs network egress that is blocked here (see docs/blocked.md). The gated
 * test at the bottom runs the moment someone with a real artifact sets DOT_TEST_SO.
 */

const NAMES = ['initialize', 'withdraw', 'deposit', 'close_account', 'set_authority'];
const disc = (n: string) => anchorDiscriminator(n);
const idl = (names: string[]) => ({ instructions: names.map((name) => ({ name, accounts: [] })) });

/** An image with the selectors parked at scattered offsets, like a rodata section would. */
function image(names: string[], gap = 137): Buffer {
  const parts: Buffer[] = [Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(gap, 0xaa)];
  for (const n of names) {
    parts.push(disc(n));
    parts.push(Buffer.alloc(gap, 0x5c));
  }
  return Buffer.concat(parts);
}

describe('Anchor discriminator derivation', () => {
  it('is sha256("global:<name>")[0..8], computed independently here', () => {
    for (const n of NAMES) {
      const expected = createHash('sha256').update(`global:${n}`).digest().subarray(0, 8);
      expect(disc(n).equals(expected)).toBe(true);
    }
  });

  it('is not the raw name hash, not a different prefix, and not the tail of the digest', () => {
    const withdraw = disc('withdraw');
    expect(withdraw.equals(createHash('sha256').update('withdraw').digest().subarray(0, 8))).toBe(false);
    expect(withdraw.equals(createHash('sha256').update('instruction:withdraw').digest().subarray(0, 8))).toBe(false);
    expect(withdraw.equals(createHash('sha256').update('global:withdraw').digest().subarray(24, 32))).toBe(false);
    expect(withdraw.length).toBe(8);
  });
});

describe('selector scanning', () => {
  it('finds named selectors and reports nothing as absent that is present', () => {
    const names = discriminatorsFromIdl(idl(NAMES));
    const scan = scanDiscriminators(image(['initialize', 'withdraw']), names.byName);
    expect(scan.found.map((f) => f.names[0]).sort()).toEqual(['initialize', 'withdraw']);
    expect(scan.absent.sort()).toEqual(['close_account', 'deposit', 'set_authority']);
    expect(scan.found[0]!.offsets.length).toBeGreaterThan(0);
  });

  it('refuses to name a hit it cannot resolve, by taking candidates from the IDL only', () => {
    // An unnamed 8-byte pattern in an image is not an instruction; scanning is
    // candidate-driven precisely so this cannot be misreported as one.
    const noise = Buffer.concat([Buffer.alloc(64), Buffer.from('deadbeefcafebabe', 'hex'), Buffer.alloc(64)]);
    const scan = scanDiscriminators(noise, discriminatorsFromIdl(idl(NAMES)).byName);
    expect(scan.found).toEqual([]);
  });
});

describe('structural diff', () => {
  it('reports added, removed and persisting entrypoints against named IDLs', () => {
    const d = diffBytecode({
      oldBytes: image(['initialize', 'withdraw', 'deposit']),
      newBytes: image(['initialize', 'withdraw', 'close_account']),
      oldIdl: idl(['initialize', 'withdraw', 'deposit']),
      newIdl: idl(['initialize', 'withdraw', 'close_account']),
    });
    expect(d.confidence).toBe('structural');
    expect(d.instructions?.added.map((a) => a.name)).toEqual(['close_account']);
    expect(d.instructions?.removed.map((r) => r.name)).toEqual(['deposit']);
    expect(d.instructions?.persisting.sort()).toEqual(['initialize', 'withdraw']);
    expect(d.instructions?.persistingNote).toMatch(/selector surviving says nothing/);
  });

  it('keeps a reachable selector missing from the new IDL as a finding, not a rejected candidate', () => {
    const d = diffBytecode({
      oldBytes: image(['initialize']),
      newBytes: image(['initialize', 'set_authority']),
      oldIdl: idl(['initialize', 'set_authority']),
      newIdl: idl(['initialize']),
    });
    const undeclared = d.instructions?.undeclaredEntrypoints ?? [];
    expect(undeclared.map((u) => u.name)).toEqual(['set_authority']);
    expect(undeclared[0]?.why).toMatch(/absent from the new IDL/);
  });

  it('reports an IDL-declared selector that is not in the image instead of calling it removed', () => {
    const d = diffBytecode({
      oldBytes: image(['initialize'], 137),
      // Must differ from the old image, or the identical-images branch correctly
      // short-circuits and there is nothing to claim-check.
      newBytes: Buffer.concat([image(['initialize'], 137), Buffer.from([0x11])]),
      oldIdl: idl(['initialize']),
      newIdl: idl(['initialize', 'withdraw']),
    });
    expect(d.instructions?.idlClaimedNotFound.map((x) => x.name)).toEqual(['withdraw']);
    expect(d.instructions?.removed).toEqual([]);
  });

  it('says "not an upgrade" when the images are identical', () => {
    const same = image(['initialize', 'withdraw']);
    const d = diffBytecode({ oldBytes: same, newBytes: same, oldIdl: idl(NAMES), newIdl: idl(NAMES) });
    expect(d.limits.join(' ')).toMatch(/not an upgrade/);
    expect(d.instructions).toBeUndefined();
  });

  it('makes no entrypoint claim at all without names', () => {
    const d = diffBytecode({
      oldBytes: image(['initialize', 'withdraw']),
      newBytes: image(['initialize', 'close_account']),
    });
    expect(d.confidence).toBe('bytecode_only');
    expect(d.instructions).toBeUndefined();
    expect(d.anchor.idlAvailable).toBe(false);
    expect(d.anchor.reason).toMatch(/no name can be attached/i);
    expect(d.similarity).toBeDefined();
    expect(d.similarity?.caveat).toMatch(/ordering-sensitive/);
    const text = renderBytecodeDiff(d, 'PROG');
    expect(text).not.toMatch(/entrypoints added/);
  });

  it('is one-sided when there is no prior image, and names why', () => {
    const d = diffBytecode({ oldBytes: null, newBytes: image(['initialize', 'withdraw']), newIdl: idl(['initialize', 'withdraw']) });
    expect(d.confidence).toBe('partial');
    expect(d.instructions?.persistingNote).toMatch(/no prior image/);
    expect(d.limits.join(' ')).toMatch(/minContextSlot/);
    expect(d.limits.join(' ')).toMatch(/indistinguishable/);
  });
});

describe('bytecode vault', () => {
  it('keeps a prior image retrievable and skips the current one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dot-vault-'));
    try {
      const vault = new BytecodeVault(dir);
      const oldImg = image(['initialize']);
      const newImg = image(['initialize', 'withdraw']);
      await vault.put({ program: 'P1', programData: 'PD1', image: oldImg, slot: 10, observedAt: 1, source: 'watch' });
      const rec = await vault.put({ program: 'P1', programData: 'PD1', image: newImg, slot: 20, observedAt: 2, source: 'watch' });
      const prior = await vault.priorFor('P1', rec.digest);
      expect(prior?.image.equals(oldImg)).toBe(true);
      expect(prior?.record.slot).toBe(10);
      expect(await vault.priorFor('P1', prior!.record.digest)).not.toBeNull();
      expect(await vault.history('P1')).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores an identical image once but links the programs that share it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dot-vault2-'));
    try {
      const vault = new BytecodeVault(dir);
      const shared = image(['initialize']);
      await vault.put({ program: 'A', programData: 'PDA', image: shared, slot: 1, observedAt: 1, source: 'watch' });
      await vault.put({ program: 'B', programData: 'PDB', image: shared, slot: 1, observedAt: 1, source: 'watch' });
      const dupes = await vault.sharedImages();
      expect(dupes[0]?.programs.sort()).toEqual(['A', 'B']);
      // Two programs shipping the same bytecode is a supply-chain link: one key, or one
      // team, or one copy-paste, and one upgrade affects both.
      expect(dupes[0]?.digest).toHaveLength(64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('validation against a real compiled program', () => {
  /**
   * The assumption behind the entrypoint diff, tested against the toolchain instead of
   * against an image this test wrote.
   *
   * `test/fixtures/sbf-dispatch.so` was compiled on this box with the Solana Rust toolchain
   * (rustc 1.89.0-sbpf-solana-v1.54, platform-tools v1.54) from a program whose dispatch has
   * the shape anchor-lang's `#[program]` macro generates: one `pub const DISCRIMINATOR:
   * [u8; 8]` per instruction, compared against the incoming data. Ten instructions, ten real
   * discriminators, one genuine compiler-emitted ELF.
   *
   * The result refutes the contiguous-constant assumption: 0 of 10 selectors are present as
   * 8 contiguous bytes, while 10 of 10 are present as two 4-byte immediates eight bytes
   * apart. A scan looking for the former finds nothing in a real program. Asserting the old
   * expectation ("> half located") would have meant deleting the finding to keep the green.
   */
  const REAL_SO = join(__dirname, 'fixtures', 'sbf-dispatch.so');
  const REAL_IDL = join(__dirname, 'fixtures', 'sbf-dispatch.idl.json');
  const real = existsSync(REAL_SO) && existsSync(REAL_IDL);
  const realBytes = () => readFileSync(REAL_SO);
  const realIdl = () => JSON.parse(readFileSync(REAL_IDL, 'utf8'));

  it('is a real SBF ELF, not a fixture shaped by hand', () => {
    expect(real).toBe(true);
    const b = realBytes();
    expect([...b.subarray(0, 4)]).toEqual([0x7f, 0x45, 0x4c, 0x46]);
    // e_machine at offset 18, little-endian. Measured: this toolchain's sbpfv2 emitter
    // reports 0x107 (263); readelf prints it as "<unknown>: 0x107" because the id is
    // Solana's own. What matters is that it is not x86 (62) and not a hand-made header.
    const machine = b[18]! | (b[19]! << 8);
    expect(machine).toBe(263);
    expect(b.length).toBeGreaterThan(1000);
    // Compiled output carries a .comment section no hand-built fixture would have.
    expect(b.includes(Buffer.from('.comment')) || b.includes(Buffer.from('llvm')) || b.includes(Buffer.from('rustc'))).toBe(true);
  });

  it('does not contain any discriminator as a contiguous 8-byte constant', () => {
    const names = discriminatorsFromIdl(realIdl());
    expect(names.byName.size).toBe(10);
    // The original finding, pinned without the scan loop so it stays true after recovery lands:
    // no 8-byte selector appears contiguously anywhere in a compiler-emitted image.
    const bytes = realBytes();
    const contiguous = [...names.byName.values()].filter((hex) => bytes.indexOf(Buffer.from(hex, 'hex')) >= 0).length;
    expect(contiguous).toBe(0);
  });

  it('locates all ten once the instruction stream is decoded', () => {
    // This is the difference between "the bytecode has no selector" and "Dot could not read it".
    // Measured: 10/10 on the committed fixture, all via the mov32/hor64 immediate pair, none
    // contiguous — the exact set the old scan reported as absent.
    const names = discriminatorsFromIdl(realIdl());
    const scan = scanDiscriminators(realBytes(), names.byName);
    expect(scan.decoded).toBe(true);
    expect(scan.found.length).toBe(10);
    expect(scan.absent).toEqual([]);
    expect(scan.recoveredOnly.slice().sort()).toEqual([...names.byName.keys()].sort());
    for (const f of scan.found) expect(f.via).toEqual(['immediate-pair']);
  });

  it('but does contain every discriminator, split across an immediate pair', () => {
    const names = discriminatorsFromIdl(realIdl());
    const bytes = realBytes();
    let halves = 0;
    let pairs = 0;
    for (const hex of names.byName.values()) {
      const d = Buffer.from(hex, 'hex');
      const lo = bytes.indexOf(d.subarray(0, 4));
      const hi = bytes.indexOf(d.subarray(4, 8));
      if (lo >= 0 && hi >= 0) halves++;
      // mov32 imm32 then hor64 imm32: the two immediates sit 8 bytes apart in .text.
      if (lo >= 0 && Math.abs(hi - lo) === 8) pairs++;
    }
    expect(halves).toBe(10);
    expect(pairs).toBeGreaterThan(0);
  });

  it('reports structural, not unscannable, once recovery locates the declared set', () => {
    const idl = realIdl();
    const newBytes = realBytes();
    // Two distinct images, so the identical-digest short-circuit does not answer the question
    // the scan is supposed to answer. The second is the first plus one byte — an ordinary
    // rebuild moves .rodata around, and nothing here is contiguous either way.
    const oldBytes = Buffer.concat([newBytes, Buffer.from([0x00])]);
    const d = diffBytecode({ oldBytes, newBytes, oldIdl: idl, newIdl: idl });
    expect(d.confidence).toBe('structural');
    expect(d.instructions?.added).toHaveLength(0);
    expect(d.instructions?.removed).toHaveLength(0);
    expect(d.instructions?.idlClaimedNotFound).toHaveLength(0);
    expect(d.limits.join(' ')).not.toMatch(/scan located 0 of/);
  });

  it('still calls an image it cannot decode unscannable rather than "nothing changed"', () => {
    // The honesty layer has to survive the scanner working: an image Dot cannot parse, with an IDL
    // declaring ten instructions, must not print an unchanged interface. This is now the only
    // route to `unscannable` in this file, which is exactly what it should be reserved for.
    const idl = realIdl();
    const noise = Buffer.alloc(4096, 0x5a);
    const d = diffBytecode({ oldBytes: noise, newBytes: Buffer.concat([noise, Buffer.from([0x01])]), oldIdl: idl, newIdl: idl });
    expect(d.confidence).toBe('unscannable');
    expect(d.instructions?.idlClaimedNotFound.length).toBe(10);
    for (const x of d.instructions?.idlClaimedNotFound ?? []) {
      expect(x.why).toMatch(/not seen|blind/i);
    }
    expect(d.limits.join(' ')).toMatch(/scan located 0 of 10/);
    expect(renderBytecodeDiff(d, 'sbf-dispatch')).toMatch(/unscannable/);
  });


  it('still calls a byte-identical observation what it is', () => {
    const idl = realIdl();
    const b = realBytes();
    const d = diffBytecode({ oldBytes: b, newBytes: b, oldIdl: idl, newIdl: idl });
    expect(d.limits.join(' ')).toMatch(/not an upgrade/);
  });

  it('still locates contiguous selectors when a producer really does emit them', () => {
    // Control: the scanner is not broken in general. Where the constants are contiguous, all
    // five are found, which is what makes the blindness above a statement about emission
    // shape rather than about the scan loop.
    const names = ['initialize', 'withdraw', 'deposit', 'close_account', 'set_authority'];
    const img = Buffer.concat(names.map((n, i) => Buffer.concat([Buffer.alloc(9 + i, 0x5c), anchorDiscriminator(n)])));
    const scan = scanDiscriminators(img, discriminatorsFromIdl({ instructions: names.map((name) => ({ name })) }).byName);
    expect(scan.found.length).toBe(5);
  });

  const extra = process.env.DOT_TEST_SO;
  const extraIdl = process.env.DOT_TEST_IDL;
  const have = Boolean(extra && extraIdl && existsSync(extra!) && existsSync(extraIdl!));
  it.skipIf(!have)(
    have ? 'runs the same check on any externally supplied artifact' : 'gated: set DOT_TEST_SO and DOT_TEST_IDL to check another program',
    () => {
      const bytes = readFileSync(extra!);
      const names = discriminatorsFromIdl(JSON.parse(readFileSync(extraIdl!, 'utf8')));
      expect(names.byName.size).toBeGreaterThan(0);
      const scan = scanDiscriminators(bytes, names.byName);
      // No threshold on purpose: running it on another artifact is to see what that compiler
      // emitted, not to bend the expectation until it passes.
      const halves = [...names.byName.values()].filter((hex) => bytes.indexOf(Buffer.from(hex, 'hex').subarray(0, 4)) >= 0).length;
      process.stderr.write(`DOT_TEST_SO: ${scan.found.length}/${names.byName.size} contiguous, ${halves}/${names.byName.size} present as a 4-byte half\n`);
      expect(scan.found.length).toBeLessThanOrEqual(names.byName.size);
    },
  );
});

describe('account-requirement diff', () => {
  /** The user's example: a new `withdraw` taking a writable account it does not constrain. */
  it('flags a new entrypoint accepting a writable, unsigned, unconstrained account', () => {
    const newIdl = {
      instructions: [
        { name: 'initialize', accounts: [] },
        {
          name: 'withdraw',
          accounts: [
            { name: 'authority', isSigner: true, isMut: false },
            { name: 'vault', isSigner: false, isMut: true },
            { name: 'systemProgram', isSigner: false, isMut: false, address: '11111111111111111111111111111111' },
          ],
        },
      ],
    };
    const d = diffBytecode({
      oldBytes: image(['initialize'], 137),
      newBytes: Buffer.concat([image(['initialize', 'withdraw'], 137), Buffer.from([0x01])]),
      oldIdl: idl(['initialize']),
      newIdl,
    });
    const withdraw = d.accounts?.find((a) => a.instruction === 'withdraw');
    expect(withdraw?.status).toBe('added');
    expect(withdraw?.writableNonSigner).toEqual(['vault']);
    // authority is a signer; systemProgram is address-constrained. Neither is flagged.
    expect(withdraw?.writableNonSigner).not.toContain('authority');
    expect(withdraw?.writableNonSigner).not.toContain('systemProgram');
    expect(withdraw?.selectorLocated).toBe(true);
    expect(renderBytecodeDiff(d, 'P')).toContain('writable, not a signer, not address-constrained: vault');
    expect(d.limits.join(' ')).toMatch(/question to ask the author, not a vulnerability finding/);
  });

  it('reads legacy isMut/isSigner and modern writable/signer alike', () => {
    const legacy = { instructions: [{ name: 'withdraw', accounts: [{ name: 'vault', isMut: false, isSigner: false }] }] };
    const modern = { instructions: [{ name: 'withdraw', accounts: [{ name: 'vault', writable: true, signer: false }] }] };
    const d = diffBytecode({
      oldBytes: image(['withdraw']),
      newBytes: Buffer.concat([image(['withdraw']), Buffer.from([9])]),
      oldIdl: legacy,
      newIdl: modern,
    });
    const w = d.accounts?.find((a) => a.instruction === 'withdraw');
    expect(w?.status).toBe('accounts_changed');
    expect(w?.shifts).toEqual([{ account: 'vault', from: 'vault', to: 'vault(w)' }]);
    expect(w?.writableNonSigner).toEqual(['vault']);
  });

  it('treats a bare string account as unnamed permissions rather than as immutable', () => {
    // Older IDLs list accounts as strings with no flags at all. Reporting "no writable
    // accounts" for that would be a false negative, so the shape is preserved as-is.
    const d = diffBytecode({
      oldBytes: image(['withdraw']),
      newBytes: Buffer.concat([image(['withdraw']), Buffer.from([9])]),
      oldIdl: idl(['withdraw']),
      newIdl: { instructions: [{ name: 'withdraw', accounts: ['vault', 'mint'] }] },
    });
    const w = d.accounts?.find((a) => a.instruction === 'withdraw');
    expect(w?.added.map((a2) => a2.name).sort()).toEqual(['mint', 'vault']);
    expect(w?.writableNonSigner).toEqual([]);
    // String-only account entries carry no flags: the diff must say the mutability is
    // unknown rather than reporting it as absent.
    expect(w?.note).toMatch(/without permission flags/);
    expect(w?.added.every((a2) => !a2.writable)).toBe(true);
  });

  it('says nothing is comparable when no IDL was supplied', () => {
    const d = diffBytecode({ oldBytes: image(['initialize']), newBytes: Buffer.concat([image(['initialize']), Buffer.from([3])]) });
    expect(d.accounts).toBeUndefined();
    expect(d.accountsNote).toMatch(/no IDL pair supplied/i);
  });

  it('lists declared accounts without inventing a "change" on a first sighting', () => {
    const d = diffBytecode({ oldBytes: null, newBytes: image(['withdraw']), newIdl: idl(['withdraw']) });
    expect(d.accounts?.[0]?.status).toBe('added');
    expect(d.accountsNote).toMatch(/nothing can be called changed/);
  });
});
