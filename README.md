# Dot

**Static tools audit what a program *could* do. Dot audits what the ecosystem *does* when a program upgrades.**

Solana programs are not artifacts, they are nodes in a graph. Program A calls Program B which calls
Program C, and none of that relationship exists in any source tree. When B's bytecode is replaced on
chain, every existing tool answers a question about B. The one that costs money is about A and C: who
calls the program that just changed, how often, and how much value routes through them.

Dot watches `BPFLoaderUpgradeable` for bytecode changes; when one lands it reconstructs the CPI
dependency graph from real execution traces, prices the upgrade by who depends on the program and what
moved through them, and emits a P0–P3 triage tier with the arithmetic that produced it, an evidence
ledger with citable ids, and the list of things it could not see. It ships as a CLI, a library and an MCP
server. Detection stays deterministic: a model is only ever asked to read an IDL diff and explain it,
never to decide what the tier is — and its explanation is discarded if it cites evidence that was never
issued.

It grew out of [Chase](https://github.com/0xCyrildev/Chase), the dynamic-analysis tool I built for Sui
Move — same bet that behaviour tells you more than intent, on a chain where an upgrade is a bytecode swap
under one shared loader.

![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

## What it does, and what it does not do

| Phase | Tool | Question it answers |
|---|---|---|
| Before deployment | static analyzers | what could this program do? |
| At build time | dependency scanners | is this npm package hostile? |
| Per transaction | runtime monitors | is this known-bad transaction running? |
| **At upgrade time** | **Dot** | **who breaks, and how much value was in the way?** |

A program's callers are not in its repository, its IDL or its dependency manifest. They are in the
transaction history of every integrator that ever did a CPI into it — which is exactly what Dot
reconstructs, and what no isolated-program audit can see.

It does not read source, does not decompile, and does not decide whether an upgrade is malicious. A P0 is
a queue position: *posture and blast radius justify a human before the weekend*. A P3 is a statement about
the evidence Dot was allowed to gather, not an all-clear. `SUSPECTED_MALICIOUS` is likewise a structural
signature it can name — who funded the authority and when, whether the new bytecode answers to a selector
the published interface denies, whether the timing fits the program's own cadence — never an intent it
cannot read. It is tuned to be rare and measured that way: 0 screams across two live mainnet programs run
with `--check-funding`, 1 on a constructed extreme case ([`docs/live-malice-2026-10-22.md`](docs/live-malice-2026-10-22.md)).

## Install and first run

Published as `@zeroxcyril/dot@1.2.1` — re-check with `npm view @zeroxcyril/dot dist-tags`, because the
registry is the only source for that sentence and this line has been wrong before. `npm publish` runs
`scripts/verify-install.sh` as `prepublishOnly`: it builds, packs this tree, installs the resulting
tarball into a throwaway prefix and executes every bin, so a package whose bins do not run cannot be
published by accident. Pass `--from registry` to aim the same check at what the registry already serves.

```bash
npm install -g @zeroxcyril/dot
dot analyze <PROGRAM_ID> --secondary-rpc <url>     # dot itself is fine; /usr/bin/dot is graphviz
npx -y -p @zeroxcyril/dot dot-limits --status      # no install at all; prints the limit catalogue
```

**`dot` collides with graphviz.** `/usr/bin/dot` shadows the linked binary, so the package also installs
unambiguous aliases — `dot-analyze`, `dot-watch`, `dot-mcp`, `dot-limits`, `dot-calibrate`. Nothing in a
`.env` is required, and no API key is read unless you ask for model reasoning. A paid RPC endpoint is not
optional in practice: the public endpoint has no transaction history, and a real run got `-32015` on all
ten trace fetches — the report said so rather than printing an empty graph.

```bash
dot analyze <program_id> --depth 2 --seeds seeds.example.json      # declared PDAs → custody
dot watch --targets targets.example.json --interval 30000 --secondary-rpc <url>
dot calibrate --rpc <url>          # measures the cost model instead of assuming it
dot mcp                            # MCP server over stdio
```

From a clone, if you intend to change it: `npm ci && npm run build && node dist/cli/index.js analyze <id>`.
The suite runs offline with no endpoint and no API key; the test count at each release is recorded in
[`docs/RELEASE-v1.2.1.md`](docs/RELEASE-v1.2.1.md) rather than copied here, because a number in two
documents is a number that goes stale in two places.

## Two numbers, two questions

Every report carries a P0–P3 tier *and* a 0–100 **Upgrade Danger Ranking**. They are allowed to disagree:
the tier is exposure (how much of the blast radius Dot was allowed to see), the ranking is queue position
(how soon a human should open *this* upgrade).

- **An axis with no data is `null`, not 0.** Never having diffed bytecode keeps code delta out of the
  total rather than scoring it as "no changes", and `CRITICAL` is withheld whenever any queue axis was
  unmeasured. A hole in the evidence must not read as a low score *or* a high one.
- **The axes sum to more than 100 and the score clamps**, with `rawScore` kept beside it so a reader can
  tell "several axes maxed out" from "the ceiling is arithmetic".
- **Inputs that do not exist on-chain are named as such.** A multisig's threshold, ecosystem-event
  proximity and routed *token* value are unmeasurable from traces; the ranking prints which axis wanted
  them instead of guessing.
- **It asks for budget rather than returning a thin answer.** When the affordable sample cannot
  distinguish "no dependents" from "not in the sample", the run returns `needs_more_budget` with the calls
  it wants and exits 4, carrying a falsifiable hypothesis (`--hypothesis-out`) that a better-funded run
  re-tests. Zero from a check that did not run is not evidence of absence.

## What Dot cannot see

`dot limits` prints the catalogue as data — each code with its full text and escape route — and
`dot limits --status` puts every row in RESOLVED / NARROWED / UNRESOLVABLE_IN_CODE with the test behind
each claim it marks RESOLVED. `dot limits --for <program_id>` answers it per program, from about four
reads: `applies`, `probe_clean`, `not_probed`, `by_construction`. The history-retention, single-node-trust
and Geyser-path rows are the ones that bite hardest on a public endpoint, and the report you get back
names the ones that applied to it. They stay out of this README on purpose: prose copies rot, and every
run already carries its own list.

## Where the rest lives

- [`docs/INTERNALS.md`](docs/INTERNALS.md) — the agent loop and budget, where the numbers come from
  (attribution, value-as-proxy, block batching, same-slot corroboration), full CLI/library/MCP reference,
  the source map, testing, and the live run.
- [`docs/lessons.md`](docs/lessons.md) — what the chain taught Dot: three load-bearing assumptions that
  died on contact, including that `@solana/web3.js` cannot deserialize its own `jsonParsed` output.
- [`docs/SUBMISSION.md`](docs/SUBMISSION.md) — the complete case, with the design decisions and the two
  places they deviate from the brief.
- [`skill/dot/SKILL.md`](skill/dot/SKILL.md) — how another agent should read a report, including the
  four kinds of nothing.

Built by reading mainnet responses instead of reading docs about them. If it earns one thing, it is that
the on-chain supply chain is a graph reconstructable from traces, and that a tool which cannot tell you
what it failed to see is worse than no tool at all.
