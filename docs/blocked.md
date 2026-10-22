# Blocked work, and why

Recorded instead of worked around, because a plausible-looking substitute for a
blocked verification is how a tool like this ends up shipping a lie.

## 1. Publishing `@zeroxcyril/dot` to npm — BLOCKED (registry reachable, no credentials)

Re-run 2026-10-22, with the exact answers rather than a summary:

| command | result |
|---|---|
| `npm publish --dry-run` | succeeds — 122 files packed, `+ @zeroxcyril/dot@0.1.0` |
| `npm whoami` | `npm error code E401 Unauthorized - GET https://registry.npmjs.org/-/whoami` |
| `npm publish --access public` | `npm error code E404 Not Found - PUT https://registry.npmjs.org/@zeroxcyril%2fdot` — "could not be found or you do not have permission to access it" |
| `npm pack` + `npm install -g --prefix /tmp/dot-prefix2 ./zeroxcyril-dot-0.1.0.tgz` | installs clean; all six bins present and executing |

So the registry is **reachable** — it answered the PUT with a 404, which is what npm returns for
an unauthenticated write to a package that does not exist yet. The blocker is credentials, not
network, and the distinction matters because "publish is blocked" reads like an environment
limit when it is an account limit.

Bin verification was done by execution, not by `ls`: `dot` and `dot-limits` print the status
line, `dot-analyze` rejects a malformed pubkey with Dot's own message, `dot-watch` demands
`--targets`, `dot-mcp` emits `dot mcp ready (mode rules, 21 codes)` on stderr, and
`dot-calibrate` measured a live block sample. Each alias dispatches to its own subcommand rather
than to the root help — which is the failure `test/install.test.ts` exists for, because `tsc`
emits bins at mode 0664 and a global install then execs a file the shell will not run.

One gap that surfaced while testing the aliases: `dot-calibrate analyze <x>` **runs calibrate and
ignores the stray argument** instead of erroring. Harmless, and arguably how a single-entry
dispatcher should behave, but it means an alias cannot be used to catch a typo'd subcommand.
Left as-is and named here rather than quietly changed.

Consequence for the docs: no README line may read `npm install -g @zeroxcyril/dot` as a currently
working command. The verified forms are `npm ci && npm run build` + `node dist/cli/index.js …`,
the tarball install above, or `npm link` after pointing the prefix somewhere writable
(`npm config set prefix ~/.npm-global`) — `/usr/local/lib/node_modules` does not exist on this box.
Unblocks with registry auth for the `@zeroxcyril` scope; the manifest name and `bin` map are
already scoped.

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

## 4. Bytecode diff validated against real compiled Anchor bytecode — MEASURED, AND THE ASSUMPTION FAILED

This section used to read "blocked: no toolchain, no artifact, egress unavailable". Egress
came back, the toolchain installed itself, and the check ran. It refuted the assumption.

`diffBytecode` locates instruction entrypoints by scanning an image for
`sha256("global:<name>")[0..8]`. The derivation rule is correct — `anchor-syn` 0.30.1's
`instruction.rs` emits `sighash(SIGHASH_GLOBAL_NAMESPACE, <snake_case method name>)` as
`const DISCRIMINATOR: [u8; 8]` — but the *emission* is not what the scan expects:

| image | how built | contiguous 8-byte selectors found | 4-byte halves found |
|---|---|---:|---:|
| `test/fixtures/sbf-dispatch.so` (3,760 B, 10 instructions) | `cargo +1.89.0-sbpf-solana-v1.54 build --target sbpfv2-solana-solana --release`, dispatch written the way `#[program]` generates it (`pub const DISCRIMINATOR: [u8; 8]` per instruction, compared against the call data) | **0 / 10** | 10 / 10, the two halves 8 bytes apart |
| `~/anchor-smoke/target/sbpfv2-solana-solana/release/anchor_smoke.so` (244,264 B, anchor-lang 0.30.1, 6 instructions) | same command, real framework dependency | **0 / 6** | **0 / 6** |

The first image's halves are visible in the disassembly as a `mov32 imm32` followed by a
`hor64 imm32` eight bytes later — for `withdraw`, `b7 12 46 9c` then `94 6d a1 22`, i.e.
`b712469c946da122`, the selector Dot's own fixtures use. The framework image lowers the
`match` on eight-byte const patterns into a byte-wise compare tree, so even the halves do not
appear. **A contiguous scan finds nothing in either, which is the case a real deployment is
in.** Consequence, stated plainly: Dot's entrypoint-level added/removed/undeclared claims are
demonstrated on constructed images only; against compiled bytecode they report nothing — and
"nothing reported" is exactly what a reader mistakes for "nothing changed".

What changed in the code as a result (not a fix to the scanner — a fix to the claim):

- `confidence: "unscannable"` when the scan locates none of three or more declared selectors,
  with the reason in the limits list, instead of `"structural"` over a silent scan.
- `idlClaimedNotFound[].why` says "not seen, scan may be blind" rather than implying absence.
- The re-test of a carried hypothesis treats an unscannable diff as *no entrypoint view*, so a
  routine-upgrade claim cannot be "confirmed" by the scan finding nothing (see
  `test/hypothesis.test.ts > derives entrypointSurface from the diff being scannable, not
  merely present`).

Reproduce the measurement:

```bash
# the committed image, always run in the suite
npx vitest run test/bytecode.test.ts

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

**What would close this for real:** either match what the compiler emits — the immediates pair
and the compare tree — or stop scanning bytecode for entrypoints and read a published IDL,
accepting that most programs publish none. Until then `BYTECODE_SCAN_BLIND_ON_COMPILED_IMAGES`
is a named defect, not a caveat, and the bytecode-diff section of any report on a real program
should be read as Dot not seeing.
