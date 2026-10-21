import type { WireGetTransactionResult, WireMessage } from '../rpc/wire.js';

export type KeyResolution = {
  /** Ordered account keys exactly as a `json`-encoded instruction `accounts[]` would index them. */
  keys: string[];
  /** Fast pubkey -> table position lookup for the mixed-encoding case. */
  indexOf: Map<string, number>;
  /** How the list was obtained, because the two paths disagree on v0 transactions. */
  method: 'inlined_by_node' | 'composed_from_loadedAddresses' | 'static_only';
  /** Numeric indexes that fell outside the table (the `encoding: "json"` failure mode). */
  unresolvedIndexes: Array<{ where: string; index: number }>;
  /** Pubkeys named by an instruction but absent from the key table (the `jsonParsed` failure mode). */
  offTablePubkeys: Array<{ where: string; pubkey: string }>;
};

/**
 * Resolve the account key table for a transaction.
 *
 * Two facts measured off mainnet responses, both of which contradict the usual
 * description of this RPC:
 *
 *  - `encoding: "json"` gives instruction `accounts` as integer indexes into
 *    static keys followed by loaded-writable followed by loaded-readonly.
 *  - `encoding: "jsonParsed"` gives them as **base58 pubkeys already**, and
 *    inlines table-loaded addresses into `message.accountKeys` with a
 *    `source: "lookupTable"` marker.
 *
 * A parser that assumes one shape silently misreads the other: an index treated
 * as a pubkey resolves to nothing, and a pubkey treated as an index picks an
 * arbitrary account. So both are handled here and neither is trusted blindly —
 * whatever cannot be placed in the table is reported in `unresolvedIndexes` or
 * `offTablePubkeys` and surfaces in the evidence ledger.
 */
export function resolveAccountKeys(tx: WireGetTransactionResult): KeyResolution {
  const message: WireMessage = tx.transaction.message;
  const staticKeys = message.accountKeys.map((k) => k.pubkey);
  const inlinedLookup = message.accountKeys.some((k) => k.source === 'lookupTable');
  const loaded = tx.meta?.loadedAddresses ?? null;
  const hasLookups = (message.addressTableLookups?.length ?? 0) > 0;

  let keys: string[];
  let method: KeyResolution['method'];

  if (inlinedLookup) {
    keys = staticKeys;
    method = 'inlined_by_node';
  } else if (hasLookups && loaded && (loaded.writable.length > 0 || loaded.readonly.length > 0)) {
    keys = [...staticKeys, ...loaded.writable, ...loaded.readonly];
    method = 'composed_from_loadedAddresses';
  } else {
    keys = staticKeys;
    method = 'static_only';
  }

  const indexOf = new Map(keys.map((k, i) => [k, i]));
  const unresolvedIndexes: KeyResolution['unresolvedIndexes'] = [];
  const offTablePubkeys: KeyResolution['offTablePubkeys'] = [];

  const check = (accounts: Array<number | string> | undefined, where: string) => {
    for (const entry of accounts ?? []) {
      if (typeof entry === 'number') {
        if (entry < 0 || entry >= keys.length) unresolvedIndexes.push({ where, index: entry });
      } else if (typeof entry === 'string') {
        if (!indexOf.has(entry)) offTablePubkeys.push({ where, pubkey: entry });
      } else {
        unresolvedIndexes.push({ where, index: -1 });
      }
    }
  };

  message.instructions.forEach((ins, i) => check(ins.accounts, `outer[${i}]`));
  (tx.meta?.innerInstructions ?? []).forEach((g) => {
    g.instructions.forEach((ins, i) => check(ins.accounts, `inner[outer ${g.index}][${i}]`));
  });

  return { keys, indexOf, method, unresolvedIndexes, offTablePubkeys };
}

/** Normalize one `accounts` entry from either encoding into a pubkey. */
export function accountPubkey(entry: number | string, resolution: KeyResolution): string | null {
  if (typeof entry === 'string') return resolution.indexOf.has(entry) ? entry : null;
  return resolution.keys[entry] ?? null;
}
