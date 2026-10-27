# Dot v1.2.1

Docs-only: no change under `src/`, so no behaviour change. This exists to get the shortened README onto
the registry page, and npm versions are immutable — a prose fix costs a patch number or nothing.

Tag the commit whose tree produced the tarball, not the branch tip.

## What is in it

- `README.md` cut from 560 lines to 119: what it is, why it exists, how to run it, and where the rest
  lives.
- `docs/INTERNALS.md` — new, holding the long form moved verbatim: the agent loop and budget, where each
  number comes from (attribution, value-as-proxy, block batching, same-slot corroboration, `--verify`),
  the CLI/library/MCP reference, the source map, testing, and the live run.
- The chain contradictions stay in `docs/lessons.md`, which already carried them in full; the limit
  catalogue stays generated output (`dot limits --status`, `docs/limits-baseline.txt`) and is not copied
  into prose anywhere.
- One claim in the README corrected while cutting it: `prepublishOnly` runs `scripts/verify-install.sh`
  with its default `--from tarball` — it installs the tree being packed, not the registry copy. The old
  wording said "installs from the registry", which is the `--from registry` invocation and cannot be
  true of the version that is about to be published.
- Copied counts removed rather than restated. The README said "the 20 codes" where the catalogue is 22.

## Measured at this tree (2026-10-27)

| claim | command | result |
|---|---|---|
| suite green, offline | `npx vitest run` | 425 passed / 3 skipped, 32 files, rc 0 |
| types clean | `npm run typecheck` (rc captured directly, never through a pipe) | rc 0 |
| limit catalogue | `node dist/cli/index.js limits --status` | 22 codes: 4 RESOLVED / 11 NARROWED / 7 UNRESOLVABLE_IN_CODE; "RESOLVED claims verified against existing test files: yes" |
| manifest | `node -p "require('./package.json').version"` | 1.2.1 |

## Registry-side verification (measured 2026-10-27, after the publish)

Before the publish this section said plainly that 1.2.1 was not on the registry — `dist-tags` answered
`latest: 1.2.0` at that point, and a version line copied from the manifest is not evidence about npm. The
publish has since happened, so the same two commands were re-run against the registry:

```
npm view @zeroxcyril/dot dist-tags   → { latest: '1.2.1' }
npm view @zeroxcyril/dot versions    → [ '0.0.0-stage', '1.0.0', '1.1.0', '1.2.0', '1.2.1' ]

bash scripts/verify-install.sh --from registry                     → rc 0
  installs @zeroxcyril/dot@1.2.1 from npm into a throwaway prefix and executes every bin:
  ✓ dot  ✓ dot-analyze  ✓ dot-watch  ✓ dot-mcp  ✓ dot-limits  ✓ dot-calibrate — all report 1.2.1
  OK — 6/6 bins executed and reported 1.2.1
```

The artifact was opened rather than inferred: `registry.npmjs.org/@zeroxcyril/dot/-/dot-1.2.1.tgz` unpacks
to a manifest at `1.2.1` and a 120-line `README.md` whose publish line names 1.2.1 — so the tree that
produced it is the tagged one, and the short README is what the registry page now renders.

**One nit, and where it actually stands.** `docs/` is not in the package's `files` allowlist (`dist`,
`skill`, `README.md`, `LICENSE`, `targets.example.json`), which is deliberate — the tarball carries no
development notes — but it means a reader inside an installed copy, or on the npm page, cannot follow the
README's `docs/…` pointers. The README now uses absolute `github.com/0xCyrildev/dot/blob/main/…` URLs for
all six of them, each checked to return 200. That fix is on `main` and therefore **not in the 1.2.1
artifact**, which was packed before it and still holds relative links; it reaches the registry with the
next publish. The skew is recorded here rather than assumed away: `v1.2.1` tags the tree that produced the
served tarball, and `main` is ahead of it by exactly this link fix.
