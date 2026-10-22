import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import base58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { BPF_LOADER_UPGRADEABLE, KNOWN_PROGRAMS, isNativeProgram } from '../ids.js';
import { DotError } from '../errors.js';

/**
 * `BPFLoaderUpgradeable` account decoding.
 *
 * Upstream Rust declares `UpgradeableLoaderState` with `ProgramData = 2` and
 * `Program = 3`. On the mainnet accounts read while writing this, the
 * discriminants measured the other way round: the 2.2 MB bytecode account
 * reported 3 and the 36-byte pointer account reported 2. A tool that hard-codes
 * the Rust enum order therefore mislabels every account it reads, and — worse —
 * computes a bytecode hash over a window starting 4 bytes too early, so an
 * upgrade looks like "nothing changed".
 *
 * Dot classifies by structure instead of by trusting a constant:
 *   - a ProgramData is recognised because its *bytecode region begins with the
 *     ELF magic* and its own address equals the PDA derived from a Program account,
 *   - the discriminant and header are reported as observed data, and
 *   - if the ELF magic is not where the layout says it is, that is an error, not
 *     a silent wrong hash.
 */

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

export type ProgramDataState = {
  programData: string;
  program: string;
  /** Discriminant read from bytes 0..4, as measured. */
  discriminant: number;
  lamports: number;
  accountLen: number;
  /** Offset of the ELF magic: the start of the executable bytes. */
  bytecodeOffset: number;
  bytecodeLen: number;
  /** Upgrade authority, or null when renounced (deployed immutable). */
  authority: string | null;
  /** First 8 bytes after the discriminant, little-endian — slot-ish in every layout observed. */
  headerU64: number;
  /** sha256 over the entire account data: length changes and header changes count. */
  fullAccountHash: string;
  /** sha256 over the bytecode region only: answers "did the code change". */
  bytecodeHash: string;
  layout: 'u64+option33' | 'u64+option1' | 'unknown';
};

export function deriveProgramData(programId: string): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [new PublicKey(programId).toBuffer()],
    new PublicKey(BPF_LOADER_UPGRADEABLE),
  );
  return pda.toBase58();
}

export function isUpgradeableProgramAddress(programId: string): boolean {
  try {
    deriveProgramData(programId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode a `ProgramData` account's base64->Buffer data.
 *
 * `program` is passed in because the account itself does not name its program;
 * the relationship is the PDA derivation, which is verified by the caller
 * reading the Program account's pointer.
 */
export function decodeProgramData(
  account: { address: string; lamports: number; owner: string; data: Buffer },
  program: string,
): ProgramDataState {
  if (account.owner !== BPF_LOADER_UPGRADEABLE) {
    throw new DotError('NOT_UPGRADEABLE', `${account.address} is owned by ${account.owner}, not BPFLoaderUpgradeable`, {
      address: account.address,
      owner: account.owner,
    });
  }
  if (account.data.length < 8) {
    throw new DotError('UNKNOWN_PROGRAMDATA_LAYOUT', `${account.address} is too short (${account.data.length} bytes) to be ProgramData`, {
      address: account.address,
    });
  }

  const discriminant = account.data.readUInt32LE(0);
  const bytecodeOffset = account.data.indexOf(ELF_MAGIC);
  if (bytecodeOffset <= 4) {
    throw new DotError(
      'UNKNOWN_PROGRAMDATA_LAYOUT',
      `no ELF magic found after the discriminant in ${account.address} (found at ${bytecodeOffset}). ` +
        `Dot refuses to hash an unknown window: an upgrade could pass unnoticed.`,
      { address: account.address, discriminant, accountLen: account.data.length },
    );
  }

  const header = account.data.subarray(4, bytecodeOffset);
  let authority: string | null = null;
  let layout: ProgramDataState['layout'] = 'unknown';
  if (header.length >= 41) {
    // 8-byte u64, then a 1-byte Option tag, then a 32-byte pubkey whether or not
    // the tag is Some — this is what the accounts measured here actually contain.
    const tag = header[8];
    const candidate = header.subarray(9, 41);
    layout = 'u64+option33';
    authority = tag === 1 ? base58.encode(candidate) : null;
  } else if (header.length === 9) {
    // 8-byte u64 + a bare Option tag with no key payload: the only value that can
    // serialize this way is None, i.e. a renounced authority.
    layout = 'u64+option1';
    authority = null;
  }

  const bytecode = account.data.subarray(bytecodeOffset);
  return {
    programData: account.address,
    program,
    discriminant,
    lamports: account.lamports,
    accountLen: account.data.length,
    bytecodeOffset,
    bytecodeLen: bytecode.length,
    authority,
    headerU64: Number(account.data.readBigUInt64LE(4)),
    fullAccountHash: sha256(account.data),
    bytecodeHash: sha256(bytecode),
    layout,
  };
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The `Program` account is a 36-byte pointer: 4-byte discriminant + 32-byte
 * programdata address. Verified against three mainnet programs: the pointer
 * matched the PDA derived from the program id exactly.
 */
export function readProgramPointer(data: Buffer): string | null {
  if (data.length < 36) return null;
  return base58.encode(data.subarray(4, 36));
}

export type AuthorityPosture =
  | 'renounced'
  | 'multisig'
  | 'program_derived'
  | 'eoa'
  | 'unknown';

/**
 * Classify who can push the next upgrade. Deliberately conservative:
 * a PDA-looking authority is only called `multisig` when it is a known
 * governance program id, otherwise it is `program_derived` and scored as
 * "unreviewed", not as "safe".
 *
 * There is no RPC call that tells you a wallet is a 2-of-3 multisig. Claiming
 * otherwise would be the single most load-bearing hallucination in this tool, so
 * the mapping is a config table the operator maintains (`--authority-map`), and
 * anything unmapped is reported as unverified.
 */
export function classifyAuthority(
  authority: string | null,
  knownMultisigs: ReadonlySet<string> = new Set(),
): AuthorityPosture {
  if (authority === null) return 'renounced';
  if (knownMultisigs.has(authority)) return 'multisig';
  // A well-known program id is never a wallet, whatever the curve test says: the
  // all-zero system address is a valid ed25519 *point* (p is 1 mod 4, so -1 is a
  // square) even though nobody holds its key. Check the table first.
  if (isNativeProgram(authority) || KNOWN_PROGRAMS.has(authority)) return 'program_derived';
  try {
    if (!PublicKey.isOnCurve(authority)) return 'program_derived';
  } catch {
    return 'unknown';
  }
  return 'eoa';
}

/**
 * A multisig quorum read from the node's own parser rather than decoded by hand.
 *
 * The states are deliberately uneven in what they license. Only `measured` moves a score. `raw_bytes`
 * says the node gave us bytes and no type, which is *not* "this is not a multisig" — it is Dot not being
 * told. And `labelled_without_quorum_fields` is the honest failure of someone else's assumption: the node
 * called this account a multisig, but the fields Dot was told to look for are not there, so this returns
 * the keys it actually saw instead of guessing at them. A later run against a real multisig therefore
 * closes the gap by itself, from the evidence in the report, rather than silently scoring a wrong number.
 */
export type QuorumRead =
  | { state: 'measured'; m: number; n: number; signers: string[] }
  | { state: 'absent'; detail: string }
  | { state: 'raw_bytes'; detail: string }
  | { state: 'other_type'; detail: string }
  | { state: 'labelled_without_quorum_fields'; detail: string };

type ParsedAccountLike = {
  parsed: boolean;
  program?: string;
  type?: string;
  info?: Record<string, unknown>;
} | null;

const QUORUM_LABEL = /multisig/i;

export function readAuthorityQuorum(account: ParsedAccountLike): QuorumRead {
  if (account === null) return { state: 'absent', detail: 'the authority account does not exist at the requested commitment' };
  if (!account.parsed) {
    return { state: 'raw_bytes', detail: 'the node returned this account unparsed, so its type is unknown to Dot — not evidence that it is a single key' };
  }
  const label = `${account.program ?? ''} ${account.type ?? ''}`;
  if (!QUORUM_LABEL.test(label)) {
    return { state: 'other_type', detail: `the node labels it \`${account.program ?? 'unknown'}${account.type ? `/${account.type}` : ''}\`, not a multisig` };
  }
  const info = account.info ?? {};
  const m = info.numRequiredSigners;
  const signers = Array.isArray(info.signers) ? info.signers.filter((s): s is string => typeof s === 'string') : null;
  if (typeof m !== 'number' || signers === null || signers.length === 0 || m > signers.length) {
    const keys = Object.keys(info).join(', ') || '(no info object at all)';
    return {
      state: 'labelled_without_quorum_fields',
      detail: `labelled \`${account.program ?? 'multisig'}\` but the required-signers count or signer list is not where the parser expects it; keys seen: ${keys}`,
    };
  }
  return { state: 'measured', m, n: signers.length, signers };
}
