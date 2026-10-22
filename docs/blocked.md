# Blocked work, and why

Recorded instead of worked around, because a plausible-looking substitute for a
blocked verification is how a tool like this ends up shipping a lie.

## 1. Publishing `@zeroxcyril/dot` to npm — CLOSED (published 2026-10-22)

**Resolved by the maintainer, not by this build:** `npm publish --access public` succeeded and
`@zeroxcyril/dot@1.0.0` is live on the registry with all six bins registered.

Verified from outside the repo afterwards, in this order:

```bash
npm view @zeroxcyril/dot version                      # 1.0.0
rm -rf /tmp/dot-global
npm install -g --prefix /tmp/dot-global @zeroxcyril/dot
for b in dot dot-analyze dot-watch dot-mcp dot-limits dot-calibrate; do /tmp/dot-global/bin/$b --version; done
npx -y -p @zeroxcyril/dot dot-limits --status | head -1
```

All six bins reported `1.0.0` from the registry-installed package, and the `npx` form printed
`Limit status — 4 RESOLVED, 10 NARROWED, 7 UNRESOLVABLE_IN_CODE (21 codes)`. That is the evidence
behind the install lines in `README.md` and `skill/dot/SKILL.md`, which is what `test/skill.test.ts`
is allowed to take on faith: it cannot query the registry (the suite is offline), so it checks that
every version quoted in those documents equals `package.json` instead, and fails if either returns to
claiming the package is unpublished.

The published tarball is 122 files from a `files` allowlist — `dist/`, `skill/`, `README.md`,
`LICENSE`, `targets.example.json`. Nothing else ships: no development notes, no engagement files, no
`.env`. The earlier entries in this file stay as written, because they record what was measured at the
time (the publish attempt at `0.1.0`, the `E401`/`E404` answers that were true then) rather than a
state that has since changed.

## 2. Live mainnet verification — PARTLY UNBLOCKED (egress returned 2026-10-21)

Re-measured rather than inherited: this section previously said "no egress". `getHealth`
now answers `ok` from `https://api.mainnet-beta.solana.com` and
`https://solana-rpc.publicnode.com`; `https://rpc.ankr.com/solana` returns HTTP 403
`API key is not allowed to access blockchain`. So two public endpoints work and the third
needs a key.

Measured live, artifact in the repo (`docs/live-verify-2026-10-21.json` / `.md`, and the
same numbers reproduced on a second run):

- `dot analyze FuCKerMR… --secondary-rpc … --verify` against a program upgraded on the real
  loader index: 18 RPC calls, 8 traces, `attributionQuality: logs`, 3 edges, 21 CPI
  occurrences of which 20 failed, `lamportsRouted 63,723,520`, tier `P2`, `cappedBy`
  "only 32% of the planned sample was retrievable from the node", exit 4 with a priced
  hypothesis.
- `dot analyze FuCKerMR… --seeds seeds-live.json` summed real custody off mainnet: 7 declared
  patterns → 6 derived, **5 accounts read, 1 well-formed address holding nothing, 1 unresolvable
  `$user`**, one batched `getMultipleAccounts` call, `1,042,041,147,090` lamports and
  `986,570,981,170` raw units of `So1111…1112` (`docs/live-seeds-2026-10-21.json`). The three
  token accounts are ATAs derived from (owner, mint) pairs taken out of a captured mainnet
  transaction, and the derivation reproduces the addresses that transaction named — so the
  rule is checked against the chain, not against a fixture written to match the code.
  Two caveats that are the point of the exercise: those accounts belong to **active traders**,
  so the figure is a snapshot (comparing the batched sum with individual reads a second later
  differed by 1,041,968 lamports — a trade, not a bug; `test/seeds-live.test.ts` therefore
  asserts exact equality only against ProgramData rent reserves, which cannot move except by
  upgrade); and they are wallets and rent reserves, **not** a protocol's vault, so nothing here
  certifies any protocol's TVL. What it certifies is that `--seeds` does what it says.
- Discovery works: `getSignaturesForAddress(BPFLoaderUpgradeable)` + local PDA
  re-derivation produced a real (program, programData) pair from live data.
- Two providers disagree about *retention*, not about the chain: one endpoint had a sampled
  signature the other reported pruned. Same-slot account comparison is impossible over
  plain RPC — concurrent reads landed 9 slots apart, and `minContextSlot` is a lower
  bound. That is why the mutable-account checks read `inconclusive` and is stated in
  `CANNOT_PROVE` rather than hidden.
- `dot calibrate --blocks 6 --out docs/calibrated-model-2026-10-21.json` measured a real
  cost model off `api.mainnet-beta`: 6/6 blocks readable, **506 transactions per block**,
  **18,040 bytes per fetched transaction**, `measuredAt` stamped in the file. Three separate
  runs on this box returned **506**, **687** and **262** transactions per block (17,123–19,761
  bytes per transaction) — a 2.6x spread on a busy chain from a six-block sample, which is the
  honest statement of what the number is worth. The model is therefore labelled with its
  endpoint and date, and a deployment is told to re-run it rather than trust this one.
- `DOT_COST_MODEL=docs/calibrated-model-2026-10-21.json dot analyze …` changes the plan the
  report prints: `docs/live-calibrated-2026-10-22.md` shows a real run computing **337.3x** byte
  amplification from the measured model where the defaults would have computed 2000x. The
  artifacts captured *before* the calibration still say `defaults_unverified`, and are left as
  they were rather than regenerated — they are the record of what that run actually used.
- Supplied via `--cost-model` or `DOT_COST_MODEL`, the ingestion rationale changes accordingly:
  the same 6-signature sample computed **506x byte amplification** instead of the **2000x**
  the shipped defaults implied. The defaults were wrong in opposite directions on both axes —
  optimistic about batching, pessimistic about bandwidth — which is what `test/calibrate.test.ts`
  now pins.

Still not done:
- The calibration is **one endpoint on one day**. A deployment should re-run `dot calibrate`
  against its own provider; `docs/blocked.md` does not claim otherwise.
- `dot blast-radius` has ranked one real loader window, not a full sweep, and its ranking
  model is still mostly fixture-tested.
- `dot analyze --seeds` has now summed live accounts, but the declared patterns are ones this
  repo can verify on its own (ATA(owner, mint) and loader ProgramData), **not a protocol's own
  seed set**. Summing a real program's vault still needs the seeds from its deployment repo —
  `test/seeds.test.ts` and `seeds-live.json` prove the mechanism, not any protocol's custody.
- No second *independent provider* — publicnode and mainnet-beta are both public
  endpoints, and the report says a hostname is not proof of independence.

`docs/live-run-2026-10-21.json` is kept as the older example because it is a genuine
report, including the `-32015` refusal: an honest failure is better evidence than a
convenient success.

## 3. Yellowstone gRPC against a live provider — BLOCKED (no token), but the probe found a bug in Dot

`GRPC_LIVE_PATH_UNREACHABLE`. Renamed from `GRPC_LIVE_PATH_MOCKED` because probing it
discovered the old label described the test rather than the world.

### What the probe found first: `start()` never opened a channel

`@triton-one/yellowstone-grpc` v9 builds its channel inside `connect()`; `subscribe()` on a
client that never connected throws **locally**:

```
Client not connected. Call connect() first
```

Dot's `start()` did not call `connect()`. The result, measured on 2026-10-21, was six
provider hostnames all "refusing" within 0–1 ms — a latency that is impossible for a network
call, which is how the bug was spotted. So every earlier claim of "no live endpoint is
reachable" was partly a claim about Dot's own code. Fixed in `src/rpc/yellowstone.ts`; the
regression is `test/yellowstone-live.test.ts > the connection sequence the real SDK demands`.

Two more defects surfaced by the same probe, both now covered:

- `connect()` can hang with no socket activity. A local HTTP/2 server received **zero bytes**
  and the promise never settled, so `dot watch --yellowstone` would stall at startup forever.
  `connectTimeoutMs` (default 15 s) bounds it and reports `stage: "connect"`.
- A stream error was re-thrown as `DotError('RPC_TRANSPORT', …, {})` — empty details — so the
  provider's reason was discarded exactly when an operator needed it. The cause and the
  redacted endpoint are now carried, and `connected` goes false.

### What is still blocked: nobody has ever sent Dot a frame

Six hostnames, no token (this box has no Geyser credentials of any kind):

| endpoint | ms | outcome |
|---|---:|---|
| `https://api.rpcpool.com` | 2509 | subscribed, then stream error `subscribe stream receive failed` |
| `https://mainnet.rpcpool.com` | 6753 | same |
| `https://grpc.mainnet.rpcpool.com` | 1412 | same |
| `https://solana-grpc.publicnode.com` | 1140 | `subscribe refused: failed to open subscribe stream` |
| `https://grpc.publicnode.com` | 1043 | same |
| `https://mainnet.helius-rpc.com` | 25001 | no settle; the bounded connect/subscribe path reported the timeout |

The control that turns this into a documented limit instead of a diagnosis: **a host with no
Geyser service at all, `https://api.mainnet-beta.solana.com`, produced the identical string**
(`subscribe stream receive failed`), as did an unfiltered subscribe against rpcpool. The
native client collapses missing token, absent service and refused filter into one opaque
message, so Dot cannot tell those apart from the client side and does not pretend to. An
unresolvable host is distinguishable — that fails at `stage: connect` in 88 ms.

Reproduce:

```bash
# gated live test; skips without the endpoint rather than passing vacuously
YELLOWSTONE_ENDPOINT=https://<your-geyser> YELLOWSTONE_TOKEN=<token> \
  npx vitest run test/yellowstone-live.test.ts

# or drive the watcher and read the counters
node dist/cli/index.js watch --yellowstone https://<your-geyser> --token <token> \
  --targets targets.example.json --once
```

Read `feed.statsView()`: `updates` must rise, `startupSkipped` should be non-zero on a
replay, `layoutMismatch` should stay near zero. A flat `updates` with no error is a filter
that matches nothing — not a quiet chain. `isReplay`, keepalive and reconnect stay
unexercised until that run happens.

## 4. Bytecode diff validated against real compiled Anchor bytecode — MEASURED, REFUTED, THEN FIXED

This section used to read "blocked: no toolchain, no artifact, egress unavailable". Egress
came back, the toolchain installed itself, and the check ran. It refuted the assumption, and
then the refutation turned out to be a defect in Dot's own scan.

`diffBytecode` locates instruction entrypoints by looking for `sha256("global:<name>")[0..8]`.
The derivation rule is correct — `anchor-syn` 0.30.1's `instruction.rs` emits
`sighash(SIGHASH_GLOBAL_NAMESPACE, <snake_case method name>)` as `const DISCRIMINATOR: [u8; 8]`,
and anchor-lang-idl 0.1.4's `convert.rs:377` derives an IDL discriminator the same way, from
`value.name.to_snake_case()` — but the *emission* is not eight bytes in a row:

| image | how built | contiguous 8-byte selectors | recovered from `.text` |
|---|---|---:|---:|
| `test/fixtures/sbf-dispatch.so` (3,760 B, 10 instructions) | `cargo +1.89.0-sbpf-solana-v1.54 build --target sbpfv2-solana-solana --release`, dispatch written the way `#[program]` generates it (`pub const DISCRIMINATOR: [u8; 8]` per instruction, compared against the call data) | **0 / 10** | **10 / 10**, all as `mov32`+`hor64` immediate pairs |
| `test/fixtures/anchor-lang-0.30.1.so` (244,264 B, anchor-lang 0.30.1, 6 instructions, committed 2026-10-22) | same command, real framework dependency | **0 / 6** | **6 / 6**, all as byte-wise compare chains |

The first image's halves are visible as a `mov32 imm32` followed by a `hor64 imm32` eight bytes
later — for `withdraw`, `b7 12 46 9c` then `94 6d a1 22`, i.e. `b712469c946da122`. The framework
image lowers the `match` on eight-byte const patterns into a compare tree: each arm tests
`data[1..8]` as seven separate equality branches, and the outer `switch (data[0])` consumed the
leading byte tens of instructions earlier (measured: 87 for `initialize`).

`src/state/sbfSelectors.ts` reads the ELF64 section table and walks `.text` as eBPF, recovering
both shapes plus the contiguous case. Nothing is reported that is not a hash the IDL supplied, so
a misdecode loses a selector and cannot invent one; the two negative controls that hold that
statement are in the suite and in the probe:

- 30 instruction names neither program implements: **0 recovered** on both images.
- the six real names mixed into that 30-name field: **exactly 6 recovered**, no more.

Three decoder bugs, each of which first presented as evidence about the bytecode rather than
about Dot, are recorded in that file's comments because they are the failure mode this module
exists to prevent: `BPF_EXIT` defined as `0x10 >> 3` (real value `0x90`) aliased `BPF_JEQ` and a
blacklist guard then silently dropped **every `jeq`** from the compare stream, which cost two of
six selectors; the reconstructed immediate pair was compared as a numeric hex string instead of
eight little-endian bytes, which found 0 of 10 pairs that were plainly there; and the `lddw`
widening test `(op & 0xe0) === 0x18` never fired, because `0x18` is the size field and `0xe0` the
mode field.

What the code does now:

- `scanDiscriminators` runs the contiguous sweep **and** the recovery, and reports `via` per
  selector plus `decoded` (did the image parse at all) and `recoveredOnly` (what the old sweep
  would have called absent).
- `confidence: "structural"` on both real images, with the entrypoint set filled in.
- `confidence: "unscannable"` is retained for the case it means: three or more declared selectors
  and nothing located. Its limits text now distinguishes "the image did not parse as a
  little-endian ELF64 with a walkable `.text`, so recovery could not run" from "both passes ran
  and found nothing", and `idlClaimedNotFound[].why` still says *not seen*, never *absent*.
- `test/bytecode.test.ts` pins all of it against the two committed images, including a
  `undeclaredEntrypoints` case on the real anchor-lang program: same bytes both sides, new IDL
  omitting `collect_fees`, the report naming it.

Reproduce the measurement:

```bash
# both committed images, always run in the suite
npx vitest run test/bytecode.test.ts

# the per-shape census (recovered / via / missed) and the two negative controls
npx tsx scripts/probe-sbf.ts
npx tsx scripts/probe-negative.ts

# any other program
DOT_TEST_SO=/path/program.so DOT_TEST_IDL=/path/idl.json npx vitest run test/bytecode.test.ts

# rebuild the framework image (crates.io is flaky here: the first attempt timed out
# downloading serde_json, the retry succeeded in 1m44s)
cd /tmp && cargo new --lib anchor-smoke && # …one #[program] handler per instruction name…
PATH=~/.cache/solana/v1.54/platform-tools/llvm/bin:$PATH \
  cargo +1.89.0-sbpf-solana-v1.54 build --target sbpfv2-solana-solana --release
```

Note on the wrapper: `cargo build-sbf` itself fails on this box with
`invalid toolchain name '1.89.0-sbpf-solana-v1.54\t/home/…/platform-tools/rust'` — it parses
`rustup toolchain list -v` output including the tab-separated path. Invoking the registered
toolchain directly (as above) works and is what produced both images.

**What would close the rest:** two images is not a corpus. The recovery is demonstrated on the two
shapes the Solana toolchain emitted here; a dispatch lowered into a jump table, a binary search on
the leading byte, or a compare wider than one byte produces no consecutive run and is then
reported as *not located*, capped by `unscannable` — which is the honest answer, not the fixed one.
The job that prices that residual is sampling: run the gated check against published mainnet
programs and report the fraction located. `BYTECODE_SCAN_BLIND_ON_COMPILED_IMAGES` stays NARROWED
for that reason, not because the scan is still blind.
