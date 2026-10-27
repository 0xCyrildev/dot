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

## What it does not claim

**1.2.1 is not on the registry as this file is written.** `npm view @zeroxcyril/dot versions` answered
`0.0.0-stage, 1.0.0, 1.1.0, 1.2.0` and `dist-tags` answered `latest: 1.2.0`, both measured 2026-10-27. So
the version lines in `README.md` and `skill/dot/SKILL.md` describe the tree being packed; they become
facts only when the publish has happened.

The publish is the operator's step, not the build's: from this box `npm publish` reaches `EOTP` because
the 2FA approval happens in a browser. Once it has, the check that closes this section is

```bash
npm view @zeroxcyril/dot dist-tags                              # expect latest: 1.2.1
bash scripts/verify-install.sh --from registry                  # expect every bin to report 1.2.1
```

and the result belongs in this file as a measured line, not as an inherited one.
