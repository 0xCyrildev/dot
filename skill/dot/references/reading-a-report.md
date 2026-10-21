# Reading a Dot report

Work top-down. Each field answers a question the next one depends on, and skipping the first three is how
an empty scan gets reported as a clean one.

| # | Field | Question it answers | If it is bad |
|---|---|---|---|
| 1 | `stoppedAt` | Did the plan complete? | `decide`/`perceive` = no sample was taken at all. `act` = the sample was cut short. |
| 2 | `cappedBy` | What blind spot limited the tier? | Non-null means the tier is *capped by a gap*, not by an absence of risk. |
| 3 | `budget.spent` vs `limits` | What did it pay for? | `rpcCalls` near the ceiling with `tracesAnalyzed` low means the ceiling, not the chain, produced the answer. |
| 4 | `rpc.pruned`, `rpc.rpcErrorCodes` | Was history available? | `-32015` = this node has no retention. Nothing below this line means anything yet. |
| 5 | `blastRadius.attributionQuality` | Can the edges be trusted? | `flat` = nested callers were credited to the transaction root; dependent counts are an **upper bound**. |
| 6 | `components[]` | Which factors produced the score? | Every component is additive and named; disagree with one, re-derive it. |
| 7 | `tier` + `confidence` | Queue position, and how much of the picture was visible | Low confidence never mints a P0. A P1 at low confidence is "get better data", not "escalate". |
| 8 | `evidence[]` | Can each claim be pointed at? | `EV-n` ids; a narrative that cites an id not in this list was discarded. |
| 9 | `integrity.agreement` | Do two endpoints agree? | `disagreed` → `tierSource: "integrity"`, a halt about the tool, not the program. |
| 10 | `limits[]` | What could not be seen | Always present. An empty graph plus `HISTORY_RETENTION` is a provider statement. |
| 11 | `hypothesis.outcome` | Did the better-funded run settle the earlier claim? | `not_testable` is the answer Dot gives when it could not afford the plan or never took the observation the claim depends on. It is not a denial. |

The worked example in this directory, `live-run-2026-10-21.json`, scores `P3` with `confidence: low` and
`cappedBy: "only 0% of the planned sample was retrievable from the node"`. Read correctly it says:
**detection worked, measurement was refused.** Read wrongly it says "this program is fine", which is the
sentence this document exists to prevent.
