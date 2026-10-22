import { Buffer } from 'node:buffer';
import base58 from 'bs58';
import { sha256 } from './programdata.js';
import type { AccountUpdate } from '../rpc/yellowstone.js';

/**
 * Pre-deploy observation: the loader's staging `Buffer` account.
 *
 * `BPFLoaderUpgradeable` holds three account kinds, and the Geyser owner filter
 * sees all three. A `Buffer` write is a program image that has been uploaded and
 * funded but **not yet deployed** — the only moment at which an operator could
 * still react before the change is live. That turns a wall into a doorway, with one honest asterisk: Dot sees that a new image exists,
 * not what it does.
 *
 * Two things this module refuses to do:
 *
 *  - **It does not hardcode the bytecode offset.** The design note said 45, which is
 *    where `ProgramData`'s ELF magic was *measured* to sit. A `Buffer` has a
 *    different header (`disc + Option<Pubkey> authority`), so the magic lands
 *    earlier. Dot locates the magic, records where it found it, and refuses when it
 *    finds none — the exact discipline that caught the `ProgramData` discriminant
 *    being inverted from the docs. Note the Buffer layout has **not** been confirmed
 *    against a live staging account; the offset reported here is per-account data,
 *    never a constant.
 *  - **It does not invent a finalization ETA.** The loader applies new bytecode on
 *    the transaction that calls `upgrade`. There is no protocol-level timelock to
 *    read, and a governance delay lives in whatever system holds the authority —
 *    which is invisible from this account. So the answer is
 *    `immediate_unless_governed` with `governance: "unobserved"` unless an operator
 *    declares a delay. A fabricated "48h" would be the single most dangerous number
 *    in this file, because it is the one an operator would act on.
 */

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

export type StagedBuffer = {
  bufferAddress: string;
  /** Where the ELF magic was found in *this* account. Not assumed, not fixed. */
  bytecodeOffset: number;
  bytecodeLen: number;
  bytecodeHash: string;
  fullAccountHash: string;
  /** The Buffer's own authority — who can call `upgrade` with this image. */
  authority: string | null;
  /** Kept as bigint: this box has 10 MB rent reserves and Number() would round them. */
  lamports: bigint;
  slot: number;
  observedAt: number;
};

export type FinalizeEta = {
  status: 'immediate_unless_governed' | 'operator_declared_delay';
  delayMs: number | null;
  governance: 'unobserved' | 'declared';
  reason: string;
};

export type StagedUpgradeEvent = {
  kind: 'staged_upgrade';
  bufferAddress: string;
  /** Null until a ProgramData write carries these bytes, or an operator says so. */
  program: string | null;
  attribution: 'unattributed' | 'hash_match' | 'operator_declared';
  staged: StagedBuffer;
  deployed: { bytecodeHash: string; bytecodeLen: number } | null;
  matchesDeployed: boolean;
  deltaBytes: number | null;
  finalizeEta: FinalizeEta;
};

export class UnrecognizedBufferError extends Error {
  readonly code = 'UNKNOWN_BUFFER_LAYOUT';
  constructor(address: string, foundAt: number, length: number) {
    super(
      `no ELF magic located in staging Buffer ${address} (length ${length}, found at ${foundAt}); ` +
        `Dot will not hash a window it has to guess`,
    );
    this.name = 'UnrecognizedBufferError';
  }
}

/** Authority position after the 4-byte discriminant in the layout measured for ProgramData. */
export function decodeStagedBuffer(u: AccountUpdate, observedAt = Date.now()): StagedBuffer {
  const data = u.data;
  const offset = data.indexOf(ELF);
  if (offset <= 4) throw new UnrecognizedBufferError(u.address, offset, data.length);

  const header = data.subarray(4, offset);
  let authority: string | null = null;
  // Same head shape as ProgramData: u64 then Option<Pubkey>, or just Option<Pubkey>.
  if (header.length >= 41) {
    const tag = header[header.length - 33];
    authority = tag === 1 ? base58.encode(header.subarray(header.length - 32)) : null;
  } else if (header.length === 33) {
    authority = header[0] === 1 ? base58.encode(header.subarray(1)) : null;
  }

  return {
    bufferAddress: u.address,
    bytecodeOffset: offset,
    bytecodeLen: data.length - offset,
    bytecodeHash: sha256(data.subarray(offset)),
    fullAccountHash: sha256(data),
    authority,
    lamports: u.lamports,
    slot: u.slot,
    observedAt,
  };
}

/**
 * The one honest ETA shape. `immediate_unless_governed` means: nothing in the
 * loader delays a signed upgrade, and Dot cannot see whether something else does.
 */
export function finalizeEta(declaredDelayMs?: number | null): FinalizeEta {
  if (typeof declaredDelayMs === 'number' && declaredDelayMs >= 0) {
    return {
      status: 'operator_declared_delay',
      delayMs: declaredDelayMs,
      governance: 'declared',
      reason: `operator declares a ${declaredDelayMs}ms governance delay before this authority can send`,
    };
  }
  return {
    status: 'immediate_unless_governed',
    delayMs: null,
    governance: 'unobserved',
    reason:
      'the loader applies new bytecode on the upgrade transaction itself; any timelock lives in the governance system holding the authority, which is not readable from this account',
  };
}

/**
 * Correlates staging with landing.
 *
 * A Buffer account names no program: `upgrade` receives the program as an argument
 * in a transaction, not as a field on the account. So attribution is deferred and
 * evidence-based — when a `ProgramData` write arrives whose bytecode hash equals a
 * staged image, the staging event is retroactively attributed to that program. An
 * unattributed staged event is still worth reporting (an image went up), but it must
 * never be shown with a guessed program id.
 */
export class StagedUpgradeDetector {
  private readonly stagedByHash = new Map<string, StagedBuffer>();
  private deployed: Map<string, { bytecodeHash: string; bytecodeLen: number }> = new Map();
  private readonly eta: () => FinalizeEta;

  constructor(opts: { declaredDelayMs?: number | null } = {}) {
    this.eta = () => finalizeEta(opts.declaredDelayMs ?? null);
  }

  /** Number of staged images currently awaiting a landing. */
  pending(): number {
    return this.stagedByHash.size;
  }

  stagedImages(): StagedBuffer[] {
    return [...this.stagedByHash.values()];
  }

  observeDeployed(programDataHash: string, bytecodeHash: string, bytecodeLen: number): void {
    this.deployed.set(programDataHash, { bytecodeHash, bytecodeLen });
  }

  /** Feeds a ProgramData write back in, to attribute earlier staging observations. */
  attributeByLanding(bytecodeHash: string, program: string): StagedBuffer | null {
    const hit = this.stagedByHash.get(bytecodeHash);
    if (!hit) return null;
    this.stagedByHash.delete(bytecodeHash);
    return hit;
  }

  /**
   * A staging write produced an image. Returns the comparison against whatever
   * deployed state Dot has for `program`, or `null` when the image is byte-identical
   * to the live code — which is not an upgrade and must not be reported as one.
   */
  observeStaged(u: AccountUpdate, known?: { programDataKey: string; program?: string }): StagedUpgradeEvent | null {
    const staged = decodeStagedBuffer(u);
    const live = known?.programDataKey ? this.deployed.get(known.programDataKey) ?? null : null;

    if (live && live.bytecodeHash === staged.bytecodeHash) {
      // Same bytes already deployed. Not a change. Reporting it as one is how a
      // monitor trains its audience to ignore it.
      this.stagedByHash.delete(staged.bytecodeHash);
      return null;
    }

    this.stagedByHash.set(staged.bytecodeHash, staged);
    return {
      kind: 'staged_upgrade',
      bufferAddress: staged.bufferAddress,
      program: known?.program ?? null,
      attribution: known?.program ? 'operator_declared' : 'unattributed',
      staged,
      deployed: live,
      matchesDeployed: false,
      deltaBytes: live === null ? null : staged.bytecodeLen - live.bytecodeLen,
      finalizeEta: this.eta(),
    };
  }
}
