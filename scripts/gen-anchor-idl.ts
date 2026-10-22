import { writeFileSync } from 'node:fs';
import { anchorDiscriminator } from '../src/state/bytecodeDiff.js';

// Emits test/fixtures/anchor-lang-0.30.1.idl.json for the committed image.
const names = ['initialize', 'withdraw', 'deposit', 'close_account', 'set_authority', 'collect_fees'];
const idl = {
  address: 'Anch1111111111111111111111111111111111111',
  metadata: { name: 'anchor_smoke', version: '0.1.0' },
  note: 'Built locally with anchor-lang 0.30.1 (src/lib.rs #[program], six instructions, dispatch over &data[..8]). Instruction names are the Rust method names; the discriminator arrays are the bytes anchor-lang-idl 0.1.4 convert.rs derives from them: sha256("global:" + name.to_snake_case())[0..8]. The same six values were printed by the framework itself through <crate::instruction::X as Discriminator>::DISCRIMINATOR under cargo test --lib, and they match.',
  instructions: names.map((n) => ({ name: n, accounts: [], args: [], discriminator: [...anchorDiscriminator(n)] })),
};
writeFileSync('test/fixtures/anchor-lang-0.30.1.idl.json', JSON.stringify(idl, null, 2) + '\n');
console.log(`wrote ${names.length} instructions`);
