import { Buffer } from 'node:buffer';
import { PublicKey } from '@solana/web3.js';
import { BPF_LOADER_UPGRADEABLE } from '../src/ids.js';
import { deriveProgramData } from '../src/state/programdata.js';
import { recoverSelectors } from '../src/state/sbfSelectors.js';
import { discriminatorsFromIdl } from '../src/state/bytecodeDiff.js';

/**
 * The bytecode-coverage probe: how much of a *real* mainnet program's instruction surface the selector
 * recovery actually locates.
 *
 * `BYTECODE_SCAN_BLIND_ON_COMPILED_IMAGES` is NARROWED because the recovery is proven on two images
 * (one hand-built dispatch shape, one anchor-lang 0.30.1 program built on this box), not on a corpus.
 * This script is the sampling job that AGENTS.md names as the only honest way to move that row.
 *
 * What it can honestly say, and what it cannot: a *candidate* program list is the bottleneck, not the
 * decoder. The addresses below are all sourced — the ids in src/ids.ts and the programs named in
 * docs/live-*.md — because nothing reachable on this box can enumerate the loader's programs
 * (`getProgramAccounts` on BPFLoaderUpgradeable is gated on the public endpoints, and publicnode refuses
 * indexed requests outright). So the output is a census of every upgradeable program this build was
 * allowed to name, and it must be reported as that, not as a sample of a population it never saw.
 */

const RPC = process.env.DOT_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const PROGRAMS = [
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // TOKEN_2022_PROGRAM (ids.ts)
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // the captured fixture's target
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // docs/live-verify-2026-10-21
  'FuCKerMRwwExvo5bGFGjszhBQXcZicVqU4H9LZjqHbVf', // docs/live-limits-for-2026-10-21
];

async function rpc(method: string, params: unknown[]): Promise<any> {
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error).slice(0, 100)}`);
  return r.result?.value;
}

/** The `anchor:idl` PDA, the same derivation src/idl.ts attempts under --try-onchain-idl. */
function idlPda(program: string): string {
  return PublicKey.findProgramAddressSync([Buffer.from('anchor:idl'), new PublicKey(program).toBuffer()], new PublicKey(program)).publicKey.toBase58();
}

const rows: string[] = [];
for (const program of PROGRAMS) {
  const pd = deriveProgramData(program);
  let image: Buffer | null = null;
  let note = '';
  try {
    const acct = await rpc('getAccountInfo', [pd, { encoding: 'base64', commitment: 'confirmed' }]);
    if (!acct) note = 'ProgramData absent';
    else if (acct.owner !== BPF_LOADER_UPGRADEABLE) note = `ProgramData owned by ${acct.owner.slice(0, 10)}`;
    else {
      const raw = Buffer.from(acct.data[0], 'base64');
      const at = raw.indexOf(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      // The magic sits at 45 on this layout with no length prefix before it (see the trap in AGENTS.md):
      // hashing a guessed slice is how a watcher reports "no change" on a real upgrade.
      if (at < 0) note = `no ELF magic in ${raw.length} bytes`;
      else image = raw.subarray(at);
    }
  } catch (e) {
    note = `read failed: ${(e as Error).message}`;
  }

  let idl: any = null;
  try {
    const a = await rpc('getAccountInfo', [idlPda(program), { encoding: 'base64', commitment: 'confirmed' }]);
    if (a) {
      const buf = Buffer.from(a.data[0], 'base64');
      // anchor's idl buffer: 8-byte discriminator, 4-byte borsh length, then the JSON document
      const len = buf.readUInt32LE(8);
      const text = buf.subarray(12, 12 + len).toString('utf8');
      idl = JSON.parse(text);
    }
  } catch {
    note += idl ? '' : ' | no on-chain IDL';
  }

  const names = idl ? discriminatorsFromIdl(idl) : null;
  const declared = names?.byHex.size ?? 0;
  let located = 0;
  let shapes = '';
  if (image && declared > 0) {
    const rec = recoverSelectors(image, names!.byName);
    located = rec.length;
    shapes = [...new Set(rec.map((r) => (r as { via?: string }).via ?? '?'))].join(',');
  }
  rows.push(
    `${program.slice(0, 10)}…  image=${image ? `${image.length}B` : 'none'}  idl=${idl ? 'on-chain' : 'none'}  declared=${declared}  located=${declared ? located : '-'}  ${shapes ? `via ${shapes}` : ''}  ${note}`,
  );
}
console.log(`endpoint: ${RPC}\n`);
for (const r of rows) console.log(r);
