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
  | 'PRE_DEPLOY_PARTIAL'
  | 'FINALITY_VS_LATENCY'
  | 'SINGLE_NODE_TRUST'
  | 'NO_MALICE_DETECTION'
  | 'BLOCK_FETCH_AMPLIFICATION'
  | 'ENDPOINT_CORROBORATION'
  | 'PROGRAMDATA_REVERSE_LOOKUP'
  | 'FEED_BACKPRESSURE'
  | 'GRPC_LIVE_PATH_UNREACHABLE'
  | 'BYTECODE_SCAN_BLIND_ON_COMPILED_IMAGES'
  | 'DANGER_RANKING_UNMEASURED_INPUTS';

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
    code: 'GRPC_LIVE_PATH_UNREACHABLE',
    title: 'The Geyser wire format is proven against real bytes; no live endpoint has ever answered',
    blind:
      'What is proven: `test/yellowstone-live.test.ts` builds a `SubscribeUpdate` frame with the package’s own generated `encode`, feeds the resulting **raw protobuf bytes** into the feed, and asserts a captured mainnet `ProgramData` account survives the trip byte-for-byte — pubkey, data length, lamports, `writeVersion`, slot — and that `decodeProgramData` recovers the real upgrade authority from those bytes. It also proves the feed calls `connect()` before `subscribe()` and bounds a channel that never completes. What is NOT proven: that any provider has ever sent Dot a frame. Re-probed 2026-10-22 from this box with no token (`npx tsx scripts/probe-geyser.ts`): two hostnames refused at `stage: subscribe` with `failed to open subscribe stream`, three **resolved the subscribe and then sent nothing for 60 s**, and the control — a host that serves JSON-RPC and has no Geyser service at all — did exactly the same as the silent three. Passing an obviously invalid token changed nothing observable. So *not authenticated*, *wrong host* and *filter matches nothing* are three-way indistinguishable from the client, and `start()` resolving is not evidence of a live feed. The control that makes this a limit rather than a bug report: **a host with no Geyser service at all (`api.mainnet-beta`) produced the identical error string as a host that does (`api.rpcpool.com`)**, so Dot cannot distinguish a missing token from a missing service from a refused filter — and a local HTTP/2 server that would have answered with a real frame received **zero bytes**, because the vendored native client does not speak plaintext. `isReplay`, keepalive and reconnect therefore remain unexercised in the field.',
    mitigation:
      'Set `YELLOWSTONE_ENDPOINT` (and `YELLOWSTONE_TOKEN`) to un-skip the live test in `yellowstone-live.test.ts`, then run `dot watch --yellowstone <url>` and read `feed.statsView()`: `updates` must rise, `startupSkipped` should be non-zero on a replay, `layoutMismatch` should stay near zero, `malformed` should stay 0. A flat `updates` counter with no error is the signature of a filter that matches nothing — which is exactly the failure mode of passing bytes where this API wants base58 strings — not evidence of a quiet chain. `docs/blocked.md` §3 carries the hostnames, the stage each failed at and the exact strings.',
    always: false,
  },
  {
    code: 'BYTECODE_SCAN_BLIND_ON_COMPILED_IMAGES',
    title: 'The selector scan finds nothing in compiled Anchor bytecode — measured, not suspected',
    blind:
      'The entrypoint diff rests on one assumption: that Anchor emits `sha256("global:<name>")[0..8]` as a contiguous 8-byte constant the scan can locate. The derivation rule is correct — anchor-syn 0.30.1 computes exactly `sighash("global", <snake_case method name>)` — but the *emission* assumption is now measured false. Compiled on this box with the Solana toolchain (rustc 1.89.0-sbpf-solana-v1.54, platform-tools v1.54): a 3,760-byte image in which ten discriminators are compared as `[u8; 8]` constants contains **0 of 10** contiguous selectors while all ten appear as two 4-byte immediates eight bytes apart (`mov32` + `hor64`); a 244,264-byte program built with anchor-lang 0.30.1 itself contains **0 of 6** contiguous selectors and 0 of 6 four-byte halves, the dispatch having lowered to a byte-wise compare tree. A contiguous scan is therefore blind to both shapes, which means "no entrypoint added or removed" from a real image is silence, not evidence. `diffBytecode` reports `confidence: "unscannable"` and relabels declared-but-not-located as "not seen" when it locates none of three or more declared selectors.',
    mitigation:
      'To make the entrypoint diff real, scan what the compiler emits: match the `mov32 imm32` / `hor64 imm32` pair and the byte-wise compare tree, or stop scanning bytecode and read an on-chain IDL where one is published. Reproduce the measurement: `test/fixtures/sbf-dispatch.so` is the 3,760-byte image and `test/bytecode.test.ts` asserts the blindness; for the framework case, build a one-instruction-per-handler program with `cargo +1.89.0-sbpf-solana-v1.54 build --target sbpfv2-solana-solana --release` (PATH including platform-tools/llvm) against `anchor-lang = "0.30.1"` and scan it. `DOT_TEST_SO=/path/program.so DOT_TEST_IDL=/path/idl.json npx vitest run test/bytecode.test.ts` runs the same check against any artifact.',
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
      'Dot plans against an explicit cost model, prints both sides of the trade in the report (`callSavingRatio`, `byteAmplification`), and refuses a block above `maxBlockBytes`. Run `dot calibrate --rpc <url>` to replace the labelled defaults with sizes your endpoint actually serves, then pass it with `--cost-model <file>` or pin it for every run with `DOT_COST_MODEL`. Measured 2026-10-21 against `api.mainnet-beta`: 506 transactions per sampled block and 18,040 bytes per fetched transaction, which puts real amplification at ~506x where the defaults implied 2000x — the defaults were optimistic about batching and pessimistic about bandwidth, in opposite directions. Until a model is supplied the rationale string says `defaults_unverified`.',
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
    title: 'Program-held vaults are only enumerable with a declared seed list',
    blind:
      'TVL sitting in a program’s PDAs is not visible from the transaction sample, and the seeds that derive those PDAs live in the deployment repo. Dot can only read custody for seed patterns an operator has declared; for everyone else the figure stays unknown, and unknown is printed as unknown. Typed seeds matter too: the encoding `u8:0` is the byte 0x00, and hashing the ASCII character for zero instead derives a different address that resolves to nothing.',
    mitigation:
      '`--seeds seeds.example.json` derives each PDA, reads them in `getMultipleAccounts` chunks of up to 100, and sums lamports plus raw token units per mint. It reports unresolved seed variables, absent accounts and an incomplete sweep separately — see `renderHoldings`, which refuses to print a USD figure and states that absence is not zero holdings. `seeds-live.json` is a worked example whose every derived address was checked against mainnet (`docs/live-seeds-2026-10-21.json`); note that the figures it produced are a snapshot of live trader accounts, so the amount is read from the same instant, never compared to a value recorded yesterday.',
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
    code: 'PRE_DEPLOY_PARTIAL',
    title: 'Dot sees that an image is staged; it does not see what the image does',
    blind:
      'Narrowed, not closed. The loader’s staging `Buffer` account is visible to the Geyser owner filter, so `dot watch --yellowstone` now emits `STAGED_UPGRADE` with the image hash, size and staging authority, and `STAGED-NOOP` when the bytes already match what is live. What remains unseen: without a published IDL pair there is no semantic reading of the staged image, no source, no repository, and no CI signal. A `Buffer` account also **names no program** — `upgrade` receives the program as a transaction argument — so attribution is deferred until the bytes land, and Dot marks it `UNATTRIBUTED` rather than guessing. There is likewise no protocol-level timelock to read: the loader applies new bytecode on the upgrade transaction itself, so `finalizeEta` reports `immediate_unless_governed` unless the operator declares a delay via `--timelock-ms`. An invented ETA would be the most dangerous number in this tool, because it is the one an operator would schedule against.',
    mitigation:
      'Supply `--idl`/`--prior-idl` so `mode: real` can read the delta; pair the staged signal with a static analyzer on the staged bytes. Run Dot long enough for bytecode-hash landing to attribute earlier stages, and record `pending()` to see how many images are still unattributed.',
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
      'Nothing here determines whether an upgrade is malicious. A P0 says "posture and blast radius justify a human before the weekend", and a P3 says "the evidence Dot could gather does not". Absence of a finding is not a clean bill of health, and the tier is a queue position, not a verdict. The malice *signature* axes narrow this and do not close it: `SUSPECTED_MALICIOUS` is a claim about a shape Dot observed — who funded the key, what the bytecode answers to, when it landed — never about what anybody intended. It also cannot see the two things a real triage would ask first: there is no mixer or obfuscation list in this build, so "funded from a suspect source" only means "from an address the operator named"; and no signer-set age is read, so a stale multisig looks exactly like a fresh one.',
    mitigation:
      'Read the `components` array and the evidence ledger before escalating to anyone. If `cappedBy` is non-null, the tier is capped by a blind spot and the next step is a better data source, not a louder alarm. If `danger.malice.flagged` is true, the scream comes with the axis points that produced it and the gate that allowed it — quote those to the human, not the label.',
    always: true,
  },
  {
    code: 'DANGER_RANKING_UNMEASURED_INPUTS',
    title: 'Several of the danger ranking’s inputs do not exist on-chain, and each axis names its own',
    blind:
      'The 0-100 ranking is arithmetic over seven axes — four for queue position, three for malice signature — and several of its sub-claims cannot be measured from what Dot is allowed to read. (1) The *threshold* of a multisig upgrade authority lives inside the multisig account, which Dot does not decode, so 1-of-2 and 5-of-9 are the same posture: scored at 25 on the queue axis — the alarming end of the two bands the model defines — never at a guessed midpoint, and left `null` on the integrity axis, which needs the band itself rather than an assumption of it. (2) The same axis\'s "stale signer set" half needs the age of each signer\'s last activity, which is a read Dot does not make. (3) "Funded by a mixer" needs a mixer list, and this build ships none: an invented one would be a claim about the world with no source, so the +30 band is reachable only through an operator\'s `--suspect` addresses or an observed first funding. (4) Observed freshness is bounded by the node\'s retention: a full page of signatures means "nothing older *here*", so `retentionBounded` withholds the band rather than reading a truncated history as a genesis. (5) "Upgrade within 24h of a major ecosystem event" has no feed in Dot at all, so that award is never given and no score this build produces has ever included it; the timing axis\'s governance and incident bands exist only against `--governance-program` and `--incident-at`, and a signature on a governance program is any call, not a proposal. (6) Value routed through *tokens* is not attributable: the graph records which mints a call touched, not how much, so the ×2 blast-radius multiplier applies to observed lamports only and a mint-heavy program can score below its real exposure. A seventh, softer: "first upgrade" means first upgrade **Dot observed in its own `--state` file**, not first upgrade in the program\'s life.',
    mitigation:
      'Each has a real fix, none of them a heuristic. Decode the multisig account (shamir/threshold fields are plain borsh, ~30 lines, and would let 1-of-N and M-of-N take their own bands, and give the signer set an age to be judged by). Let the operator declare what Dot cannot read — `--threshold 2-of-3`, `--timelock`, `--suspect <address>`, `--governance-program <address>`, `--incident-at <time>` — which is what the signature axes are built on, and each one says in the report that it was declared rather than observed. Get instruction-level token deltas from an indexer or an instrumented node — the same fix HISTORY_RETENTION asks for. Run Dot continuously so the state file predates the upgrade. Until then the axis prints the gap in its own `notAssessed` line, an unmeasured axis is `null` rather than 0, and CRITICAL is withheld whenever any of the **four queue-position axes** was unmeasured: the ceiling is the mechanism that stops a hole in the data reading as a low score. The three signature axes are deliberately outside that rule — they cost RPC calls an operator may decline to spend, and withholding CRITICAL because `--check-funding` was not run would make the default ranking unable to top out.',
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
