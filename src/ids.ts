/**
 * Program identity table.
 *
 * Every address marked `observed` appeared verbatim in a mainnet
 * `getTransaction` response captured while writing this file (see
 * `test/fixtures/`). Addresses marked `assumed` are long-standing well-known
 * ids that were not on that particular transaction — they are kept separate so
 * a wrong constant is visible as a wrong constant rather than as a silent
 * misclassification.
 *
 * The `noise` flag marks native/system programs that inflate edge counts
 * without carrying any supply-chain meaning: `Program -> Token` edges are
 * universal, so counting them makes every blast radius look identical and
 * therefore useless. Dot records them but excludes them from the headline
 * dependent count.
 */

import base58 from 'bs58';

export type KnownProgram = {
  address: string;
  label: string;
  /** Cannot be upgraded through BPFLoaderUpgradeable (native/system program). */
  native: boolean;
  /** Excluded from blast-radius dependent counts; still recorded as an edge. */
  noise: boolean;
  observed: boolean;
};

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
export const BPF_LOADER_DEPRECATED = 'BPFLoader2111111111111111111111111111111111';
export const STAKE_PROGRAM = 'Stake111111111111111111111111111111111111111';
export const VOTE_PROGRAM = 'Vote111111111111111111111111111111111111111';

const table: KnownProgram[] = [
  { address: SYSTEM_PROGRAM, label: 'system', native: true, noise: true, observed: true },
  { address: TOKEN_PROGRAM, label: 'spl-token', native: false, noise: true, observed: true },
  { address: TOKEN_2022_PROGRAM, label: 'token-2022', native: false, noise: true, observed: true },
  { address: ATA_PROGRAM, label: 'associated-token-account', native: false, noise: true, observed: true },
  { address: COMPUTE_BUDGET_PROGRAM, label: 'compute-budget', native: true, noise: true, observed: true },
  { address: BPF_LOADER_UPGRADEABLE, label: 'bpf-loader-upgradeable', native: true, noise: false, observed: true },
  { address: BPF_LOADER_DEPRECATED, label: 'bpf-loader', native: true, noise: false, observed: false },
  { address: STAKE_PROGRAM, label: 'stake', native: true, noise: true, observed: false },
  { address: VOTE_PROGRAM, label: 'vote', native: true, noise: true, observed: false },
];

export const KNOWN_PROGRAMS: ReadonlyMap<string, KnownProgram> = new Map(
  table.map((p) => [p.address, p]),
);

export function isNoiseProgram(id: string): boolean {
  return KNOWN_PROGRAMS.get(id)?.noise === true;
}

export function isNativeProgram(id: string): boolean {
  return KNOWN_PROGRAMS.get(id)?.native === true;
}

export function labelOf(id: string): string | undefined {
  return KNOWN_PROGRAMS.get(id)?.label;
}

/** Base58-decode and assert the 32-byte width Solana account addresses have. */
export function decodePubkey(id: string): Uint8Array {
  const bytes = base58.decode(id);
  if (bytes.length !== 32) {
    throw new Error(`address ${id} is ${bytes.length} bytes, expected 32 (base58 typo?)`);
  }
  return bytes;
}

export function isWellFormedPubkey(id: string): boolean {
  try {
    decodePubkey(id);
    return true;
  } catch {
    return false;
  }
}
