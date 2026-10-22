import { deriveProgramData, decodeProgramData, classifyAuthority } from '../src/state/programdata.js';

/**
 * Does the node itself tell us an upgrade authority is a native multisig, and if so what its quorum is?
 *
 * The reason this is measured before any code is written: Dot cannot currently tell a 1-of-2 DAO from a
 * 5-of-9 (see DANGER_RANKING_UNMEASURED_INPUTS), and the obvious fix — parse the authority account as
 * borsh — would mean hardcoding a layout and a program id from memory. There is no native-multisig
 * program id in @solana/web3.js to copy, which is the tell that a remembered constant would be unsourced.
 * So this probe asks `getAccountInfo(jsonParsed)` and records what the *node* labels the account as, for
 * every candidate it is given. Whatever shape comes back is the shape the parser will be written against.
 */

const RPC = process.env.DOT_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

/**
 * Candidates are sourced, never recalled: every address in the captured mainnet fixtures (so real
 * programs that appeared in real transactions), plus the two programs docs/live-*.md was measured
 * against, plus the loader-relevant ids in src/ids.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';

function fixtureAddresses(): string[] {
  const out = new Set<string>();
  for (const f of readdirSync(new URL('../test/fixtures/', import.meta.url).pathname)) {
    if (!f.startsWith('tx-')) continue;
    const j = JSON.parse(readFileSync(new URL(`../test/fixtures/${f}`, import.meta.url), 'utf8')) as any;
    for (const a of j?.result?.transaction?.message?.accountKeys ?? j?.transaction?.message?.accountKeys ?? []) {
      const pk = typeof a === 'string' ? a : a?.pubkey;
      if (pk) out.add(pk);
    }
  }
  return [...out];
}

const CANDIDATES = [
  ...fixtureAddresses(),
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  'FuCKerMRwwExvo5bGFGjszhBQXcZicVqU4H9LZjqHbVf',
];

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method} -> ${JSON.stringify(j.error).slice(0, 160)}`);
  return j.result;
}

async function accountBase64(address: string) {
  const r = await withRetry(() => rpc('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]));
  return r.value;
}

/** api.mainnet-beta drops to `fetch failed` in bursts (docs/blocked.md §2). A probe that treats that as
 * "no such account" would silently under-report, which is the failure mode this whole file exists to avoid. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw last;
}

async function accountParsed(address: string) {
  return (await withRetry(() => rpc('getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'confirmed' }]))).value;
}

console.log(`endpoint: ${RPC}\n`);
for (const program of CANDIDATES) {
  const pd = deriveProgramData(program);
  let authority: string | null = null;
  try {
    const a = await accountBase64(pd);
    if (!a) {
      console.log(`${program}\n  ProgramData ${pd} -> absent (not an upgradeable program on this cluster)\n`);
      continue;
    }
    const state = decodeProgramData({ address: pd, lamports: a.lamports, owner: a.owner, data: Buffer.from(a.data[0], 'base64') }, program);
    authority = state.authority;
  } catch (e) {
    console.log(`${program}\n  decode failed: ${(e as Error).message}\n`);
    continue;
  }

  if (!authority) {
    console.log(`${program}\n  authority: null (renounced / immutable)\n`);
    continue;
  }

  const dotSays = classifyAuthority(authority, new Set());
  let nodeLabel = '(no parsed value)';
  let info: Record<string, unknown> | null = null;
  let rawShape = '';
  try {
    const v = await accountParsed(authority);
    if (!v) rawShape = 'account absent';
    else {
      const d = v.data as unknown;
      const parsed = d && typeof d === 'object' && 'parsed' in d ? (d as { parsed: { program?: string; info?: unknown } }).parsed : null;
      nodeLabel = parsed?.program ?? '(not parsed by the node)';
      info = (parsed?.info as Record<string, unknown> | null) ?? null;
      rawShape = `owner=${v.owner} space=${v.space}`;
    }
  } catch (e) {
    nodeLabel = `jsonParsed REFUSED: ${(e as Error).message}`;
  }

  console.log(`${program}`);
  console.log(`  authority    ${authority}`);
  console.log(`  dot calls it ${dotSays}`);
  console.log(`  node labels it ${nodeLabel}${rawShape ? `  (${rawShape})` : ''}`);
  if (info) console.log(`  raw info     ${JSON.stringify(info).slice(0, 500)}`);
  if (info) {
    const signers = Array.isArray(info.signers) ? info.signers : null;
    console.log(`  info keys    ${Object.keys(info).join(', ')}`);
    console.log(`  quorum       ${'numRequiredSigners' in info ? info.numRequiredSigners : '(no numRequiredSigners field)'}${signers ? ` of ${signers.length}` : ''}`);
    if (signers) console.log(`  signers      ${signers.slice(0, 3).map((s) => String(s).slice(0, 8) + '…').join(' ')}${signers.length > 3 ? ` (+${signers.length - 3})` : ''}`);
  }
  console.log('');
}
