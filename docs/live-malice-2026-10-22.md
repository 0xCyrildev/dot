# Malice detection, live: two real programs, neither screams

Generated on 2026-10-22 from this checkout (`npm run build`), against `api.mainnet-beta.solana.com`,
with `--check-funding` switched **on** — the axis that costs extra RPC calls and is off by default.
Nothing below is handwritten: the blocks are what the CLI put on stdout.

The claim under test is constraint 2 of the brief: **the flag has to be rare.** A scream that fires on
one upgrade in ten is noise. This is the live half of that check; the synthetic half is
`test/malice.test.ts`, which runs nine ordinary shapes and asserts none of them fire.

## 1. A real program whose upgrade authority is a single EOA — the worst live case

```bash
node dist/cli/index.js analyze FuCKerMRwwExvo5bGFGjszhBQXcZicVqU4H9LZjqHbVf \
  --sample 2 --budget-rpc 25 --budget-wall 120000 --check-funding
```

```
UPGRADE DANGER RANKING: HIGH (Score: 60/100)
  scored on 60 of 100 measurable axis points; no data for: codeDelta, behavior, codeAnomaly, timingAnomaly
├── Authority: Single-key EOA (w3mDDN…) [+40/40]
├── Code Delta: no bytecode diff performed [not assessed/30]
├── Blast Radius: 0 direct, 0 transitive, routing 0 lamports in the sample (a per-transaction proxy, not a TVL figure) [+0/30]
├── Behavior: no state file: Dot has no memory of this program [not assessed/20]
├── Authority Integrity: single EOA, funding 5 hour(s) ago (retention-bounded) [+20/30]
├── Code Anomaly: no bytecode diff performed [not assessed/20]
└── Timing Anomaly: no timing evidence available [not assessed/10]
      · codeDelta: the diff was never run, so the axis has no data
      · behavior: no `--state` file: first-observed status carries no information
      · behavior: "upgrade within 24h of a major ecosystem event" (+10): Dot has no event feed of any kind, so this award is never given and no score in this build has ever included it
      · authorityIntegrity: no suspect funding addresses were supplied (`--suspect`), so the flagged-source band was unreachable by construction — Dot ships no mixer or obfuscation list of its own. This axis can report "no fresh funding observed"; it cannot report "not mixer-funded"
      · authorityIntegrity: the wallet looks young (5 hour(s) ago) but the node could be hiding older history, so "fresh" is not established and the +30 is withheld
      · codeAnomaly: the diff never ran, so no structural signature was checked
      · timingAnomaly: governance proximity not measured: no governance program was supplied, so this is neither clear nor suspicious
      · timingAnomaly: what a signature on that program means: Dot counts any transaction, and cannot tell a governance *proposal* from an ordinary call on the same program. Measured against the block time of the newest transaction Dot sampled for this program, not the upgrade transaction itself.
      · timingAnomaly: "during a known network incident" is not checkable by default: Dot ships no incident feed and fetches none, so it is only ever measured when an operator declares a time (--incident-at)
      · timingAnomaly: off-cadence requires 3 prior upgrades with block times; this run had fewer, so "routine cadence" is not established either

MALICE HEURISTIC: not flagged. Signature axes total 20/60; the gate needs the overall score at or above 90.

VERDICT: An upgrade of `FuCKerMRwwExvo5bGFGjszhBQXcZicVqU4H9LZjqHbVf` by Single-key EOA (w3mDDN…) (40/40 posture points). No bytecode diff was performed, so nothing is known about what the new code can be asked to do. 0 direct, 0 transitive, routing 0 lamports in the sample (a per-transaction proxy, not a TVL figure). Open it before the weekend: read the added entrypoints and the accounts they take, and check who signs. Held below its own ceiling because 4 axis/axes had no data (codeDelta, behavior, codeAnomaly, timingAnomaly).
```

**What the funding probe established.** The authority is one key, and the walk down its own signature
history found a funding event roughly five hours old — the shape the brief's +30 band describes. The +30
was **not** awarded, and the axis says why: the node returned a full page of signatures, so older
history may exist on a node that keeps more, and "fresh" is therefore not established. A truncated
history is not a genesis. That line is constraint 1 working on mainnet data rather than in a fixture:
`retentionBounded` is what stops the most accusation-shaped number in this build from being minted by
the size of a page.

The score is HIGH on posture alone and the heuristic stays quiet: the gate wants the score *and*
positive evidence, and 40 posture points plus 20 integrity points is an ordinary Solana program, not the
signature of an attack.

## 2. A real program whose authority is a PDA — nothing to accuse, nothing claimed

```bash
node dist/cli/index.js analyze LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo \
  --sample 2 --budget-rpc 25 --budget-wall 120000 --check-funding --sol-usd 150
```

```
UPGRADE DANGER RANKING: LOW (Score: 10/100)
  scored on 10 of 70 measurable axis points; no data for: codeDelta, behavior, authorityIntegrity, codeAnomaly, timingAnomaly
├── Authority: PDA authority (JADaUV…) [+10/40]
├── Code Delta: no bytecode diff performed [not assessed/30]
├── Blast Radius: 0 direct, 0 transitive, routing 0 lamports in the sample (a per-transaction proxy, not a TVL figure) [+0/30]
├── Behavior: no state file: Dot has no memory of this program [not assessed/20]
├── Authority Integrity: PDA authority [not assessed/30]
├── Code Anomaly: no bytecode diff performed [not assessed/20]
└── Timing Anomaly: no timing evidence available [not assessed/10]
      · codeDelta: the diff was never run, so the axis has no data
      · behavior: no `--state` file: first-observed status carries no information
      · behavior: "upgrade within 24h of a major ecosystem event" (+10): Dot has no event feed of any kind, so this award is never given and no score in this build has ever included it
      · authorityIntegrity: the signer is a program address: who can move it is decided by code Dot has not read, and "funded by a mixer" has no meaning for a PDA. This axis stays unmeasured rather than assuming the answer
      · codeAnomaly: the diff never ran, so no structural signature was checked
      · timingAnomaly: governance proximity not measured: no governance program was supplied, so this is neither clear nor suspicious
      · timingAnomaly: what a signature on that program means: Dot counts any transaction, and cannot tell a governance *proposal* from an ordinary call on the same program. Measured against Dot's own clock: this run had no upgrade timestamp, so proximity here is proximity to *now*, not to the upgrade.
      · timingAnomaly: "during a known network incident" is not checkable by default: Dot ships no incident feed and fetches none, so it is only ever measured when an operator declares a time (--incident-at)
      · timingAnomaly: off-cadence requires 3 prior upgrades with block times; this run had fewer, so "routine cadence" is not established either

MALICE HEURISTIC: not assessed — no signature axis had data on this run (No malice signature axis was measurable on this run, so the heuristic reports nothing — which is not a clean result.)

VERDICT: An upgrade of `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` by PDA authority (JADaUV…) (10/40 posture points). No bytecode diff was performed, so nothing is known about what the new code can be asked to do. 0 direct, 0 transitive, routing 0 lamports in the sample (a per-transaction proxy, not a TVL figure). No immediate action implied. A LOW is a statement about the evidence Dot was allowed to gather, not an all-clear. Held below its own ceiling because 5 axis/axes had no data (codeDelta, behavior, authorityIntegrity, codeAnomaly, timingAnomaly).
```

`--check-funding` was passed and spent **zero** calls on the authority: "who funded this wallet" has no
meaning for a program address, so the axis reads `not assessed` rather than 0, and the block ends with
"which is not a clean result" instead of an all-clear.

## Tally

| corpus | cases | screamed |
|---|---|---|
| live mainnet, this file | 2 | 0 |
| synthetic ordinary shapes (`test/malice.test.ts`) | 9 | 0 |
| synthetic extreme case (single EOA + observed fresh funding + undeclared selector) | 1 | 1 |

Two live programs is not a prevalence study and this file does not claim to be one. What it does
establish is narrower and checkable: the flag did not fire on a real single-EOA program that *did* have
a recent-looking funding event, because the evidence for freshness was not there — and it fires on the
constructed case where all three signatures line up.
