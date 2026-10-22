import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { recoverSelectors } from '../src/state/sbfSelectors.js';
import { anchorDiscriminator } from '../src/state/bytecodeDiff.js';

const real = Buffer.from(readFileSync('/home/zeroxcyril/anchor-smoke/target/sbpfv2-solana-solana/release/anchor_smoke.so'));
const fixture = Buffer.from(readFileSync('/home/zeroxcyril/dot/test/fixtures/sbf-dispatch.so'));

// Names neither program implements. If a recovery rule can fire on a near-miss byte ordering,
// this is where it shows up.
const absent = [
  'close_position', 'liquidate', 'borrow', 'repay', 'flash_loan', 'set_owner', 'upgrade', 'mint',
  'burn', 'approve', 'transfer', 'withdraw_fees', 'govern', 'propose', 'vote', 'claim', 'stake',
  'unstake', 'redeem', 'deposit_with_permit', 'initialize_account', 'set_authority_v2', 'sweep_all',
  'collect', 'fees', 'close', 'withdraw_to', 'halt', 'resume', 'migrate',
];
const expected = new Map(absent.map((n) => [n, anchorDiscriminator(n).toString('hex')]));
for (const [label, img] of [['anchor-lang real', real], ['committed fixture', fixture]] as const) {
  const rec = recoverSelectors(img, expected);
  console.log(`${label}: ${absent.length} absent names -> recovered ${rec.length} ${JSON.stringify(rec.map((r) => `${r.name}/${r.via}`))}`);
}

// Present names, but asked for alongside a large field of absent ones: the real six must still be
// found, and nothing else must join them.
const six = ['initialize', 'withdraw', 'deposit', 'close_account', 'set_authority', 'collect_fees'];
const mixed = new Map([...absent, ...six].map((n) => [n, anchorDiscriminator(n).toString('hex')]));
const rec = recoverSelectors(real, mixed);
console.log(`mixed 36-name field -> recovered ${rec.length}: ${rec.map((r) => `${r.name}:${r.via}`).join(', ')}`);
