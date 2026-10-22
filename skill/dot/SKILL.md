---
name: dot
description: "Blast-radius analysis of Solana program upgrades. Watches BPFLoaderUpgradeable for bytecode changes, reconstructs the on-chain CPI dependency graph from real execution traces, scores the upgrade into tiers P0 to P3 with the arithmetic and an evidence ledger behind it, and runs as a budget-bounded agent that stops early, reports partial graphs as partial, and asks for more budget instead of returning a thin answer. Covers the on-chain supply chain that static analysis cannot see: who calls this program, and how much value routes through them. Triggers on 'blast radius of a Solana program', 'what depends on this program', 'watch a Solana program upgrade', 'this program just upgraded', 'Solana CPI graph', 'who breaks if this program changes', 'supply chain risk for this Solana protocol', 'is this upgrade dangerous', 'check the upgrade authority', 'Solana programdata changed'."
paths: **/*.json, **/*.ts, **/*.md
---

# Dot

Static analysis reads what a program claims it will do. Dot reads what the ecosystem **does** when a
program changes: who calls it, how often, and how much value was routing through them at the moment the
bytecode was replaced. That relationship lives in no source tree — it is only in the transaction history
of every integrator that ever did a CPI into the program.

`$SKILL_DIR` = the directory containing this SKILL.md.

## Install

Published: `@zeroxcyril/dot@1.0.0`. Both forms below were run against the registry before being
written here: a global install into a throwaway prefix reported `1.0.0` from all six bins, and the
`npx` form printed the limit catalogue.

```bash
npm install -g @zeroxcyril/dot
dot-limits --status                              # use the alias: /usr/bin/dot is graphviz

npx -y -p @zeroxcyril/dot dot-limits --status    # no install at all
```

From a clone, when the agent is meant to edit rather than only call it: `npm ci && npm run build`,
then `node dist/cli/index.js analyze <PROGRAM_ID>`. To check an install rather than assume one, run
`npm run verify-install` — it builds, packs, installs into a throwaway prefix and **executes all six
bins**, printing `OK — 6/6 bins executed and reported <version>` or the named failure; add
`--from registry` to do the same against the published package. `test/install.test.ts` drives this
same script, so the suite and the operator cannot drift. If the global prefix is not writable - on the build box it resolves
to a `/usr/local/lib/node_modules` that does not exist - set one you own first:
`npm config set prefix ~/.npm-global`. The bare bin is `dot`, which collides with graphviz; `dot-analyze`, `dot-watch`, `dot-mcp`,
`dot-limits`, `dot-calibrate` do not. One alias quirk to know before scripting around it: an alias
dispatches to its own subcommand and **ignores a stray extra argument** —
`dot-calibrate analyze X` runs a calibration instead of failing.

## When to use it

| Situation | Use | Wrong tool if you reach for |
|---|---|---|
| Program source, before deployment | a static analyzer | Dot (it sees landings, plus staged bytes at best) |
| "What depends on this program?" | `dot analyze <program> --depth 3` | a dependency scanner — it reads npm, not CPI |
| "An upgrade just landed. Does anyone care?" | `dot watch` / `dot-mcp` → `dot_evaluate_upgrade` | a runtime monitor (pattern-matching, one tx at a time) |
| "Which upgrade in the last 24h should a human open first?" | `dot blast-radius --since <date>` | a ranking of your own portfolio |
| "A single key can replace this. What else can it touch?" | the widen path, on by default when dependents are nil | nothing else does this |
| "What is an agent calling?" | `dot mcp` over stdio | — |

## The three layers

1. **`dot analyze <program>`** — one-off. Reads the program's own state and its dependent graph.
2. **`dot watch`** — continuous, budgeted. A `Budget` (`maxRpcCalls`, `maxSignatures`, `maxLlmTokens`,
   `maxWallMs`) is charged **before** every request, a failed call still counts, each retry is charged
   again. `decide` exists to skip `act`, so a boring upgrade costs one RPC call and still emits a report.
   Chain-wide mode (`--yellowstone`) caps each event at `--per-event-rpc` and drops the excess **with a
   counter**.
3. **`dot blast-radius --since --min-value`** — ecosystem. Discovers upgrades by walking the loader's own
   signature index, proves each program/programdata pair by re-deriving the PDA locally, and outputs a
   **warning list**: who to notify, by dependent-program authority, or a count of authorities it could not
   read.

## How to read coverage honestly

This is the section that exists to prevent the failure mode of every scanning tool: **an agent that has
only ever seen successful scans will report an empty range as a clean one.** There are four kinds of
"nothing" and they mean opposite things.

| What you see | What it means | Where it is proven |
|---|---|---|
| **No scan ran.** `blastRadius: null`, `stoppedAt: "decide"` or `"perceive"` | Dot declined or was refused before sampling. Silence here is *not* safety; it is an absence of evidence about an unknown thing. | `report.stoppedAt` |
| **Range empty.** `tracesAnalyzed: 0` with `pruned > 0` or `rpcErrorCodes` populated | The window exists but the node would not serve it. `-32015` means *this node has no history*, not *nothing happened*. | `report.rpc`, `cappedBy` |
| **Target not matched.** traces parsed, but zero attributed edges | This program was not called inside the sample. Meaningful only when `sampleCoverage` is high. | `blastRadius.attributionQuality`, `sampleCoverage` |
| **Target reached, clean.** full coverage, real sample, edges present and unremarkable | The only "nothing to see" that is evidence. | `confidence: "high"` **and** `cappedBy: null` |
| **Axis not assessed.** `danger.axes[].points === null` | One of the four danger-ranking inputs never existed for this run — no diff, no graph, no state file. It is excluded from the total, not scored as zero, and CRITICAL is withheld while it is missing. | `danger.unassessedAxes`, `danger.coverage`, `danger.ceiling` |

Read in this order, every time: `stoppedAt` → `cappedBy` → `sampleCoverage` → `confidence` → then the
tier. A tier with `cappedBy` non-null is a tier limited by a blind spot; `NO_MALICE_DETECTION` and
`FINALITY_VS_LATENCY` are in `dot limits --status` for the same reason.

**Before analyzing one program, `dot limits --for <program>` costs about four calls and says which blind
spots are live for it**: `applies` (observed here), `probe_clean` (one probe found nothing wrong at the
point it touched — a retrievable newest signature says nothing about where the node's retention ends),
`not_probed` (this run could not look), `by_construction` (no probe of one program would change it).
`probe_clean` is not `applies`, and `not_probed` is never `probe_clean`.

**`confidence` is not severity.** A low-confidence P1 is a different job from a high-confidence P1.
`tierSource: "integrity"` means the *tool's inputs* contradicted each other (two endpoints, same slot,
different bytes) and the run halted — that is not a statement about the program at all.

**The tier is not the ranking, and the ranking is not a verdict.** Every report carries both numbers:
`tier`/`score` from `scoreRisk()` is *exposure* — how much blast radius Dot was permitted to see — while
`danger` from `src/score/danger.ts` is a *queue position* for this one upgrade, 0–100 over authority
posture (40), code delta (30), blast radius (30) and behavioural anomaly (20). They disagree routinely
and that is the point: a dull-looking program held by one key can be P3 by sampled exposure and CRITICAL
by posture. Read `danger.category` to decide when to look, never whether the program is safe. Three
inputs the model would want are not obtainable from chain data and the axis prints them in its own
`notAssessed` line rather than approximating: a multisig's **threshold** (Dot does not decode the
multisig account, so 1-of-2 and 5-of-9 both score 25, at the alarming end and labelled as an assumption),
**proximity to an ecosystem event** (no feed exists, so that +10 has never been awarded), and routed
**token value** (the graph records which mints were touched, never how much, so the ×2 multiplier is
lamports-only). The axes sum to 120 and the score clamps to 100: keep `rawScore` in view, because
100/100 can mean "several axes maxed out" or "the arithmetic ran out of room", and those are different
facts about the program.

## What the agent will do that a script will not

- **Ask for budget.** When posture says single-key or rotated authority and the affordable sample is
  below what can distinguish "no dependents" from "not in the sample", the run returns
  `needs_more_budget` with the number of calls it wants and what they would confirm, prints
  `Re-run with --budget-rpc +N`, and exits **4**. Do not treat exit 4 as failure; it is the agent naming
  its own limit. Exit 3 = a stop was reached, 5 = the limit catalogue failed its own test.
- **Report partial graphs as partial.** Budget exhaustion mid-pull keeps the graph it built and sets
  `stoppedAt: "act"`. Never re-label it complete.
- **Widen to the authority** when a single-key program shows no dependents on a meaningful sample — and
  say `co-control, NOT dependents` when it does, because co-occurring programs share no CPI edge.
- **Discard a model answer that cites evidence that was never issued**, wholesale rather than trimmed,
  and print the refusal. Never quote a discarded narrative as a finding.

## Machine-readable interfaces

```bash
dot limits --status       # RESOLVED / NARROWED / UNRESOLVABLE_IN_CODE, each RESOLVED naming a test
dot limits --status --format json
dot mcp                   # tools: dot_blast_radius, dot_evaluate_upgrade, dot_limits, dot_watch_status
```

Every MCP tool requires a `budget` argument, so an orchestrator cannot ask for an unbounded scan by
accident. `dot_watch_status` distinguishes "no upgrades detected" from "nobody is watching", and flags a
cursor older than five minutes as stale.

## Limits you must carry into any conclusion

Run `dot limits` — 20 codes, each with what it cannot see and the escape route. The ones that bite
hardest: `HISTORY_RETENTION` (public endpoints retain days; the fix is an archive endpoint, not code),
`VALUE_IS_PROXY` (routed lamports are a per-transaction upper bound, never TVL, never per-leg),
`PDA_HOLDINGS_NOT_ENUMERATED` (custody is invisible without a seed list), `NO_IDL_CONTRACT` (no
mandatory interface, so semantics may be unreadable), `SINGLE_NODE_TRUST` (one endpoint is one point of
view), and `NO_MALICE_DETECTION` (a tier is a queue position, not a verdict).

`references/live-run-2026-10-21.json` is a real report from a real endpoint that refused history.
Read it before trusting a clean one: it is the empty-scan example, and it is deliberately in here so an
agent has seen what failure looks like.
