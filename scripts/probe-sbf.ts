import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { findText, decode, recoverSelectors } from '../src/state/sbfSelectors.js';
import { anchorDiscriminator } from '../src/state/bytecodeDiff.js';

const cases: Array<[string, string, string[]]> = [
  ['/home/zeroxcyril/sbf-anchorlike/target/sbpfv2-solana-solana/release/sbf_anchorlike.so', 'anchorlike', ['initialize', 'withdraw', 'deposit', 'close_account', 'set_authority', 'collect_fees', 'sweep', 'mint_to', 'transfer_proxy', 'refresh_state']],
  ['/home/zeroxcyril/anchor-smoke/target/sbpfv2-solana-solana/release/anchor_smoke.so', 'anchor-lang 0.30.1', ['initialize', 'withdraw', 'deposit', 'close_account', 'set_authority', 'collect_fees']],
  ['/home/zeroxcyril/dot/test/fixtures/sbf-dispatch.so', 'committed fixture', ['initialize', 'withdraw', 'deposit', 'close_account', 'set_authority', 'collect_fees', 'sweep', 'mint_to', 'transfer_proxy', 'refresh_state']],
];

for (const [path, label, names] of cases) {
  const buf = Buffer.from(readFileSync(path));
  const text = findText(buf);
  const expected = new Map(names.map((n) => [n, anchorDiscriminator(n).toString('hex')]));
  const rec = recoverSelectors(buf, expected);
  const by = (v: string) => rec.filter((r) => r.via === v).map((r) => r.name);
  console.log(`${label}: .text=${text ? `${text.length}B @0x${text.vma.toString(16)}` : 'n/a'} insns=${text ? decode(buf.subarray(text.fileOffset, text.fileOffset + text.length)).length : 0}`);
  console.log(`   recovered ${rec.length}/${names.length}`);
  console.log(`   contiguous=[${by('contiguous').join(',')}] immediate-pair=[${by('immediate-pair').join(',')}] compare-chain=[${by('compare-chain').join(',')}]`);
  console.log(`   missed=[${names.filter((n) => !rec.some((r) => r.name === n)).join(',')}]`);
}
