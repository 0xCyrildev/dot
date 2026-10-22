import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import base58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import type { SolanaClient } from '../rpc/client.js';
import { BudgetExhaustedError } from '../errors.js';

/**
 * Custody, for programs whose PDA seeds the operator supplies.
 *
 * `PDA_HOLDINGS_NOT_ENUMERATED` is the largest gap in this tool: value parked in a
 * program's PDAs is invisible to a transaction sample, no RPC lists "every token
 * account owned by these PDAs", and the seeds live in the deployment repo. This
 * module does not close that gap. It converts it from "unknowable" to "knowable if
 * you tell Dot the seeds", which is a real difference during an incident — and it
 * is honest about the half that remains: a program whose seeds nobody publishes still
 * reports zero observed holdings, which must never be read as zero holdings.
 *
 * Seeds are typed because Solana seed encodings are: a base58 key, a UTF-8 literal,
 * or a little-endian integer. `seed_template: ["vault"]` and `["pool", "u8:0"]` are
 * both common, and hashing the ASCII `"0"` instead of the byte `0x00` derives a
 * different address that simply resolves to nothing — the quietest possible failure.
 */

export type SeedSpec = {
  program_id: string;
  /** Literals, base58 pubkeys, or typed encodings: u8:n u16:n u32:n u64:n bytes:hex str:text */
  seed_template: string[];
  account_type: 'SPL' | 'SPL_2022' | 'RAW';
  label?: string;
};

export type DerivedPda =
  | { ok: true; address: string; programId: string; accountType: SeedSpec['account_type']; label?: string }
  | { ok: false; spec: SeedSpec; reason: string };

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export function encodeSeed(token: string): Buffer | null {
  const typed = /^(\w+):(.*)$/.exec(token);
  if (typed) {
    const kind = typed[1]!.toLowerCase();
    const raw = typed[2]!;
    try {
      // Node coerces NaN into a zero byte and Buffer.write* does not throw, so
      // "u32:notanumber" silently produced a valid-looking all-zero seed and a
      // wrong address. Validate before writing.
      if (kind === 'u8' || kind === 'u16' || kind === 'u32') {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) return null;
        const width = kind === 'u8' ? 1 : kind === 'u16' ? 2 : 4;
        if (n > 256 ** width - 1) return null;
        const b = Buffer.alloc(width);
        if (kind === 'u8') b.writeUInt8(n);
        else if (kind === 'u16') b.writeUInt16LE(n);
        else b.writeUInt32LE(n);
        return b;
      }
      if (kind === 'u64') {
        if (!/^(0|[1-9][0-9]*)$/.test(raw)) return null;
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(BigInt(raw));
        return b;
      }
      if (kind === 'bytes') return Buffer.from(raw, 'hex');
      if (kind === 'str') return Buffer.from(raw, 'utf8');
      return null;
    } catch {
      return null;
    }
  }
  // A 32-byte base58 key is used as bytes; anything else is a literal string seed.
  try {
    const decoded = base58.decode(token);
    if (decoded.length === 32) return Buffer.from(decoded);
  } catch {
    /* fall through to literal */
  }
  return Buffer.from(token, 'utf8');
}

export function deriveSeedAddress(spec: SeedSpec): DerivedPda {
  const seeds: Buffer[] = [];
  for (const token of spec.seed_template) {
    if (token.startsWith('$')) {
      return { ok: false, spec, reason: `unresolved seed variable "${token}" — supply a concrete value` };
    }
    const encoded = encodeSeed(token);
    if (encoded === null) return { ok: false, spec, reason: `unencodable seed "${token}"` };
    seeds.push(encoded);
  }
  try {
    const [pda] = PublicKey.findProgramAddressSync(seeds, new PublicKey(spec.program_id));
    return {
      ok: true,
      address: pda.toBase58(),
      programId: spec.program_id,
      accountType: spec.account_type,
      ...(spec.label ? { label: spec.label } : {}),
    };
  } catch (e) {
    return { ok: false, spec, reason: `derivation failed: ${(e as Error).message}` };
  }
}

export type Holdings = {
  observedLamports: number;
  observedTokenRaw: Map<string, bigint>;
  accountsRead: number;
  accountsEmpty: number;
  unresolvedSeeds: Array<{ spec: SeedSpec; reason: string }>;
  /** Budget stop is a coverage statement, not a zero. */
  stoppedReason: string | null;
  complete: boolean;
};

/**
 * Read the balances of derived PDAs. Chunked through `getMultipleAccounts` so the
 * call count scales with vaults per 100, not one call per vault.
 */
export async function sumHoldings(
  client: SolanaClient,
  specs: SeedSpec[],
  opts: { chunkSize?: number } = {},
): Promise<Holdings> {
  const derived: string[] = [];
  const typeByAddress = new Map<string, SeedSpec['account_type']>();
  const unresolvedSeeds: Holdings['unresolvedSeeds'] = [];
  for (const spec of specs) {
    const d = deriveSeedAddress(spec);
    if (!d.ok) {
      unresolvedSeeds.push({ spec, reason: d.reason });
      continue;
    }
    derived.push(d.address);
    typeByAddress.set(d.address, d.accountType);
  }

  const out: Holdings = {
    observedLamports: 0,
    observedTokenRaw: new Map(),
    accountsRead: 0,
    accountsEmpty: 0,
    unresolvedSeeds,
    stoppedReason: null,
    complete: true,
  };
  const chunkSize = Math.min(opts.chunkSize ?? 100, 100);

  for (let i = 0; i < derived.length; i += chunkSize) {
    const chunk = derived.slice(i, i + chunkSize);
    let accounts;
    try {
      accounts = await client.getMultipleAccountsParsed(chunk);
    } catch (e) {
      if (e instanceof BudgetExhaustedError) {
        out.stoppedReason = `budget exhausted after ${out.accountsRead} account(s); ${derived.length - i} vault address(es) unread`;
        out.complete = false;
        break;
      }
      out.stoppedReason = `account read failed: ${(e as Error).message}`;
      out.complete = false;
      break;
    }
    // Walk the *requested* addresses, not the response array: a node that returns
    // fewer entries than asked must not silently shift balances onto the wrong
    // address, and an entry missing from the response is an absent account.
    chunk.forEach((address, j) => {
      const acct = accounts[j];
      if (!acct) {
        out.accountsEmpty++;
        return;
      }
      out.accountsRead++;
      out.observedLamports += acct.lamports;
      const kind = typeByAddress.get(address);
      if ((kind === 'SPL' || kind === 'SPL_2022') && acct.parsedInfo?.tokenAmount) {
        const ta = acct.parsedInfo.tokenAmount as { amount?: string; mint?: string };
        const mint = typeof acct.parsedInfo.mint === 'string' ? acct.parsedInfo.mint : 'unknown-mint';
        if (ta.amount) out.observedTokenRaw.set(mint, (out.observedTokenRaw.get(mint) ?? 0n) + BigInt(ta.amount));
      }
    });
  }
  return out;
}

export async function loadSeedFile(path: string): Promise<SeedSpec[]> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error('seed file must be a JSON array');
  return raw
    .map((r) => r as Partial<SeedSpec>)
    .filter((r) => typeof r.program_id === 'string' && Array.isArray(r.seed_template))
    .map((r) => ({
      program_id: r.program_id as string,
      seed_template: r.seed_template as string[],
      account_type: (r.account_type ?? 'RAW') as SeedSpec['account_type'],
      ...(r.label ? { label: r.label } : {}),
    }));
}

export function renderHoldings(program: string, h: Holdings): string {
  const L: string[] = [];
  L.push(`Custody observed for PDAs declared against ${program}`);
  L.push(`  rent-paying lamports: ${h.observedLamports}`);
  for (const [mint, raw] of [...h.observedTokenRaw.entries()].sort()) L.push(`  mint ${mint}: ${raw} raw units`);
  L.push(`  accounts read ${h.accountsRead}, absent ${h.accountsEmpty}, seeds unresolved ${h.unresolvedSeeds.length}`);
  if (!h.complete) L.push(`  **INCOMPLETE**: ${h.stoppedReason}`);
  if (!h.complete || h.observedTokenRaw.size === 0) {
    L.push(
      h.observedTokenRaw.size === 0
        ? '  note: no SPL balances found on the derived addresses — either the account_type is wrong, the seeds do not describe a token vault, or the sweep was cut short. Absence here is not zero holdings.'
        : '  note: balances were found, but the sweep is incomplete; the true custody figure is at least this large. Absence here is not zero holdings.',
    );
  }
  L.push('  no USD figure: Dot has no price oracle. Raw units and decimals are what the chain reported.');
  return L.join('\n');
}

export { TOKEN_PROGRAM, TOKEN_2022_PROGRAM };
