# Submission: Dot — agentic blast-radius analysis for the Solana on-chain supply chain

**Repo:** <https://github.com/0xCyrildev/dot> · **npm:** `@zeroxcyril/dot@1.1.0` is what the registry serves (`npm view @zeroxcyril/dot dist-tags`, measured 2026-10-22, and the published tarball was unpacked and checked: it carries the danger ranking, `dist/score/danger.js`, and the funding probe, `dist/agent/funding.js`). Install evidence is checked rather than asserted: `bash scripts/verify-install.sh --from registry` installs from the registry and executes all six bins (`docs/blocked.md` §1). One bug is fixed on `main` and not yet in a release: 1.1.0's `--threshold` parser rejects the `2-of-3` form its own help text quotes
**Ecosystem:** Solana · **Language:** TypeScript, Node ESM · **Category:** dynamic analysis / upgrade & supply-chain monitoring
**Interfaces:** CLI (6 bins), library, MCP server over stdio, agent skill (`skill/dot/`)
**Evidence of being built against the chain:** [`docs/lessons.md`](./lessons.md) · [`docs/live-run-2026-10-21.json`](./live-run-2026-10-21.json)

---

## 1. Five-minute reproduction — no endpoint, no API key, no network

```bash
git clone <repo> && cd dot
npm ci && npm run build
npm test                                   # offline suite; count recorded in RELEASE-v1.0.0.md

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
Dot was watching. **And where the scan cannot read the image, it says so instead of going quiet.**
The contiguous-constant assumption was measured against compiler-emitted SBF, found false (0 of 10
and 0 of 6 selectors are contiguous bytes), and then repaired: `src/state/sbfSelectors.ts` decodes
`.text` and recovers **10 of 10** immediate-pair selectors and **6 of 6** compare-chain selectors on
the two committed images, so entrypoint added/removed/undeclared claims are now demonstrated on
framework-compiled bytecode and not only on constructed images. What remains blind is an emission
shape the recovery has not been shown on, and that case still reports `confidence: "unscannable"`,
still rewords "declared but not found" as *not seen*, and still cannot confirm a carried hypothesis
by finding nothing (§9, and `docs/blocked.md` §4 for both images and the build commands).

The ranking model is stated rather than hidden: value is scored **linearly** (capped at the reference) and
dependents **log-scaled**, so `$400M through 2 dependents` outranks `$40M through 14`. Log-scaling
both axes — the obvious choice — inverts that, because it compresses a 10x value difference into noise and
lets breadth win. `composite = valueScore × (1 + dependentsScore)` ships alongside every score.

**The last thing a document cannot give you is per-program answers.** A README's limitations section says
what is generally invisible; an operator asking "can I trust *this* number for *this* address" needs a
different sentence. `dot limits --for <program>` spends about four reads and answers it: `applies`
(observed here — the node refused `-32015` for this program, no IDL is reachable, the Program account
names a different ProgramData than the one Dot would read), `probe_clean` (one probe found nothing wrong
*at the point it touched* — a retrievable newest signature says nothing about where the retention window
ends, and the evidence column says exactly that), `not_probed` (this run could not afford to look), and
`by_construction` (a property of the source or of intent, which no probe of one program would change).
Measured, on a program upgraded the same day: `docs/live-limits-for-2026-10-21.md` — 4 calls, 432,384
bytecode bytes, `eoa` authority, 2 applies / 6 probed clean / 13 by construction. It answers
`CPI_DEPTH_ATTRIBUTION` by looking for `stackHeight` in a transaction it just fetched, instead of quoting
the specification at the reader.

## 5. What Dot does not see — in three states, not two

`dot limits --status` prints 22 codes: **4 RESOLVED** (each names test files, and `verifyTestClaims()`
exits 5 if a named test is missing or contains no `it()`), **11 NARROWED**, **7 UNRESOLVABLE_IN_CODE**.
The third category exists because a two-state table forces a bad choice between claiming a fix and filing
a property of the chain under "not done".

The count moved during this session in the direction that *reduced* Dot's claim: chain-wide upgrade
detection had been marked RESOLVED because the Geyser transport exists, but its live test is gated on an
endpoint this box does not have, so the green label was resting on a check that never ran. It is now
NARROWED with the deviation recorded (`statusFor('NO_CHAIN_WIDE_UPGRADE_SUBSCRIPTION').deviation`), and
`test/limits-status.test.ts` asserts it stays that way while no provider has answered. A taxonomy that
only ever gains RESOLVED rows is marketing, not accounting.

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

### Blocked, each with the command that would unblock it

`docs/blocked.md` records four items. They are written as "here is how to do this on a machine
that can", never as a shrug, because a blocked verification replaced by a plausible-looking
substitute is how a tool like this ships a lie.

| blocked item | what would close it | still true after closing it |
|---|---|---|
| [§1 npm publish](./blocked.md#1-publishing-zeroxcyrildot-to-npm--closed-published-2026-10-22) | **Closed on 2026-10-22.** The first publish reported `1.0.0` from all six bins of a throwaway-prefix registry install, and `npx -y -p @zeroxcyril/dot dot-limits --status` printed the catalogue. Re-measured the same day after 1.1.0 went out: `npm view @zeroxcyril/dot dist-tags` is `latest: 1.1.0`, and the unpacked tarball contains `dist/score/danger.js` and `dist/agent/funding.js`, so the ranking and the malice axes are installable rather than main-only. | `test/skill.test.ts` cannot reach the registry (the suite is offline), so it pins the *structure* of the claim rather than the claim: a quoted version is either the manifest's or sits in a sentence naming the registry, and when the two differ the docs must say the manifest version is unpublished. Doc/manifest agreement alone was the wrong guard — it was satisfied while `package.json` said 1.1.0 and the registry had never seen one. |
| [§2 live mainnet verification](./blocked.md#2-live-mainnet-verification--partly-unblocked-egress-returned-2026-10-21) | Already partly done: egress returned mid-session and `analyze`, `--verify`, `calibrate`, loader-index discovery and `--seeds` have all been run against mainnet. What remains is `blast-radius` at sweep scale and a second provider that is not another public endpoint. | Block retention is a property of the node, not of this session: the `-32015` refusal stands whatever else gets reachable. |
| [§3 Yellowstone gRPC against a live endpoint](./blocked.md#3-yellowstone-grpc-against-a-live-provider--no-frame-received-and-the-probe-found-two-bugs-in-dot) | A token: `npx tsx scripts/probe-geyser.ts` reproduces the whole table; `YELLOWSTONE_ENDPOINT=… YELLOWSTONE_TOKEN=… npx vitest run test/yellowstone-live.test.ts` is the gated live run. The probe fixed two of Dot's own bugs on the way (`start()` never opened a channel; a truncated frame killed the watcher). | Re-measured 2026-10-22, the picture is worse, not better: three rpcpool hosts now **accept the subscribe and send nothing**, an invalid token behaves identically, and a host with no Geyser service at all behaves identically to both. Nothing but counting `statsView().updates` distinguishes them. The wire format, by contrast, is now pinned by a committed artifact: `test/fixtures/yellowstone-frame.bin`, the codec's own bytes for a real mainnet `ProgramData` account, decoded off disk by the suite. |
| [§4 the bytecode diff against a compiled Anchor program](./blocked.md#4-bytecode-diff-validated-against-real-compiled-anchor-bytecode--measured-refuted-then-fixed) | **Done, came back negative, and the negative is now repaired.** Both images are committed (`test/fixtures/sbf-dispatch.so`, `test/fixtures/anchor-lang-0.30.1.so`) and `test/bytecode.test.ts` runs against both with no toolchain needed; `docs/blocked.md` §4 keeps the build commands. | A contiguous scan locates **0/10** and **0/6** selectors. `src/state/sbfSelectors.ts` decodes `.text` and recovers **10/10** (immediate pairs) and **6/6** (compare chains), with **0/30** on names neither program implements, so a misdecode costs a miss and never invents a selector. `unscannable` is retained for an image that will not parse. |

## 6. MCP integration

```bash
npx -y -p @zeroxcyril/dot dot-mcp        # live on the registry since 2026-10-22
node dist/cli/index.js mcp               # from a clone
```

Four tools — `dot_blast_radius`, `dot_evaluate_upgrade`, `dot_limits`, `dot_watch_status` — all requiring
a `budget` argument so an orchestrator cannot ask for an unbounded scan by accident. `test/mcp.test.ts`
spawns the process over real stdio pipes and asserts every stdout line is parseable JSON-RPC, because one
stray `console.log` corrupts the stream and the host drops the connection with no useful error.

Every tool result carries the danger ranking in `structuredContent.danger` — score, raw score,
category, the withheld-ceiling note, the coverage pair, the seven axes with their `notAssessed`
lines and the malice gate (`danger.malice`: flagged, the verdict sentence, the signature-axis total and
the four gate booleans) — and `test/mcp.test.ts` pins that the key is present as `null` when there is no
ranking, because an omitted key and a null one read differently to a consumer and only one of them is
honest.
One consequence of wiring it this way is worth stating rather than hiding: the MCP path has no
`--state` file, so its behavioural axis is always unmeasured, so **`dot_evaluate_upgrade` can never
return CRITICAL.** That is the ceiling rule doing its job — a tool that cannot tell whether this is a
program's first upgrade should not be the one that says it is the most urgent thing on the queue.

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
`docs/blocked.md` was rewritten from measurement: what has now been run against mainnet, what was
fixed as a result, and what still has never been exercised — the Geyser path has still never met a
live endpoint. The package is published (`@zeroxcyril/dot@1.1.0` as re-measured on 2026-10-22, verified by installing from the registry and running every bin); the artifacts below are the measured
ones; everything else stays labelled as the claim it is.

## 8. Live verification

Every artifact in this directory is machine-generated, from the command printed in it, against
`api.mainnet-beta.solana.com` and `solana-rpc.publicnode.com` on 2026-10-21. None is a fixture
handwritten to match the code that reads it.

| artifact | command | what it establishes |
|---|---|---|
| [`live-verify-2026-10-21.json`](./live-verify-2026-10-21.json) / [`.md`](./live-verify-2026-10-21.md) | `dot analyze FuCKerMR… --secondary-rpc … --verify --verify-sample 4 --sample 8 --budget-rpc 60` | A real program, upgraded the same day, discovered through the loader index: 8 traces, 3 edges, 21 CPI occurrences (20 failed), `attributionQuality: logs`, tier P2 with `cappedBy` naming the 32% coverage, exit 4 carrying a priced hypothesis. `chain_verified: false`, with each check's verdict and reason. Reproduced at the same numbers on a second run. |
| [`live-limits-for-2026-10-21.md`](./live-limits-for-2026-10-21.md) | `dot limits --for FuCKerMR… --try-onchain-idl --secondary-rpc …` | 4 RPC calls → 2 limits apply, 6 probed clean, 13 properties of the source. `CPI_DEPTH_ATTRIBUTION` answered by finding `stackHeight` in a fetched transaction rather than quoting the spec. |
| [`live-seeds-2026-10-21.json`](./live-seeds-2026-10-21.json) / [`.md`](./live-seeds-2026-10-21.md) | `dot analyze FuCKerMR… --seeds seeds-live.json` | Custody swept live: 6 derived patterns → 5 read, 1 absent, 1 unresolved, in **one** `getMultipleAccounts` call; 1,042,041,147,090 lamports and 986,570,981,170 raw units of `So1111…1112`. The derived addresses reproduce the ones the captured transaction named, so the seed rule is checked against the chain. |
| [`calibrated-model-2026-10-21.json`](./calibrated-model-2026-10-21.json) | `dot calibrate --blocks 6 --out docs/calibrated-model-2026-10-21.json` | The ingestion cost model measured rather than assumed: 506 transactions per block, 18,040 bytes per fetched transaction. Supplied to the analyzer it changes the reported byte amplification from 2000x to 506x. Two consecutive runs gave 506 and 687, which is why the file carries its endpoint and date. |
| [`live-run-2026-10-21.json`](./live-run-2026-10-21.json) | `dot analyze LBUZ… --mode rules` (older session) | Kept because it is the honest failure case: `-32015` on every trace fetch, tier capped at P3 by coverage. A refusal, not a clean result. |
| [`live-danger-2026-10-22.md`](./live-danger-2026-10-22.md) | `dot analyze LBUZ… --sample 2 --budget-rpc 20 --sol-usd 150`, then the same with `--state` | The Upgrade Danger Ranking, live, twice on one program: **LOW 10/100** with two axes unmeasured, then **MODERATE 50/100** once a state file made the behavioural axis scoreable and a sample found one caller (1.7 SOL, 3 mints touched — reported as unusable for the ×2 multiplier, because the graph has no token amounts). The score moved because the evidence moved, which is the property the artifact exists to show. Not reproducible from the published 1.0.0: it postdates the release. |
| [`live-malice-2026-10-22.md`](./live-malice-2026-10-22.md) | the same two programs, `--check-funding` | The malice heuristic live, on real authorities: **0 of 2 screamed.** One is a single-EOA authority whose funding looked five hours old and was not called fresh, because the node returned a full page and older history cannot be ruled out — the constraint that a missing check is not a clean check, doing its job on mainnet data. |
| [`replay-pamm.txt`](./replay-pamm.txt) | `dot replay --fixture test/fixtures/tx-nested.json --target pAMM…` | The real parser, offline, on a captured mainnet transaction: depth-2 attribution, dependents and lamports, reproducible with no network. |

What these runs also produced were five bug fixes, because a measurement can disagree with the tool:
`start()` never opened the Geyser channel (every "provider refused" had been a local throw in ~1 ms);
`connect()` could hang forever, stalling the watcher at startup; a dropped stream discarded the
provider's reason; `--out` died on `ENOENT` after spending the entire RPC budget; and a truncated
Geyser frame threw out of the data handler, killing a watcher that then reported nothing at all —
which is the worst silence a monitoring tool can produce. Each has a regression test, named in
`docs/blocked.md`. Two of the five (the channel and the hang) were found by probing an endpoint that
never answered; the malformed-frame one was found by writing a test artifact for the frame format.

## 9. Design decisions, including where they deviated from the brief

**The hypothesis is assembled by the Scout after `act` and after the widen path, not by the rule
engine.** The brief put it in `rules.ts`. It is not there, and putting it there would have made it a
guess: at Decide time the engine has the authority posture and the bytecode diff, but not the
attributed dependent count and not what else the same key controls — and those are exactly the fields
the claim's `evidenceFor`/`evidenceAgainst` are made of. So `RuleBasedDecision` raises
`needs_more_budget`, and `Scout` converts that into a claim once the sample exists. The reasoning is
in a comment at the call site, because the plausible-looking wrong version (build the claim in
Decide, where "the decision lives") is the one a reviewer would otherwise write.

**`chain_verified: false` is printed, never hidden.** The temptation was to omit the flag when the
cross-check could not conclude, since "no information" reads cleaner than a red `false`. But the
measured reality is that most public-endpoint runs *cannot* reach same-slot agreement on a mutable
account, so an absent flag would have meant "Dot did not look" and "Dot looked and could not tell"
would be indistinguishable — the exact confusion this tool exists to prevent. The flag therefore
ships with a per-check verdict, a reason that names which check to question, and `CANNOT_PROVE`
attached, so it cannot be quoted as a consensus claim.

**Non-Anchor programs are not downgraded to `low` confidence — they are denied semantics.** The brief
asked for "best effort, low confidence". Confidence in this build answers one question — how much of
the *evidence* was reachable — and is computed from sample coverage and attribution quality, so an
IDL-less program with full trace coverage genuinely has a better-observed blast radius than an
IDL-rich program whose history the node dropped. Fusing interface availability into confidence would
rank *publishing an IDL* above *having reachable traces*, which is backwards for a dependency graph.
Instead the diff carries its own axis (`confidence: structural | partial | bytecode_only`), refuses to
name an instruction it cannot resolve from an IDL, and reports the semantic gap as
`NO_IDL_CONTRACT` with `narrative.refused = "idl_unavailable"`. Two numbers, two meanings — the same
separation that keeps `severity` and `confidence` apart.

**Selector-level edges were built before the selectors were validated — and the validation
failed.** Locating instruction discriminators in a bytecode image is the assumption under the
"which entrypoints appeared, and who already calls them" result. It was tested against images the
test itself assembled. This session compiled real SBF images with the Solana toolchain and scanned
them: a 3,760-byte program whose dispatch has the shape `#[program]` generates yields **0 of 10**
contiguous selectors (each present as a `mov32 imm32` + `hor64 imm32` pair eight bytes apart), and a
244 KB program built against anchor-lang 0.30.1 yields **0 of 6** contiguous and **0 of 6** halves,
its `match` lowering into a byte-wise compare tree. The finding was pinned as an assertion before it
was fixed, so the fix could not be quietly swapped in: `confidence: "unscannable"` when nothing is
located against a declared interface, `idlClaimedNotFound` reworded from "not there" to "not seen",
and a carried hypothesis that cannot be *confirmed* by a scan that saw nothing.

Then the blindness turned out to be Dot's, not the bytecode's. `src/state/sbfSelectors.ts` reads the
ELF64 section table, walks `.text` as eBPF and recovers all three emission shapes: **10 of 10** on the
hand-built-shape image (every selector as an immediate pair) and **6 of 6** on the anchor-lang program
(every arm a compare chain, the leading byte consumed by the outer switch ~87 instructions earlier).
Both images are committed, so the claim needs no toolchain to check. It is self-checking by
construction — a candidate is reported only when it equals a hash the IDL supplied — and the two
negative controls are in the suite: **0 of 30** names that neither program implements, and the six
real names still exactly six when padded with those thirty. A misdecode therefore costs a miss and
cannot produce a false claim. `unscannable` stays, now reserved for the case it actually describes:
an image that does not parse, or one lowered into a shape the recovery has not been shown on —
which is why `BYTECODE_SCAN_BLIND_ON_COMPILED_IMAGES` is NARROWED rather than RESOLVED, the residual
being a claim about coverage (two images, not a corpus).

**The danger ranking reports its own holes in the number, and three of the brief's inputs do not
exist.** `src/score/danger.ts` answers "how soon should a human open this upgrade" with a 0–100
score over four queue-position axes (§10 adds the three signature axes), deliberately separate from the P0–P3 tier: a program with a dull history and
200 dependents can be P1 by exposure and CRITICAL by posture, and the two numbers disagreeing is
information, not a defect. Three sub-claims in the specification cannot be measured from anything Dot
is allowed to read, and each is reported inside the axis that wanted it rather than approximated: the
*threshold* of a multisig authority lives in an account Dot does not decode, so 1-of-2 and 5-of-9 score
identically (at the alarming end, 25, and printed as an assumption); "within 24h of a major ecosystem
event" has no feed at all, so that award has never been given by any score this build produced; and
routed *token* value is not attributable — the graph records which mints a call touched, never how much
— so the ×2 multiplier is lamports-only. Two more choices are arithmetic made visible instead of
absorbed: the queue-position axes sum to 120 and all seven sum to 180, so `rawScore` is kept beside the clamped `score`; and an axis with
no data is `null`, never 0, so a run that never built a graph does not collect "0 blast radius" and a
tidy-looking total — `coverage` prints how many of the points that were scoreable actually were and CRITICAL is
withheld outright when any axis was unmeasured. `DANGER_RANKING_UNMEASURED_INPUTS` carries the row in
`dot limits --status`.

## 10. Malice Detection: Detecting the Signature of an Attack, Not the Intent

Dot does not know what anybody meant. Intent lives in a repository, a Discord, a signing ceremony — none
of which this tool reads. What it *can* read is whether an upgrade arrives through the same structural
shape an attack does, and whether that shape is rare enough to be worth shouting about. So three
**signature** axes were added to the danger ranking: Authority Integrity (0–30), Code Anomaly (0–20),
Timing Anomaly (0–10). Seven axes now, summing to 180, still clamped to a 100 score with `rawScore`
beside it.

- **Authority Integrity** — +30 only when funding was *observed*: a transfer into the authority from an
  address the operator named (`--suspect`), or a first funding sitting at the very start of the wallet's
  visible history. +20 single EOA, +10 a low-threshold multisig or a stale signer set, 0 renounced or a
  high threshold behind a declared timelock. The quorum is now **read rather than assumed**: Dot asks the
  node to parse the authority account (`getAccountInfo` with `jsonParsed`, whose label sits at
  `data.program`), and a native multisig is banded on its real m-of-n across both axes. `--check-signers`
  then dates the set it just listed — one read per signer, capped at five, with the cap reported. A
  program-owned DAO (Squads-style) comes back as a program account, so it keeps the declared path. "Funded by a mixer" needs a mixer list, and Dot ships none:
  an invented one would be a claim about the world with no source, so that half of the band is reachable
  only through an operator's list, and every single-key path prints that the band was unreachable without
  one.
- **Code Anomaly** — +20 for `undeclaredEntrypoints` (a selector reachable in the bytecode that the
  published interface denies) or for a signer/writable widening on an instruction that already existed;
  +10 for `unscannable`; 0 for additive change.
- **Timing Anomaly** — +10 within an hour of activity on a declared governance program (`--governance-program`)
  or of a declared incident (`--incident-at`); +5 off the program's own observed cadence. Any signature on
  a governance program counts: Dot cannot tell a *proposal* from an ordinary call, and the axis says so in
  its own `notAssessed` line, along with which clock it stood on — the watcher's detection time, the newest
  sampled transaction, or Dot's own wristwatch, which is the only case where "recent" means "recent to me".

**The gate, and the one place this deviates from the brief.** Applied literally — `score >= 90 AND
authorityIntegrity > 0` — the flag fired on the first ordinary upgrade tried: a single-key program with an
*established* history, an unscannable image and a widened account set scored 110 raw and screamed, which
constraint 2 forbids. The shipped gate therefore also requires **positive** evidence of a kind Dot can
observe: integrity at its 30-point band, or an undeclared selector. Absence of verification is deliberately
excluded — `unscannable` records that Dot could not look, and a heuristic that reads blindness as wrongdoing
would be loudest on exactly the programs nobody can check.

**A missing check is not a clean check**, and the mechanism shows up in the numbers rather than in prose:
a node that returns a full page of signatures makes the wallet look young without proving it is, so
`retentionBounded` withholds the +30; a refused `getSignaturesForAddress` sets `authorityFunding:
unverified` and scores the ordinary 20 with the refusal printed; an authority the node hands back as raw
bytes is `raw_bytes`, never "single key" and never "clean"; and the signer band runs the other way from the
funding band — an unread, refused or empty signer set scores *nothing*, because a check that did not run must
not mint suspicion; and the probes are opt-in (`--check-funding`, `--check-signers`) because each buys calls
the analysis did not need.

**How rare, measured.** [`live-malice-2026-10-22.md`](./live-malice-2026-10-22.md) runs it against two real
mainnet programs with `--check-funding` on: neither screams, and one of them is a single-EOA authority with
a genuinely recent-looking funding event that the node's retention would not let Dot call fresh.
`test/malice.test.ts` runs nine ordinary synthetic shapes (unscannable bytecode, permission widening, first
sighting, PDA authority, no diff, refused probe) and asserts none fire, and one extreme shape and asserts it
does.

**The output**, when it fires — labelled as a heuristic before it says anything that could be mistaken for a
finding, and followed by the evidence rather than standing alone:

```
MALICE HEURISTIC: **SUSPECTED_MALICIOUS** — a scream, not a proof
VERDICT: SUSPECTED_MALICIOUS — This upgrade has the structural signature of an attack. Immediate human review required. Do not trust the new bytecode.
  Authority integrity 30/30: +30: first funded 2 hours ago … Code anomaly 20/20: +20: selector … (`drain`). Score: 100/100.
```

It is also above the fold in the markdown report, and in both `dot watch` summary lines, because an operator
reading one line of a stream is the case where minutes matter. `NO_MALICE_DETECTION` stays UNRESOLVABLE in
`dot limits --status`: the scream routes a human, it never adjudicates.

---

**In one line.** Dot ranks what breaks when a Solana program changes, shows the arithmetic behind the
ranking, cites the evidence behind every claim or discards the claim, asks for budget in the form of a
falsifiable hypothesis a better-funded run has to answer, and prints what it could not see in every
report — including the reports where what it could not see was everything.
