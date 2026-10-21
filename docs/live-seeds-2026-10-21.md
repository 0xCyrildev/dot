# Dot · FuCKerMRwwExvo5bGFGjszhBQXcZicVqU4H9LZjqHbVf

**P2** (tier source: exposure, score 51/100, confidence low) — event `upgrade`, mode `rules`, run ended at `report`

Trace ingestion: `per_signature` — 6 relevant tx(s) across 6 block(s), density 1.00 tx/block. per_signature: 6 call(s), ~39.0 kB. per_block: 6 call(s), ~78.0 MB (amplification 2000.0x, because a block carries every transaction in the slot, not yours). Calls 1.0x cheaper, bytes 2000.0x dearer. Chose per_signature because density 1.00 < floor 4. Cost model: defaults_unverified: run `dot calibrate --rpc <url>` to measure these.

> Tier capped by a blind spot: only 24% of the planned sample was retrievable from the node

ProgramData `BmArTGeoddLk3tts8AvH2ivNfVUtoHCX6V7dKDaVD4Xq`

## Blast radius

| metric | value |
| --- | --- |
| direct callers attributed | 0 |
| transitive callers (≤3 hops) | 0 |
| edges | 3 |
| CPI occurrences in sample | 13 (12 failed) |
| traces analyzed | 6 (3 transactions that failed outright) |
| **lamports moved (deduped)** | 63723520 (0.064 SOL) — use this figure |
| lamports attributed per call | 63723520 (0.064 SOL) — NOT a total, repeats across calls sharing an account |
| distinct mints touched | 0 |
| attribution | `logs` |
| history span of sample | 6.00 days |

## Why this tier
- **authority_posture** 30/30 — a single key can replace the program with no threshold and no delay
- **change_magnitude** 10/24 — bytecode size moved
- **dependents** 0/22 — 0 direct, 0 transitive attributed callers
- **cpi_volume** 3/12 — 13 attributed CPI occurrences in the sample
- **value_routed** 9/14 — 63723520 lamports moved (deduped per account per transaction; edge-sum attribution totals 63723520, which overcounts) across 0 mint(s)

## Decision
source `rules`, proceed `true`, plan `{"signatures":6,"rpcCalls":7,"useLlm":false,"wantedSignatures":25}`
> Wants 25 signature(s); only 6 affordable. authority is a single key: a one-wallet compromise can push a replacement immediately, with no threshold to wait on; no prior graph for this program: blast radius is unobserved, which is not the same as zero

## Hypothesis — `authority_risk`

**Claim.** the exposure here is the key, not the code: one signature can replace the program

| evidence for | evidence against |
| --- | --- |
| a single key can sign the next replacement with no threshold and no delay | no instruction-level view: the bytecode diff is bytecode_only or absent, so nothing here distinguishes a new entrypoint from a recompiled constant |
|  | no dependents were attributed in this sample — but that is what a thin sample always looks like |
|  | the sample Dot could afford (6) is below the 25 its own risk rule asked for |

**What more budget would test:**
- *(19 RPC)* widen the sample to the authority’s own transaction history to enumerate what else that key controls → the key reaches more programs than this one; compromise is a multi-protocol event, not a single-program one
- *(19 RPC)* check whether this authority signed upgrades for the same programs in the previous epoch (habit vs anomaly) → the cadence is habitual, which weakens the anomaly claim and strengthens the routine one

**Falsifier.** if the widened sample shows this authority signing upgrades for this program and no other program's ProgramData in the window, the blast radius is one program — the multi-protocol reading is denied
Widen path: widen skipped: 6 trace(s) parsed at 24% coverage — an empty dependent set here is a coverage gap, not a finding — co-controlled programs: 0

## Run stages
- `perceive` @ 3ms (0 call(s) spent): reading ProgramData for FuCKerMRwwExvo5bGFGjszhBQXcZicVqU4H9LZjqHbVf
- `perceive` @ 2101ms (1 call(s) spent): posture=eoa authority=w3mDDNmTLnp9FUfjdPrGZt7GyTBWzjyF5wGvzdQGDaD priorDependents=unobserved
- `decide` @ 2101ms (1 call(s) spent): rules: proceed=true plan={"signatures":6,"rpcCalls":7,"useLlm":false,"wantedSignatures":25}
- `act` @ 12090ms (8 call(s) spent): strategy=per_signature traces=6 pruned=0 errors=0 edges=3 quality=logs
- `evaluate` @ 12094ms (8 call(s) spent): score=51 tier=P2 confidence=low direct=0 transitive=0

## Budget

| | spent | limit |
| --- | ---: | ---: |
| RPC calls | 8 | 40 |
| signatures | 6 | 6 |
| LLM tokens | 0 | 20000 |
| wall | 12095ms | 90000ms |

RPC: 8 calls (0 retries, 0 pruned reads, 0 failures)

## Evidence
- `EV-1` [posture] authority=w3mDDNmTLnp9FUfjdPrGZt7GyTBWzjyF5wGvzdQGDaD posture=eoa bytecode=432384B at offset 45 discriminant=3 layout=u64+option33 sha256=570e4cd4703aad60…
- `EV-2` [trace] ingestion plan: 6 relevant tx(s) across 6 block(s), density 1.00 tx/block. per_signature: 6 call(s), ~39.0 kB. per_block: 6 call(s), ~78.0 MB (amplification 2000.0x, because a block carries every transaction in the slot, not yours). Calls 1.0x cheaper, bytes 2000.0x dearer. Chose per_signature because density 1.00 < floor 4. Cost model: defaults_unverified: run `dot calibrate --rpc <url>` to measure these.
- `EV-3` [trace] trace 1: slot=459718519 version=0 outer=3 innerGroups=0 attribution=logs keys=static_only
- `EV-4` [limit] widen skipped: 6 trace(s) parsed at 24% coverage — an empty dependent set here is a coverage gap, not a finding
- `EV-5` [limit] widen declined: no budget left to sample the authority history
- `EV-6` [limit] hypothesis [authority_risk]: the exposure here is the key, not the code: one signature can replace the program — falsifier: if the widened sample shows this authority signing upgrades for this program and no other program's ProgramData in the window, the blast radius is one program — the multi-protocol reading is denied

## What Dot could not see

### No IDL, no semantic claim
_There is no mandatory on-chain IDL. Anchor programs may or may not publish one, the legacy `anchor:idl` PDA is version- and size-dependent, and non-Anchor programs frequently ship a binary with no interface at all. In `mode: real` the model then has nothing to read, and Dot must say so instead of paraphrasing a bytecode diff._
→ `--idl <path|url>` to supply a published IDL and a prior version for a real diff. Without it, `narrative.refused = "idl_unavailable"` appears in the report and the tier rests only on posture plus observed graph.

### Historical transactions are whatever the node kept
_getTransaction returns null outside the node’s retention window. Public mainnet endpoints commonly retain on the order of days, not the chain’s full life, and the window is a BigTable/leader configuration Dot cannot read. A program whose integrators were busy in 2024 can show a small graph today because the 2024 traces are gone, not because nobody called it._
→ Run Dot continuously so the graph is built while the traces are still hot and persisted in Dot’s own store. For backfill, use a provider archive node, or `getBlock`/`getBlocks` streaming into your own indexer, or Yellowstone gRPC `subscribe` on transaction notifications, which is a live feed rather than a historical read.

### Core JSON-RPC has no "every bytecode change" feed
_There is no `getProgramChanges` and `subscribe*` is per-account. Watching the whole upgradeable loader means polling `getProgramAccounts` on a program that owns >100k accounts, which providers gate, rate-limit or reject outright._
→ Dot ships both layers: `watch --targets` polls a named list over JSON-RPC, and `watch --yellowstone <url>` subscribes by owner over Geyser and sees every `ProgramData` write on the cluster. The gRPC feed costs zero JSON-RPC calls, which is what makes chain-wide detection budget-feasible at all.

### innerInstructions is flat; depth is inferred, never given as a tree
_`meta.innerInstructions[i]` maps a group of CPI instructions onto one outer instruction index, and the list inside the group has no parent pointers. At CPI depth >= 3 the caller of a nested call is not recoverable from the group alone. Measured on mainnet, instructions do carry `stackHeight` and `meta.logMessages` carries `Program <id> invoke [N]`, and Dot uses both — but `stackHeight` is absent from `@solana/web3.js` v1 type declarations and is not guaranteed by every node, and the log collector truncates._
→ Dot reports `attributionQuality`: `stackHeight` (exact), `logs` (exact, truncation-bounded) or `flat` (upper bound only, nested callers credited to the top-level program). For guaranteed depth-agnostic capture, parse a Yellowstone gRPC transaction stream, or record with an instrumented validator, since neither depends on the RPC’s log caps.

### Value routed is an upper-bound proxy, per transaction, not per edge
_Lamports move between accounts; nothing in the response says "this transfer belongs to this CPI leg". Dot sums positive balance deltas over the accounts a call touched, and takes token deltas from pre/postTokenBalances, which are per-transaction arrays. A swap through a router that touches six accounts is counted once on the receiving side, and cannot be split into legs._
→ Treat it as a ranking signal. For a settlement-grade number you need an account-level state diff per instruction, which means an instrumented node or an indexer that stores instruction-level balance changes.

### Program-held vaults are only enumerable with a declared seed list
_TVL sitting in a program’s PDAs is not visible from the transaction sample, and the seeds that derive those PDAs live in the deployment repo. Dot can only read custody for seed patterns an operator has declared; for everyone else the figure stays unknown, and unknown is printed as unknown. Typed seeds matter too: the encoding `u8:0` is the byte 0x00, and hashing the ASCII character for zero instead derives a different address that resolves to nothing._
→ `--seeds seeds.example.json` derives each PDA, reads them in `getMultipleAccounts` chunks of up to 100, and sums lamports plus raw token units per mint. It reports unresolved seed variables, absent accounts and an incomplete sweep separately — see `renderHoldings`, which refuses to print a USD figure and states that absence is not zero holdings.

### getSignaturesForAddress matches keys, not roles
_The index returns any transaction where the address appears as an account key: as the invoked program, as a CPI target, as a mint, as a PDA, as a token account. For an id that is also a commonly-referenced account, the sample fills up with transactions that have nothing to do with the program’s execution._
→ Filter on "appears as a program id in an instruction" during normalization, which Dot does by dropping frames whose program never actually ran. Sample size and `sampleCoverage` are reported so a reader can see how much of the window was noise.

### Dot sees that an image is staged; it does not see what the image does
_Narrowed, not closed. The loader’s staging `Buffer` account is visible to the Geyser owner filter, so `dot watch --yellowstone` now emits `STAGED_UPGRADE` with the image hash, size and staging authority, and `STAGED-NOOP` when the bytes already match what is live. What remains unseen: without a published IDL pair there is no semantic reading of the staged image, no source, no repository, and no CI signal. A `Buffer` account also **names no program** — `upgrade` receives the program as a transaction argument — so attribution is deferred until the bytes land, and Dot marks it `UNATTRIBUTED` rather than guessing. There is likewise no protocol-level timelock to read: the loader applies new bytecode on the upgrade transaction itself, so `finalizeEta` reports `immediate_unless_governed` unless the operator declares a delay via `--timelock-ms`. An invented ETA would be the most dangerous number in this tool, because it is the one an operator would schedule against._
→ Supply `--idl`/`--prior-idl` so `mode: real` can read the delta; pair the staged signal with a static analyzer on the staged bytes. Run Dot long enough for bytecode-hash landing to attribute earlier stages, and record `pending()` to see how many images are still unattributed.

### Finalized-only means slow-only
_Dot reads at `finalized` because a graph built on `processed` data can be reorged out from under it. That costs minutes of detection latency, which matters if the upgrade you are watching is being exploited right now._
→ `--commitment confirmed` trades reorg risk for latency. Do not use `processed` for a persisted graph.

### One RPC node is one point of failure and one point of view
_A provider can cache, filter, lag, or serve you a node that is behind. Every number in a Dot report is a statement about what one endpoint chose to return. A quiet blast radius can mean a filtered node._
→ `--secondary-rpc <url>` reads the `ProgramData` account from both endpoints and halts on a same-slot contradiction; each endpoint gets its own `Budget` so a retry on one cannot silently spend the other’s. `rpc.rpcErrorCodes` and `pruned` remain the first places to look.

### Dot ranks attention; it does not adjudicate guilt
_Nothing here determines whether an upgrade is malicious. A P0 says "posture and blast radius justify a human before the weekend", and a P3 says "the evidence Dot could gather does not". Absence of a finding is not a clean bill of health, and the tier is a queue position, not a verdict._
→ Read the `components` array and the evidence ledger before escalating to anyone. If `cappedBy` is non-null, the tier is capped by a blind spot and the next step is a better data source, not a louder alarm.

---
Dot ranks where a human should look first. It does not establish that this upgrade is malicious, and a low tier is a statement about the evidence Dot was able to gather — not an absence of risk. Generated 2026-10-21T18:57:11.057Z.