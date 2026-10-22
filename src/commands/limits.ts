import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { LIMIT_NOTES, type LimitCode, type LimitNote } from '../limits.js';

/**
 * Three states, not two.
 *
 * A limit that reads `RESOLVED` when the chain still cannot answer the question is
 * worse than an open limit, because it tells the next reviewer to stop looking. So
 * the taxonomy separates "a bug we fixed" from "a surface we made smaller" from
 * "a property of the network that no code in this repo can change". The third
 * category is where most of Dot lives, and saying so out loud is the point of the
 * file rather than an admission.
 *
 * Every `RESOLVED` entry names test files, and `test/limits-status.test.ts` asserts
 * they exist and that the assertions they contain are real. A `RESOLVED` with a
 * missing test is a bug in this file.
 */

export type LimitState = 'RESOLVED' | 'NARROWED' | 'UNRESOLVABLE_IN_CODE';

export type LimitStatus = {
  code: LimitCode;
  state: LimitState;
  /** What the code now does, for RESOLVED; what got smaller, for NARROWED. */
  change: string;
  /** What still cannot be answered. Non-empty for NARROWED and UNRESOLVABLE. */
  remains: string;
  /** Test files that prove the claim. Required for RESOLVED. */
  tests: string[];
  /** The escape route, including the ones that cost money or a different transport. */
  fix?: string;
  /** Where a plan asked for a different state and this file says no, and why. */
  deviation?: string;
};

export const LIMIT_STATUS: LimitStatus[] = [
  {
    code: 'NO_CHAIN_WIDE_UPGRADE_SUBSCRIPTION',
    state: 'NARROWED',
    change:
      'src/rpc/yellowstone.ts subscribes by owner over Geyser, so every ProgramData write on the cluster can be observed with no target list and no JSON-RPC polling. The wire format is proven against real captured ProgramData bytes — committed as `test/fixtures/yellowstone-frame.bin` and decoded from disk by the suite — and the connect/subscribe sequence is now correct.',
    remains:
      'The transport has never received a frame from a provider: no credential exists on this box, and six endpoints probed without one all failed with one opaque native string (docs/blocked.md §3). Core JSON-RPC still cannot do this either way, and the live test in test/yellowstone-live.test.ts is skipped rather than passing when YELLOWSTONE_ENDPOINT is unset — so calling this RESOLVED would rest a green label on a file whose decisive test did not run.',
    tests: ['test/transports.test.ts', 'test/yellowstone-live.test.ts'],
    deviation:
      'The plan asked for this to be RESOLVED once the transport existed. It exists; what it has not done is receive anything. The state tracks the verification, not the code.',
    fix: 'Run against any Geyser provider, or run your own validator with the plugin.',
  },
  {
    code: 'ADDRESS_TABLE_RESOLUTION',
    state: 'RESOLVED',
    change:
      'src/graph/keys.ts handles both compositions — node-inlined lookupTable keys and static+loaded-writable+loaded-readonly — and reports which one it used, plus any index it could not place.',
    remains: 'A node that omits loadedAddresses entirely produces unresolvedIndexes rather than a wrong graph; the analysis is then partial and labelled.',
    tests: ['test/graph.test.ts', 'test/normalize.test.ts'],
  },
  {
    code: 'WEB3JS_JSONPARSED_VALIDATOR',
    state: 'RESOLVED',
    change:
      'Dot does not route reads through @solana/web3.js, so the StructError on parsed inner instructions cannot occur. The wire types in src/rpc/wire.ts model accounts as optional and stackHeight as present-optional.',
    remains: 'The upstream bug is unfixed and still bites anyone who follows the documented path; the repro is recorded in the limit note so it is not rediscovered.',
    tests: ['test/graph.test.ts', 'test/normalize.test.ts'],
    fix: 'Nothing in Dot to do. Upstream issue, not a Dot limitation.',
  },
  {
    code: 'FAILED_TRANSACTIONS_ROLLED_BACK',
    state: 'RESOLVED',
    change:
      'Failed frames and failed transactions are counted separately and contribute zero to every value field, so a rolled-back CPI cannot inflate routed value.',
    remains: 'A CPI that failed inside a successful transaction proves attempted integration, not intent; that inference is still a human call.',
    tests: ['test/graph.test.ts'],
  },
  {
    code: 'ENDPOINT_CORROBORATION',
    state: 'RESOLVED',
    change:
      'ResilientClient compares same-slot reads and returns five distinct verdicts (agreed / disagreed / slot_mismatch / single_source / both_failed), and the verdict is carried in every report rather than only on a halt.',
    remains: 'Two endpoints from the same provider agreeing is not corroboration. Dot records endpoint labels but cannot tell you they share an upstream.',
    tests: ['test/transports.test.ts', 'test/scout.test.ts'],
    fix: 'Use endpoints from different providers, not just different URLs.',
  },
  {
    code: 'GRPC_LIVE_PATH_UNREACHABLE',
    state: 'NARROWED',
    change:
      'The message shape is no longer assumed and it is now a committed artifact: `test/fixtures/yellowstone-frame.bin` is what the package’s own codec produces for a captured mainnet ProgramData account, and the suite decodes it from disk byte-for-byte (regenerate with `npx tsx scripts/gen-geyser-frame.ts`). The feed opens the channel before it subscribes (measured: without `connect()` the v9 client throws locally in ~1ms with a message that reads like a provider outage), bounds a connect that never settles, and survives a frame it cannot decode — measured 2026-10-22, a truncated frame threw `premature EOF` out of the data handler, which kills a watcher silently instead of noisily; it is now counted in `statsView().malformed` with the reason kept.',
    remains:
      'No provider has ever delivered a frame to this build. Re-probed 2026-10-22 (`npx tsx scripts/probe-geyser.ts`): two hosts refused at `stage: subscribe`, three resolved the subscribe and sent nothing for a full minute, and a host with no Geyser service at all behaved exactly like the silent three — as did rpcpool with an obviously invalid token. So auth-missing, service-absent and filter-matches-nothing are three-way indistinguishable from the client, and a `connected: true` with flat `updates` is not evidence of a live feed. isReplay, keepalive and reconnect remain unexercised in the field, as does `--authority` server-side filtering against a real node.',
    tests: ['test/yellowstone-live.test.ts'],
    fix: 'Set YELLOWSTONE_ENDPOINT (and YELLOWSTONE_TOKEN) to run the gated live test, then read feed.statsView() against a real stream. docs/blocked.md §3 has the hostnames and the reproduction command.',
  },
  {
    code: 'PRE_DEPLOY_PARTIAL',
    state: 'NARROWED',
    change:
      'STAGED_UPGRADE fires when a loader Buffer account receives an image that is not what is live, with bytecode hash, size, offset and staging authority; STAGED-NOOP fires when the bytes already match production; landing attributes the staged image by bytecode-hash match.',
    remains:
      'Dot sees that an image exists, not what it does — an IDL pair can narrow that, and only if the publisher released one. A Buffer account names no program, so attribution is deferred until the bytes land. There is no protocol-level timelock to read, so finalizeEta is immediate_unless_governed unless an operator declares a delay.',
    tests: ['test/predeploy.test.ts'],
    deviation:
      'The plan called for this to be marked RESOLVED. It is not: the semantic content of a staged image is still invisible, and reporting a staged upgrade as fully analysed would be exactly the false all-clear this taxonomy exists to prevent.',
  },
  {
    code: 'HISTORY_RETENTION',
    state: 'UNRESOLVABLE_IN_CODE',
    change:
      'Dot cannot fix this and does not pretend to. Retention is a BigTable/provider decision; the only thing code can do is classify `-32015` as missing history instead of as a fetch error, and cap the tier on it.',
    remains:
      'Any graph built after the fact is built from what a node happened to keep. A program can look dependency-free because its integrators’ traces are gone.',
    tests: ['test/scout.test.ts'],
    fix:
      'Deployment, not code: run Dot continuously and persist its own graph, or buy an archive-node endpoint. A `dot cache --warm` prefetch was proposed and is **not implemented in this build** — do not cite it.',
  },
  {
    code: 'VALUE_IS_PROXY',
    state: 'UNRESOLVABLE_IN_CODE',
    change: 'Value is attributed to the accounts a call touched, counted once on the receiving side, and reported per transaction with its ceiling stated.',
    remains:
      'Nothing in the RPC response binds a transfer to a CPI leg. A router swap touching six accounts cannot be split, so no per-edge settlement figure exists to be computed.',
    tests: ['test/graph.test.ts'],
    fix: 'An instrumented node or an indexer that stores instruction-level balance diffs. Not a Dot feature.',
  },
  {
    code: 'NO_IDL_CONTRACT',
    state: 'UNRESOLVABLE_IN_CODE',
    change: 'Without an interface Dot makes no semantic claim, and the report says `narrative.refused = "idl_unavailable"` rather than paraphrasing a bytecode diff.',
    remains: 'Solana has no mandatory IDL. A publisher who ships only a binary leaves nothing for any tool to read, in Dot or elsewhere.',
    tests: ['test/llm.test.ts'],
    fix: 'Operator supplies --idl and --prior-idl. That is the whole fix.',
  },
  {
    code: 'SINGLE_NODE_TRUST',
    state: 'NARROWED',
    change:
      '--secondary-rpc reads the load-bearing account from two endpoints at the same slot and halts on contradiction; each endpoint carries its own budget so a retry on one cannot spend the other’s.',
    remains:
      'Corroboration covers the one read that triggers the run. Trace fetches, signature walks and block reads still come from a single endpoint, which can filter or cache them without contradiction.',
    tests: ['test/transports.test.ts', 'test/scout.test.ts'],
    fix: 'Point every read at a quorum, or diff two full reports.',
  },
  {
    code: 'CPI_DEPTH_ATTRIBUTION',
    state: 'NARROWED',
    change:
      'stackHeight is used when present, the log tree when it is not, and the two are cross-checked — disagreement is reported as evidence a provider is filtering one view. Flat attribution still produces a graph but is labelled as an upper bound.',
    remains:
      'Both sources are optional on the wire and the log collector truncates, so a deep call chain on a filtered node can still be flattened. Guaranteed depth-agnostic capture needs a transaction-level feed or an instrumented validator.',
    tests: ['test/normalize.test.ts'],
  },
  {
    code: 'PARSED_INSTRUCTION_ACCOUNTS',
    state: 'NARROWED',
    change:
      'Parsed instructions have no accounts array, so the key table is searched inside parsed.info and every frame records accountSource: accounts | parsed_info | none. Heuristic-derived numbers cannot outlive their tag.',
    remains: 'Field naming inside parsed.info is inconsistent across programs, so recovery is best-effort; an instruction that names no recoverable account contributes no value.',
    tests: ['test/normalize.test.ts', 'test/graph.test.ts'],
  },
  {
    code: 'SIGNATURE_INDEX_IS_KEY_BASED',
    state: 'NARROWED',
    change:
      'The index returns transactions where the id appears in any role; Dot only credits a program with a call it actually executed, and reports sampleCoverage so noise in the window is visible.',
    remains:
      'A sample can still be dominated by transactions where the id is a mint or a token account, which lowers coverage rather than producing a wrong edge.',
    tests: ['test/scout.test.ts'],
  },
  {
    code: 'BYTECODE_SCAN_BLIND_ON_COMPILED_IMAGES',
    state: 'NARROWED',
    change:
      'The assumption was tested instead of asserted, it failed, and the failure is now repaired rather than documented. With the Solana toolchain on this box a compiled image holding ten `[u8; 8]` discriminators yields **0 of 10** contiguous selectors, and a program built with anchor-lang 0.30.1 yields **0 of 6** contiguous and 0 of 6 four-byte halves — the constants are split across a `mov32`+SBF-`hor64` immediate pair, or dissolved into a byte-wise compare tree. `src/state/sbfSelectors.ts` parses the ELF section table, walks `.text` as eBPF and recovers both shapes: **10 of 10** on the committed compiled fixture (all via the immediate pair), **6 of 6** on the anchor-lang 0.30.1 program (all via the compare chain), and **0 of 30** on names neither program implements — a candidate is reported only when it equals a hash the IDL supplied, so a misdecode costs a miss and never a false claim. `diffBytecode` now reports `structural` with a real entrypoint set on images where the old sweep returned nothing.',
    remains:
      'Two emission shapes are demonstrated; a compiler is free to choose others. A jump table or a binary search over `data[0]` would not produce the consecutive-compare run the compare-chain rule requires, and a `match` lowered onto values wider than a byte would drop out of the stream entirely — both then surface as "not located", capped by `confidence: "unscannable"`, not as an absent handler. The chain rule pairs the arm body (data[1..8]) with a leading-byte compare emitted ~87 instructions earlier by the outer switch, so a location there is an arm-plus-dispatch pair, not one contiguous test, and `via` is carried into the report to say so. One real anchor-lang program, six instructions, built locally: the numbers are not a corpus.',
    tests: ['test/bytecode.test.ts'],
    deviation:
      'The plan treated this item as "unvalidated, pending a toolchain", then as a named defect once the toolchain refuted the assumption. Both were under-described: the defect was in Dot\'s decoder, not in the bytecode. It stayed NARROWED when the fix landed because the fix is proven on two images, not on a corpus, and a taxonomy that gains RESOLVED as soon as code works is marketing — the residual is a claim about coverage, which is what NARROWED means here.',
    fix: 'npx vitest run test/bytecode.test.ts (uses test/fixtures/sbf-dispatch.so), or DOT_TEST_SO=program.so DOT_TEST_IDL=idl.json npx vitest run test/bytecode.test.ts for any real artifact. Wider coverage is a sampling job: run the gated check against published mainnet programs and report the fraction located.',
  },
  {
    code: 'DANGER_RANKING_UNMEASURED_INPUTS',
    state: 'NARROWED',
    change:
      'The ranking reports its own gaps in the number rather than around it. An axis with no data is `null`, not 0, so a run that never built a graph does not collect 0 blast-radius points and a clean-looking total; `coverage` prints how many of the 120 possible axis points were measurable; `rawScore` is kept next to the 100 clamp because the axes sum to 120 and a reader is entitled to know that several were maxed out; and CRITICAL is withheld outright when any axis was unmeasured (`test/danger.test.ts` pins the clamp and the withholding). The three unanswerable sub-claims — multisig threshold, ecosystem-event proximity, routed token value — are each declared inside the axis that could not use them.',
    remains:
      'A 1-of-2 multisig and a 5-of-9 multisig score identically, because Dot does not decode the multisig account. Token-heavy programs are ranked on lamports alone: the graph knows which mints were touched and not how much. "First upgrade observed" is bounded by how long `--state` has been running, which for a program Dot was pointed at yesterday is not a statement about its history at all. And the score is a queue position derived from posture and volume — it is not a vulnerability claim, and a LOW is a statement about the evidence Dot was allowed to gather.',
    tests: ['test/danger.test.ts', 'test/scout.test.ts'],
    fix: 'Decode the authority account for its threshold, accept an operator-declared incident window instead of inventing one, and route token deltas from an indexer. docs/limits.md (dot limits) carries the row; the module header in src/score/danger.ts carries the reasoning.',
  },
  {
    code: 'PROGRAMDATA_REVERSE_LOOKUP',
    state: 'NARROWED',
    change:
      'ProgramIndex resolves a ProgramData address to its program three ways and stamps which one worked: observed pointer accounts (free), the writing transaction plus local PDA re-derivation (one call, exact), or a reverse getProgramAccounts scan.',
    remains:
      'A fresh daemon with no pointer history and a provider that gates getProgramAccounts can still see an upgrade it cannot name. Those events are counted in `unresolved`, never guessed at.',
    tests: ['test/transports.test.ts'],
  },
  {
    code: 'BLOCK_FETCH_AMPLIFICATION',
    state: 'UNRESOLVABLE_IN_CODE',
    change:
      'A block contains every transaction in the slot. Dot prices this explicitly: the plan prints callSavingRatio and byteAmplification together, refuses oversized blocks, and only batches when calls genuinely bind. The inputs are now measured, not guessed — `docs/calibrated-model-2026-10-21.json` came out of `dot calibrate` against mainnet (506 tx/block, 18,040 bytes per fetched transaction) and `test/calibrate.test.ts` asserts the plan uses it.',
    remains:
      'No encoding choice makes a block smaller than the block. Bandwidth-bound backfills need a filtered feed or an indexer, not a better getBlock call. The measurement is one endpoint on one day: block sizes vary by an order of magnitude between slots, so a deployment should re-run calibrate against its own provider.',
    tests: ['test/ingest.test.ts', 'test/calibrate.test.ts'],
    fix: 'dot calibrate --rpc <url> replaces the labelled defaults with your endpoint’s real sizes; --cost-model <file> or DOT_COST_MODEL supplies it.',
  },
  {
    code: 'FEED_BACKPRESSURE',
    state: 'UNRESOLVABLE_IN_CODE',
    change:
      'A finite budget against an unbounded event stream means some events are not analysed. Dispatcher serves authority handovers first, drains serially, and exposes dropped by reason.',
    remains: 'Raising maxPerEvent or maxRpcCalls moves the ceiling; it does not remove it. An unbounded daemon is an unbudgeted bill.',
    tests: ['test/ingest.test.ts'],
    fix: 'More daily RPC, or a narrower --authority filter.',
  },
  {
    code: 'FINALITY_VS_LATENCY',
    state: 'UNRESOLVABLE_IN_CODE',
    change: 'Reads default to finalized so a persisted graph cannot be reorged out from under itself, and the latency cost is named in the report.',
    remains:
      'Detecting an exploit in progress costs minutes. There is no commitment level that is both safe to persist and immediate.',
    tests: [],
    fix: '--commitment confirmed trades reorg safety for latency. Never processed for a persisted graph.',
  },
  {
    code: 'NO_MALICE_DETECTION',
    state: 'UNRESOLVABLE_IN_CODE',
    change: 'A tier is printed as a queue position with its components exposed, and every report ends with a sentence saying a low tier is a statement about evidence.',
    remains:
      'Deciding whether an upgrade is hostile requires intent: repository, governance discussion, who signed. Dot ranks attention; it never adjudicates.',
    tests: ['test/risk.test.ts'],
  },
  {
    code: 'PDA_HOLDINGS_NOT_ENUMERATED',
    state: 'NARROWED',
    change:
      'Routed value is still labelled as routed, never as custody. Additionally `--seeds` now derives PDAs from an operator-declared seed list, reads them in getMultipleAccounts chunks of up to 100, and sums lamports and raw token units per mint, with typed seed encodings (u8:1 vs the character "1") handled explicitly. The path is exercised against mainnet, not only against fixtures: `seeds-live.json` derives seven patterns, five resolve to accounts the chain named, one is a well-formed address holding nothing, one is an unresolvable `$user`, and the run summed 1,042,041,147,090 lamports and 986,570,981,170 raw units of `So1111…1112` in one batched call (`docs/live-seeds-2026-10-21.json`).',
    remains:
      'Only declared patterns are read. The seeds live in the deployment repo and a publisher who does not share them has, by construction, no observable custody — `unresolvedSeeds`, `accountsEmpty` and `complete:false` are reported so an absent figure is never shown as a zero one. No USD value is printed: there is no price oracle. And the figure is a snapshot: three of the five accounts in that live run belong to active traders, and a batched sum compared against individual reads a second later differed by 1,041,968 lamports — a trade, not a bug, which is why the exact-equality assertion in `test/seeds-live.test.ts` is made against ProgramData rent reserves, the accounts that cannot move except by upgrade.',
    tests: ['test/seeds.test.ts', 'test/seeds-live.test.ts'],
    fix: 'Publish the seed patterns in the deployment repo, or use an indexer/DAS API for programs that will not.',
  },
];

export function statusFor(code: LimitCode): LimitStatus | undefined {
  return LIMIT_STATUS.find((s) => s.code === code);
}

export function countStates(): Record<LimitState, number> {
  return {
    RESOLVED: LIMIT_STATUS.filter((s) => s.state === 'RESOLVED').length,
    NARROWED: LIMIT_STATUS.filter((s) => s.state === 'NARROWED').length,
    UNRESOLVABLE_IN_CODE: LIMIT_STATUS.filter((s) => s.state === 'UNRESOLVABLE_IN_CODE').length,
  };
}

/** Codes that exist in the catalogue but have no status entry, and vice versa. */
export function auditCoverage(): { missingStatus: LimitCode[]; orphanStatus: LimitCode[] } {
  const codes = LIMIT_NOTES.map((n) => n.code);
  const statuses = LIMIT_STATUS.map((s) => s.code);
  return {
    missingStatus: codes.filter((c) => !statuses.includes(c)),
    orphanStatus: statuses.filter((c) => !codes.includes(c)),
  };
}

/**
 * A RESOLVED claim is only as good as the test behind it, so the check is
 * mechanical: the named file must exist, and must contain at least one `it(`.
 */
export async function verifyTestClaims(root: string): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  for (const s of LIMIT_STATUS) {
    if (s.state !== 'RESOLVED') continue;
    if (s.tests.length === 0) {
      problems.push(`${s.code}: RESOLVED with no test file named`);
      continue;
    }
    for (const t of s.tests) {
      const p = `${root}/${t}`;
      if (!existsSync(p)) {
        problems.push(`${s.code}: named test ${t} does not exist`);
        continue;
      }
      const src = await readFile(p, 'utf8');
      if (!/\bit\(/.test(src)) problems.push(`${s.code}: ${t} contains no it() — not a test`);
    }
  }
  return { ok: problems.length === 0, problems };
}

export function renderLimitStatus(opts: { state?: LimitState | null; note?: Map<LimitCode, LimitNote> } = {}): string {
  const counts = countStates();
  const L: string[] = [];
  L.push(
    `Limit status — ${counts.RESOLVED} RESOLVED, ${counts.NARROWED} NARROWED, ${counts.UNRESOLVABLE_IN_CODE} UNRESOLVABLE_IN_CODE (${LIMIT_STATUS.length} codes)`,
  );
  L.push('');
  const order: LimitState[] = ['RESOLVED', 'NARROWED', 'UNRESOLVABLE_IN_CODE'];
  for (const st of order.filter((x) => !opts.state || x === opts.state)) {
    L.push(`## ${st}`);
    for (const s of LIMIT_STATUS.filter((x) => x.state === st)) {
      L.push(`${s.code}`);
      L.push(`  ${st === 'RESOLVED' ? 'fixed' : st === 'NARROWED' ? 'narrowed' : 'not a code problem'}: ${s.change}`);
      if (s.remains) L.push(`  remains: ${s.remains}`);
      if (s.fix) L.push(`  fix:     ${s.fix}`);
      if (s.deviation) L.push(`  !deviation from plan: ${s.deviation}`);
      L.push(`  tests:   ${s.tests.length > 0 ? s.tests.join(', ') : '(none — this state does not claim a fix)'}`);
      L.push('');
    }
  }
  return L.join('\n');
}
