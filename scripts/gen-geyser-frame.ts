import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { PublicKey } from '@solana/web3.js';
import { encodeUpdate } from '../src/rpc/yellowstone.js';
import { BPF_LOADER_UPGRADEABLE } from '../src/ids.js';

/**
 * Builds `test/fixtures/yellowstone-frame.bin`.
 *
 * Say exactly what this artifact is, because the difference is the whole point of the limit
 * code: these are **not bytes a provider sent us**. They are the bytes the geyser codec
 * produces for an account that mainnet *did* serve — the first 45 bytes of the LBUZ
 * ProgramData account, captured 2026-10-21 via `getAccountInfo` and committed as
 * `programdata-observed.json`. So the wire format is real while the transport stays unproven.
 *
 * Regenerate with `npx tsx scripts/gen-geyser-frame.ts`. `test/yellowstone-live.test.ts`
 * asserts the committed file still equals this output, so an edit to either the codec inputs
 * or the artifact fails the suite instead of silently diverging.
 */
const observed = JSON.parse(readFileSync('test/fixtures/programdata-observed.json', 'utf8')) as {
  accounts: Array<{ program: string; programData: string; headBase64: string }>;
};
const real = observed.accounts[0]!;
const data = Buffer.from(real.headBase64, 'base64');

const frame = {
  filters: ['loader'],
  createdAt: undefined,
  account: {
    isStartup: false,
    slot: '459621012',
    bankId: undefined,
    account: {
      pubkey: new PublicKey(real.programData).toBuffer(),
      lamports: '12633600',
      owner: new PublicKey(BPF_LOADER_UPGRADEABLE).toBuffer(),
      executable: false,
      rentEpoch: '18446744073709551615',
      data: new Uint8Array(data),
      writeVersion: '4471',
      // The signature field is the one place this artifact would need bytes Dot never saw, so
      // it is left absent rather than filled with something plausible.
      txnSignature: undefined,
    },
  },
};

const bytes = encodeUpdate(frame as never);
writeFileSync('test/fixtures/yellowstone-frame.bin', Buffer.from(bytes));
const head = Buffer.from(bytes).subarray(0, 8).toString('hex');
console.log(`wrote test/fixtures/yellowstone-frame.bin — ${bytes.length} bytes, head ${head}`);
console.log(`account ${real.programData} data ${data.length}B sha256(data)=${createHash('sha256').update(data).digest('hex').slice(0, 16)}…`);
console.log(`sha256(frame)=${createHash('sha256').update(Buffer.from(bytes)).digest('hex').slice(0, 16)}…`);
