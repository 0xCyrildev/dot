# Dot

**Static tools audit what a program *could* do. Dot audits what the ecosystem *does* when a program upgrades.**

Solana programs are not artifacts, they are nodes in a graph. Program A calls Program B which calls
Program C, and none of that relationship exists in any source tree. When B's bytecode is replaced on
chain, the question every existing tool answers is about B. The question that actually costs money is
about A and C: who calls the program that just changed, how often, and how much value routes through
them.

![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
199 tests, no network (1 skipped: a gated live-Geyser test). `tsc --noEmit` and `npm run build` clean.

You give it a program id, or a list of them, or nothing at all in chain-wide mode, and it watches
`BPFLoaderUpgradeable` for bytecode changes; when one lands it reconstructs the CPI dependency graph
from real execution traces, prices the upgrade by who depends on the program and what moved through
them, and emits a P0–P3 triage tier with the arithmetic that produced it, an evidence ledger with
citable ids, and the list of things it could not see.

It ships as a CLI, a library, and an MCP server. Detection stays deterministic: a model is only ever
asked to read an IDL diff and explain it, never to decide what the tier is — and its explanation is
discarded if it cites evidence that was never issued.

```
  ████   ████  ██  ██  █████
 ██  ██ ██  ██ ███ ██  ██
 ██  ██ ██  ██ ██ ███  ██
 ██████  ████  ██  ██  █████   blast radius, not vulnerabilities
```

## What it does, and what it does not do

| Phase | Tool | Question it answers |
|---|---|---|
| Before deployment | static analyzers (SolanaShield, Sentio) | what could this program do? |
| At build time | dependency scanners (LoserLab) | is this npm package hostile? |
| Per transaction | runtime monitors (GulfWatch) | is this known-bad transaction running? |
| **At upgrade time** | **Dot** | **who breaks, and how much value was in the way?** |

The gap is the on-chain supply chain. A program's callers are not in its repository, not in its IDL,
and not in its dependency manifest. They are in the transaction history of every integrator that ever
did a CPI into it — which is exactly what Dot reconstructs, and exactly what no isolated-program audit
can see.

It does not read source, does not decompile, and does not decide whether an upgrade is malicious. A P0
is a queue position: *posture and blast radius justify a human before the weekend*. A P3 is a statement
about the evidence Dot was allowed to gather, not an all-clear.

## Install and first run

Not published to npm yet — `npm whoami` returns E401 from the build environment, so
`npm install -g @zeroxcyril/dot` would be an unverified line and is therefore not
printed anywhere in this file. See `docs/blocked.md`. Every command below is one that
was actually run, which is the same rule Chase's README states out loud.

From a clone:

```bash
npm ci
npm run build                                  # tsc, then postbuild chmods the bin
node dist/cli/index.js analyze <PROGRAM_ID>
node dist/cli/index.js limits                  # what Dot cannot see, as data
```

As a global install from the built tarball — verified end to end by
`test/install.test.ts`, which packs, installs with `npm install -g` into a throwaway
prefix, and executes all six bins:

```bash
npm pack                                                    # -> zeroxcyril-dot-0.1.0.tgz
npm install -g --prefix /tmp/dot-prefix ./zeroxcyril-dot-0.1.0.tgz
/tmp/dot-prefix/bin/dot-limits
```

Or with a prefix you control on PATH:

```bash
npm config set prefix ~/.npm-global
export PATH=~/.npm-global/bin:$PATH
npm link && dot analyze <PROGRAM_ID>
```

`npm link` needs a writable global prefix. On the build box it is not: the prefix
resolves to a `/usr/local/lib/node_modules` that does not exist, so `npm link` fails
with EACCES rather than half-installing.

**The `dot` bin name collides with graphviz, and this is not hypothetical.** `/usr/bin/dot` was present
here, shadowed the linked binary, and `dot limits` printed graphviz's `can't open limits`. The package
therefore also installs unambiguous aliases that dispatch on the invoked name:

```bash
dot-analyze <program>   dot-watch --targets targets.json   dot-mcp
(dot | dot-analyze | dot-watch | dot-mcp | dot-limits | dot-calibrate)
dot-limits                  dot-calibrate --rpc <url>
```

Verified by symlinking both names and running them: `dot-limits` prints the limit catalogue and
`dot-watch` complains about its own missing `--targets`. After a publish this becomes
`npm install -g @zeroxcyril/dot`; the clone form above is what actually ran.

Nothing in a `.env` is required. No API key is read unless you ask for model reasoning.

```bash
dot analyze JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 --depth 2 --seeds seeds.example.json
dot blast-radius --since 2026-10-20 --min-value 100000000000 --authority-map authorities.json
dot watch --targets targets.example.json --interval 30000 --secondary-rpc <url>
dot watch --yellowstone <grpc-url> --per-event-rpc 50 --daily-rpc 5000
dot calibrate --rpc <url>          # measures the cost model below instead of assuming it
dot mcp                            # MCP server over stdio
```

A paid RPC endpoint is not optional in practice. The public endpoint has no transaction history: a real
run against it read the program state correctly and then got `-32015 Transaction history is not
available` on all ten trace fetches, and the report said so — see [the live run](#the-live-run).

## What we learned from the chain

The long form is [`docs/lessons.md`](docs/lessons.md) — the contradictions below, the two refusals, the graphviz collision, and the
bugs the test suite found in code I had written that same day. What follows is the condensed version, and
it is the part that should decide whether this was built against the chain or against its documentation.

This tool was written against measured mainnet responses, and three load-bearing assumptions in the
original design died on contact. They are in the code as comments and in `dot limits` as documented
blind spots, because the next person to build against these APIs will hit the same three.

**1. `@solana/web3.js` cannot deserialize its own `jsonParsed` output.**

```
Connection.getTransaction(sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 })
→ StructError: At path: meta.innerInstructions.0.instructions.0.accounts
  -- Expected an array value, but received: undefined
```

Parsed instructions have no `accounts` field — the account set lives inside `parsed.info`. web3.js's
superstruct marks it required. This throws on ordinary CPI-heavy mainnet traffic, reproduced on the
first sample tried. Dot therefore owns its JSON-RPC layer (`src/rpc/transport.ts`, `src/rpc/client.ts`)
and uses web3.js only for `PublicKey` and PDA derivation. A catch block that swallows this error turns
into "no dependencies found", which is the most expensive possible accident for a blast-radius tool.

**2. Instruction `accounts` are pubkeys in `jsonParsed` and indexes in `json`.**

The spec said indexes. Mainnet says:

```
jsonParsed  → accounts: ["6tv7sUQ4R3fE9rnBX4w72oiiqSHqKF3KPvyubFNfazxd", …]
json        → accounts: [1, 5, 12]
```

A parser that assumes indexes evaluates `keys["6tv7sUQ4…"]`, gets `undefined`, and reports that no lamports
moved. Not a crash — a confident zero. `src/graph/keys.ts` accepts both, and `test/graph.test.ts`
asserts that the two encodings of the same trace produce the same graph.

**3. `ProgramData` is not the layout the SDK describes.**

Measured across several mainnet programs: `ProgramData` account discriminant **3**, `Program` account
discriminant **2** — the reverse of the `UpgradeableLoaderState` enum order — and the ELF magic at byte
**45**, with `u64 + Option<Pubkey>` before it and **no `data_len` field**. Reading the documented layout
lands you on `0x7f454c46` while claiming it is a length.

So Dot does not trust offsets for anything load-bearing. Change detection hashes the **whole account**,
which cannot miss a realloc or a rewrite regardless of layout; the bytecode-only hash is computed only
after the ELF magic has been *found*, and an account where it is not found raises
`UNKNOWN_PROGRAMDATA_LAYOUT` instead of hashing a guessed window. A watcher with a wrong offset does not
error — it reports an all-clear forever.

Two smaller ones: `stackHeight` is present on mainnet instructions but absent from web3.js v1's type
declarations (it is what makes depth-3 attribution exact rather than guessed), and a Yellowstone v9
subscription takes `owner` as a **base58 string** where the usual write-ups say bytes — pass bytes and
you match nothing, which looks identical to a quiet chain.

## What Dot is as an agent

One run is five stages, and only one of them is expensive:

```
perceive  1 RPC call: read the ProgramData account, decode, diff
decide    rule engine or model: is this worth a trace pull, and how big a sample
act       the only expensive stage: signature walk + trace fetch + graph build
evaluate  digest the graph, price exposure, price the evidence quality
report    tier + components + evidence ledger + budget snapshot + limits
```

`decide` exists to avoid `act`. A multisig-held program with an already-known empty graph stops after
**one RPC call** and still emits a complete report, budget snapshot included, recording what it declined
to spend. That trace of skipped work is the difference between an agent and a script with a for-loop.

The `Budget` (`maxRpcCalls`, `maxSignatures`, `maxLlmTokens`, `maxWallMs`) is enforced before every
request, not after:

- a refused call is still a decision, and appears in the run trace;
- a **failed** call is a **spent** call — the node already did the work;
- every **retry** is charged again, which is why `HttpTransport` is deliberately dumb and the client
  owns the retry loop;
- LLM tokens are estimated, reserved, then **settled against the API's billed usage**, so an
  underestimate surfaces as `budget.overrun` instead of an invisible overdraft.

When `act` runs out of budget mid-sample, Dot does not crash and does not silently report what it found.
It keeps the partial graph, sets `stoppedAt: "act"`, and writes the reason into `cappedBy`.

**It asks for budget rather than returning a thin answer.** When posture is a single key and the
affordable sample cannot distinguish "no dependents" from "not in the sample", the run returns
`needs_more_budget` with the number of calls it wants; the CLI prints
`Re-run with --budget-rpc +N` and exits **4** — distinct from 3 (a stop was reached), 1 (it broke), and
5 (the limit catalogue failed its own test). Coverage is measured against the sample the risk *wanted*,
not the one the budget could afford, because that number is what caps the tier.

**The ask is a claim, not a complaint.** Alongside the number, `needs_more_budget` carries a hypothesis
derived from the signals this run actually saw — claim, evidence for, evidence against, a priced test
plan and the one observation that would knock it down (`--hypothesis-out` writes it; `--hypothesis-file`
carries it into a better-funded run, which re-tests it). A run that still cannot afford the plan, or that
never sampled the thing the claim depends on, answers `not_testable` with the shortfall instead of
`denied`: zero from a check that did not run is not evidence of absence.

**Fair share under a firehose.** In chain-wide mode a deploy storm can spend the entire day's allowance
on the first program that looks interesting. `UpgradeDispatcher` caps each investigation at
`--per-event-rpc` (default 50) and the daemon at `--daily-rpc`, serves an authority handover or a
vanished `ProgramData` ahead of a routine bytecode write, drains serially so a burst cannot become a
thundering herd on one endpoint, and **counts every dropped event by reason**. Dropped is not clean.

## Where the numbers come from

**Blast radius.** `meta.innerInstructions[].index` is a position in the *outer* instruction array, so the
inner lists are folded onto their parent before any edge is attributed. Inside a group the list is flat:
there are no parent pointers, so depth comes from `stackHeight`, then from the log tree
(`Program <id> invoke [N]`), then from flat attribution. Each edge carries which method established it,
and `attributionQuality: "flat"` means dependent counts are an **upper bound** because a depth-3 callee
got credited to the transaction root. Two joins that only bite on real data: the log tree is matched to
outer instructions **by ordinal, not by program id** (a transaction can invoke AToken twice), and self-CPI
is a legitimate edge that gets kept, not filtered.

**Value.** Positive balance deltas over the accounts a call touched, and token deltas from
`pre/postTokenBalances`. Both are per-transaction, not per-edge: a swap through a router cannot be split
into legs. Failed transactions are counted as interactions and excluded from value, because the runtime
rolled them back. `lamportsRouted` is routed-through, never custody — program-held vault PDAs are not
enumerated (`PDA_HOLDINGS_NOT_ENUMERATED`), and there is no price oracle, so no USD figure is printed
unless an operator passes `--sol-usd`.

**Block batching, stated honestly.** One `getBlock` replaces many `getTransaction` calls, so the call
ceiling stops binding — and the payload becomes every transaction in the slot. Calls go down 10–100x,
bytes go up 100–1000x, and on a busy program the *wall clock* gets worse. So `BlockBatcher` plans against
an explicit cost model, prints both ratios in the report, refuses blocks above `maxBlockBytes`, and only
chooses batching when calls are genuinely the binding constraint or the target's density justifies it.
`dot calibrate` measures `avgBlockTransactions` and `avgTxnBytes` from your endpoint and writes the model;
until then every rationale string says `defaults_unverified`.

**Corroboration.** `--secondary-rpc` reads the `ProgramData` account from two endpoints and compares —
but only at the *same slot*. Two nodes 40 slots apart holding different bytes is chain progress, not
contradiction, and a check that cannot tell them apart cries wolf until everyone ignores it. Outcomes:
`agreed`, `disagreed` (halt), `slot_mismatch` (inconclusive, continue), `single_source` (continue,
labelled uncorroborated), `both_failed` (halt, no conclusion). Each endpoint gets its own `Budget`.

**The halt is a different kind of P0.** On a same-slot contradiction, Dot stops and emits tier P0 with
`tierSource: "integrity"`. That is not an exposure score and never passes through `scoreRisk`: the
endpoints are the tool's input, and a contradiction is evidence about the tool, not the program. Nothing
downstream of that read is trustworthy, including the absence of findings.

**`--verify` asks the second node about the report, not just the upgrade.** `chain_verified`
cross-checks four things: the `ProgramData` bytes, the `Program` pointer, a sample of the
transactions the edges were built from (instructions, accounts, slot and balance deltas —
`logMessages` excluded, because providers truncate differently), and what each node says
about finality. Verdicts are `agree`, `contradict`, `inconclusive`, `unconfirmed`, and the
last two are not the same sentence: measured on mainnet, two public endpoints asked
*concurrently* still answered the same account read 9 slots apart, and `minContextSlot` is a
lower bound, so a mutable account simply cannot be compared at one moment over plain RPC.
Finalized transactions can. `chain_verified: true` therefore means two endpoints described
the same chain, and the report prints beside it what that still does not prove — no
inclusion proof exists in core RPC, and a hostname is not proof that the two endpoints are
independent providers. See `docs/live-verify-2026-10-21.md` for a real run, which comes back
`false` for exactly these reasons.

## Usage

### CLI

```bash
dot analyze <program_id> --sample 60 --depth 3            # one-off blast radius
dot analyze <program_id> --mode real --idl new.json --prior-idl old.json
dot analyze <program_id> --ingest blocks --cost-model dot-cost-model.json
dot analyze <program_id> --unbounded                       # the mode Dot argues against
dot watch --targets targets.example.json --state state.json
dot watch --yellowstone <grpc-url> --authority <pubkey>   # chain-wide, no target list
dot limits
dot limits --status        # RESOLVED / NARROWED / UNRESOLVABLE_IN_CODE, each with its test files
dot replay --fixture tx.json --target <program>   # the real parser, offline, on captured bytes
dot mcp
```

`--format md` renders the report, `--format json` emits the structure, `--out <dir>` writes both. Every
report ends with the limits that applied to it and a line saying that Dot ranks attention rather than
adjudicating guilt.

### Library

```ts
import { Budget, SolanaClient, HttpTransport, RuleBasedDecision, Scout, BlockBatcher } from 'dot-blast-radius';

const budget = new Budget({ maxRpcCalls: 60, maxSignatures: 60 });
const client = new SolanaClient({ transport: new HttpTransport(url), budget });
const scout = new Scout({
  client, budget,
  decision: new RuleBasedDecision(),
  mode: 'rules',
  batcher: new BlockBatcher(client, await loadCostModel('dot-cost-model.json'), budget),
});
const report = await scout.run({ program });
report.tier; report.components; report.budget.spent.rpcCalls; report.limits;
```

`RuleBasedDecision` and `RealLlmDecision` implement one interface, and the Decide step is handed the
same `EvidenceLedger` the report prints — an engine with its own ledger would reject every valid citation.

### MCP server

Two tools, so another agent can call Dot instead of reimplementing the fold:

```bash
dot mcp        # stdio
```

Four tools, all requiring a `budget` argument so an orchestrator cannot ask for an unbounded scan by
accident:

| Tool | Returns |
|---|---|
| `dot_blast_radius` | the CPI graph, dependents, value routed (marked `valueIsProxy: true`), tier, budget spent, triggered limits |
| `dot_evaluate_upgrade` | one upgrade scored: posture, authority rotation, size move, blast radius, components |
| `dot_limits` | the 20 codes in three states, plus `verifyTestClaims()` so a `RESOLVED` with a missing test is reported, not hidden |
| `dot_watch_status` | the daemon's cursor and counters — and `available: false` with the path it looked at when nobody is watching |

`test/mcp.test.ts` spawns the server over real stdio pipes and asserts every stdout line parses as
JSON-RPC: one stray `console.log` corrupts the stream and the host drops the connection with no useful
error, so diagnostics go to stderr and that is tested rather than hoped. Both return `isError` on a
malformed address, and the `limits` codes in the structured result even when the run looked clean.

```json
{ "name": "dot_evaluate_upgrade",
  "arguments": {
    "program": "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    "budget": { "maxRpcCalls": 60, "maxSignatures": 60, "maxLlmTokens": 0, "maxWallMs": 60000 },
    "event": { "kind": "authority_change", "beforeAuthority": "…", "afterAuthority": "…" },
    "knownMultisigs": ["…"] } }
```

`knownMultisigs` is required in spirit, not by schema: **nothing on chain tells you an authority is a
2-of-3 multisig.** An unmapped authority is scored `unknown` or `program_derived` and treated as
unreviewed, never as safe.

## Architecture

```
src/
  rpc/wire.ts          measured wire contract (accounts?: number|string, stackHeight?)
  rpc/transport.ts     single-shot JSON-RPC. No retries: a retry is a second paid call
  rpc/client.ts        Budget enforcement, byte accounting, -32015 → pruned
  rpc/resilient.ts     two-endpoint same-slot corroboration
  rpc/yellowstone.ts   chain-wide owner subscription
  graph/keys.ts        key table: inlined / composed-from-loadedAddresses
  graph/normalize.ts   the fold + stackHeight → logs → flat attribution
  graph/builder.ts     edge aggregation, value attribution, failure exclusion
  graph/batcher.ts     density-driven getBlock ingestion with an explicit cost model
  state/programdata.ts structural decode, ELF validation, authority posture
  state/programIndex.ts  ProgramData → program, three ways, cheapest first
  watcher/watcher.ts     whole-account hashing, poll + accountSubscribe
  watcher/dispatcher.ts  per-event caps, priority, counted drops
  agent/budget.ts        reserve-before-act ceilings
  agent/scout.ts         perceive → decide → act → evaluate → report
  agent/rules.ts         deterministic engine: default AND fallback
  agent/llm.ts           citation-gated model + IDL narrator
  score/risk.ts          P0–P3, severity kept separate from confidence
  limits.ts              honest limits as data
test/fixtures/           one real mainnet transaction + measured ProgramData bytes
```

Dependencies: `@solana/web3.js` for `PublicKey` and PDA derivation only, `bs58`, `zod`, `commander`,
`@modelcontextprotocol/sdk`, `@triton-one/yellowstone-grpc`. Node's global `fetch` and `WebSocket` do the
transport. There is no RPC library in the read path, for the reason in contradiction #1.

## The live run

`docs/live-run-2026-10-21.json` is a real report from `dot analyze` against
`api.mainnet-beta.solana.com`, from the `4be1b77` baseline build (two things the current build does
differently: `limits` is no longer emitted twice, and `-32015` is now classified as pruned history
rather than as a fetch error).

```
program     LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
programData HZcJwcJ2njPDxZtpPoKnF8v2w9QAx2rS7TdJPSRkbEhu   ← PDA derived, not looked up
posture     EV-1: authority=JADaUV8… posture=program_derived bytecode=2229776B at offset 45
            discriminant=3 layout=u64+option33 sha256=d296c6771cec9456…
decision    proceed=true plan={"signatures":25}
outcome     stoppedAt=act  cappedBy="only 0% of the planned sample was retrievable from the node"
            rpc: 13 calls, 1 retry, 10×-32015
tier        P3, confidence LOW
```

That is the interesting result. The upgrade-detection half worked against production: the PDA derivation
matched the on-chain pointer, the layout decoded, the authority was classified off-curve. The trace half
was refused by the endpoint, and Dot **said so instead of reporting an empty graph** — tier capped,
confidence low, `HISTORY_RETENTION` triggered, and a `cappedBy` line that cannot be misread as
"nobody depends on this". A tool that printed P3 with confidence "high" there would be lying about the
ecosystem's supply chain in exactly the way this project exists to fix.

## Testing

```bash
npm test           # 199 tests, no network, no API key
npm run typecheck
```

Fixtures are real where reality matters: `test/fixtures/tx-nested.json` is a captured mainnet
transaction (6 outer instructions, inner groups at index 2 and 4, 11 CPIs, `stackHeight: 2`), and
`programdata-observed.json` holds the captured bytes that overturned the layout assumption, with the
`metaqbxx` renounced-authority case included. The deep-nesting, log-only, failed-transaction and
v0-address-table cases are generated by `test/fixtures/generate.mjs` against measured field shapes,
because a public node that prunes history will not serve them on demand — and the generator says so in
its header rather than passing them off as captures.

The tests that earned their place all started as code reviews of my own assumptions:

- *encoding equivalence* — pubkeys and indexes must produce the same graph;
- *depth-3 attribution* — `C` belongs to `B`, not to the transaction root;
- *budget stop mid-trace* — partial graph, `stoppedAt: act`, `cappedBy` set, no crash;
- *unobserved ≠ zero* — no prior graph must force a trace pull, not permit an early exit;
- *stoppedAt* — caught a hardcoded `'report'` that was hiding every budget-limited run;
- *ledger injection* — caught an engine holding its own ledger, which would have made every model
  citation fail forever;
- *slot_mismatch ≠ disagreement* — caught corroboration that would have cried wolf on every upgrade;
- *cursor no-progress* — caught a walk that hammered the endpoint when `until` was ignored.

## Known limitations

`dot limits` prints these with the full text and the escape route for each. They are output data, not
prose in a README, so a report can name the ones that actually applied to it.

| Code | What Dot cannot see |
|---|---|
| `HISTORY_RETENTION` | `getTransaction` returns whatever the node kept. Public endpoints retain days, not the program's life; **the live run above got `-32015` on every trace fetch**. A program whose integrators were busy last year can look dependent-free because the traces are gone. Fix: run continuously, or an archive node, or ingest from a live feed. |
| `SINGLE_NODE_TRUST` | Every number is one endpoint's word. Providers cache, filter, lag, and rate-limit; three public endpoints in this session went from working to `ETIMEDOUT` mid-build. `--secondary-rpc` now makes the load-bearing read corroborated, and `--verify` puts the second node's answer about the sampled transactions in the report as `chain_verified`. |
| `NO_CHAIN_WIDE_UPGRADE_SUBSCRIPTION` | Core JSON-RPC has no "all loader accounts" feed — that is why `src/rpc/yellowstone.ts` exists. `accountSubscribe` is per-account. |
| `GRPC_LIVE_PATH_UNVERIFIED` | **The Geyser transport is typechecked against generated types and unit-tested with a fake stream, but no live endpoint was reachable while it was written.** Handshake, auth and replay semantics are unverified in the field. |
| `CPI_DEPTH_ATTRIBUTION` | `innerInstructions` is flat. Depth comes from `stackHeight` or logs; both are optional and logs truncate. `attributionQuality` always says which. |
| `PARSED_INSTRUCTION_ACCOUNTS` | Parsed instructions have no `accounts` at all; Dot recovers them by matching `parsed.info` strings against the key table and tags every frame with how. |
| `PROGRAMDATA_REVERSE_LOOKUP` | A `ProgramData` write does not name its program, and PDA derivation is one-way. Unresolvable events are counted and skipped, never guessed. |
| `NO_IDL_CONTRACT` | No mandatory on-chain interface. No IDL → no semantic claim; `narrative.refused = "idl_unavailable"`. |
| `VALUE_IS_PROXY` | Routed value is a per-transaction upper-bound proxy; a swap cannot be split into legs. |
| `PDA_HOLDINGS_NOT_ENUMERATED` | Vault custody is invisible without a seed list or an indexer. Routed ≠ held. |
| `FAILED_TRANSACTIONS_ROLLED_BACK` | Failed CPIs are populated in the response but moved nothing; counted separately. |
| `SIGNATURE_INDEX_IS_KEY_BASED` | The index matches account keys, not roles, so samples contain noise. |
| `ADDRESS_TABLE_RESOLUTION` | Wrong v0 key composition misattributes edges silently. `keys.method` is reported. |
| `BLOCK_FETCH_AMPLIFICATION` | Batching cuts calls and multiplies bytes; the model is labelled until you calibrate it. |
| `FEED_BACKPRESSURE` | Under a storm the dispatcher drops events. Dropped has a counter; it is not clean. |
| `PRE_DEPLOY_PARTIAL` | Narrowed: `STAGED_UPGRADE` now fires when an image is uploaded but not yet live, with hash, size and staging authority. Still unseen: what the image *does*, the program it belongs to until it lands, and any governance delay — `finalizeEta` says `immediate_unless_governed` rather than inventing one. |
| `FINALITY_VS_LATENCY` | Reads are `finalized`, which costs minutes of detection. |
| `ENDPOINT_CORROBORATION` | Comparison is only valid same-slot; a lone live endpoint is `single_source`, not verified. |
| `NO_MALICE_DETECTION` | A tier is a queue position. Absence of a finding is not a clean bill of health. |

---

Dot was built by reading mainnet responses instead of reading docs about them. If it earns one thing,
it is that the on-chain supply chain is a graph that can be reconstructed from traces, and that a tool
which cannot tell you what it failed to see is worse than no tool at all.
