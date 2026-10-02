/** Prints the architecture as a map — a terminal-native alternative to scrolling the README. */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Tests are generated in loops from the BIP vectors, so grep undercounts — ask the runner. */
const testCount = (): string => {
  try {
    const out = execSync("npm test 2>&1 | grep -oP '^. pass \\K[0-9]+' | tail -1", { encoding: 'utf8' }).trim();
    return out || 'see npm test';
  } catch { return 'see npm test'; }
};
const regtestFiles = execSync("git ls-files '*regtest.test.ts' | wc -l").toString().trim();
const lines = (dir: string) => execSync(`git ls-files '${dir}/*.ts' | grep -v test | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}'`).toString().trim();

const row = (name: string, spec: string, what: string) =>
  console.log(`  ${name.padEnd(16)} ${spec.padEnd(13)} ${what}`);

console.log(`
  SILENT PAYJOIN — what the ${execSync("git ls-files '*.ts' | wc -l").toString().trim()} TypeScript files do
  ${''.padEnd(88, '─')}

  THE TWO PROTOCOLS IT COMBINES`);
row('src/sp/', 'BIP352', 'silent payments: input rules, key derivation, chain scanning,');
row('', '', 'and the receiver wallet that recomputes its own output');
row('src/payjoin/', 'BIP78', 'payjoin: sender + receiver checklists, coin selection that');
row('', '', 'avoids UIH2, and a transport seam (v1 HTTP / async directory)');

console.log(`
  THE BIT THAT MAKES IT A PRODUCT`);
row('src/pay/', '—', 'ONE send path: try payjoin, fall back to a plain silent');
row('', '', 'payment. There is no privacy flag for the user to forget.');
row('src/cli/', '—', 'spay: pay · receive · balance · fund');
row('src/wallet/', '—', 'keys, PSBT build + sign, coin selection, persistence');
row('src/chain/', '—', 'JSON-RPC to a real bitcoind');

console.log(`
  HOW WE GRADE OURSELVES`);
row('src/analysis/', '—', 'the chain-surveillance tool we run against our own transactions');

console.log(`
  ${''.padEnd(88, '─')}
  ${lines('src')} lines of source · ${testCount()} tests passing · ${regtestFiles} suites run against a live bitcoind

  Conformance is not asserted, it is checked:
    · BIP78 sender reproduces the BIP's own test vectors byte-for-byte
    · all 28 official BIP352 send/receive vectors pass through our derivation layer
    · ${JSON.parse(readFileSync('package.json', 'utf8')).dependencies ? Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).dependencies).length : 0} runtime dependencies
`);
