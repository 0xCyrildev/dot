import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { BPF_LOADER_UPGRADEABLE } from '../src/ids.js';
import {
  classifyAuthority,
  decodeProgramData,
  deriveProgramData,
  readProgramPointer,
} from '../src/state/programdata.js';
import { DotError } from '../src/errors.js';
import { fixture } from './helpers.js';

const observed = fixture<{
  accounts: Array<{
    program: string;
    programData: string;
    headBase64: string;
    accountLen: number;
    expect: { discriminant: number; bytecodeOffset: number; authority: string | null; headerU64: number };
  }>;
  programPointers: Array<{ program: string; discriminant: number; accountLen: number; pointsTo: string }>;
}>('programdata-observed');

const asData = (b64: string) => Buffer.from(b64, 'base64');

describe('ProgramData decoding against captured mainnet bytes', () => {
  for (const a of observed.accounts) {
    it(`decodes ${a.program.slice(0, 8)}… with the ELF magic where it was measured`, () => {
      const s = decodeProgramData(
        { address: a.programData, lamports: 1, owner: BPF_LOADER_UPGRADEABLE, data: asData(a.headBase64) },
        a.program,
      );
      expect(s.discriminant).toBe(a.expect.discriminant);
      expect(s.bytecodeOffset).toBe(a.expect.bytecodeOffset);
      expect(s.authority).toBe(a.expect.authority);
      expect(s.headerU64).toBe(a.expect.headerU64);
      expect(s.bytecodeHash).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  it('treats a zero authority tag as renounced, not as a zero pubkey', () => {
    const renounced = observed.accounts.find((a) => a.expect.authority === null);
    expect(renounced).toBeDefined();
    const s = decodeProgramData(
      { address: renounced!.programData, lamports: 1, owner: BPF_LOADER_UPGRADEABLE, data: asData(renounced!.headBase64) },
      renounced!.program,
    );
    expect(s.authority).toBeNull();
    expect(classifyAuthority(s.authority)).toBe('renounced');
  });

  it('refuses to hash a region it cannot identify instead of producing a plausible wrong digest', () => {
    const noElf = Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.alloc(40, 7)]);
    let code = '';
    try {
      decodeProgramData({ address: 'x', lamports: 1, owner: BPF_LOADER_UPGRADEABLE, data: noElf }, 'x');
    } catch (e) {
      code = (e as DotError).code;
    }
    expect(code).toBe('UNKNOWN_PROGRAMDATA_LAYOUT');
  });

  it('rejects an account the loader does not own', () => {
    let code = '';
    try {
      decodeProgramData({ address: 'x', lamports: 1, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: Buffer.alloc(64) }, 'x');
    } catch (e) {
      code = (e as DotError).code;
    }
    expect(code).toBe('NOT_UPGRADEABLE');
  });

  it('derives the same programdata PDA the chain points at, for every captured pointer', () => {
    for (const p of observed.programPointers) {
      expect(deriveProgramData(p.program)).toBe(p.pointsTo);
    }
  });

  it('reads the 36-byte Program account pointer body', () => {
    const data = Buffer.concat([Buffer.from([2, 0, 0, 0]), Buffer.alloc(32, 9)]);
    expect(readProgramPointer(data)).not.toBeNull();
    expect(readProgramPointer(Buffer.alloc(20))).toBeNull();
  });
});

describe('authority posture', () => {
  const multisig = 'HZcJwcJ2njPDxZtpPoKnF8v2w9QAx2rS7TdJPSRkbEhu';
  const eoa = 'FnSCQX1CYdGkGgd7RSScZzVij7nfKhYK5VcjaAozv3d5';
  it('only calls an authority multisig when the operator said so', () => {
    expect(classifyAuthority(multisig, new Set([multisig]))).toBe('multisig');
    expect(classifyAuthority(multisig, new Set())).not.toBe('multisig');
  });
  it('classifies an off-curve authority as program-derived rather than as a wallet', () => {
    // 32 zero bytes is not a curve point: no wallet can sign with it.
    expect(classifyAuthority('11111111111111111111111111111111')).toBe('program_derived');
  });
  it('passes the on-curve check through as eoa', () => {
    expect(classifyAuthority(eoa)).toBe('eoa');
  });
});
