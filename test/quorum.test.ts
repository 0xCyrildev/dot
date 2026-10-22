import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { Budget } from '../src/agent/budget.js';
import { RuleBasedDecision } from '../src/agent/rules.js';
import { Scout } from '../src/agent/scout.js';
import { SolanaClient } from '../src/rpc/client.js';
import { deriveProgramData, readAuthorityQuorum } from '../src/state/programdata.js';
import { scoreDanger, type DangerInputs } from '../src/score/danger.js';
import { BPF_LOADER_UPGRADEABLE } from '../src/ids.js';
import { probeSignerActivity } from '../src/agent/funding.js';
import { readFileSync } from 'node:fs';
import { FakeTransport, txFixture } from './helpers.js';

/**
 * Reading a multisig quorum from the node instead of decoding the account by hand.
 *
 * Why this route: Dot has no verifiable source for the native multisig program id or its borsh layout on
 * this box (web3.js ships neither, and a remembered constant is exactly the unsourced thing), and no live
 * native multisig could be *found* here either — the discovery call that would have surfaced one,
 * `getTokenLargestAccounts`, is refused on both reachable endpoints (429 on api.mainnet-beta, an
 * indexed-request token on publicnode). So the parser is written against the nested shape the node
 * actually returns, which was captured from a real mainnet `getAccountInfo(jsonParsed)` response for a
 * `Tokenkeg…`-owned account:
 *
 *     { "parsed": { "info": { … }, "type": "account" }, "program": "spl-token", "space": 165 }
 *
 * Note where the label sits. `data.program` carries the type; `data.parsed.type` carries the subtype. The
 * first version of this probe looked at `data.parsed.program`, which does not exist, and every account it
 * checked came back labelled `?` — a wrong answer that looked like missing data rather than a bug.
 *
 * The `labelled_without_quorum_fields` case is the part that makes this safe to ship before a live
 * multisig has been seen: if a real one turns out to carry different field names, this returns the keys
 * it *did* see instead of scoring a guess, so the first sighting writes the evidence that fixes it.
 */

const TARGET = '5PjDJaGfSPJj4tFzMRCiuuAasKg5n8dJKXKenhuwZexx';
const AUTH = 'FnSCQX1CYdGkGgd7RSScZzVij7nfKhYK5VcjaAozv3d5';

/** Matches the layout src/state/programdata.ts decodes: disc u32, rent state u64, has-authority flag, key. */
function programDataBytes(authority: string | null): Buffer {
  return Buffer.concat([
    Buffer.from([3, 0, 0, 0]),
    (() => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(423_977_638n);
      return b;
    })(),
    authority ? Buffer.from([1]) : Buffer.alloc(0),
    ...(authority ? [new PublicKey(authority).toBuffer()] : []),
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]),
  ]);
}

describe('readAuthorityQuorum — the node labels it, Dot does not guess it', () => {
  it('measures m-of-n from a parsed multisig body', () => {
    const signers = ['s1', 's2', 's3'].map((_, i) => `Signer${i}`);
    const r = readAuthorityQuorum({ parsed: true, program: 'multisig', type: 'multisig', info: { numRequiredSigners: 2, numValidSigners: 2, signers } });
    expect(r).toEqual({ state: 'measured', m: 2, n: 3, signers });
  });

  it('reports an unparsed account as an unknown, never as a single key', () => {
    const r = readAuthorityQuorum({ parsed: false });
    expect(r.state).toBe('raw_bytes');
    expect(r.state === 'raw_bytes' && r.detail).toMatch(/not evidence that it is a single key/);
  });

  it('reports a parsed non-multisig by the label the node gave it', () => {
    const r = readAuthorityQuorum({ parsed: true, program: 'spl-token', type: 'account', info: { mint: 'So1111', owner: 'x' } });
    expect(r.state).toBe('other_type');
    expect(r.state === 'other_type' && r.detail).toMatch(/`spl-token\/account`/);
  });

  it('keeps the keys it saw when the label says multisig but the fields do not, instead of inventing a quorum', () => {
    const r = readAuthorityQuorum({ parsed: true, program: 'multisig', type: 'multisig', info: { required: 3, members: ['a', 'b', 'c'] } });
    expect(r.state).toBe('labelled_without_quorum_fields');
    const detail = r.state === 'labelled_without_quorum_fields' ? r.detail : '';
    expect(detail).toMatch(/keys seen: required, members/);
  });

  it('refuses a quorum larger than the signer set it was given', () => {
    // 5-of-3 is not a strange multisig, it is a misread field, and scoring it as a low-threshold multisig
    // would flatter exactly the programs worth watching.
    const r = readAuthorityQuorum({ parsed: true, program: 'multisig', info: { numRequiredSigners: 5, signers: ['a', 'b', 'c'] } });
    expect(r.state).toBe('labelled_without_quorum_fields');
  });

  it('calls a missing account absent', () => {
    expect(readAuthorityQuorum(null).state).toBe('absent');
  });
});

describe('the measured quorum moves the two bands that were assumptions', () => {
  const base = (over: Partial<DangerInputs> = {}): DangerInputs => ({
    program: 'Pg11111111111111111111111111111111111111',
    authority: { posture: 'multisig', address: AUTH },
    delta: { confidence: 'structural', addedEntrypoints: [], undeclaredEntrypoints: [], accountChanges: [] },
    radius: { direct: 1, transitive: 0, lamportsRouted: 0, usdPerSol: null, mintsTouched: 0 },
    behavior: { priorDigestAt: '2026-09-01T00:00:00.000Z', stateFileUsed: true },
    integrity: { funding: null, declaredThreshold: null, timelockDeclared: false, fundingProbe: null, suspectAddressesSeen: 0 },
    timing: null,
    ...over,
  });
  const axis = (d: ReturnType<typeof scoreDanger>, id: string) => d.axes.find((a) => a.id === id)!;

  it('takes the alarming band for a 1-of-N and the gated band for anything above it', () => {
    expect(axis(scoreDanger(base({ integrity: { funding: null, declaredThreshold: null, timelockDeclared: false, fundingProbe: null, suspectAddressesSeen: 0, quorum: { m: 1, n: 9 } } })), 'authority').points).toBe(25);
    expect(axis(scoreDanger(base({ integrity: { funding: null, declaredThreshold: null, timelockDeclared: false, fundingProbe: null, suspectAddressesSeen: 0, quorum: { m: 3, n: 5 } } })), 'authority').points).toBe(10);
  });

  it('labels the band as measured, and stops printing the 1-of-N assumption', () => {
    const d = scoreDanger(base({ integrity: { funding: null, declaredThreshold: { m: 5, n: 9 }, timelockDeclared: false, fundingProbe: null, suspectAddressesSeen: 0, quorum: { m: 2, n: 3 } } }));
    const a = axis(d, 'authority');
    // A measured 2-of-3 outranks a declared 5-of-9: the chain talking beats an operator's note.
    expect(a.points).toBe(10);
    expect(a.label).toContain('2-of-3');
    expect(a.detail.join(' ')).toMatch(/quorum the node parsed/);
    expect(a.detail.join(' ')).not.toMatch(/scored as 1-of-N/);
    const i = axis(d, 'authorityIntegrity');
    expect(i.label).toMatch(/low-threshold multisig \(2-of-3 \(quorum read from the node's own parser\)\)/);
  });

  it('still says unknown when the read came back raw, and does not call it a single key', () => {
    const d = scoreDanger(base({ integrity: { funding: null, declaredThreshold: null, timelockDeclared: false, fundingProbe: null, suspectAddressesSeen: 0, quorum: null, quorumRead: 'raw_bytes', quorumDetail: 'the node returned this account unparsed' } }));
    const i = axis(d, 'authorityIntegrity');
    expect(i.points).toBeNull();
    expect(i.notAssessed.join(' ')).toMatch(/quorum read came back `raw_bytes`/);
    expect(i.notAssessed.join(' ')).toMatch(/not a single key, and it is not a clean authority either/);
  });
});

describe('Scout reads the authority account without spending perceive’s one call', () => {
  const pdRoute = (authority: string | null) => ({
    match: (m: string, p: unknown[]) => m === 'getAccountInfo' && (p as unknown[])[0] === deriveProgramData(TARGET),
    result: {
      context: { slot: 1 },
      value: { lamports: 12_633_600, owner: BPF_LOADER_UPGRADEABLE, executable: false, data: [programDataBytes(authority).toString('base64'), 'base64'] },
    },
  });
  const multisigRoute = (info: Record<string, unknown>) => ({
    match: (m: string, p: unknown[]) => m === 'getAccountInfo' && (p as unknown[])[0] === AUTH,
    result: { context: { slot: 1 }, value: { lamports: 1, owner: 'MultisigProgramPlaceholder', executable: false, space: 111, data: { parsed: { type: 'multisig', info }, program: 'multisig', space: 111 } } },
  });
  const rest = () => [
    { match: (m: string) => m === 'getSignaturesForAddress', result: Array.from({ length: 2 }, (_, i) => ({ signature: `sig${i}`, slot: 400_000_000 + i, err: null, memo: null, blockTime: 1_760_000_000 - i * 400, confirmationStatus: 'finalized' })) },
    { match: (m: string) => m === 'getTransaction', result: txFixture('tx-depth3') },
  ];

  async function runWith(routes: Parameters<FakeTransport['route']>[], opts: { checkSigners?: boolean; timelockDeclared?: boolean } = {}) {
    const transport = new FakeTransport();
    routes.forEach((r) => transport.route(r));
    const budget = new Budget({ maxRpcCalls: 500, maxSignatures: 500, maxLlmTokens: 0, maxWallMs: 600_000 });
    const scout = new Scout({
      client: new SolanaClient({ transport, budget, commitment: 'finalized' }),
      budget,
      decision: new RuleBasedDecision({}),
      mode: 'rules',
      ...(opts.checkSigners ? { checkSigners: true } : {}),
      ...(opts.timelockDeclared ? { timelockDeclared: true } : {}),
    });
    return { report: await scout.run({ program: TARGET }), transport };
  }

  it('reclassifies an authority the node parses as a multisig, with no --multisig from the operator', async () => {
    const signers = ['A', 'B', 'C'];
    const { report } = await runWith([
      multisigRoute({ numRequiredSigners: 2, numValidSigners: 2, signers }),
      pdRoute(AUTH),
      ...rest(),
    ]);
    const authority = report.danger!.axes.find((a) => a.id === 'authority')!;
    expect(authority.points).toBe(10);
    expect(authority.label).toMatch(/2-of-3/);
    // Posture came from the chain, so the operator's silence is no longer a blind spot.
    expect(report.evidence.map((e) => e.summary).join(' ')).toMatch(/read from the node's own parser rather than declared with --multisig/);
  });

  it('does not turn an unparsed authority into a multisig, and does not let it read as clean either', async () => {
    // A real EOA comes back exactly like this: owned by the system program, data as base64, no parsed
    // body at all. The quorum read therefore knows nothing, which must show up as a limit note while the
    // curve heuristic keeps the posture where it belongs.
    const rawAuthority = {
      match: (m: string, p: unknown[]) => m === 'getAccountInfo' && (p as unknown[])[0] === AUTH,
      result: { context: { slot: 1 }, value: { lamports: 23_879_600, owner: '11111111111111111111111111111111', executable: false, space: 0, data: ['', 'base64'] } },
    };
    const { report } = await runWith([rawAuthority, pdRoute(AUTH), ...rest()]);
    const integrity = report.danger!.axes.find((a) => a.id === 'authorityIntegrity')!;
    const authority = report.danger!.axes.find((a) => a.id === 'authority')!;
    expect(authority.points).toBe(40); // still a single key, by the curve test
    expect(authority.label).toMatch(/Single-key EOA/);
    expect(integrity.points).toBe(20); // and the funding band it can honestly claim
    expect(integrity.notAssessed.join(' ')).toMatch(/funding was not probed/);
    // The quorum read is recorded as an absence of evidence, never as a verified non-multisig.
    expect(report.stages.map((s) => s.note).join(' ')).toMatch(/authority quorum: raw_bytes/);
    expect(report.evidence.map((e) => e.summary).join(' ')).toMatch(/authority quorum unverified/);
  });
  it('dates the signer set end to end once the authority parses as a multisig', async () => {
    // The fixture signers resolve to the captured trace's own history, roughly a year old against this
    // run's clock, so the set reads as stale and lifts a timelocked 3-of-5 out of the brief's 0-point case.
    const signers = ['A', 'B', 'C', 'D', 'E'];
    const { report, transport } = await runWith(
      [multisigRoute({ numRequiredSigners: 3, numValidSigners: 3, signers }), pdRoute(AUTH), ...rest()],
      { checkSigners: true, timelockDeclared: true },
    );
    const integrity = report.danger!.axes.find((a) => a.id === 'authorityIntegrity')!;
    expect(integrity.points).toBe(10);
    expect(integrity.label).toMatch(/3-of-5/);
    expect(integrity.label).toMatch(/signer set reads as stale/);
    expect(report.stages.map((x) => x.note).join(' ')).toMatch(/signer set: stale/);
    // 1 quorum read + 5 signer reads on top of the analysis, all counted.
    expect(transport.calls.filter((c) => c.method === 'getSignaturesForAddress').length).toBeGreaterThanOrEqual(6);
  });

  it('does not spend signer reads when there is no parsed signer list to date', async () => {
    // Compared against the same run with the flag off, because the baseline already walks the program's
    // own history (and possibly its authority's): what must be true is that the flag costs *nothing*.
    const without = await runWith([pdRoute(AUTH), ...rest()], {});
    const with_ = await runWith([pdRoute(AUTH), ...rest()], { checkSigners: true });
    const n = (t: FakeTransport) => t.calls.filter((c) => c.method === 'getSignaturesForAddress').length;
    expect(n(with_.transport)).toBe(n(without.transport));
    expect(with_.report.stages.map((x) => x.note).join(' ')).toMatch(/--check-signers skipped/);
  });
});

describe('probeSignerActivity — the stale half of the band, and what it refuses to score', () => {
  const DAY = 86_400_000;

  /**
   * One route per signer. `FakeTransport`'s `resultFn` takes no arguments, so reaching for the request
   * params inside it throws a ReferenceError at runtime — which `tsc` never sees, because the suite is
   * not typechecked, and which the probe's own try/catch then reports as `unverified`. A broken test
   * wearing the costume of a finding about the target; the fix is per-address routes.
   */
  function clientWith(signers: string[], perSigner: (signer: string) => unknown[]) {
    const transport = new FakeTransport();
    for (const signer of signers) {
      transport.route({ match: (m: string, p: unknown[]) => m === 'getSignaturesForAddress' && (p as [string])[0] === signer, result: perSigner(signer) });
    }
    // Anything unmatched is a loud error rather than a silent empty history.
    transport.route({ match: () => true, error: { code: -1, message: 'unrouted call in the signer test' } });
    const budget = new Budget({ maxRpcCalls: 200, maxSignatures: 200 });
    return { client: new SolanaClient({ transport, budget, commitment: 'finalized' }), transport };
  }

  it('calls a set idle once every signer is past the window', async () => {
    const now = 1_800_000_000_000;
    const aged = (daysAgo: number) => [{ signature: 's', slot: 1, err: null, memo: null, blockTime: Math.floor((now - daysAgo * DAY) / 1000), confirmationStatus: 'finalized' }];
    const { client } = clientWith(['A', 'B', 'C'], () => aged(400));
    const r = await probeSignerActivity(client, { signers: ['A', 'B', 'C'], nowMs: now });
    expect(r.state).toBe('stale');
    expect(r.probed).toBe(3);
    expect(r.detail).toMatch(/400 day\(s\) old/);
  });

  it('is not stale if any one signer has moved recently', async () => {
    const now = 1_800_000_000_000;
    const bt = (daysAgo: number) => [{ signature: 's', slot: 1, err: null, memo: null, blockTime: Math.floor((now - daysAgo * DAY) / 1000), confirmationStatus: 'finalized' }];
    const { client } = clientWith(['A', 'B', 'C'], (signer) => (signer === 'C' ? bt(2) : bt(400)));
    const r = await probeSignerActivity(client, { signers: ['A', 'B', 'C'], nowMs: now });
    expect(r.state).toBe('active');
  });

  it('returns unverified, never stale, when the node gives nothing back', async () => {
    // The direction of this matters: an unread set must not mint the +10 that accuses it of being cold.
    const { client } = clientWith(['A', 'B'], () => []);
    const r = await probeSignerActivity(client, { signers: ['A', 'B'], nowMs: Date.now() });
    expect(r.state).toBe('unverified');
    expect(r.detail).toMatch(/idleness is unknown rather than long/);
  });

  it('reports the cap instead of applying it silently', async () => {
    const now = 1_800_000_000_000;
    const signers = Array.from({ length: 11 }, (_, i) => `S${i}`);
    const { client } = clientWith(signers, () => [{ signature: 's', slot: 1, err: null, memo: null, blockTime: Math.floor((now - 500 * DAY) / 1000), confirmationStatus: 'finalized' }]);
    const r = await probeSignerActivity(client, { signers, nowMs: now, maxSigners: 5 });
    expect(r.probed).toBe(5);
    expect(r.of).toBe(11);
    expect(r.detail).toMatch(/5 of 11 signers were probed/);
  });
});

describe('the stale band scores, and refuses to double-count', () => {
  const mk = (over: Partial<DangerInputs['integrity']> & object) => scoreDanger({
    program: 'Pg11111111111111111111111111111111111111',
    authority: { posture: 'multisig', address: AUTH },
    delta: { confidence: 'structural', addedEntrypoints: [], undeclaredEntrypoints: [], accountChanges: [] },
    radius: { direct: 1, transitive: 0, lamportsRouted: 0, usdPerSol: null, mintsTouched: 0 },
    behavior: { priorDigestAt: '2026-09-01T00:00:00.000Z', stateFileUsed: true },
    integrity: { funding: null, declaredThreshold: null, timelockDeclared: false, fundingProbe: null, suspectAddressesSeen: 0, ...over },
    timing: null,
  } as DangerInputs).axes.find((a) => a.id === 'authorityIntegrity')!;
  const sa = (state: 'stale' | 'active' | 'unverified') => ({ state, detail: `most recent signer activity is 400 day(s) old`, probed: 2, of: 2 });

  it('lifts a timelocked high-threshold multisig out of the 0-point case when its keys have not moved', () => {
    const clean = mk({ quorum: { m: 5, n: 9 }, timelockDeclared: true, signerActivity: sa('active') });
    const cold = mk({ quorum: { m: 5, n: 9 }, timelockDeclared: true, signerActivity: sa('stale') });
    expect(clean.points).toBe(0);
    expect(cold.points).toBe(10);
    expect(cold.label).toMatch(/signer set reads as stale/);
  });

  it('adds nothing to a low threshold that already earns the band, because the brief puts both in it', () => {
    const alone = mk({ quorum: { m: 2, n: 3 }, signerActivity: sa('active') });
    const both = mk({ quorum: { m: 2, n: 3 }, signerActivity: sa('stale') });
    expect(alone.points).toBe(10);
    expect(both.points).toBe(10);
    expect(both.detail.join(' ')).toMatch(/also reads as idle/);
  });

  it('leaves the score where it was when the read was unverified, and says so', () => {
    const a = mk({ quorum: { m: 5, n: 9 }, timelockDeclared: true, signerActivity: { state: 'unverified', detail: 'no signer activity could be read', probed: 2, of: 2 } });
    expect(a.points).toBe(0);
    expect(a.notAssessed.join(' ')).toMatch(/adds no points|not established either way/);
  });

  it('names the truncation when only part of the set was read', () => {
    const a = mk({ quorum: { m: 5, n: 9 }, timelockDeclared: true, signerActivity: { state: 'stale', detail: 'x', probed: 5, of: 9 } });
    expect(a.notAssessed.join(' ')).toMatch(/only 5 of 9 signers were read/);
  });
});

describe('the --check-signers wiring', () => {
  // A source-shape guard, not a behaviour test: `src/cli/index.ts` runs program.parseAsync at import,
  // so the three places that construct a Scout cannot be executed from a test. This one was written
  // after a mechanical edit produced `...(o.checkFunding ? { checkSigners: true } : {})` — valid types,
  // a flag that could never be set, and a suite that stayed green.
  it('passes each flag under its own name at every construction site', () => {
    const src = readFileSync(new URL('../src/cli/index.ts', import.meta.url), 'utf8');
    // Only the flags that follow the same-name spread form. Others legitimately rename an option
    // (`--timelock` -> timelockDeclared, `--suspect` -> suspectAddresses), and asserting otherwise would just
    // encode today's spelling.
    for (const flag of ['checkFunding', 'checkSigners']) {
      const spread = new RegExp(`\\.\\.\\.\\((?:o|opts)\\.${flag} \\? \\{ ${flag}: `, 'g');
      const sites = src.match(spread) ?? [];
      expect(sites.length, `--${flag} is not threaded into any Scout construction`).toBeGreaterThan(0);
      // And no site may set it from a different flag's condition.
      const wrong = src.match(new RegExp(`\\.\\.\\.\\((?:o|opts)\\.(?!${flag}\\b)\\w+ \\? \\{ ${flag}: `, 'g')) ?? [];
      expect(wrong, `${flag} is being set from another option's condition: ${wrong.join(' | ')}`).toEqual([]);
    }
    expect(src).toMatch(/--check-signers/);
  });
});
