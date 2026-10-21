import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveSeedAddress, loadSeedFile, sumHoldings } from '../src/state/seeds.js';
import { HttpTransport, type JsonRpcResponse, type RpcTransport } from '../src/rpc/transport.js';
import { SolanaClient } from '../src/rpc/client.js';
import { Budget } from '../src/agent/budget.js';

/**
 * Custody from declared seeds, exercised against the chain.
 *
 * The gap this command lives next to is real: program-held value is not enumerable from
 * RPC, so `--seeds` only sums what an operator declares. What was never shown, until now, is
 * that the declaration does what it claims — that a seed template derives *the address the
 * chain actually uses*, and that the sum is the sum of what was read, with absent accounts
 * kept out of the figure instead of counted as zero.
 *
 * The seed list is built from a captured mainnet transaction: three (owner, mint) pairs from
 * its token balances. Deriving ATA(owner, mint) reproduces exactly the accounts that
 * transaction named at those indices, and reading them live (2026-10-21, api.mainnet-beta)
 * returned each one as a `So1111…1112` token account owned by the SPL Token program. So the
 * derivation is checkable by anyone with the same two rules, and it is not a fixture the
 * author wrote to match his own code.
 *
 * The two lamports-reserve entries are `ProgramData` PDAs, which is the same one-seed rule
 * `dot analyze` uses internally; the last two entries are deliberately unresolvable so the
 * run proves that absence and non-derivation are reported rather than absorbed.
 */

const ROOT = join(__dirname, '..');
const SEEDS = join(ROOT, 'seeds-live.json');
const ARTIFACT = join(ROOT, 'docs', 'live-seeds-2026-10-21.json');

/** Live-verified 2026-10-21 against api.mainnet-beta: each exists, owner=Token, mint=So1111… */
const CHAIN_VERIFIED_ATAS = [
  '7LT9N9FZGqgj56G4p6xK26CY6KUEuTAwDa6K2HKF2TAY',
  'X5QPJcpph4mBAJDzc4hRziFftSbcygV59kRb2Fu6Je1',
  'GYH1Gae1wJytMSvMvw8JVcv7nuAbxi8i9erNVbERnzXd',
];
/** deriveProgramData() of the two programs named in the seed file. */
const CHAIN_VERIFIED_PROGRAMDATA = ['BmArTGeoddLk3tts8AvH2ivNfVUtoHCX6V7dKDaVD4Xq', '6naEzKeUuFh1Jeeu51NXQgr5qkXgXtc9WKNct4xynVJc'];

describe('the seed file derives the addresses the chain uses', () => {
  it('has one entry per expectation, and each derives deterministically', async () => {
    const specs = await loadSeedFile(SEEDS);
    expect(specs).toHaveLength(7);
    const derived = specs.map((s) => deriveSeedAddress(s));
    const ok = derived.filter((d) => d.ok);
    const bad = derived.filter((d) => !d.ok);
    expect(ok).toHaveLength(6);
    expect(bad).toHaveLength(1);
    expect(bad[0] && !bad[0].ok ? bad[0].reason : '').toMatch(/\$user/);
    const addresses = ok.map((d) => (d.ok ? d.address : ''));
    for (const a of [...CHAIN_VERIFIED_ATAS, ...CHAIN_VERIFIED_PROGRAMDATA]) expect(addresses).toContain(a);
  });

  it('derives the same addresses twice, because a seed list whose output moves is a bug', async () => {
    const specs = await loadSeedFile(SEEDS);
    const once = specs.map((s) => deriveSeedAddress(s));
    const twice = specs.map((s) => deriveSeedAddress(s));
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });

  it('records a live run whose shape the code actually produces', () => {
    expect(existsSync(ARTIFACT)).toBe(true);
    const report = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as {
      holdings?: { observedLamports: number; observedTokenRaw: Record<string, string>; accountsRead: number; accountsEmpty: number; unresolvedSeeds: unknown[]; complete: boolean; source: string };
      budget: { spent: { rpcCalls: number } };
    };
    const h = report.holdings!;
    expect(h.source).toBe('seeds-live.json');
    expect(h.accountsRead).toBe(5);
    expect(h.accountsEmpty).toBe(1);
    expect(h.unresolvedSeeds).toHaveLength(1);
    expect(h.complete).toBe(true);
    expect(h.observedLamports).toBeGreaterThan(0);
    expect(Object.keys(h.observedTokenRaw)).toEqual(['So11111111111111111111111111111111111111112']);
    // Raw units are strings on the wire: a BigInt in JSON would have been silently truncated
    // to a Number at some point between the chain and the report.
    for (const v of Object.values(h.observedTokenRaw)) expect(typeof v).toBe('string');
    // The custody sweep cost one getMultipleAccounts call, not one per vault.
    expect(report.budget.spent.rpcCalls).toBeLessThan(20);
  });
});

describe('the sum is what was read, not what was declared', () => {
  const live = process.env.DOT_LIVE_RPC;
  // Gated, not skipped-quietly: without a reachable endpoint this suite asserts nothing
  // about the chain, and an empty assertion list is not evidence.
  it.skipIf(!live)('cross-checks the batched sum against individual reads on the same endpoint', async () => {
    const budget = new Budget({ maxRpcCalls: 40, maxSignatures: 5, maxLlmTokens: 0, maxWallMs: 120_000 });
    const client = new SolanaClient({ transport: new HttpTransport(live!), budget, commitment: 'finalized' });
    const specs = await loadSeedFile(SEEDS);
    const h = await sumHoldings(client, specs);

    expect(h.complete).toBe(true);
    expect(h.unresolvedSeeds).toHaveLength(1);
    expect(h.accountsEmpty).toBeGreaterThanOrEqual(1);
    expect(h.accountsRead).toBe(5);

    // Exact equality is only assertable against accounts that cannot move underneath the
    // read. The three token accounts in this list belong to active traders: a first run of
    // this test measured the batched sum and the individual sum one second apart and found
    // them 1,041,968 lamports apart, which is a trade, not a bug. So the strict check is
    // done on the two ProgramData rent reserves — which change only when someone upgrades —
    // and the live-set check stays structural.
    const stable = specs.filter((s) => s.account_type === 'RAW');
    let stableIndividual = 0;
    for (const spec of stable) {
      const d = deriveSeedAddress(spec);
      if (!d.ok) continue;
      const raw = await client.getRawAccountInfo(d.address);
      if (raw.account) stableIndividual += raw.account.lamports;
    }
    const stableBatched = await sumHoldings(
      client,
      stable.concat([specs.find((s) => s.label?.includes('holds nothing')) ?? stable[0]!]),
    );
    expect(stableBatched.observedLamports).toBe(stableIndividual);
    expect(stableBatched.accountsEmpty).toBe(1);

    // The SPL branch ran for real: a mint key and raw units off the chain, not off a fixture.
    const mints = [...h.observedTokenRaw.keys()];
    expect(mints).toContain('So11111111111111111111111111111111111111112');
    expect(h.observedTokenRaw.get('So11111111111111111111111111111111111111112')! > 0n).toBe(true);
    expect(h.observedLamports).toBeGreaterThan(stableIndividual);
  }, 180_000);

  it('proves the same invariant offline, against a transport that answers like the node did', async () => {
    // The chain moves: those three token accounts belong to active traders, so the absolute
    // figures in the artifact are a snapshot, not a constant. The invariant that has to hold
    // at any instant is "the batched sum equals the per-account sum", and that is testable
    // without network — including the chunking, which is the whole reason the sweep is
    // budgetable.
    const specs = await loadSeedFile(SEEDS);
    const derived = specs
      .map((s) => deriveSeedAddress(s))
      .filter((d): d is Extract<typeof d, { ok: true }> => d.ok)
      .map((d) => d.address);
    expect(derived).toHaveLength(6);

    const ata = new Set(CHAIN_VERIFIED_ATAS);
    const balances: Record<string, { lamports: number; token?: string }> = {
      [CHAIN_VERIFIED_ATAS[0]!]: { lamports: 954_068_781_180, token: '954067292740' },
      [CHAIN_VERIFIED_ATAS[1]!]: { lamports: 32_070_771_541, token: '32069283101' },
      [CHAIN_VERIFIED_ATAS[2]!]: { lamports: 1_031_243_475, token: '1029755035' },
      [CHAIN_VERIFIED_PROGRAMDATA[0]!]: { lamports: 2_197_389_560 },
      [CHAIN_VERIFIED_PROGRAMDATA[1]!]: { lamports: 53_268_311_040 },
      // The nonsense vault: well-formed address, nothing there. Reported as absent, never as 0
      // contributions to a sum that a reader will take as custody.
      [derived[5]!]: { lamports: 0 },
    };
    const transport = new ChunkFake(derived.map((address) => ({ address, ...balances[address]!, absent: address === derived[5], ata: ata.has(address) })));
    const budget = new Budget({ maxRpcCalls: 60, maxSignatures: 10, maxLlmTokens: 0, maxWallMs: 60_000 });
    const client = new SolanaClient({ transport, budget, commitment: 'finalized' });
    const h = await sumHoldings(client, await loadSeedFile(SEEDS));

    expect(h.complete).toBe(true);
    expect(h.unresolvedSeeds).toHaveLength(1);
    expect(h.accountsRead).toBe(5);
    expect(h.accountsEmpty).toBe(1);
    expect(h.observedLamports).toBe(954_068_781_180 + 32_070_771_541 + 1_031_243_475 + 2_197_389_560 + 53_268_311_040);
    expect(h.observedTokenRaw.get('So11111111111111111111111111111111111111112')).toBe(954_067_292_740n + 32_069_283_101n + 1_029_755_035n);
    // One call for six vaults. One-call-per-PDA is the shape this exists to avoid.
    expect(transport.calls.filter((c) => c.method === 'getMultipleAccounts')).toHaveLength(1);
  });
});

/** Answers `getMultipleAccounts` in one chunk the way mainnet-beta shaped its reply. */
class ChunkFake implements RpcTransport {
  readonly endpoint = 'fake://chunked';
  readonly calls: Array<{ method: string; params: unknown[] }> = [];
  constructor(
    private readonly accounts: Array<{ address: string; lamports: number; token?: string; absent?: boolean; ata: boolean }>,
  ) {}

  async request<T>(method: string, params: unknown[]): Promise<JsonRpcResponse<T>> {
    this.calls.push({ method, params });
    const wanted = (params as [string[]])[0];
    const value = wanted.map((a) => {
      const found = this.accounts.find((x) => x.address === a);
      if (!found || found.absent) return null;
      if (found.ata) {
        return {
          lamports: found.lamports,
          owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          executable: false,
          rentEpoch: null,
          data: {
            parsed: { info: { mint: 'So11111111111111111111111111111111111111112', tokenAmount: { amount: found.token, decimals: 9 }, isNative: true }, type: 'account' },
            program: 'spl-token',
            space: 165,
          },
        };
      }
      return {
        lamports: found.lamports,
        owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
        executable: false,
        rentEpoch: null,
        data: ['e30=', 'base64'],
      };
    });
    return { jsonrpc: '2.0', id: this.calls.length, result: { context: { slot: 1 }, value } as unknown as T };
  }
}
