# Submission: Dot — agentic blast-radius analysis for the Solana on-chain supply chain

**Repo:** `@zeroxcyril/dot` (npm pending) · **Ecosystem:** Solana · **Language:** TypeScript, Node ESM
**Category:** dynamic analysis / dependency & upgrade monitoring · **Interfaces:** CLI, library, MCP server

---

## 1. What it is

Dot watches `BPFLoaderUpgradeable` for bytecode changes, reconstructs the CPI dependency graph of the
program that just changed from real execution traces, and scores the upgrade by how many integrators call
it and how much value routes through them. Output is a P0–P3 triage tier with the arithmetic that produced
it, an evidence ledger with citable ids, a budget snapshot, and the list of things it could not see.

One run is five stages under a hard spend ceiling:

```
perceive  1 RPC call     read ProgramData, decode, diff
decide    rules or model is this worth a trace pull, and how big a sample
act       expensive      signature walk → innerInstructions fold → graph
evaluate                 digest, price exposure, price the evidence quality
report                   tier + components + evidence + budget + limits
```

`decide` exists to avoid `act`. A multisig-held program with an already-known empty graph stops after
**one RPC call** and still emits a complete report recording what it declined to spend. That trace of
skipped work is the difference between an agent and a script with a for-loop, and it is in the report, not
in a README claim.

## 2. Why it is different: the ecosystem is a graph, not a set of programs

The tools in this space are siloed by phase. Static analyzers audit one program in isolation before
deployment. Runtime monitors match transactions against known-bad patterns. Dependency scanners inspect
off-chain npm manifests. None of them models the thing that actually carries risk on Solana: **program A
CPIs into program B, B into C, and no source tree contains that edge.**

When B's bytecode is replaced on chain, every caller of B inherits B's new behaviour — including the
version of it they never reviewed. Dot is the only tool here that answers the question a real incident
asks: *how many integrators are now running against new code, and how much value was flowing through
them when it changed?*

The graph is reconstructed from `meta.innerInstructions`, which means getting the semantics right rather
than the API call: `innerInstructions[].index` is a position in the **outer** instruction array, so the
inner lists must be folded onto their parent before any edge is attributed, and depth beyond that comes
from `stackHeight` or the `Program <id> invoke [N]` log tree — with a labelled fallback, because flat
attribution silently credits depth-3 callees to the transaction root and inflates dependent counts.

Agentic, not decorative: budgets are enforced **before** the request; a failed call is still a spent call;
each retry is charged again; LLM tokens are reserved as an estimate and settled against billed usage so an
underestimate surfaces as `overrun`. In chain-wide mode a `UpgradeDispatcher` caps each investigation at 50
calls and the daemon at a daily pool, serves authority handovers ahead of routine bytecode writes, drains
serially, and **counts every dropped event** — because a daemon that dropped forty upgrades looks
identical to one that saw none.

The model is quarantined. In `mode: real` a model reads the IDL diff and explains it, but it cannot set
the tier, and an answer that cites an evidence id Dot never issued is **discarded whole, not trimmed**,
with the refusal printed. Detection stays deterministic.

## 3. Why it belongs in this list

- **Fills a named gap.** On-chain supply chain / blast radius at upgrade time is the phase nobody covers:
  before deployment is static's job, per-transaction is monitoring's job, and between them an upgrade lands
  and integrates invisibly.
- **Composable with the list.** It ships an MCP server (`solana_blast_radius`, `solana_evaluate_upgrade`)
  with a required `budget` argument, so an orchestrator can call it and cannot accidentally ask for an
  unbounded scan. Same engine as a CLI, a library, and JSON reports a pipeline can diff.
- **Built to be audited.** Every figure carries a `file:line`-equivalent: components explain the tier,
  evidence ids back the prose, `cappedBy` names the blind spot that capped it, and `dot limits` prints 20
  documented blind spots as machine-readable data rather than a disclaimer paragraph.
- **Honest about severity ≠ likelihood ≠ confidence.** Low confidence can never mint a P0 — an agent that
  could not see the graph gets to declare a blind spot, not an emergency.

## 4. The three chain contradictions — evidence it was built against real data

The original design was written from documentation and client typings. Three load-bearing assumptions died
on contact with mainnet, and all three are in the code as measured comments and in `dot limits` as
documented blind spots.

**1. `@solana/web3.js` cannot deserialize its own `jsonParsed` output.**

```
Connection.getTransaction(sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 })
→ StructError: At path: meta.innerInstructions.0.instructions.0.accounts
  -- Expected an array value, but received: undefined
```

Parsed instructions carry no `accounts` field — the account set lives in `parsed.info`. The v1.99
superstruct marks it required, so this throws on ordinary CPI-heavy mainnet traffic, reproduced on the
first sample tried. Dot therefore owns its JSON-RPC layer and uses web3.js only for `PublicKey`/PDA
derivation. Anything that swallowed this error into a `try/catch` would report "no dependencies found" on
the most integrated programs in the ecosystem.

**2. Instruction `accounts` are base58 pubkeys under `jsonParsed` and integer indexes under `json`.**

```
jsonParsed → accounts: ["6tv7sUQ4R3fE9rnBX4w72oiiqSHqKF3KPvyubFNfazxd", …]
json       → accounts: [1, 5, 12]
```

A parser that assumes indexes evaluates `keys["6tv7sUQ4…"]`, gets `undefined`, and concludes no lamports
moved. That is not a crash — it is a confident zero. `src/graph/keys.ts` accepts both shapes, and
`test/graph.test.ts` asserts the two encodings of the same trace produce the same graph.

**3. `ProgramData` is not the layout the SDK describes.**

Measured across several live programs: `ProgramData` discriminant **3** and `Program` discriminant **2** —
the reverse of the `UpgradeableLoaderState` enum order — and the ELF magic at byte **45** with
`u64 + Option<Pubkey>` before it and **no `data_len` field**. Reading the documented layout lands on
`0x7f454c46` while calling it a length.

So Dot trusts no offset for anything load-bearing: change detection hashes the **whole account**, which
cannot miss a realloc or rewrite regardless of layout, and the bytecode-only hash is computed only after
the ELF magic has been *found*. An account where it is not found raises `UNKNOWN_PROGRAMDATA_LAYOUT`
instead of hashing a guessed window — a watcher with a wrong offset does not error, it reports an all-clear
indefinitely.

Two smaller ones discovered on the same pass: `stackHeight` **is** returned by mainnet but is absent from
web3.js v1's type declarations (it is what makes depth-3 attribution exact), and in
`@triton-one/yellowstone-grpc` v9 `accounts.owner`/`account` are **base58 strings**, not bytes — pass bytes
and your filter matches nothing, which is indistinguishable from a quiet chain.

## 5. Reproducing it in five minutes

```bash
npm ci && npm run build
npm test                        # 108 tests, no network, no API key
node dist/cli/index.js limits    # the 20 documented blind spots, as data
node dist/cli/index.js analyze LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo --sample 20
```

`npm link` needs a writable global prefix; on the build box it is not (prefix resolves to a
`/usr/local/lib/node_modules` that does not exist), so use `node dist/cli/index.js` or
`npm config set prefix ~/.npm-global`. The bare `dot` bin collides with graphviz — measured, `/usr/bin/dot`
shadowed it — which is why the package also installs `dot-analyze`, `dot-watch`, `dot-mcp`, `dot-limits`,
`dot-calibrate`, dispatching on the invoked name.

Fixtures are real where reality matters: `test/fixtures/tx-nested.json` is a captured mainnet transaction
(6 outer instructions, inner groups at index 2 and 4, 11 CPIs, `stackHeight: 2`), and
`programdata-observed.json` holds captured `ProgramData` bytes including a renounced-authority case. The
deep-nesting, log-only, failed-tx and v0-address-table fixtures are generated against measured field shapes
and say so in their header, because a history-pruning public node will not serve those shapes on demand.

## 6. What Dot is not, and what is not yet verified

The report's last section is the limits, and `docs/live-run-2026-10-21.json` is the honest showcase:
against `api.mainnet-beta.solana.com`, upgrade detection worked (PDA derivation matched the on-chain
pointer, layout decoded, authority classified off-curve) and the trace pull was refused —
`-32015 Transaction history is not available` on all ten fetches. The report says
`cappedBy: "only 0% of the planned sample was retrievable from the node"`, tier P3 with confidence **low**.
It did not print an empty graph and imply that nobody depends on this program.

Explicitly unverified, stated rather than glossed:

- **The Yellowstone gRPC transport has never touched a live endpoint.** It is typechecked against the
  generated types and unit-tested with an injected fake stream; handshake, auth-token handling and replay
  semantics are unproven in the field. `GRPC_LIVE_PATH_UNVERIFIED` is in the limits catalogue for that
  reason.
- **Block batching is a trade, not a win.** One `getBlock` replaces many `getTransaction` calls and turns a
  call ceiling into a bandwidth problem: the payload becomes every transaction in the slot. Dot prints both
  ratios (`callSavingRatio`, `byteAmplification`), refuses oversized blocks, and only batches when calls
  are the binding constraint. The cost model is labelled `defaults_unverified` until
  `dot calibrate --rpc <url>` measures it — no public endpoint was reachable while this was written, so the
  defaults are declared assumptions, not numbers.
- **Value is a proxy.** Routed lamports are a per-transaction upper bound, not per-edge settlement, and a
  swap cannot be split into legs. Program-held vault PDAs are not enumerated. There is no price oracle: no
  USD figure is printed unless the operator passes `--sol-usd`, so you will not find an invented "$4.2M" in
  a Dot report.
- **Authority governance is not derivable from chain data.** No RPC call tells you an authority is a 2-of-3
  multisig. `knownMultisigs` is an operator-supplied map; anything unmapped is scored `unknown` and treated
  as unreviewed, never as safe.
- **Dot does not adjudicate guilt.** A tier is a queue position. Absence of a finding is not a clean bill
  of health, and `NO_MALICE_DETECTION` is printed in every report to keep that from being forgotten.
