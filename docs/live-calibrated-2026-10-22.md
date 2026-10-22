# Calibrated ingestion plan, measured on mainnet 2026-10-22

```bash
DOT_COST_MODEL=docs/calibrated-model-2026-10-21.json \
  node dist/cli/index.js analyze FuCKerMRwwExvo5bGFGjszhBQXcZicVqU4H9LZjqHbVf \
  --sample 6 --budget-rpc 24 --format md
```

Live output, the ingestion line verbatim:

```
Trace ingestion: `per_signature` — 6 relevant tx(s) across 4 block(s), density 1.50 tx/block. per_signature: 6 call(s), ~108.2 kB. per_block: 4 call(s), ~36.5 MB (amplification 337.3x, because a block carries every transaction in the slot, not yours). Calls 1.5x cheaper, bytes 337.3x dearer. Chose per_signature because density 1.50 < floor 4. Cost model: docs/calibrated-model-2026-10-21.json.
```

Without the model the same code path prints
`Cost model: defaults_unverified: run dot calibrate --rpc <url> to measure these`
and computes amplification from 2000 transactions per block instead of the 506
measured here — the earlier artifacts in this directory, which ran before the
calibration, show that 2000x figure and are left as they were.
