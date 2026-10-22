# Dot v1.0.0

Agentic blast-radius analysis for Solana program upgrades. `@zeroxcyril/dot`, bin `dot`.
TypeScript, one npm package, six bins, no daemon required.

## What it is

Static tools audit what a program *could* do. Dot audits what the ecosystem *does* when a
program changes: it reconstructs the on-chain CPI dependency graph from execution traces, so the
answer is built from the chain rather than from a repository that never contained the relationship
between two programs in the first place.

One run is a bounded agent loop — `perceive → decide → act → evaluate → report` — under a budget
of RPC calls, signatures, LLM tokens and wall-clock time. It stops early when a multisig-held
program with no known dependents and a no-size-change bytecode write cannot justify 60 paid reads,
and it asks for resources in writing when it cannot answer the question it was set.

## What it does

- **Score an upgrade** — authority posture (`eoa` / `multisig` / `program_derived` / `renounced`),
  whether the authority rotated, the size and entropy move, and the observed blast radius — into a
  P0–P3 **queue position** with the arithmetic printed and a separate `confidence` that says how
  much of the picture the node was willing to show.
- **Reconstruct dependents** from `meta.innerInstructions[].index` folded onto the outer
  instruction position, with depth recovered from `stackHeight` where present, the log tree
  otherwise, and a labelled upper bound when neither is available. Multi-hop reach at
  `--depth N`, direct vs transitive, and who already sends a newly added entrypoint's selector.
- **Diff bytecode at the entrypoint level** when Dot kept the prior image, using Anchor
  discriminators — and report `undeclaredEntrypoints` rather than discarding what the IDL does not
  name.
- **Ask for budget as a claim**: `needs_more_budget` carries a derived hypothesis with a priced
  test plan and a falsifier; a funded run re-tests it, and a run that could not take the
  observation answers `not_testable` instead of `denied`.
- **Corroborate itself** against a second endpoint (`--secondary-rpc`, `--verify` →
  `chain_verified`), and halt with `tierSource: "integrity"` when two nodes describe the same slot
  incompatibly.
- **Say what it cannot see**, per report and per program (`dot limits`, `dot limits --for`).

## The three chain contradictions this build was shaped by

1. **`@solana/web3.js` v1.99 cannot deserialize its own `jsonParsed` output** — `StructError` on
   `meta.innerInstructions.*.accounts`, because parsed instructions have no `accounts` field. Dot
   owns its JSON-RPC layer; web3.js is used only for `PublicKey` and PDA derivation.
2. **Instruction `accounts` are base58 pubkeys in `jsonParsed` and integer indexes in `json`.**
   A parser that assumes indexes reads `keys["6tv7sUQ…"]` → `undefined` → reports zero value
   routed: a confident lie, not a crash. Both encodings resolve through one table and every frame
   is tagged with how it was resolved.
3. **`ProgramData` is not the layout the SDK describes.** Measured: discriminant 3 for ProgramData
   and 2 for Program (inverted versus the documented Rust enum order), ELF magic at offset 45, and
   no `data_len` field where the spec says one is. Change detection therefore hashes the whole
   account and only computes a bytecode hash once the magic is found — guessing an offset would
   produce false "no change" results, the worst failure a watcher can have.

## Live verification

All measured against mainnet, artifacts in `docs/`:

- `live-verify-2026-10-21.{json,md}` — real upgrade found through the loader index; 18 calls,
  8 traces, `attributionQuality: logs`, 3 edges, 20 failed CPIs, tier P2, exit 4 with a priced
  hypothesis, `chain_verified: false` with per-check reasons. Reproduced on a second run.
- `live-seeds-2026-10-21.{json,md}` — custody sweep over declared seeds: 6 derived patterns, 5
  accounts read, 1 absent, 1 unresolved, one batched `getMultipleAccounts` call.
- `calibrated-model-2026-10-21.json` + `live-calibrated-2026-10-22.md` — cost model measured
  (506 tx/block, 18,040 B/tx); three samples spread 262–687 tx/block.
- `live-limits-for-2026-10-21.md` — per-program limit probe, 4 calls.
- `replay-pamm.txt`, `live-run-2026-10-21.json` — the real parser on captured mainnet bytes, and
  the older run that got `-32015` on every fetch, kept because it is honest.
- `test/fixtures/sbf-dispatch.so` — a genuine SBF image compiled with platform-tools v1.54.

```
npm test  →  314 passed, 3 skipped          (the 3 skips are gated live endpoints)
npx tsc --noEmit  →  clean
dot limits --status  →  21 codes: 4 RESOLVED / 10 NARROWED / 7 UNRESOLVABLE_IN_CODE, exit 0
```

## Honest limits — what v1.0.0 does not claim

- **`BYTECODE_SCAN_BLIND_ON_COMPILED_IMAGES`** — measured this release, and it refuted an
  assumption: a contiguous scan for `sha256("global:<name>")[0..8]` finds **0 of 10** selectors in
  a real compiler-emitted image (they are split across `mov32`/`hor64` immediates) and **0 of 6**
  in a program built against anchor-lang 0.30.1 (a byte-wise compare tree). Entrypoint-level
  added/removed claims are proven on constructed images only; the diff now reports
  `confidence: "unscannable"` rather than letting silence look like "nothing changed". The scanner
  fix is deliberately not in this release.
- **`GRPC_LIVE_PATH_UNREACHABLE`** — no provider has ever delivered a frame to this build. The
  wire format is proven against real captured `ProgramData` bytes and the connect/subscribe
  sequence is now correct (it was not: `start()` never called `connect()`, which had been making
  every live attempt fail locally in ~1 ms), but `isReplay`, keepalive and reconnect are
  unexercised, and the native client cannot distinguish a missing token from an absent endpoint.
- **`NO_CHAIN_WIDE_UPGRADE_SUBSCRIPTION`** is NARROWED, not RESOLVED — downgraded this release
  because its green label had been resting on a test that skips without an endpoint.
- **Routed value is a proxy**, per transaction, never TVL; **program-held custody** requires a
  seed list; **no USD figure** without an operator-supplied price; **no inclusion proof** exists in
  core RPC, so `chain_verified` is corroboration; **no intent classification** — Dot ranks
  attention and never adjudicates guilt.
- **Not published to npm.** The registry answers `npm publish` with 404 for lack of credentials;
  install is verified from a packed tarball (`test/install.test.ts`), and `npm link` works with a
  prefix you own.
- **`calibrate` is one endpoint on one day**, and the live artifacts above are from public
  endpoints that are not independent providers. A hostname is not proof of independence, and the
  report says so in the same block as the flag.

Full text of every limitation, with its escape route: `dot limits`. Blocked items with the
command that would close each one: `docs/blocked.md`. The submission write-up:
`docs/SUBMISSION.md`.
