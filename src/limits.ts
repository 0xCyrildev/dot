export type LimitCode =
  | 'HISTORY_RETENTION'
  | 'NO_CHAIN_WIDE_UPGRADE_SUBSCRIPTION'
  | 'CPI_DEPTH_ATTRIBUTION'
  | 'PARSED_INSTRUCTION_ACCOUNTS'
  | 'WEB3JS_JSONPARSED_VALIDATOR'
  | 'NO_IDL_CONTRACT'
  | 'VALUE_IS_PROXY'
  | 'PDA_HOLDINGS_NOT_ENUMERATED'
  | 'FAILED_TRANSACTIONS_ROLLED_BACK'
  | 'SIGNATURE_INDEX_IS_KEY_BASED'
  | 'ADDRESS_TABLE_RESOLUTION'
  | 'NO_PRE_DEPLOY_ANALYSIS'
  | 'FINALITY_VS_LATENCY'
  | 'SINGLE_NODE_TRUST'
  | 'NO_MALICE_DETECTION'
  | 'BLOCK_FETCH_AMPLIFICATION'
  | 'ENDPOINT_CORROBORATION'
  | 'PROGRAMDATA_REVERSE_LOOKUP'
  | 'FEED_BACKPRESSURE'
  | 'GRPC_LIVE_PATH_MOCKED';

export type LimitNote = {
  code: LimitCode;
  title: string;
  /** What Dot cannot see, stated as a fact about the data source, not a hedge. */
  blind: string;
  /** The concrete way out, including the ones that cost money or a different transport. */
  mitigation: string;
  /** Reported on every run, or only when the condition actually triggered. */
  always: boolean;
};

export const LIMIT_NOTES: LimitNote[] = [
  {
    code: 'HISTORY_RETENTION',
    title: 'Historical transactions are whatever the node kept',
    blind:
      'getTransaction returns null outside the node’s retention window. Public mainnet endpoints commonly retain on the order of days, not the chain’s full life, and the window is a BigTable/leader configuration Dot cannot read. A program whose integrators were busy in 2024 can show a small graph today because the 2024 traces are gone, not because nobody called it.',
    mitigation:
      'Run Dot continuously so the graph is built while the traces are still hot and persisted in Dot’s own store. For backfill, use a provider archive node, or `getBlock`/`getBlocks` streaming into your own indexer, or Yellowstone gRPC `subscribe` on transaction notifications, which is a live feed rather than a historical read.',
    always: true,
  },
  {
    code: 'NO_CHAIN_WIDE_UPGRADE_SUBSCRIPTION',
    title: 'Core JSON-RPC has no "every bytecode change" feed',
    blind:
      'There is no `getProgramChanges` and `subscribe*` is per-account. Watching the whole upgradeable loader means polling `getProgramAccounts` on a program that owns >100k accounts, which providers gate, rate-limit or reject outright.',
    mitigation:
      'Dot ships both layers: `watch --targets` polls a named list over JSON-RPC, and `watch --yellowstone <url>` subscribes by owner over Geyser and sees every `ProgramData` write on the cluster. The gRPC feed costs zero JSON-RPC calls, which is what makes chain-wide detection budget-feasible at all.',
    always: true,
  },
  {
    code: 'GRPC_LIVE_PATH_MOCKED',
    title: 'The Geyser wire format is proven against real bytes; the socket beneath it is not',
    blind:
      'What is proven: `test/yellowstone-live.test.ts` builds a `SubscribeUpdate` frame with the package’s own generated `encode`, feeds the resulting **raw protobuf bytes** into the feed, and asserts a captured mainnet `ProgramData` account survives the trip byte-for-byte — pubkey, data length, lamports, `writeVersion`, slot — and that `decodeProgramData` recovers the real upgrade authority from those bytes. Unclassifiable, truncated and `isStartup` frames are also covered. What is NOT proven: HTTP/2 handshake, x-token auth, `isReplay` semantics, ping/pong keepalive, and reconnect. Those live below the seam any test in this repo can reach without an endpoint. `test/transports.test.ts` additionally exercises the object-level fake; neither substitutes for the other.',
    mitigation:
      'Set `YELLOWSTONE_ENDPOINT` (and `YELLOWSTONE_TOKEN`) to un-skip the live test in `yellowstone-live.test.ts`, then run `dot watch --yellowstone <url>` and read `feed.statsView()`: `updates` must rise, `startupSkipped` should be non-zero on a replay, `layoutMismatch` should stay near zero. A flat `updates` counter with no error is the signature of a filter that matches nothing — which is exactly the failure mode of passing bytes where this API wants base58 strings — not evidence of a quiet chain.',
    always: false,
  },
  {
    code: 'PROGRAMDATA_REVERSE_LOOKUP',
    title: 'A ProgramData write does not say which program it is',
    blind:
      'Geyser reports the account address; `find_program_address` is one-way, and nothing on chain stores the reverse pointer. On a fresh daemon most `ProgramData` accounts therefore arrive nameless, and a nameless upgrade cannot be put in a graph.',
    mitigation:
      '`ProgramIndex` resolves it three ways, cheapest first, and stamps the method on the answer: pointer accounts the feed already saw (free), the writing transaction plus local PDA re-derivation (one call, exact), or a reverse `getProgramAccounts` scan (heavy, commonly gated). Events that resolve to none are **counted and skipped** (`unresolved`), never guessed and never silently dropped.',
    always: false,
  },
  {
    code: 'BLOCK_FETCH_AMPLIFICATION',
    title: 'Block batching buys calls with bandwidth, not with cost',
    blind:
      'One `getBlock` replaces many `getTransaction` calls, so the RPC-call ceiling stops binding — and the payload becomes every transaction in the slot, most of them unrelated to the target. On a busy program the byte count goes up by two or three orders of magnitude while the call count drops by one. A tool that reports only the first number is recommending the more expensive option.',
    mitigation:
      'Dot plans against an explicit cost model, prints both sides of the trade in the report (`callSavingRatio`, `byteAmplification`), and refuses a block above `maxBlockBytes`. Run `dot calibrate --rpc <url>` to replace the labelled defaults with sizes your endpoint actually serves; until then the rationale string says `defaults_unverified`.',
    always: false,
  },
  {
    code: 'ENDPOINT_CORROBORATION',
    title: 'Corroboration is only meaningful at the same slot',
    blind:
      'Two endpoints holding different bytes for one account at different slots are describing chain progress, not contradicting each other. And when one endpoint is down, the surviving number is uncorroborated rather than wrong.',
    mitigation:
      '`ResilientClient` compares only same-slot reads and splits the outcomes: `agreed`, `disagreed` (halt, P0 with `tierSource: integrity`), `slot_mismatch` (inconclusive, continue), `single_source` (continue, labelled), `both_failed` (halt, no conclusion). Every report carries the verdict, not just the ones that halted.',
    always: false,
  },
  {
    code: 'FEED_BACKPRESSURE',
    title: 'A deploy storm drops analyses, with a count',
    blind:
      'When the chain-wide feed fires faster than the daily RPC pool allows, events are dropped. Dropped is not the same as clean, and a daemon that dropped forty upgrades looks identical to one that saw none.',
    mitigation:
      '`UpgradeDispatcher` caps each investigation at `--per-event-rpc` (default 50) and the daemon at `--daily-rpc`, serves authority handovers and vanished ProgramData ahead of routine bytecode writes, drains serially so a burst cannot turn into a thundering herd, and exposes `dropped: {queue_full, daily_pool, below_minimum}`. Below `minViable` calls an analysis is refused rather than run thin.',
    always: false,
  },
  {
    code: 'CPI_DEPTH_ATTRIBUTION',
    title: 'innerInstructions is flat; depth is inferred, never given as a tree',
    blind:
      '`meta.innerInstructions[i]` maps a group of CPI instructions onto one outer instruction index, and the list inside the group has no parent pointers. At CPI depth >= 3 the caller of a nested call is not recoverable from the group alone. Measured on mainnet, instructions do carry `stackHeight` and `meta.logMessages` carries `Program <id> invoke [N]`, and Dot uses both — but `stackHeight` is absent from `@solana/web3.js` v1 type declarations and is not guaranteed by every node, and the log collector truncates.',
    mitigation:
      'Dot reports `attributionQuality`: `stackHeight` (exact), `logs` (exact, truncation-bounded) or `flat` (upper bound only, nested callers credited to the top-level program). For guaranteed depth-agnostic capture, parse a Yellowstone gRPC transaction stream, or record with an instrumented validator, since neither depends on the RPC’s log caps.',
    always: true,
  },
  {
    code: 'PARSED_INSTRUCTION_ACCOUNTS',
    title: 'Instruction accounts are pubkeys in jsonParsed and indexes in json — and parsed instructions have neither',
    blind:
      'Three shapes coexist in one response. A partially-decoded instruction under `encoding: "jsonParsed"` carries `accounts` as base58 pubkeys already resolved; the same field under `encoding: "json"` carries integer indexes into static keys followed by loaded-writable then loaded-readonly; and a *parsed* instruction (`spl-token`, `system`, …) carries no `accounts` at all, only whatever pubkeys happen to appear inside `parsed.info` under inconsistent names (`source`, `destination`, `newAccount`, `owner`, …). A parser that assumes one shape does not crash on the others — it reads `keys["6tv7sUQ4…"]`, gets undefined, and reports that no value moved. That is how a blast-radius tool produces a confident zero.',
    mitigation:
      'Dot accepts both entry types, resolves them through one table (`src/graph/keys.ts`), tags every frame `accountSource: accounts | parsed_info | none`, and records pubkeys that appear in an instruction but not in the key table as an anomaly instead of guessing. `test/graph.test.ts` asserts the two encodings of the same trace yield the same graph.',
    always: false,
  },
  {
    code: 'WEB3JS_JSONPARSED_VALIDATOR',
    title: '@solana/web3.js v1 cannot deserialize its own jsonParsed inner instructions',
    blind:
      'Not a limit of the chain but of the client, and it is the reason Dot owns its JSON-RPC layer: `Connection.getTransaction(sig, {encoding: "jsonParsed", maxSupportedTransactionVersion: 0})` throws `StructError: At path: meta.innerInstructions.0.instructions.0.accounts -- Expected an array value, but received: undefined` on real CPI-heavy mainnet transactions, because the schema requires `accounts` on parsed instructions the node does not send it on. Anything that trusts those types silently inherits the crash — or worse, a catch block that turns it into "no dependencies found".',
    mitigation:
      'Call the RPC directly and parse against Dot’s own wire types (`src/rpc/wire.ts`), which model `accounts` as optional and `stackHeight` as present-but-optional. Reproduced 2026-10-21 against api.mainnet-beta.solana.com with @solana/web3.js 1.99.x.',
    always: false,
  },
  {
    code: 'NO_IDL_CONTRACT',
    title: 'No IDL, no semantic claim',
    blind:
      'There is no mandatory on-chain IDL. Anchor programs may or may not publish one, the legacy `anchor:idl` PDA is version- and size-dependent, and non-Anchor programs frequently ship a binary with no interface at all. In `mode: real` the model then has nothing to read, and Dot must say so instead of paraphrasing a bytecode diff.',
    mitigation:
      '`--idl <path|url>` to supply a published IDL and a prior version for a real diff. Without it, `narrative.refused = "idl_unavailable"` appears in the report and the tier rests only on posture plus observed graph.',
    always: true,
  },
  {
    code: 'VALUE_IS_PROXY',
    title: 'Value routed is an upper-bound proxy, per transaction, not per edge',
    blind:
      'Lamports move between accounts; nothing in the response says "this transfer belongs to this CPI leg". Dot sums positive balance deltas over the accounts a call touched, and takes token deltas from pre/postTokenBalances, which are per-transaction arrays. A swap through a router that touches six accounts is counted once on the receiving side, and cannot be split into legs.',
    mitigation:
      'Treat it as a ranking signal. For a settlement-grade number you need an account-level state diff per instruction, which means an instrumented node or an indexer that stores instruction-level balance changes.',
    always: true,
  },
  {
    code: 'PDA_HOLDINGS_NOT_ENUMERATED',
    title: 'Program-held vaults are not enumerated',
    blind:
      'TVL sitting in a program’s PDAs is not visible from the transaction sample. There is no RPC that lists "all token accounts owned by these PDAs"; `getTokenAccountsByOwner` takes one owner at a time and `getProgramAccounts` on the token program with an owner filter is a full-program scan providers will not serve.',
    mitigation:
      'Compute vault balances from a known-PDA list (the IDL or the deployment repo gives you the seeds) via `getMultipleAccounts`, or use an indexer/DAS API. Dot leaves `blastRadius.lamportsRouted` explicitly labelled as routed-through value, not custody.',
    always: true,
  },
  {
    code: 'FAILED_TRANSACTIONS_ROLLED_BACK',
    title: 'A failed transaction moved nothing',
    blind:
      'Inner instructions are still populated for the part of a transaction that executed before it failed, and a CPI that fails inside a successful transaction is rolled back to its checkpoint. Counting those as interactions is right; counting them as value moved is not.',
    mitigation:
      'Dot keeps `failedCpiOccurrences` and `tracesFailed` separate from the value sums, so an integrator that started erroring on the new bytecode shows up as a signal rather than as volume.',
    always: false,
  },
  {
    code: 'SIGNATURE_INDEX_IS_KEY_BASED',
    title: 'getSignaturesForAddress matches keys, not roles',
    blind:
      'The index returns any transaction where the address appears as an account key: as the invoked program, as a CPI target, as a mint, as a PDA, as a token account. For an id that is also a commonly-referenced account, the sample fills up with transactions that have nothing to do with the program’s execution.',
    mitigation:
      'Filter on "appears as a program id in an instruction" during normalization, which Dot does by dropping frames whose program never actually ran. Sample size and `sampleCoverage` are reported so a reader can see how much of the window was noise.',
    always: true,
  },
  {
    code: 'ADDRESS_TABLE_RESOLUTION',
    title: 'v0 transactions need table-loaded addresses resolved before indexes mean anything',
    blind:
      'Instruction account indexes point into static keys followed by loaded writable then loaded readonly addresses. If a node omits `meta.loadedAddresses`, every index past the static table is wrong, and the graph is wrong in a way that looks like data rather than like an error.',
    mitigation:
      'Dot resolves both paths and reports `keys.method` plus any `unresolvedIndexes` as anomalies in the evidence ledger. Zero unresolved indexes is a precondition for trusting an edge.',
    always: false,
  },
  {
    code: 'NO_PRE_DEPLOY_ANALYSIS',
    title: 'Dot sees landings, not intentions',
    blind:
      'A bytecode change that has not been written on chain does not exist for Dot: no propose-stage review, no repository, no CI signal. It is a runtime tool, deliberately not a static analyzer of what is about to be deployed.',
    mitigation:
      'Partly narrowed: the Geyser owner filter also catches the loader’s `Buffer` accounts, so `dot watch --yellowstone` prints a `STAGED` line when a program is being uploaded before it lands — an early trigger, not an analysis. Pair it with a static analyzer on the staged bytes.',
    always: true,
  },
  {
    code: 'FINALITY_VS_LATENCY',
    title: 'Finalized-only means slow-only',
    blind:
      'Dot reads at `finalized` because a graph built on `processed` data can be reorged out from under it. That costs minutes of detection latency, which matters if the upgrade you are watching is being exploited right now.',
    mitigation:
      '`--commitment confirmed` trades reorg risk for latency. Do not use `processed` for a persisted graph.',
    always: true,
  },
  {
    code: 'SINGLE_NODE_TRUST',
    title: 'One RPC node is one point of failure and one point of view',
    blind:
      'A provider can cache, filter, lag, or serve you a node that is behind. Every number in a Dot report is a statement about what one endpoint chose to return. A quiet blast radius can mean a filtered node.',
    mitigation:
      '`--secondary-rpc <url>` reads the `ProgramData` account from both endpoints and halts on a same-slot contradiction; each endpoint gets its own `Budget` so a retry on one cannot silently spend the other’s. `rpc.rpcErrorCodes` and `pruned` remain the first places to look.',
    always: true,
  },
  {
    code: 'NO_MALICE_DETECTION',
    title: 'Dot ranks attention; it does not adjudicate guilt',
    blind:
      'Nothing here determines whether an upgrade is malicious. A P0 says "posture and blast radius justify a human before the weekend", and a P3 says "the evidence Dot could gather does not". Absence of a finding is not a clean bill of health, and the tier is a queue position, not a verdict.',
    mitigation:
      'Read the `components` array and the evidence ledger before escalating to anyone. If `cappedBy` is non-null, the tier is capped by a blind spot and the next step is a better data source, not a louder alarm.',
    always: true,
  },
];

export type LimitCondition = {
  pruned: number;
  attributionQuality: 'stackHeight' | 'logs' | 'flat';
  idlAvailable: boolean;
  logTruncated: boolean;
};

/** The triggered subset — a report lists the limits that actually applied to it. */
export function limitsFor(c: LimitCondition): LimitNote[] {
  const triggered: LimitNote[] = [];
  if (c.pruned > 0) triggered.push(LIMIT_NOTES.find((n) => n.code === 'HISTORY_RETENTION')!);
  if (c.attributionQuality === 'flat') triggered.push(LIMIT_NOTES.find((n) => n.code === 'CPI_DEPTH_ATTRIBUTION')!);
  if (c.logTruncated) triggered.push(LIMIT_NOTES.find((n) => n.code === 'CPI_DEPTH_ATTRIBUTION')!);
  if (!c.idlAvailable) triggered.push(LIMIT_NOTES.find((n) => n.code === 'NO_IDL_CONTRACT')!);
  const always = LIMIT_NOTES.filter((n) => n.always);
  const seen = new Set<string>(triggered.map((t) => t.code));
  return [...triggered, ...always.filter((a) => !seen.has(a.code))];
}
