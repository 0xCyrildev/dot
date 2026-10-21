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

## 2. Live mainnet verification of the new commands — BLOCKED (no egress)

Every Solana RPC endpoint reachable by name from this box (`api.mainnet-beta`,
`solana-rpc.publicnode.com`, `rpc.ankr.com`) fails with `UND_ERR_CONNECT_TIMEOUT` or
`ENOTFOUND` for the whole session, while `registry.npmjs.org` works — so it is
egress-specific, not a dead network.

Not done as a result:
- `dot calibrate` has never measured a real block. Its cost model still says
  `defaults_unverified`.
- `dot blast-radius` has never seen a real loader history, so its ranking model is
  tested only against constructed fixtures.
- `dot analyze --seeds` has summed no real vault. The derivation is proven against a
  captured mainnet ProgramData PDA (`test/seeds.test.ts`), but no balance read has run
  against a live node.
- `dot analyze <Jupiter>` for the demo graph. The only real mainnet artifact in the
  repo is `docs/live-run-2026-10-21.json`, captured before these features existed and
  from the endpoint that then went on to refuse history.

Unblocks with any working RPC URL. `docs/live-run-2026-10-21.json` is kept as the
example because it is a genuine report, including the `-32015` refusal — an honest
failure is better evidence than a convenient success.

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
