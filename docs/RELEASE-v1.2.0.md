# Dot v1.2.0

Released 2026-10-22 to npm as `@zeroxcyril/dot@1.2.0`. Supersedes [v1.0.0](./RELEASE-v1.0.0.md) and v1.1.0.

Suite at this tree: **425 passed / 3 skipped, 32 files**, `npx vitest run`, rc 0;
`npx tsc -p tsconfig.json --noEmit` rc 0 (never piped — a pipe reports the pipe's status).
`bash scripts/verify-install.sh --from registry` after the publish: 6/6 bins execute and report `1.2.0`.

## What is in it

**The multisig quorum is read from the chain.** `getParsedAccountInfo` asks the node to parse the upgrade
authority with `jsonParsed`, and `readAuthorityQuorum` bands both the queue-position axis and the integrity
axis on the real m-of-n. A native multisig is therefore recognised as one without the operator saying
`--multisig`, and a 1-of-2 no longer scores the same as a 5-of-9. The read happens in `evaluate`, not
`perceive`, so `perceive` keeps the one-RPC-call property that makes it legal to run before a decision.

**`--check-signers` dates the signer set.** One `getSignaturesForAddress` per signer, capped at five, with
the cap reported rather than applied silently, filling the brief's other half of the same +10 band ("a stale
signer set"). It scores in the opposite direction from the funding axis: an unread, refused or empty set
earns nothing, because a check that did not run must not mint suspicion. The two halves are not added.

**`DOT_STATE_FILE` gives the MCP server a memory.** Without a prior digest the behavioural axis is
unmeasured, and the ceiling rule withholds CRITICAL from every answer the server gives — a limit of the
transport that a reader could only misread as a statement about the program. The file is read, never written:
an MCP server writing to a path its caller chose is a side effect nobody asked for. Measured with
`scripts/probe-mcp-state.mjs`: with the file set, `behavior` leaves `danger.unassessedAxes`; the score stays
10/100 either way, because measurability is not magnitude.

**The malice scream now says when the clamp bit.** A flagged upgrade prints `Score: 100/100 (raw 155/180
before the clamp)`, and prints the suffix only when the clamp actually bit — a test asserts the unclamped
case, so the note cannot decay into boilerplate. In an accusation, `100/100` is the one number a reader
treats as a measurement, and it is arithmetic.

**`--threshold 2-of-3` works.** In 1.1.0 the parser rejected the form its own help text and error message
quote: the grammar `/^(\d+)\s*(?:-?of|-)\s*(\d+)$/i` lets `-?of` consume `-of` and leaves the trailing `-3`
nowhere to go, while `2of3`, `2-of-3`'s siblings `2-3` and `2 of 3` parsed. It shipped because nothing could
import the function to test it — `src/cli/index.ts` runs `program.parseAsync` at import time — which is why
the declared-input parsers now live in `src/cli/args.ts` and the watch-line alarm in `src/report.ts`, both
pinned by tests.

**Operator-declared inputs, threaded honestly.** `--suspect`, `--governance-program`, `--incident-at`,
`--threshold m-of-n`, `--timelock`, `--check-funding`, `--check-signers`. Each one prints in the report that
it was declared rather than observed. `--check-funding` no longer walks a multisig authority that no band can
score, and when it skips it says so in the trace and the evidence ledger, so silence cannot read as
probed-and-clean.

**State handling is one module.** `src/state/priorStore.ts` replaces two copies in the CLI and the third the
MCP server needed. A digest with no usable timestamp is dropped rather than rendered as "Invalid Date" inside
a score, and saving creates the parent directory — the same lesson `--out` learned by losing a whole paid run
to `ENOENT`.

## What it does not claim

- **No live native multisig has been sighted from this box.** The one call that would surface one,
  `getTokenLargestAccounts`, is refused by both reachable endpoints (429 on api.mainnet-beta, an
  indexed-request token on publicnode), and no candidate program I can source from this repo has a multisig
  upgrade authority. The quorum path is therefore proven against a captured real `jsonParsed` body and
  fixtures, and its `labelled_without_quorum_fields` state returns the keys it *did* see, so the first real
  sighting produces evidence instead of a mis-score. `DANGER_RANKING_UNMEASURED_INPUTS` stays NARROWED.
- **Program-owned DAOs (Squads v2/v3) are still unread.** The node returns their authority as a program
  account, not a parsed multisig; their quorum lives in that program's own layout, which differs by version.
  Those keep the operator-declared path.
- **The bytecode scanner's coverage is still two images.** `scripts/probe-coverage.ts` proved the ELF
  extraction against four deployed mainnet programs (432 KB to 10.5 MB — the magic-at-45, no-length-prefix
  assumption holds on live data), but none of the four publishes an `anchor:idl` PDA, so located-over-declared
  is undefined for every program reachable here. That is corpus access, not the decoder.
- **Timelocks, mixer lists and incident feeds are not readable from chain data at all.** The brief's 0-point
  authority case exists only when somebody types `--timelock`; "funded by a mixer" only ever means "funded
  from an address the operator named", because an invented list would be a claim about the world with no
  source.
- **The scream is not intent.** `SUSPECTED_MALICIOUS` routes a human with the axis points and the gate
  printed underneath; a team with a fresh ops wallet, a stale IDL and an honest upgrade produces the same
  signature, and the output says so in the same breath.

## Reproducing

```bash
npm view @zeroxcyril/dot dist-tags                    # latest: 1.2.0
bash scripts/verify-install.sh --from registry        # installs 1.2.0 and runs all six bins
npx -y -p @zeroxcyril/dot dot-limits --status         # no install; prints the limit catalogue
```

Tags point at the commits that produced the artifacts, not at the branch tip: `v1.1.0` sits at `91879ae`
because that is the tree whose tarball npm served as 1.1.0, verified by what the published `dist/` does not
contain. `v1.2.0` follows the same rule.
