/**
 * Synthetic trace fixtures.
 *
 * `tx-nested.json` is a real mainnet transaction captured 2026-10-21 and is the
 * one that proves the `innerInstructions[].index` fold against production data.
 * It is only two levels deep, and the cases that actually break a naive analyzer
 * are three levels deep, log-only, failed, and v0-with-address-tables — so those
 * four are constructed here, against the field names and shapes observed on the
 * wire (see `src/rpc/wire.ts` for what was measured vs assumed).
 *
 * Regenerate with: node test/fixtures/generate.mjs
 */
import { writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { PublicKey } from '@solana/web3.js';

const pk = (letter) => new PublicKey(Buffer.alloc(32, letter.charCodeAt(0))).toBase58();
const P = {
  alpha: pk('A'),
  bravo: pk('B'),
  charlie: pk('C'),
  delta: pk('D'),
  user: pk('U'),
  vault: pk('V'),
  table: pk('T'),
};
const SYSTEM = '11111111111111111111111111111111';

const key = (pubkey, writable = false, signer = false) => ({
  pubkey,
  signer,
  source: 'transaction',
  writable,
});

function tx({ instructions, inner, logs, version = 'legacy', accountKeys, loadedAddresses, err = null }) {
  return {
    slot: 400_000_100,
    transactionIndex: 7,
    blockTime: 1_760_000_000,
    version,
    transaction: {
      message: {
        accountKeys,
        instructions,
        recentBlockhash: 'EKAGmSeh7AUWmQq9q8CtHwNv5P4v7WvKQv8cQiSeHtVj',
        addressTableLookups: version === 'legacy' ? null : [{ accountKey: P.table, writableIndexes: [0], readonlyIndexes: [1] }],
      },
      signatures: ['5Tx' + version],
    },
    meta: {
      err,
      status: err === null ? { Ok: null } : { Err: err },
      fee: 5_000,
      computeUnitsConsumed: 42_000,
      preBalances: accountKeys.map((_, i) => 1_000_000 + i * 1_000),
      postBalances: accountKeys.map((_, i) => 1_000_000 + i * 1_000),
      innerInstructions: inner,
      logMessages: logs,
      loadedAddresses: loadedAddresses ?? null,
      rewards: [],
    },
  };
}

const parsedIns = (program, programId, info, stackHeight) => ({
  program,
  programId,
  parsed: { type: 'transfer', info },
  ...(stackHeight === undefined ? {} : { stackHeight }),
});

/** `encoding: "json"` shape: accounts are integer indexes into the key table. */
const rawIdx = (programId, accounts, stackHeight) => ({
  programId,
  accounts,
  data: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  ...(stackHeight === undefined ? {} : { stackHeight }),
});

/**
 * `encoding: "jsonParsed"` shape: the node has already decomplied the indexes
 * into pubkeys. This is what mainnet actually returns and what Dot is built
 * against; the index form above is handled too, but a parser that assumes it
 * silently resolves `keys["6tv7sUQ4..."]` to undefined and reports zero value.
 */
const rawPk = (programId, accountIdx, keys, stackHeight) => ({
  programId,
  accounts: accountIdx.map((i) => keys[i].pubkey),
  data: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  ...(stackHeight === undefined ? {} : { stackHeight }),
});

const LOGS_D3 = [
  `Program ${P.alpha} invoke [1]`,
  `Program ${P.bravo} invoke [2]`,
  `Program ${P.charlie} invoke [3]`,
  `Program ${P.charlie} success`,
  `Program ${P.bravo} success`,
  `Program ${P.delta} invoke [2]`,
  `Program ${P.delta} success`,
  `Program ${SYSTEM} invoke [2]`,
  `Program ${SYSTEM} success`,
  `Program ${P.alpha} success`,
];

// ---- depth 3: A -> B -> C, plus a sibling A -> D. The fold must NOT credit C to A.
const accountsD3 = [key(P.user, true, true), key(P.alpha, true), key(P.bravo), key(P.charlie), key(P.delta), key(P.vault, true)];
const innerD3Parsed = [
  rawPk(P.bravo, [2, 3], accountsD3, 2),
  rawPk(P.charlie, [3, 4], accountsD3, 3),
  rawPk(P.delta, [1, 5], accountsD3, 2),
  parsedIns('system', SYSTEM, { source: P.user, destination: P.vault, lamports: 750_000 }, 2),
];
writeFileSync(
  'test/fixtures/tx-depth3.json',
  JSON.stringify(
    tx({
      accountKeys: accountsD3,
      instructions: [rawPk(P.alpha, [0, 1, 2], accountsD3, 1)],
      inner: [{ index: 0, instructions: innerD3Parsed }],
      logs: LOGS_D3,
    }),
  ),
);

// ---- the identical trace in `encoding: "json"` form: indexes instead of pubkeys.
writeFileSync(
  'test/fixtures/tx-depth3-json-encoded.json',
  JSON.stringify(
    tx({
      accountKeys: accountsD3,
      instructions: [rawIdx(P.alpha, [0, 1, 2], 1)],
      inner: [{ index: 0, instructions: [rawIdx(P.bravo, [2, 3], 2), rawIdx(P.charlie, [3, 4], 3), rawIdx(P.delta, [1, 5], 2), rawIdx(SYSTEM, [0, 5], 2)] }],
      logs: LOGS_D3,
    }),
  ),
);

// ---- same trace with stackHeight stripped: attribution must fall back to logs, not to flat.
const logsOnlyInner = [{ index: 0, instructions: [
  rawPk(P.bravo, [2, 3], accountsD3),
  rawPk(P.charlie, [3, 4], accountsD3),
  rawPk(P.delta, [1, 5], accountsD3),
  rawPk(SYSTEM, [0, 5], accountsD3),
] }];
writeFileSync(
  'test/fixtures/tx-logs-only.json',
  JSON.stringify(
    tx({
      accountKeys: accountsD3,
      instructions: [rawPk(P.alpha, [0, 1, 2], accountsD3)],
      inner: logsOnlyInner,
      logs: [
        `Program ${P.alpha} invoke [1]`,
        `Program ${P.bravo} invoke [2]`,
        `Program ${P.charlie} invoke [3]`,
        `Program ${P.charlie} failed: AccountInUse`,
        `Program ${P.bravo} success`,
        `Program ${P.delta} invoke [2]`,
        `Program ${P.delta} success`,
        `Program ${SYSTEM} invoke [2]`,
        `Program ${SYSTEM} success`,
        `Program ${P.alpha} success`,
      ],
    }),
  ),
);

// ---- failed transaction: inner instructions present, but the whole tx rolled back.
writeFileSync(
  'test/fixtures/tx-failed.json',
  JSON.stringify(
    tx({
      accountKeys: accountsD3,
      err: { InstructionError: [0, { Custom: 6000 }] },
      instructions: [rawPk(P.alpha, [0, 1, 2], accountsD3, 1)],
      inner: [{ index: 0, instructions: [rawPk(P.bravo, [2, 3], accountsD3, 2)] }],
      logs: [
        `Program ${P.alpha} invoke [1]`,
        `Program ${P.bravo} invoke [2]`,
        `Program ${P.bravo} success`,
        `Program ${P.alpha} failed: Custom program error: 0x1770`,
      ],
    }),
  ),
);

// ---- v0 with table-loaded addresses NOT inlined: index 5/6 only exist in loadedAddresses.
const staticKeys = [key(P.user, true, true), key(P.alpha, true), key(P.table), key(P.bravo), key(SYSTEM, true)];
writeFileSync(
  'test/fixtures/tx-v0-lookup.json',
  JSON.stringify(
    tx({
      version: 0,
      accountKeys: staticKeys,
      loadedAddresses: { writable: [P.vault], readonly: [P.charlie] },
      instructions: [rawIdx(P.alpha, [0, 1, 5], 1)],
      inner: [{ index: 0, instructions: [rawIdx(P.bravo, [3, 5, 6], 2)] }],
      logs: [
        `Program ${P.alpha} invoke [1]`,
        `Program ${P.bravo} invoke [2]`,
        `Program ${P.bravo} success`,
        `Program ${P.alpha} success`,
      ],
    }),
  ),
);

/**
 * Real ProgramData account heads, captured from mainnet on 2026-10-21 via
 * getAccountInfo(base64). These are the bytes that overturned two assumptions:
 * the ProgramData discriminant measured 3 (not 2) and the ELF magic sits at 45
 * with no data_len field before it. metaqbxx's authority is renounced, which is
 * the None case.
 */
const observed = {
  provenance: 'api.mainnet-beta.solana.com getAccountInfo(base64), 2026-10-21, first 45 bytes of each ProgramData account',
  accounts: [
    {
      program: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
      programData: 'HZcJwcJ2njPDxZtpPoKnF8v2w9QAx2rS7TdJPSRkbEhu',
      accountLen: 2_229_821,
      headBase64: Buffer.from(
        '03000000' + 'a66245190000000001fef3204452c2c8f37575d8a7e30bd14a7d712ae9fbf1a92f0784f92b2f6361fa' + '7f454c46',
        'hex',
      ).toString('base64'),
      expect: { discriminant: 3, bytecodeOffset: 45, authority: 'JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd', headerU64: 423_977_638 },
    },
    {
      program: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
      programData: 'PwDiXFxQsGra4sFFTT8r1QWRMd4vfumiWC1jfWNfdYT',
      accountLen: 794_036,
      headBase64: Buffer.from(
        '03000000' + 'b867b116000000000051b4de5a0619575adb04c439878648ac81487e8529cded2b1fccb55115ef7247' + '7f454c46',
        'hex',
      ).toString('base64'),
      expect: { discriminant: 3, bytecodeOffset: 45, authority: null, headerU64: 380_725_176 },
    },
  ],
  programPointers: [
    { program: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', discriminant: 2, accountLen: 36, pointsTo: 'HZcJwcJ2njPDxZtpPoKnF8v2w9QAx2rS7TdJPSRkbEhu' },
    { program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', discriminant: 2, accountLen: 36, pointsTo: 'B5MvUwXdiW1NMM6QFFD3ssPKBujD4zMohncbM73Z2BQu' },
    { program: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', discriminant: 2, accountLen: 36, pointsTo: 'PwDiXFxQsGra4sFFTT8r1QWRMd4vfumiWC1jfWNfdYT' },
  ],
};
writeFileSync('test/fixtures/programdata-observed.json', JSON.stringify(observed, null, 2));
console.log('wrote 5 tx fixtures + programdata-observed.json');
console.log(JSON.stringify({ P }, null, 1));
