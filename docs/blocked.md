# Blocked work, and why

Recorded instead of worked around, because a plausible-looking substitute for a
blocked verification is how a tool like this ends up shipping a lie.

## 1. Publishing `@zeroxcyril/dot` to npm — BLOCKED (no credentials)

`npm publish --dry-run` succeeds (92 files, valid manifest, executable bins) and
`npm install -g ./zeroxcyril-dot-0.1.0.tgz` into a clean prefix installs and runs all
six bins — `test/install.test.ts` proves it. But `npm whoami` returns
`E401 Unauthorized` from this environment, so the package is **not published**.

Consequence for the docs: no README line may read `npm install -g @zeroxcyril/dot` as
a currently working command. The verified forms are `npm ci && npm run build` +
`node dist/cli/index.js …`, or a tarball install. Unblocks with registry auth; the
manifest name and `bin` map are already scoped.

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
  **18,040 bytes per fetched transaction**, `measuredAt` stamped in the file. Two consecutive
  runs returned 506 and 687 tx/block, which is the honest statement of how much a six-block
  sample is worth: an order-of-magnitude-ish spread on a busy chain, so the model is labelled
  with its endpoint and date rather than treated as a constant.
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

## 4. Bytecode diff validated against real compiled Anchor bytecode — BLOCKED (no toolchain, no artifact)

`cargo build-sbf` exists on this box but aborts with
`error: not a directory: ~/.cache/solana/v1.54/platform-tools/rust/lib`, and fetching that
platform-tools bundle needs network egress that is blocked. No Anchor `.so` or `idl.json`
exists anywhere in the home tree either. So the entrypoint diff is validated by unit tests
against Anchor's published derivation rule and constructed images, not against a compiled
program. The gated test is ready:

```bash
DOT_TEST_SO=/path/to/program.so DOT_TEST_IDL=/path/to/idl.json npx vitest run test/bytecode.test.ts
```

On a networked machine, `cargo build-sbf` inside any Anchor project produces both artifacts
in about two minutes. Until then `BYTECODE_SCANABILITY_UNVALIDATED` stays in the catalogue.

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
