# Limits that apply to FuCKerMRwwExvo5bGFGjszhBQXcZicVqU4H9LZjqHbVf

ProgramData `BmArTGeoddLk3tts8AvH2ivNfVUtoHCX6V7dKDaVD4Xq` at slot 459725242, upgrade authority `eoa` (w3mDDNmTLnp9FUfjdPrGZt7GyTBWzjyF5wGvzdQGDaD), 432384 bytecode bytes.
Probed with 4 RPC call(s).

| limit | status | what was observed | catalogue state | way out |
| --- | --- | --- | --- | --- |
| `ENDPOINT_CORROBORATION` | **applies** | measured on mainnet: two endpoints asked concurrently answered the same account read 9 slots apart, and minContextSlot is a lower bound, not a pin — a mutable account cannot be compared at one moment over plain RPC | RESOLVED | ResilientClient compares only same-slot reads and splits the outcomes: agreed, disagreed (halt, P0 with… |
| `NO_IDL_CONTRACT` | **applies** | no IDL was supplied and the on-chain attempt found none: Dot has names for nothing in this bytecode | UNRESOLVABLE_IN_CODE | --idl <path|url> to supply a published IDL and a prior version for a real diff. |
| `CPI_DEPTH_ATTRIBUTION` | **probe_clean** | the probed transaction carries stackHeight, so CPI depth is attributed exactly for traces of this shape | NARROWED | Dot reports attributionQuality: stackHeight (exact), logs (exact, truncation-bounded) or flat (upper bound… |
| `FINALITY_VS_LATENCY` | **probe_clean** | this node reports the newest signature finalized; Dot reads at the commitment it was given and prints which one | UNRESOLVABLE_IN_CODE | --commitment confirmed trades reorg risk for latency. |
| `HISTORY_RETENTION` | **probe_clean** | one probe at the newest end: slot 459718519 was retrievable. The far edge of the window is what matters and it is invisible from here | UNRESOLVABLE_IN_CODE | Run Dot continuously so the graph is built while the traces are still hot and persisted in Dot’s own store. |
| `PARSED_INSTRUCTION_ACCOUNTS` | **probe_clean** | the probed transaction resolved instruction accounts through the key table | NARROWED | Dot accepts both entry types, resolves them through one table (src/graph/keys.ts), tags every frame… |
| `PROGRAMDATA_REVERSE_LOOKUP` | **probe_clean** | the Program account names the derived ProgramData, so the pair is confirmed from the program side | NARROWED | ProgramIndex resolves it three ways, cheapest first, and stamps the method on the answer: pointer accounts… |
| `SINGLE_NODE_TRUST` | **probe_clean** | 2 endpoints configured for the load-bearing reads — a second provider's word, which is not the same as independence | NARROWED | --secondary-rpc <url> reads the ProgramData account from both endpoints and halts on a same-slot… |
| `ADDRESS_TABLE_RESOLUTION` | **by_construction** | the probed transaction uses no lookup table; the limit is about the ones that do | RESOLVED | Dot resolves both paths and reports keys.method plus any unresolvedIndexes as anomalies in the evidence… |
| `BLOCK_FETCH_AMPLIFICATION` | **by_construction** | not a property of this program: a block carries every transaction in the slot, so batching trades calls for bytes | UNRESOLVABLE_IN_CODE | Dot plans against an explicit cost model, prints both sides of the trade in the report (callSavingRatio,… |
| `BYTECODE_SCANABILITY_UNVALIDATED` | **by_construction** | not a property of this program: the discriminator scan is validated against Anchor’s derivation rule, not against a compiled .so | NARROWED | Point the gated test at any real artifact: DOT_TEST_SO=program.so DOT_TEST_IDL=idl.json npx vitest run… |
| `FAILED_TRANSACTIONS_ROLLED_BACK` | **by_construction** | not a property of this program: a failed transaction proves reach and intent, not a state change | RESOLVED | Dot keeps failedCpiOccurrences and tracesFailed separate from the value sums, so an integrator that started… |
| `FEED_BACKPRESSURE` | **by_construction** | not a property of this program: a live feed that cannot keep up drops events, and dropped is not clean | UNRESOLVABLE_IN_CODE | UpgradeDispatcher caps each investigation at --per-event-rpc (default 50) and the daemon at --daily-rpc,… |
| `GRPC_LIVE_PATH_MOCKED` | **by_construction** | not a property of this program: the Geyser path is exercised against encoded frames until an endpoint is configured | NARROWED | Set YELLOWSTONE_ENDPOINT (and YELLOWSTONE_TOKEN) to un-skip the live test in yellowstone-live.test.ts, then… |
| `NO_CHAIN_WIDE_UPGRADE_SUBSCRIPTION` | **by_construction** | not a property of this program: detecting its upgrade needs a watch entry or a Geyser feed either way | RESOLVED | Dot ships both layers: watch --targets polls a named list over JSON-RPC, and watch --yellowstone <url>… |
| `NO_MALICE_DETECTION` | **by_construction** | not a property of this program: Dot measures blast radius and does not classify intent | UNRESOLVABLE_IN_CODE | Read the components array and the evidence ledger before escalating to anyone. |
| `PDA_HOLDINGS_NOT_ENUMERATED` | **by_construction** | not a property of this program: custody lives in PDAs whose seeds are in the deployment repo, not on the chain | NARROWED | --seeds seeds.example.json derives each PDA, reads them in getMultipleAccounts chunks of up to 100, and sums… |
| `PRE_DEPLOY_PARTIAL` | **by_construction** | not a property of this program: a Buffer has no back-link to the program it becomes | NARROWED | Supply --idl/--prior-idl so mode: real can read the delta; pair the staged signal with a static analyzer on… |
| `SIGNATURE_INDEX_IS_KEY_BASED` | **by_construction** | not a property of this program: getSignaturesForAddress matches keys, never roles, so the caller comes only from the inner-instruction fold | NARROWED | Filter on "appears as a program id in an instruction" during normalization, which Dot does by dropping frames… |
| `VALUE_IS_PROXY` | **by_construction** | not a property of this program: value routed is a per-transaction upper bound, never TVL | UNRESOLVABLE_IN_CODE | Treat it as a ranking signal. |
| `WEB3JS_JSONPARSED_VALIDATOR` | **by_construction** | not a property of this program: @solana/web3.js v1 rejects parsed inner instructions, which is why Dot owns the RPC layer | RESOLVED | Call the RPC directly and parse against Dot’s own wire types (src/rpc/wire.ts), which model accounts as… |

_Full remedy text for every row: `dot limits`._
Applies: 2. Probed clean: 6. Not probed: 0. Property of the source rather than the program: 13.

_`probe_clean` is the narrowest claim in this table: one probe found nothing wrong at the point it touched, and the evidence column names that point._
