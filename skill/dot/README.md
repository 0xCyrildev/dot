# dot — skill for agents

Human-facing review of [`SKILL.md`](./SKILL.md), the instruction layer for Dot: the same engine the CLI
and the MCP server expose, written for an agent that has to decide *when* to reach for it and *how* to
read what comes back.

- **What it does.** Reconstructs a Solana program's on-chain CPI dependency graph from execution traces
  and prices an upgrade by who depends on the program and what value routes through them.
- **Why an agent needs the skill and not just the binary.** Dot's most useful outputs are the ones that
  look like failures — `stoppedAt: "decide"`, `cappedBy: "only 0% of the planned sample was retrievable"`,
  exit code 4 asking for budget. An agent that has only seen clean runs will read an empty range as a
  clean one. The skill's "how to read coverage honestly" table is the four kinds of nothing, and it is
  the reason this file exists.
- **Detection is deterministic.** A model is asked to read an IDL diff and explain it. It cannot set a
  tier, and an answer citing evidence that was never issued is discarded whole.
- **References.** [`references/live-run-2026-10-21.json`](./references/live-run-2026-10-21.json) is the
  genuine artifact, including the `-32015` history refusal. It is a failure example on purpose.
- **What is verified, and what is not.** The package is published and installable
  (`npm install -g @zeroxcyril/dot`), and `dot calibrate` has measured real mainnet blocks
  (`../../docs/calibrated-model-2026-10-21.json`). What is still not verified, and is said so in the
  skill: **no Yellowstone endpoint has been reached live** by this build, so chain-wide gRPC detection
  is proven against captured bytes and a correct connect sequence, not against a provider.
