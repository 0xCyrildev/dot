# Dot

Agentic blast-radius analyzer for Solana program upgrades.

When an upgradeable Solana program changes bytecode, the question nobody answers is
*who downstream breaks*. Static analyzers see one program. Runtime monitors see one
transaction. Dot reconstructs the on-chain supply chain — the `caller → callee` graph
recovered from real execution traces — and prices an upgrade by how much value and
how many integrators route through the program that just changed.

## Run

```bash
npm install
npm test                                # 72 tests, no network

node --import tsx src/cli/index.ts analyze <program_id> --sample 60
node --import tsx src/cli/index.ts watch --targets targets.example.json --interval 30000
node --import tsx src/cli/index.ts limits      # what Dot cannot see, as data
node --import tsx src/cli/index.ts mcp         # MCP stdio server
```

`DOT_RPC_URL` sets the endpoint, `DOT_LLM_API_KEY` enables `--mode real`. Both also
exist as flags. Prefer a paid endpoint: the public one has no transaction history and
Dot will say so in every report it produces against it.

## Why it is an agent and not a script

One run is `perceive → decide → act → evaluate → report` under a `Budget`
(`maxRpcCalls`, `maxSignatures`, `maxLlmTokens`, `maxWallMs`). `act` is the only
expensive stage, so `decide` exists to avoid it: a multisig-held program with an
already-known empty graph stops after **one** RPC call and still emits a full report
recording what it declined to spend. Every report carries the budget snapshot, the
stage it stopped at, and an evidence ledger with citable ids.

In `--mode real` a model reads the IDL diff — but only inside a citation gate: an
answer that references an evidence id Dot never issued is **discarded**, not trimmed,
and the refusal is printed in the report. The tier itself is computed from posture
and observed graph in code.

## Three things the chain contradicted

Written against measured mainnet responses, not against client typings
(`src/rpc/wire.ts` records what was observed vs assumed):

- `Connection.getTransaction(..., 'jsonParsed')` in `@solana/web3.js` v1.99 **throws**
  `StructError: meta.innerInstructions.0.instructions.0.accounts — Expected an array,
  received undefined`. Parsed instructions carry no `accounts`. Dot owns its JSON-RPC.
- Instruction `accounts` are **base58 pubkeys** under `jsonParsed` and **integer
  indexes** under `json`. Assuming one silently reads `keys["6tv7…"]` → `undefined` →
  a confident "no value routed through here".
- `ProgramData` measured discriminant **3** (Program **2**), with the ELF magic at
  offset **45** and no `data_len` field before it. So change detection hashes the
  *whole account* and only computes a bytecode hash once the magic has been found.

See `src/limits.ts` / `dot limits` for the honest blind spots, including why
chain-wide upgrade detection needs Yellowstone gRPC rather than core JSON-RPC.
