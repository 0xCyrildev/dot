# Submission: Dot — agentic blast-radius analysis for the Solana on-chain supply chain

**Repo:** `@zeroxcyril/dot` (npm publish blocked; see §5 of `docs/blocked.md`)
**Ecosystem:** Solana · **Language:** TypeScript, Node ESM · **Category:** dynamic analysis / upgrade & supply-chain monitoring
**Interfaces:** CLI (6 bins), library, MCP server over stdio, agent skill (`skill/dot/`)
**Evidence of being built against the chain:** [`docs/lessons.md`](./lessons.md) · [`docs/live-run-2026-10-21.json`](./live-run-2026-10-21.json)

---

## 1. Five-minute reproduction — no endpoint, no API key, no network

```bash
git clone <repo> && cd dot
npm ci && npm run build
npm test                                   # 193 passed, 1 skipped (a gated live-endpoint test)

# The real parser, run over a real mainnet transaction that ships in the repo:
node dist/cli/index.js replay \
  --fixture test/fixtures/tx-nested.json \
  --target  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA \
  --provenance "captured from api.mainnet-beta.solana.com on 2026-10-21"

# What it refuses to see, in three states:
node dist/cli/index.js limits --status
```

The graph, from bytes that came off the chain:

```
slot 459628002  version legacy  succeeded  keys via static_only
6 outer instruction(s), 2 inner group(s), 11 CPI instruction(s), attribution stackHeight

  depth 2  AToken…8knL -> Tokenk…Q5DA [spl-token]   via stackHeight
  depth 2  pAMMBa…fXEA -> Tokenz…xuEb [token-2022] via stackHeight
  depth 2  pAMMBa…fXEA -> Tokenk…Q5DA [spl-token]   via stackHeight
  depth 2  pAMMBa…fXEA -> pAMMBa…fXEA              via stackHeight   ← a real self-CPI

Aggregated edges:
  AToken…8knL -> Tokenk…Q5DA   count=3 lamports=313067416 txs=1
  pAMMBa…fXEA -> Tokenz…xuEb   count=1 lamports=313067416 txs=1
  pAMMBa…fXEA -> pAMMBa…fXEA   count=1 lamports=0         txs=1

Direct dependents of pAMMBa…fXEA: 0
One transaction, replayed from captured bytes. It is not a sweep and does not stand for one.
```

Three details in that output are the whole product. The edge at outer index 4 is attributed to the
program that *made* the call, because `innerInstructions[].index` is folded onto its parent first. The
self-CPI is kept rather than filtered, because a program calling itself is a real coupling an upgrade
changes. And `Direct dependents: 0` is honest for one transaction — the dependents of a program come from
many traces, which is what `dot analyze` and `dot blast-radius` go and fetch.

With a reachable RPC, the same engine produces the sweep:

```bash
dot analyze JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 --depth 3 --secondary-rpc <url2>
dot blast-radius --since 2026-10-20 --min-value 100000000000 --authority-map authorities.json
```

No Jupiter graph is printed here, because no endpoint was reachable while this was built
(`UND_ERR_CONNECT_TIMEOUT` on three public RPCs). The preserved real artifact
[`live-run-2026-10-21.json`](./live-run-2026-10-21.json) is instead — including the part where the node
refused history and the report said `cappedBy: "only 0% of the planned sample was retrievable from the
node"`, tier P3, confidence **low**. That is the failure case behaving correctly, and it is shipped as an
example on purpose.

## 2. The three chain contradictions

Written against measured mainnet responses. Three load-bearing assumptions in the original design died
on contact with the chain; full accounts in [`docs/lessons.md`](./lessons.md).

**1. `@solana/web3.js` cannot deserialize its own `jsonParsed` output.**

```
Connection.getTransaction(sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 })
→ StructError: At path: meta.innerInstructions.0.instructions.0.accounts
  -- Expected an array value, but received: undefined
```

Parsed instructions carry no `accounts` field — the account set is inside `parsed.info` — while the v1.99
superstruct declares it required. It threw on the first CPI-heavy mainnet transaction tried, and the
second. Dot therefore owns its JSON-RPC layer and uses web3.js only for `PublicKey`/PDA derivation. A
tool that wrapped that call in `try/catch` and carried on would have reported "no dependencies found" for
the most integrated programs in the ecosystem: a swallowed parse error is a confident false negative.

**2. Instruction `accounts` are pubkeys in `jsonParsed` and indexes in `json`.**

```
jsonParsed → accounts: ["6tv7sUQ4R3fE9rnBX4w72oiiqSHqKF3KPvyubFNfazxd", …]
json       → accounts: [1, 5, 12]
```

Assuming the second shape while serving the first evaluates `keys["6tv7sUQ4…"]` → `undefined` and
concludes nothing moved. No throw, no warning — a zero where the risk was. Both shapes resolve through one
table, and an equivalence test asserts the same trace in either encoding yields the same graph.

**3. `ProgramData` is not the layout the SDK describes.** Measured across several live programs:
`ProgramData` discriminant **3**, `Program` discriminant **2** — inverted from the
`UpgradeableLoaderState` enum order — and the **ELF magic at byte 45**, preceded by `u64 + Option<Pubkey>`
with **no `data_len` field**. Reading the documented layout lands on `0x7f454c46` and calls it a length.
So change detection hashes the *whole account*, which cannot miss a rewrite regardless of layout, and the
bytecode-only hash is computed after the magic is *found*; an account where it is not found raises
`UNKNOWN_PROGRAMDATA_LAYOUT` rather than hashing a guessed window. A watcher with a wrong offset does not
error — it reports an all-clear forever.

Two smaller ones: `stackHeight` is returned by mainnet but absent from web3.js v1's types (it is what
makes depth attribution exact), and `@triton-one/yellowstone-grpc` v9 takes `accounts.owner` as a **base58
string**, with `lamports`/`slot`/`writeVersion` as **decimal strings** — pass bytes where it wants a
string and your filter matches nothing, which looks identical to a quiet chain.

## 3. Why it is different: the ecosystem is a graph, not a set of programs

| Phase | Tool | Question it answers |
|---|---|---|
| Before deployment | static analyzers (SolanaShield, Sentio) | what could this program do? |
| At build time | dependency scanners (LoserLab) | is this npm package hostile? |
| Per transaction | runtime monitors (GulfWatch) | is this known-bad transaction running? |
| **At upgrade time** | **Dot** | **who breaks, and how much value was in the way?** |

A program's callers are in no source tree. They are in the transaction history of every integrator that
ever did a CPI into it. When B's bytecode is replaced, every caller inherits B's new behaviour including
the parts they never reviewed, and the only artifact that records who they are is the ledger.

Dot also sees the moment *before* the landing. The loader's staging `Buffer` account is visible to the
Geyser owner filter, so `dot watch --yellowstone` emits `STAGED_UPGRADE` — image hash, size, staging
authority — while the change is still uploadable-not-live, and `STAGED-NOOP` when the bytes already match
production.

**Agentic, specifically:**

- One run is `perceive → decide → act → evaluate → report` under a `Budget` charged **before** each
  request; a failed call is a spent call and every retry is charged again.
- `decide` exists to avoid `act`. A multisig-held program with a known empty graph stops after **one RPC
  call** and still emits a full report of what it declined to spend.
- **It asks for budget instead of returning a thin answer.** Where posture is a single key and the
  affordable sample cannot distinguish "no dependents" from "not in the sample", the run returns
  `needs_more_budget` with the number of calls and what they would confirm; the CLI prints
  `Re-run with --budget-rpc +N` and exits **4** — distinct from 3 (a stop was reached), 1 (it broke) and
  5 (the limit catalogue failed its own test).
- The plan is provably derived from budget state: a 10-call budget plans ≤9 signatures, a 400-call budget
  plans 25 (what the posture wants), and a test asserts they differ.
- Sample coverage is measured against what the risk *wanted*, not what the budget allowed — otherwise a
  1-of-25 sample reports a flattering 100% and the capped-tier rule reads the lie.
- When a single-key program shows no dependents on a meaningful sample, the agent **widens to the
  authority's own history** and reports what else that one key reaches, explicitly as co-control and not
  as dependents — because two programs sharing a transaction share no CPI edge.
- Chain-wide mode caps each investigation at `--per-event-rpc` and the daemon at `--daily-rpc`, serves
  authority handovers ahead of routine bytecode writes, drains serially, and **counts every dropped
  event**. A daemon that dropped forty upgrades does not look like one that saw none.

## 4. What Dot sees that a static analyzer does not

A static analyzer reading `pAMMBay6oce…` sees `invoke()` and flags a missing account check inside one
program. Dot, on the captured transaction above, reports the actual call edge — *this* program called
*that* program at outer instruction 4, through these accounts, with 313,067,416 lamports credited to an
account the call touched, and called itself while doing it. Multiply that by the sample and you get the
thing no repository contains: the dependent set, ranked.

`dot blast-radius` answers the plural question — *which upgrade in this window deserves a human first* —
by discovering loader transactions over plain JSON-RPC (`getSignaturesForAddress(BPFLoaderUpgradeable)`
**is** the chain-wide upgrade ledger) and proving each program/programdata pair by re-deriving the PDA
locally rather than trusting a discriminator or the node's parsing. Its output is a **warning list**, not
a leaderboard: who to notify, by each dependent program's own upgrade authority, or an explicit count of
authorities it could not read.

And the part a graph cannot give you: **what the upgrade does**. Because Dot keeps every image
it has seen in a local content-addressed vault, an upgrade can be diffed at the entrypoint level —
Anchor instruction selectors are `sha256("global:<name>")[0..8]`, so locating the named selectors in
the old and new images yields added, removed and persisting entrypoints with no decompiler involved.
Two output rules make that a security artifact rather than a changelog: a selector reachable in the
new image but **absent from the new IDL** is reported as an undeclared entrypoint instead of being
discarded as an unmatched candidate, and an instruction the new IDL declares that is not located in
the image is reported as unconfirmed instead of being quietly called removed. Where there is no IDL,
or no prior image in the vault, the diff says `bytecode_only`/`partial` and refuses to name an
instruction at all — because RPC has no historical account state, the "before" side only exists if
Dot was watching.

The ranking model is stated rather than hidden: value is scored **linearly** (capped at the reference) and
dependents **log-scaled**, so `$400M through 2 dependents` outranks `$40M through 14`. Log-scaling
both axes — the obvious choice — inverts that, because it compresses a 10x value difference into noise and
lets breadth win. `composite = valueScore × (1 + dependentsScore)` ships alongside every score.

## 5. What Dot does not see — in three states, not two

`dot limits --status` prints 21 codes: **5 RESOLVED** (each names test files, and `verifyTestClaims()`
exits 5 if a named test is missing or contains no `it()`), **9 NARROWED**, **7 UNRESOLVABLE_IN_CODE**.
The third category exists because a two-state table forces a bad choice between claiming a fix and filing
a property of the chain under "not done".

- `HISTORY_RETENTION` — **unresolvable in code.** Retention is a provider decision; three public
  mainnet endpoints in this build environment refused all ten trace fetches with `-32015` while
  answering state reads. Dot classifies that as missing history, not as an error, and caps the tier on
  it. The proposed prefetch-warm cache is **not implemented**, and the limit file says so rather than
  implying otherwise.
- `VALUE_IS_PROXY` — **unresolvable in code.** Nothing in the RPC response binds a transfer to a CPI leg,
  so a router swap cannot be split. Lamports are credited once per receiving account per transaction;
  `lamportsMovedDeduped` is the total, and the per-edge sum is still printed, labelled as not additive.
  No USD figure is ever printed unless an operator passes `--sol-usd`.
- `PDA_HOLDINGS_NOT_ENUMERATED` — **narrowed, not closed.** `--seeds` derives PDAs from a declared list
  (typed seeds: `u8:0` is the byte `0x00`, not the character `'0'`), reads them in
  `getMultipleAccounts` chunks, and reports unresolved seed variables, absent accounts and an incomplete
  sweep separately. A publisher who shares no seeds has, by construction, unobservable custody.
- `NO_IDL_CONTRACT`, `NO_MALICE_DETECTION`, `FINALITY_VS_LATENCY` — chain and intent, not code.
- `GRPC_LIVE_PATH_UNREACHABLE` — honest about its own build: raw protobuf frames built with the codec
  and carrying captured `ProgramData` bytes are decoded and still yield the right upgrade authority, but
  **no provider has ever delivered a frame to this build**. Probing six Geyser hostnames on 2026-10-21
  turned up a bug first: `start()` never called the v9 client's `connect()`, so every live attempt threw
  locally in ~1 ms and *looked* like a provider outage. Fixed, and two more defects found by the same
  probe — a `connect()` that can hang forever now has a bounded timeout, and a dropped stream now keeps
  the provider's reason instead of rethrowing an empty envelope. What remains unproven is liveness: the
  native client answers a missing token, an absent Geyser service and a refused filter with one identical
  opaque string (measured — `api.mainnet-beta`, which has no Geyser at all, fails with the same text as
  `api.rpcpool.com`), so `isReplay`, keepalive and reconnect have still never been exercised against a live
  endpoint here. The gated test skips rather than passing vacuously. `docs/blocked.md` §3 carries the
  hostnames, the timings and the reproduction command.

Detection is deterministic throughout. In `--mode real` a model reads the IDL delta and the dependent list
and writes an advisory — *what is the likely impact, what should those operators do* — with the four
inputs it was given recorded in the output. It cannot set a tier, and an answer citing an evidence id Dot
never issued is **discarded whole, not trimmed**, with the refusal printed.

## 6. MCP integration

```bash
npx -y -p @zeroxcyril/dot dot-mcp        # after publish
node dist/cli/index.js mcp               # today
```

Four tools — `dot_blast_radius`, `dot_evaluate_upgrade`, `dot_limits`, `dot_watch_status` — all requiring
a `budget` argument so an orchestrator cannot ask for an unbounded scan by accident. `test/mcp.test.ts`
spawns the process over real stdio pipes and asserts every stdout line is parseable JSON-RPC, because one
stray `console.log` corrupts the stream and the host drops the connection with no useful error.

```json
{ "jsonrpc": "2.0", "id": 4, "method": "tools/call",
  "params": { "name": "dot_evaluate_upgrade", "arguments": {
    "program": "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    "budget": { "maxRpcCalls": 60, "maxSignatures": 60, "maxLlmTokens": 0, "maxWallMs": 60000 },
    "event": { "kind": "authority_change", "beforeAuthority": "JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd" },
    "knownMultisigs": [] } } }
```

<!-- The keys below are asserted against a real tool call in test/submission.test.ts,
     which runs dot_blast_radius against a local stub RPC; the values are from that run. -->
```json
{ "result": { "structuredContent": {
    "tier": "P1", "tierSource": "exposure", "score": 47, "confidence": "medium",
    "stoppedAt": "report", "cappedBy": null, "decisionSource": "rules",
    "directCallers": 6, "transitiveCallers": 18,
    "lamportsRouted": 313067416, "valueIsProxy": true,
    "attributionQuality": "stackHeight", "integrity": "single_source",
    "budget": { "limits": { "maxRpcCalls": 60 }, "spent": { "rpcCalls": 34, "signatures": 30 } },
    "limits": ["NO_IDL_CONTRACT","VALUE_IS_PROXY","SINGLE_NODE_TRUST","HISTORY_RETENTION"],
    "components": [ { "name": "authority_posture", "points": 11, "max": 26,
                      "why": "authority not classifiable from chain data" } ] } } }
```

`dot_watch_status` distinguishes "no upgrades detected" from "nobody is watching": with no status file it
returns `available: false` with the reason and the path it looked at, and flags a cursor older than five
minutes as `stale`. A P0 with `tierSource: "integrity"` means two endpoints contradicted each other at
the same slot — a halt about the tool's inputs, never a verdict about the program.

The skill at [`../skill/dot/SKILL.md`](../skill/dot/SKILL.md) is the instruction layer for an agent
calling these tools, and its central section is **how to read a nothing**: no scan ran / range empty /
target not matched / target reached and clean. An agent that has only ever seen successful scans will
report an empty range as a clean one, and that single confusion is the failure mode this whole design
exists to prevent.

## 7. An ask that can be wrong, a second node that can disagree, and a table about one program

Three things a script cannot do, added after the first submission draft, because each one
converts a missing number into a claim someone can check.

**The escalation is a hypothesis, not a complaint.** When the affordable sample cannot settle the
question, `needs_more_budget` carries `claimKind`, the claim, the evidence for and against it, a test
plan with a price on every step, and the one observation that would knock it down. It is *derived* from
what this run saw — an undeclared selector beats an added entrypoint beats a removed one beats an
`eoa` authority beats a routine multisig release — and when nothing supports a claim, the kind is
`unknown_coverage` and the claim is about Dot's own visibility. `--hypothesis-out` writes it; a funded
run with `--hypothesis-file` answers it instead of re-deriving it, and the re-test refuses to settle a
claim it cannot afford or whose observation never ran: a full 8-of-8 sample whose widen path declined
on coverage grounds comes back `not_testable` with the shortfall, never `denied`. A model may write the
same shape, through the same all-or-nothing citation gate.

**`--verify` asks the second node about the report, not just the upgrade.** `chain_verified`
cross-checks the `ProgramData` bytes, the `Program` pointer, the sampled transactions (instructions,
accounts, slot, balance deltas — `logMessages` excluded, since providers truncate differently) and each
node's own claim about finality. Verdicts are `agree | contradict | inconclusive | unconfirmed`, and
that distinction came from running it: two public endpoints asked *concurrently* answered the same
account read 9 slots apart, and `minContextSlot` is a lower bound, so a mutable account cannot be
compared at one moment over plain RPC — while finalized transactions can. One provider had a sampled
signature the other reported pruned, which is a retention difference, not a disagreement.
`CANNOT_PROVE` travels with the flag: no inclusion proof exists in core RPC, and a hostname is not
proof that two endpoints are independent. The real run, reproduced at the same numbers on a second
call, is `live-verify-2026-10-21.md`.

**`dot limits --for <program>` answers "which of these, here?"** The catalogue says what Dot can never
see; four calls decide which limits are live for one address, in four statuses — `applies` (observed),
`probe_clean` (nothing wrong found *at the point one probe touched*, and the evidence column names that
point), `not_probed` (this run could not look), `by_construction` (no probe of one program would change
it). It answers `CPI_DEPTH_ATTRIBUTION` by looking for `stackHeight` in a fetched transaction rather
than quoting the spec, and confirms the (program, programData) pair from the program side.
`live-limits-for-2026-10-21.md` is that output, from mainnet.

**Re-measured, not inherited.** RPC egress came back on this box during this session, so
`docs/blocked.md` §2 now records what has been run against mainnet and what has not: `calibrate` has
still never measured a real block, `--seeds` has summed no live vault, the Geyser path has still never
met a live endpoint, and the package is still unpublished (`E401`). The artifacts above are the
measured ones; everything else stays labelled as the claim it is.

---

**In one line.** Dot ranks what breaks when a Solana program changes, shows the arithmetic behind the
ranking, cites the evidence behind every claim or discards the claim, asks for budget in the form of a
falsifiable hypothesis a better-funded run has to answer, and prints what it could not see in every
report — including the reports where what it could not see was everything.
