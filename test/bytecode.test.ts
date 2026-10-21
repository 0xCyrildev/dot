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
  const so = process.env.DOT_TEST_SO;
  const idlPath = process.env.DOT_TEST_IDL;
  const have = Boolean(so && idlPath && existsSync(so!) && existsSync(idlPath!));
  it.skipIf(!have)(
    have
      ? 'locates every IDL instruction selector in genuine compiled bytecode'
      : 'gated: no compiled .so in this environment (SBF toolchain bootstrap needs network)',
    () => {
    const bytes = readFileSync(so!);
    const names = discriminatorsFromIdl(JSON.parse(readFileSync(idlPath!, 'utf8')));
    expect(names.byName.size).toBeGreaterThan(0);
    const scan = scanDiscriminators(bytes, names.byName);
    // Partial recovery is expected and still informative; total failure would mean the
    // contiguous-constant assumption is wrong and the whole module needs rethinking.
    expect(scan.found.length / names.byName.size).toBeGreaterThan(0.5);
  });
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
