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
- Discovery works: `getSignaturesForAddress(BPFLoaderUpgradeable)` + local PDA
  re-derivation produced a real (program, programData) pair from live data.
- Two providers disagree about *retention*, not about the chain: one endpoint had a sampled
  signature the other reported pruned. Same-slot account comparison is impossible over
  plain RPC — concurrent reads landed 9 slots apart, and `minContextSlot` is a lower
  bound. That is why the mutable-account checks read `inconclusive` and is stated in
  `CANNOT_PROVE` rather than hidden.

Still not done:
- `dot calibrate` has never measured a real block; the cost model still says
  `defaults_unverified`.
- `dot blast-radius` has ranked one real loader window, not a full sweep, and its ranking
  model is still mostly fixture-tested.
- `dot analyze --seeds` has summed no real vault. The derivation is proven against a
  captured mainnet ProgramData PDA (`test/seeds.test.ts`); no live balance read has run.
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

## 3. Yellowstone gRPC against a live endpoint — BLOCKED (no endpoint, no token)

`GRPC_LIVE_PATH_MOCKED` covers what was proven: raw protobuf frames built with the
package's own generated codec, carrying captured mainnet `ProgramData` bytes, decoded
by the feed and still yielding the correct upgrade authority. Not proven: HTTP/2
handshake, `x-token` auth, `isReplay` semantics, keepalive, reconnect.

Set `YELLOWSTONE_ENDPOINT` (+ `YELLOWSTONE_TOKEN`) and the gated test in
`test/yellowstone-live.test.ts` runs; it is `skipIf`-ed, not silently passing.
