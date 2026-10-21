# What the chain taught Dot

Dot was designed against documentation and client typings, and then run against mainnet. Three
load-bearing assumptions died in the first hour, and the rest of this document is about the ones that
survived. The question a reviewer is really asking of any security tool is: *was this built against the
chain, or against the description of the chain?* Here is the evidence.

## 1. The SDK could not read the response its own library produces

The first probe was the single most instructive thing in the project:

```
Connection.getTransaction(sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 })
→ StructError: At path: meta.innerInstructions.0.instructions.0.accounts
  -- Expected an array value, but received: undefined
```

That is `@solana/web3.js` v1.99 failing to deserialize an ordinary CPI-heavy mainnet transaction. The
cause is that parsed instructions (`spl-token`, `system`) carry **no** `accounts` field at all — their
account set lives inside `parsed.info` — while the library's superstruct declares it required. It threw
on the first sample tried, then on the second.

Two consequences. Dot owns its JSON-RPC layer, and web3.js survives in the tree only for `PublicKey` and
PDA derivation. And the more alarming lesson: any tool that wrapped that call in a `try/catch` and
carried on would have reported "no dependencies found" for the most integrated programs in the
ecosystem. For a blast-radius tool, a swallowed parse error is not a crash — it is a confident false
negative, and it looks exactly like a safe program.

## 2. Accounts are pubkeys in one encoding and indexes in another

The design said instruction `accounts` are indexes into the key table. Mainnet says:

```
jsonParsed → accounts: ["6tv7sUQ4R3fE9rnBX4w72oiiqSHqKF3KPvyubFNfazxd", …]
json       → accounts: [1, 5, 12]
```

A parser written for the second shape, fed the first, evaluates `keys["6tv7sUQ4…"]`, gets `undefined`,
and concludes that no lamports moved. No throw, no warning, just a zero where the risk was. Both shapes
now resolve through one table, and a test asserts that the same trace expressed in either encoding
produces the identical graph — because the failure mode is silent enough that only an equivalence test
catches it.

## 3. `ProgramData` is not the layout the SDK describes

Measured across several live programs: `ProgramData` account discriminant **3**, `Program` account
discriminant **2** — the reverse of the `UpgradeableLoaderState` enum order — and the ELF magic at byte
**45**, preceded by `u64 + Option<Pubkey>` with **no `data_len` field**. Reading the documented layout
lands you on `0x7f454c46` while calling it a length.

The discipline that came out of this is that Dot never trusts a constant for anything load-bearing.
Change detection hashes the **whole account**, which cannot miss a realloc or a rewrite regardless of
layout. The bytecode-only hash is computed after `indexOf(ELF_MAGIC)` *finds* the magic, and an account
where it is not found raises `UNKNOWN_PROGRAMDATA_LAYOUT` instead of hashing a guessed window. A watcher
with a wrong offset does not error; it reports an all-clear forever. Same rule applied later to the
staging `Buffer` account, whose header is shorter than `ProgramData`'s: the offset is located per account
and reported, never assumed — and unlike `ProgramData`, that layout has no live capture behind it yet,
which the code says out loud.

## 4. Two refusals, in the tool's own favour

**Block batching, refused as specified.** The plan called `getBlock` batching a 10x–100x RPC reduction.
That is true of *calls* and false of *cost*: a block is not your program's transactions, it is every
transaction in the slot. Measured against the default model, batching 20 transactions across 5 blocks is
4x fewer calls and **500x more bytes**. On a busy program the wall clock gets worse. So the batcher
prices both, prints both ratios next to the strategy it chose, refuses oversized blocks, and only batches
when calls genuinely bind. The cost model's defaults are labelled `defaults_unverified` until
`dot calibrate` measures them against your endpoint — and because no endpoint was reachable, they are
still labelled that way in this build rather than quietly promoted to constants.

**Multi-endpoint corroboration, narrowed.** "Query two endpoints, halt on disagreement" as written fires
on every upgrade, because two nodes 40 slots apart holding different bytes is chain progress, not a
contradiction. The comparison is same-slot only, and the verdicts are five: `agreed`, `disagreed`
(halt), `slot_mismatch` (inconclusive, continue), `single_source` (continue, labelled uncorroborated),
`both_failed` (halt). A check that cries wolf gets ignored, and an ignored integrity check is worse than
none.

## 5. Two collisions nobody warned me about

`/usr/bin/dot` is **graphviz**, and it shadowed the installed bin. `dot limits` printed
`can't open limits`. The package now ships `dot-analyze`, `dot-watch`, `dot-mcp`, `dot-limits`,
`dot-calibrate`, dispatching on `process.argv[1]`'s basename — verified by symlinking the names and
running them. Related: `tsc` emits bins at mode 0664 and npm packs the mode it is handed, so a global
install can exec a file the shell will not run; `postbuild` chmods and `test/install.test.ts` proves the
whole pack-and-install path.

And `@triton-one/yellowstone-grpc` v9 disagrees with the usual write-ups: `accounts.owner` and `account`
are **base58 strings**, not bytes; `lamports`, `slot`, `writeVersion` and `rentEpoch` are **decimal
strings** (kept as `BigInt`); and `isStartup` replay dumps must be filtered or a node catch-up looks like
100,000 upgrades. Pass bytes where this API wants a string and your filter matches nothing — which is
indistinguishable from a quiet chain, the single most dangerous ambiguity in a detection tool.

## 6. The tests audited my own code, and won

Every one of these was a bug I had written that session, found by a test rather than by reading:

- `stoppedAt` was hardcoded to `'report'` in the final return, so every budget-limited run was reported
  as a completed one.
- The Decide engine held its own `EvidenceLedger` while the Scout filled another, which would have made
  every model citation fail forever and `--mode real` degrade silently.
- A cursor walk with no progress guard hammered the endpoint until the budget died, then reported **zero**
  pruned traces, because every later fetch was refused.
- Once the plan became budget-derived, sample coverage measured against the *shrunk* plan — a run that
  wanted 25 traces and got 1 reported 100% coverage, which is the exact number the capped-tier rule
  reads. It now measures against what the risk wanted.
- Edge-level `lamportsRouted` was being summed into a total. The replay output showed why: the same
  313,067,416-lamport movement appeared on three different edges. A deduped per-transaction total is now
  the headline, and the overcount is still printed, labelled as not a total.

## 7. What that buys

A static analyzer reading `pAMMBay6oce…` sees instructions and missing checks inside one program. Run
the same captured mainnet transaction through Dot and it sees who called whom and how the caller was
established:

```
depth 2  AToken…8knL -> Tokenk…Q5DA [spl-token]   via stackHeight
depth 2  pAMMBa…fXEA -> Tokenz…xuEb [token-2022] via stackHeight
depth 2  pAMMBa…fXEA -> pAMMBa…fXEA              via stackHeight   ← a real self-CPI
6 outer instruction(s), 2 inner group(s), 11 CPI instruction(s), attribution stackHeight
```

That graph is not in the source tree, not in the IDL, and not in any dependency manifest. It exists only
in the transaction history of everyone who called the program — which is the on-chain supply chain, and
the reason this tool exists. Dot's answer to "what breaks if this changes?" is a ranked warning list with
an arithmetic trail, an evidence ledger whose ids a model must cite or be discarded, and twenty documented
blind spots in three states — resolved, narrowed, or not a thing code can fix.

The last category matters most. Public RPC prunes history, vault custody needs seed patterns a publisher
may never share, routed value is a per-transaction upper bound rather than a settlement figure, and no
tool can tell you an upgrade was hostile when the intent lives in a repository and a governance channel.
Dot says which of those it hit, on every report, in the report. A scanner that cannot tell you what it
failed to see is not more convenient than no scanner — it is worse.
