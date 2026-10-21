import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { PublicKey } from '@solana/web3.js';
import { inspectProgramLimits, renderProgramLimits, type ProbeInput } from '../src/commands/perProgram.js';
import { LIMIT_NOTES } from '../src/limits.js';
import { Budget } from '../src/agent/budget.js';
import { SolanaClient } from '../src/rpc/client.js';
import { deriveProgramData } from '../src/state/programdata.js';
import { FakeTransport, type FakeRoute, txFixture } from './helpers.js';

const PROGRAM = '5PjDJaGfSPJj4tFzMRCiuuAasKg5n8dJKXKenhuwZexx';
const PD = deriveProgramData(PROGRAM);

const programDataAccount = (over: { exists?: boolean; authority?: string | null } = {}) => {
  const auth = over.authority === undefined ? new PublicKey('FnSCQX1CYdGkGgd7RSScZzVij7nfKhYK5VcjaAozv3d5') : over.authority === null ? null : new PublicKey(over.authority);
  return {
    context: { slot: 459_700_100 },
    value: over.exists === false
      ? null
      : {
          lamports: 12_633_600,
          owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
          executable: false,
          rentEpoch: null,
          data: [
            Buffer.concat([
              Buffer.from([3, 0, 0, 0]),
              (() => {
                const b = Buffer.alloc(8);
                b.writeBigUInt64LE(423_977_638n);
                return b;
              })(),
              Buffer.from([1]),
              auth ? auth.toBuffer() : Buffer.alloc(32),
              Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4, ...new Array(56).fill(9)]),
            ]).toString('base64'),
            'base64',
          ],
        },
  };
};

/** The Program account holds the ProgramData address; the pointer check reads those bytes. */
const programAccount = (pointsAt: string | null) => ({
  context: { slot: 459_700_100 },
  value: {
    lamports: 2_259_200,
    owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
    executable: true,
    rentEpoch: null,
    data: [Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.alloc(8), pointsAt ? new PublicKey(pointsAt).toBuffer() : Buffer.alloc(32)]).toString('base64'), 'base64'],
  },
});

const sigsRoute = (n: number) => ({
  match: (m: string) => m === 'getSignaturesForAddress',
  result: Array.from({ length: n }, (_, i) => ({ signature: `probe${i}sig`, slot: 459_700_000 - i, err: null, blockTime: 1_760_000_000, confirmationStatus: i === 0 ? 'finalized' : 'confirmed' })),
});

function harness(
  routes: FakeRoute[],
  over: Partial<Pick<ProbeInput, 'endpointCount' | 'idl' | 'knownMultisigs'>> & { maxRpcCalls?: number } = {},
) {
  const transport = new FakeTransport(routes);
  const budget = new Budget({ maxRpcCalls: over.maxRpcCalls ?? 20, maxSignatures: 20, maxLlmTokens: 0, maxWallMs: 600_000 });
  const client = new SolanaClient({ transport, budget, commitment: 'finalized' });
  return { transport, budget, client, over };
}

async function probe(routes: FakeRoute[], over: Parameters<typeof harness>[1] = {}) {
  const h = harness(routes, over);
  const p = await inspectProgramLimits({
    client: h.client,
    budget: h.budget,
    program: PROGRAM,
    endpointCount: h.over.endpointCount ?? 1,
    ...(h.over.idl ? { idl: h.over.idl } : {}),
    knownMultisigs: h.over.knownMultisigs ?? [],
  });
  return { p, h };
}

const base = (extra: FakeRoute[] = []): FakeRoute[] => [
  { match: (m, params) => m === 'getAccountInfo' && params[0] === PD, result: programDataAccount() },
  { match: (m, params) => m === 'getAccountInfo' && params[0] === PROGRAM, result: programAccount(PD) },
  sigsRoute(1),
  { match: (m) => m === 'getTransaction', result: txFixture('tx-depth3') },
  ...extra,
];

const row = (p: Awaited<ReturnType<typeof probe>>['p'], code: string) => p.rows.find((r) => r.code === code)!;

describe('the per-program probe covers the catalogue exactly once', () => {
  it('emits one row for every documented limit code, and no invented ones', async () => {
    const { p } = await probe(base());
    const codes = p.rows.map((r) => r.code);
    expect(codes).toHaveLength(LIMIT_NOTES.length);
    expect(new Set(codes).size).toBe(LIMIT_NOTES.length);
    for (const note of LIMIT_NOTES) expect(codes).toContain(note.code);
    // The counts are derived from the rows, so a row that fell through both would show up here.
    expect(Object.values(p.counts).reduce((a, b) => a + b, 0)).toBe(p.rows.length);
  });

  it('borrows the way-out text from the catalogue instead of restating it', async () => {
    const { p } = await probe(base());
    for (const note of LIMIT_NOTES) {
      const r = row(p, note.code);
      expect(r.fix.length).toBeGreaterThan(10);
    }
  });
});

describe('what the probe can actually decide about one program', () => {
  it('reports retention as probed-clean only as far as one probe reaches', async () => {
    const { p } = await probe(base());
    const r = row(p, 'HISTORY_RETENTION');
    expect(r.status).toBe('probe_clean');
    // The wording matters more than the status: a clean probe at the newest end says
    // nothing about the far edge, and the evidence column has to say that.
    expect(r.evidence).toMatch(/far edge/);
    expect(r.evidence).toContain('459700000');
    expect(p.cost.rpcCalls).toBeGreaterThan(0);
  });

  it('calls a -32015 refusal retention, applied, and names the code', async () => {
    const { p } = await probe([
      { match: (m, params) => m === 'getAccountInfo' && params[0] === PD, result: programDataAccount() },
      { match: (m, params) => m === 'getAccountInfo' && params[0] === PROGRAM, result: programAccount(PD) },
      { match: (m) => m === 'getSignaturesForAddress', error: { code: -32015, message: 'Block not available for the requested slot' } },
    ]);
    expect(row(p, 'HISTORY_RETENTION').status).toBe('applies');
    expect(row(p, 'HISTORY_RETENTION').evidence).toMatch(/-32015/);
  });

  it('calls a walk that failed for another reason not_probed, not retention', async () => {
    const { p } = await probe([
      { match: (m, params) => m === 'getAccountInfo' && params[0] === PD, result: programDataAccount() },
      { match: (m, params) => m === 'getAccountInfo' && params[0] === PROGRAM, result: programAccount(PD) },
      { match: (m) => m === 'getSignaturesForAddress', error: { code: -32603, message: 'boom' } },
    ]);
    expect(row(p, 'HISTORY_RETENTION').status).toBe('not_probed');
    expect(row(p, 'HISTORY_RETENTION').evidence).toMatch(/reason other than retention/);
  });

  it('treats a pruned newest signature as the window being gone', async () => {
    const { p } = await probe([...base().filter((r) => !r.match('getTransaction', [])), { match: (m) => m === 'getTransaction', result: null }]);
    expect(row(p, 'HISTORY_RETENTION').status).toBe('applies');
    expect(row(p, 'HISTORY_RETENTION').evidence).toMatch(/already unreadable/);
  });

  it('sees an empty signature list as ambiguous, not as a clean result', async () => {
    const { p } = await probe([...base().filter((r) => !r.match('getSignaturesForAddress', [])), sigsRoute(0)]);
    expect(row(p, 'HISTORY_RETENTION').status).toBe('not_probed');
    expect(row(p, 'HISTORY_RETENTION').evidence).toMatch(/indistinguishable/);
  });

  it('confirms the ProgramData pair from the program side', async () => {
    const { p } = await probe(base());
    expect(row(p, 'PROGRAMDATA_REVERSE_LOOKUP').status).toBe('probe_clean');
    expect(p.observed.pointerMatches).toBe(true);
  });

  it('says so when the Program account points at a different ProgramData', async () => {
    const other = deriveProgramData('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    // FakeTransport answers from the first matching route, so the standing Program route has
    // to go — a test that appended a lie and still read the truth would pass for nothing.
    const routes = base().filter((r) => !r.match('getAccountInfo', [PROGRAM]));
    const { p } = await probe([...routes, { match: (m, params) => m === 'getAccountInfo' && params[0] === PROGRAM, result: programAccount(other) }]);
    const r = row(p, 'PROGRAMDATA_REVERSE_LOOKUP');
    expect(r.status).toBe('applies');
    expect(r.evidence).toMatch(/not the pair the chain executes/);
  });

  it('reports a missing ProgramData as a limit about this program, not a gap in the probe', async () => {
    const { p } = await probe([
      { match: (m, params) => m === 'getAccountInfo' && params[0] === PD, result: programDataAccount({ exists: false }) },
      { match: (m, params) => m === 'getAccountInfo' && params[0] === PROGRAM, result: programAccount(PD) },
      sigsRoute(0),
    ]);
    expect(p.observed.programDataExists).toBe(false);
    expect(p.posture).toBeNull();
    expect(row(p, 'PROGRAMDATA_REVERSE_LOOKUP').status).toBe('applies');
  });

  it('reads CPI depth off the transaction shape, not off the spec', async () => {
    const withStack = await probe(base());
    expect(row(withStack.p, 'CPI_DEPTH_ATTRIBUTION').status).toBe('probe_clean');
    const fixture = txFixture('tx-depth3');
    for (const i of [...fixture.transaction.message.instructions, ...(fixture.meta?.innerInstructions ?? []).flatMap((g) => g.instructions)]) delete (i as { stackHeight?: number }).stackHeight;
    const without = await probe([...base().filter((r) => !r.match('getTransaction', [])), { match: (m) => m === 'getTransaction', result: fixture }]);
    expect(row(without.p, 'CPI_DEPTH_ATTRIBUTION').status).toBe('applies');
    expect(row(without.p, 'CPI_DEPTH_ATTRIBUTION').evidence).toMatch(/log pairing/);
  });

  it('answers the IDL question three different ways depending on what was asked', async () => {
    const notProbed = await probe(base());
    expect(row(notProbed.p, 'NO_IDL_CONTRACT').status).toBe('not_probed');
    const absent = await probe(base(), { idl: 'absent' });
    expect(row(absent.p, 'NO_IDL_CONTRACT').status).toBe('applies');
    const found = await probe(base(), { idl: 'found' });
    expect(row(found.p, 'NO_IDL_CONTRACT').status).toBe('probe_clean');
  });

  it('refuses to call an unaffordable probe clean', async () => {
    // The anti-flattery case: with 1 call the signature walk never happens, and the table
    // must degrade to not_probed rather than implying anything was checked.
    const { p } = await probe(base(), { maxRpcCalls: 1 });
    expect(row(p, 'HISTORY_RETENTION').status).toBe('not_probed');
    expect(row(p, 'CPI_DEPTH_ATTRIBUTION').status).toBe('not_probed');
    expect(p.cost.refused).toMatch(/budget exhausted/);
    expect(p.counts.probe_clean).toBeLessThan(p.rows.length);
  });

  it('makes single-endpoint trust a limit that applies, and two endpoints a probed claim', async () => {
    const one = await probe(base(), { endpointCount: 1 });
    expect(row(one.p, 'SINGLE_NODE_TRUST').status).toBe('applies');
    const two = await probe(base(), { endpointCount: 2 });
    expect(row(two.p, 'SINGLE_NODE_TRUST').status).toBe('probe_clean');
    // Corroboration of a *mutable* account is out of reach over RPC whatever the count, and
    // the row says which of the two failures it is.
    const c = row(two.p, 'ENDPOINT_CORROBORATION');
    expect(c.status).toBe('applies');
    expect(c.evidence).toMatch(/minContextSlot/);
  });

  it('records the posture it read, and the account it read it from', async () => {
    const { p } = await probe(base());
    expect(p.posture).toBe('eoa');
    expect(p.programData).toBe(PD);
    expect(p.slot).toBe(459_700_100);
    expect(p.observed.bytecodeLen).toBeGreaterThan(0);
    expect(p.cost.rpcCalls).toBeLessThanOrEqual(4);
  });

  it('honours a declared multisig instead of guessing one from a curve check', async () => {
    const auth = 'FnSCQX1CYdGkGgd7RSScZzVij7nfKhYK5VcjaAozv3d5';
    const { p } = await probe(base([{ match: (m, params) => m === 'getAccountInfo' && params[0] === PD, result: programDataAccount({ authority: auth }) }]), {
      knownMultisigs: [auth],
      endpointCount: 1,
    });
    expect(p.posture).toBe('multisig');
  });
});

describe('the table renders what was measured, in the order a reader needs', () => {
  it('leads with the limits that apply and keeps the caveat line attached', async () => {
    const { p } = await probe([...base().filter((r) => !r.match('getSignaturesForAddress', [])), { match: (m) => m === 'getSignaturesForAddress', error: { code: -32015, message: 'no history' } }], {
      endpointCount: 1,
    });
    const md = renderProgramLimits(p);
    expect(md).toContain(`# Limits that apply to ${PROGRAM}`);
    expect(md).toContain('**applies**');
    const firstStatus = md.split('\n').find((l) => l.startsWith('| `'))!;
    expect(firstStatus).toContain('applies');
    expect(md).toMatch(/probe_clean` is the narrowest claim/);
    expect(md).toContain('-32015');
    expect(md).toContain(`Probed with ${p.cost.rpcCalls} RPC call(s)`);
  });

  it('keeps the remedy column short enough to read, and says where the long version is', async () => {
    const { p } = await probe(base());
    const md = renderProgramLimits(p);
    const cells = md
      .split('\n')
      .filter((l) => l.startsWith('| `'))
      .map((l) => l.split('|').at(-2)!.trim());
    expect(cells.length).toBe(p.rows.length);
    // The catalogue's own fix strings run to paragraphs; a per-program table that pastes
    // them turns one measured column into a wall.
    expect(Math.max(...cells.map((c) => c.length))).toBeLessThan(140);
    expect(md).toContain('Full remedy text');
  });

  it('names a refused probe in the header rather than hiding it in a row', async () => {
    const { p } = await probe(base(), { maxRpcCalls: 1 });
    const md = renderProgramLimits(p);
    expect(md).toMatch(/Refused: .*budget exhausted/);
  });
});
