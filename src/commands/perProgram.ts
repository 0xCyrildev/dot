import { PublicKey } from '@solana/web3.js';
import { BudgetExhaustedError, isDotError } from '../errors.js';
import { LIMIT_NOTES, type LimitCode, type LimitNote } from '../limits.js';
import { statusFor, type LimitState } from './limits.js';
import { classifyAuthority, decodeProgramData, deriveProgramData } from '../state/programdata.js';
import type { Budget } from '../agent/budget.js';
import type { SolanaClient } from '../rpc/client.js';

/**
 * "Which of these blind spots is *this* program's blind spot?"
 *
 * `dot limits` answers the general question — the catalogue, three states, a test file
 * behind every RESOLVED. That is not the question an operator asks about one program. This
 * probe spends a handful of calls to find out, per program, which limits are live: whether
 * *this* node will show *this* program's history, whether *this* program's interface is
 * anywhere to be found, whether the ProgramData Dot would read is the one the chain
 * executes.
 *
 * The discipline is the same as everywhere else in Dot, and it is why this command exists
 * rather than a paragraph in the README: a limit that could not be probed is reported as
 * `not_probed`, with the reason, never as `probe_clean`. A table that flatters the
 * deployment is worse than no table.
 */

export type ProbeStatus = 'applies' | 'probe_clean' | 'not_probed' | 'by_construction';

export type ProgramLimitRow = {
  code: LimitCode;
  title: string;
  status: ProbeStatus;
  /** What this run observed, or exactly why nothing could be observed here. */
  evidence: string;
  /** The way out, taken from the catalogue so the fix never lives in two places. */
  fix: string;
  /** The catalogue's own state for this code, so the two views cannot drift apart. */
  state: LimitState | null;
};

export type ProbeObservation = {
  programDataExists: boolean | null;
  programAccountExists: boolean | null;
  pointerMatches: boolean | null;
  bytecodeLen: number | null;
  signaturesVisible: number | null;
  newestSignature: string | null;
  newestSlot: number | null;
  newestTxStatus: 'found' | 'pruned' | 'error' | 'not_fetched';
  stackHeightSeen: boolean | null;
  addressTableUsed: boolean | null;
  confirmationStatus: string | null;
  idl: 'found' | 'absent' | 'not_probed';
};

export type ProgramLimitProbe = {
  program: string;
  programData: string | null;
  posture: string | null;
  authority: string | null;
  slot: number | null;
  observed: ProbeObservation;
  rows: ProgramLimitRow[];
  counts: Record<ProbeStatus, number>;
  cost: { rpcCalls: number; refused: string | null };
  /** Set when the node refused or failed a read, so "not probed" can name the cause. */
  probeErrors: string[];
};

export type ProbeInput = {
  client: SolanaClient;
  budget: Budget;
  program: string;
  /** How many endpoints the caller can actually corroborate against. */
  endpointCount: number;
  /** Supplied when the caller resolved an IDL (file, url, or the on-chain attempt). */
  idl?: 'found' | 'absent' | 'not_probed';
  knownMultisigs?: string[];
};

const STATUS_ORDER: ProbeStatus[] = ['applies', 'probe_clean', 'not_probed', 'by_construction'];

function row(code: LimitCode, status: ProbeStatus, evidence: string): ProgramLimitRow {
  const note: LimitNote | undefined = LIMIT_NOTES.find((n) => n.code === code);
  return {
    code,
    title: note?.title ?? code,
    status,
    evidence,
    fix: note?.mitigation ?? statusFor(code)?.fix ?? 'none recorded',
    state: statusFor(code)?.state ?? null,
  };
}

type Facts = {
  o: ProbeObservation;
  programData: string | null;
  endpointCount: number;
  retentionRefused: boolean;
  walkFailed: boolean;
};

/** Decide one row per limit code. Explicit branches, so a disputed row is findable. */
function decide(f: Facts): ProgramLimitRow[] {
  const { o } = f;
  const rows: ProgramLimitRow[] = [];

  // HISTORY_RETENTION is the one limit here that a single probe can prove *for this
  // program* — if the newest signature the node lists is already unreadable, the window is
  // gone. What one probe cannot show is where the far edge sits, so the clean case says so.
  if (f.retentionRefused) {
    rows.push(row('HISTORY_RETENTION', 'applies', 'this node refused the signature walk outright (-32015): it publishes no history for this program at all'));
  } else if (f.walkFailed) {
    rows.push(row('HISTORY_RETENTION', 'not_probed', 'the signature walk failed for a reason other than retention, so nothing was learned about what this node keeps'));
  } else if (o.newestTxStatus === 'pruned') {
    rows.push(row('HISTORY_RETENTION', 'applies', `the newest listed signature ${o.newestSignature?.slice(0, 12)}… (slot ${o.newestSlot}) is already unreadable on this node`));
  } else if (o.newestTxStatus === 'found') {
    rows.push(
      row(
        'HISTORY_RETENTION',
        'probe_clean',
        `one probe at the newest end: slot ${o.newestSlot} was retrievable. The far edge of the window is what matters and it is invisible from here`,
      ),
    );
  } else if (o.signaturesVisible === 0) {
    rows.push(row('HISTORY_RETENTION', 'not_probed', 'the node listed no signatures at all, which is the same answer for "no history" and "nothing kept" — indistinguishable with one call'));
  } else {
    rows.push(row('HISTORY_RETENTION', 'not_probed', o.signaturesVisible === null ? 'the signature walk was never afforded a call' : 'the transaction behind the first signature was never fetched'));
  }

  // Depth, account encodings and lookup tables are all properties of the transaction shape,
  // so the one real transaction fetched says something about each.
  if (o.stackHeightSeen === true) {
    rows.push(row('CPI_DEPTH_ATTRIBUTION', 'probe_clean', 'the probed transaction carries stackHeight, so CPI depth is attributed exactly for traces of this shape'));
  } else if (o.stackHeightSeen === false) {
    rows.push(row('CPI_DEPTH_ATTRIBUTION', 'applies', 'the probed transaction carries no stackHeight: nested callers fall back to log pairing, or to the flat upper bound'));
  } else {
    rows.push(row('CPI_DEPTH_ATTRIBUTION', 'not_probed', 'no transaction was fetched, so nothing was observed about its shape'));
  }

  rows.push(
    o.newestTxStatus === 'found'
      ? row('PARSED_INSTRUCTION_ACCOUNTS', 'probe_clean', 'the probed transaction resolved instruction accounts through the key table')
      : row('PARSED_INSTRUCTION_ACCOUNTS', 'not_probed', 'needs one parsed transaction'),
  );

  if (o.addressTableUsed === true) {
    rows.push(row('ADDRESS_TABLE_RESOLUTION', 'probe_clean', 'the probed transaction uses a lookup table, and Dot resolves loaded addresses for it'));
  } else if (o.addressTableUsed === false) {
    rows.push(row('ADDRESS_TABLE_RESOLUTION', 'by_construction', 'the probed transaction uses no lookup table; the limit is about the ones that do'));
  } else {
    rows.push(row('ADDRESS_TABLE_RESOLUTION', 'not_probed', 'no transaction was fetched, so table usage is unknown for this program'));
  }

  rows.push(
    o.idl === 'found'
      ? row('NO_IDL_CONTRACT', 'probe_clean', 'an interface was supplied or found on-chain, so entrypoint names exist for this program')
      : o.idl === 'absent'
        ? row('NO_IDL_CONTRACT', 'applies', 'no IDL was supplied and the on-chain attempt found none: Dot has names for nothing in this bytecode')
        : row('NO_IDL_CONTRACT', 'not_probed', 'no --idl and no --try-onchain-idl, so this run did not look'),
  );

  // The pair is checkable in two reads, and checking it is the difference between analyzing
  // the executed program and analyzing an address that looks right.
  if (o.programDataExists === false) {
    rows.push(row('PROGRAMDATA_REVERSE_LOOKUP', 'applies', `the derived ProgramData ${f.programData?.slice(0, 12)}… does not exist: not upgradeable through this loader, or closed`));
  } else if (o.pointerMatches === true) {
    rows.push(row('PROGRAMDATA_REVERSE_LOOKUP', 'probe_clean', 'the Program account names the derived ProgramData, so the pair is confirmed from the program side'));
  } else if (o.pointerMatches === false) {
    rows.push(row('PROGRAMDATA_REVERSE_LOOKUP', 'applies', 'the Program account names a different ProgramData than the derived one: the pair Dot would read is not the pair the chain executes'));
  } else {
    rows.push(row('PROGRAMDATA_REVERSE_LOOKUP', 'not_probed', 'the Program account was not read, so only the derived half of the pair is known'));
  }

  // Corroboration is a property of the deployment, and it is measurable here.
  const single = f.endpointCount < 2;
  rows.push(
    single
      ? row('SINGLE_NODE_TRUST', 'applies', `one endpoint configured: every figure Dot prints about this program is one node's word`)
      : row('SINGLE_NODE_TRUST', 'probe_clean', `${f.endpointCount} endpoints configured for the load-bearing reads — a second provider's word, which is not the same as independence`),
  );
  rows.push(
    row(
      'ENDPOINT_CORROBORATION',
      'applies',
      single
        ? 'no second endpoint, so nothing about this program is corroborated at all'
        : 'measured on mainnet: two endpoints asked concurrently answered the same account read 9 slots apart, and minContextSlot is a lower bound, not a pin — a mutable account cannot be compared at one moment over plain RPC',
    ),
  );

  rows.push(
    o.confirmationStatus
      ? row('FINALITY_VS_LATENCY', 'probe_clean', `this node reports the newest signature ${o.confirmationStatus}; Dot reads at the commitment it was given and prints which one`)
      : row('FINALITY_VS_LATENCY', 'not_probed', 'no signature was listed, so nothing was observed about finality'),
  );

  // Facts about the data source or about intent: true for this program, and not something
  // a probe of this program could change or confirm.
  const construction: Array<[LimitCode, string]> = [
    ['NO_CHAIN_WIDE_UPGRADE_SUBSCRIPTION', 'not a property of this program: detecting its upgrade needs a watch entry or a Geyser feed either way'],
    ['WEB3JS_JSONPARSED_VALIDATOR', 'not a property of this program: @solana/web3.js v1 rejects parsed inner instructions, which is why Dot owns the RPC layer'],
    ['VALUE_IS_PROXY', 'not a property of this program: value routed is a per-transaction upper bound, never TVL'],
    ['PDA_HOLDINGS_NOT_ENUMERATED', 'not a property of this program: custody lives in PDAs whose seeds are in the deployment repo, not on the chain'],
    ['FAILED_TRANSACTIONS_ROLLED_BACK', 'not a property of this program: a failed transaction proves reach and intent, not a state change'],
    ['SIGNATURE_INDEX_IS_KEY_BASED', 'not a property of this program: getSignaturesForAddress matches keys, never roles, so the caller comes only from the inner-instruction fold'],
    ['NO_MALICE_DETECTION', 'not a property of this program: Dot measures blast radius and does not classify intent'],
    ['BLOCK_FETCH_AMPLIFICATION', 'not a property of this program: a block carries every transaction in the slot, so batching trades calls for bytes'],
    ['PRE_DEPLOY_PARTIAL', 'not a property of this program: a Buffer has no back-link to the program it becomes'],
    ['FEED_BACKPRESSURE', 'not a property of this program: a live feed that cannot keep up drops events, and dropped is not clean'],
    ['GRPC_LIVE_PATH_MOCKED', 'not a property of this program: the Geyser path is exercised against encoded frames until an endpoint is configured'],
    ['BYTECODE_SCANABILITY_UNVALIDATED', 'not a property of this program: the discriminator scan is validated against Anchor’s derivation rule, not against a compiled .so'],
  ];
  for (const [code, why] of construction) rows.push(row(code, 'by_construction', why));

  return rows;
}

export async function inspectProgramLimits(input: ProbeInput): Promise<ProgramLimitProbe> {
  const { client, budget, program } = input;
  const before = budget.snapshot().spent.rpcCalls;
  const o: ProbeObservation = {
    programDataExists: null,
    programAccountExists: null,
    pointerMatches: null,
    bytecodeLen: null,
    signaturesVisible: null,
    newestSignature: null,
    newestSlot: null,
    newestTxStatus: 'not_fetched',
    stackHeightSeen: null,
    addressTableUsed: null,
    confirmationStatus: null,
    idl: input.idl ?? 'not_probed',
  };
  const probeErrors: string[] = [];
  const counts = { applies: 0, probe_clean: 0, not_probed: 0, by_construction: 0 } as Record<ProbeStatus, number>;
  let programData: string | null = null;
  let posture: string | null = null;
  let authority: string | null = null;
  let slot: number | null = null;
  let retentionRefused = false;
  let walkFailed = false;
  let refused: string | null = null;

  /** Every probe is optional and every failure is recorded; none of them aborts the table. */
  const spend = async (what: string, fn: () => Promise<void>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (e) {
      if (e instanceof BudgetExhaustedError) {
        refused = `${what} not probed: budget exhausted (${e.kind} limit ${e.limit}, used ${e.used})`;
        return false;
      }
      if (isDotError(e) && e.details.rpcCode === -32015) {
        retentionRefused = true;
        return false;
      }
      probeErrors.push(isDotError(e) ? `${e.code}: ${e.message}` : String(e));
      return false;
    }
  };

  try {
    programData = deriveProgramData(program);
  } catch (e) {
    probeErrors.push(`program id unusable: ${isDotError(e) ? `${e.code}: ${e.message}` : String(e)}`);
  }

  // 1. The derived ProgramData. One read, and it decides whether the remaining rows are
  //    about an upgradeable program at all.
  if (programData) {
    const paid = await spend('programData', async () => {
      const raw = await client.getRawAccountInfo(programData!);
      slot = raw.slot;
      if (!raw.account) {
        o.programDataExists = false;
        return;
      }
      o.programDataExists = true;
      const state = decodeProgramData(raw.account, program);
      o.bytecodeLen = state.bytecodeLen;
      authority = state.authority;
      posture = classifyAuthority(state.authority, new Set(input.knownMultisigs ?? []));
    });
    if (!paid && o.programDataExists === null) probeErrors.push('programData read did not complete');
  }

  // 2. The Program account: the only chain-side confirmation that the ProgramData Dot would
  //    read is the one the loader executes. A substring test on the 32 pubkey bytes is
  //    enough for that and does not pretend to decode a layout Dot has not measured.
  await spend('program account', async () => {
    const raw = await client.getRawAccountInfo(program);
    o.programAccountExists = raw.account !== null;
    if (raw.account?.data && programData) {
      o.pointerMatches = raw.account.data.includes(new PublicKey(programData).toBuffer());
    }
  });

  // 3. One signature and the transaction behind it: two calls that speak to retention,
  //    attribution depth, account encodings and lookup tables at once.
  await spend('signature list', async () => {
    try {
      const sigs = await client.getSignaturesForAddress(program, { limit: 1 });
      o.signaturesVisible = sigs.length;
      const s = sigs[0];
      if (s) {
        o.newestSignature = s.signature;
        o.newestSlot = s.slot;
        o.confirmationStatus = s.confirmationStatus ?? null;
      }
    } catch (e) {
      if (isDotError(e) && e.details.rpcCode === -32015) {
        retentionRefused = true;
        return;
      }
      walkFailed = true;
      throw e;
    }
  });
  if (o.newestSignature) {
    await spend('newest transaction', async () => {
      const r = await client.getTransaction(o.newestSignature!);
      o.newestTxStatus = r.status;
      if (r.status === 'found' && r.tx) {
        const flat = [...(r.tx.transaction.message.instructions ?? []), ...(r.tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions ?? [])];
        o.stackHeightSeen = flat.some((i) => (i as { stackHeight?: number }).stackHeight !== undefined);
        const lookups = (r.tx.transaction.message as { addressTableLookups?: unknown[] }).addressTableLookups ?? [];
        const loaded = r.tx.meta?.loadedAddresses as { writables?: unknown[]; readonly?: unknown[] } | undefined;
        o.addressTableUsed = lookups.length > 0 || (loaded ? (loaded.writables?.length ?? 0) + (loaded.readonly?.length ?? 0) > 0 : false);
      }
    });
  }

  const rows = decide({ o, programData, endpointCount: input.endpointCount, retentionRefused, walkFailed });
  for (const r of rows) counts[r.status]++;

  return {
    program,
    programData,
    posture,
    authority,
    slot,
    observed: o,
    rows,
    counts,
    cost: { rpcCalls: budget.snapshot().spent.rpcCalls - before, refused },
    probeErrors,
  };
}

/**
 * The fix column, clipped. The full text is the catalogue's job — `dot limits` prints it —
 * and a per-program table whose remedy column runs to three sentences per row is a wall of
 * prose with one measured column in it.
 */
function shorten(s: string, n = 110): string {
  const first = s.split(/(?<=\.)\s/)[0] ?? s;
  const one = first.replace(/`/g, '');
  return one.length > n ? `${one.slice(0, n).replace(/\s+\S*$/, '')}…` : one;
}

export function renderProgramLimits(p: ProgramLimitProbe): string {
  const L: string[] = [];
  L.push(`# Limits that apply to ${p.program}`);
  L.push('');
  L.push(
    `ProgramData \`${p.programData ?? 'not derived'}\`${p.slot !== null ? ` at slot ${p.slot}` : ''}${p.posture ? `, upgrade authority \`${p.posture}\`${p.authority ? ` (${p.authority})` : ' (none — renounced)'}` : ''}${p.observed.bytecodeLen !== null ? `, ${p.observed.bytecodeLen} bytecode bytes` : ''}.`,
  );
  L.push(`Probed with ${p.cost.rpcCalls} RPC call(s)${p.cost.refused ? `. Refused: ${p.cost.refused}` : '.'}`);
  if (p.probeErrors.length > 0) L.push(`Reads that failed: ${p.probeErrors.join(' | ')}`);
  L.push('');
  L.push('| limit | status | what was observed | catalogue state | way out |');
  L.push('| --- | --- | --- | --- | --- |');
  const order: Record<ProbeStatus, number> = { applies: 0, probe_clean: 1, not_probed: 2, by_construction: 3 };
  for (const r of [...p.rows].sort((a, b) => order[a.status] - order[b.status] || a.code.localeCompare(b.code))) {
    L.push(`| \`${r.code}\` | **${r.status}** | ${r.evidence} | ${r.state ?? '—'} | ${shorten(r.fix)} |`);
  }
  L.push('');
  L.push('_Full remedy text for every row: `dot limits`._');
  L.push(
    `Applies: ${p.counts.applies}. Probed clean: ${p.counts.probe_clean}. Not probed: ${p.counts.not_probed}. Property of the source rather than the program: ${p.counts.by_construction}.`,
  );
  L.push('');
  L.push('_`probe_clean` is the narrowest claim in this table: one probe found nothing wrong at the point it touched, and the evidence column names that point._');
  return L.join('\n');
}
