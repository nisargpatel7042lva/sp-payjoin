/**
 * Phase 4 — the demo moment.
 *
 * Alice pays Bob 600,000 sat three times, on a real regtest chain:
 *   (1) the way wallets do it today: a reused address, Alice's inputs only
 *   (2) with silent payments: a fresh key, still Alice's inputs only
 *   (3) with silent payments + payjoin: a fresh key, and Bob contributes an input
 *
 * Then a chain-surveillance tool is pointed at all three, and its conclusions are
 * checked against what actually happened. Writes out/report.html as well.
 */
import { writeFileSync } from 'node:fs';
import { BitcoinRpc, type DecodedTx } from '../src/chain/rpc.js';
import { SimpleKey, fundAddress, withPrevouts, buildSignedTx, type KeyedUtxo } from '../src/wallet/simple.js';
import { SpWallet } from '../src/sp/wallet.js';
import { silentPaymentOutputs } from '../src/sp/send.js';
import { PayjoinReceiver } from '../src/payjoin/receiver.js';
import { startReceiverServer } from '../src/payjoin/http.js';
import { payWithPayjoin } from '../src/payjoin/client.js';
import { buildPjUri } from '../src/payjoin/uri.js';
import { analyze, buildChainIndex } from '../src/analysis/cioh.js';
import { renderReport, renderReportFragment } from '../src/analysis/report.js';

const rpc = new BitcoinRpc();
const PAY = 600_000, FEE = 600;
const sat = (n: number) => n.toLocaleString('en-US');
const btc = (v: number) => Math.round(v * 1e8);

export interface Scenario {
  key: string; title: string; subtitle: string;
  txid: string; tx: DecodedTx;
  /** ground truth */
  owners: Record<string, string>; paymentSat: number; paymentOutputIndex: number; receiverLabel: string;
  reusedAddress?: string;
}

const owners: Record<string, string> = {};
const fundP2tr = async (k: SimpleKey, amount: number, who: string): Promise<KeyedUtxo> => {
  const u = { ...(await fundAddress(rpc, k.p2tr.address!, amount)), priv: k.p2trPriv, type: 'p2tr' as const };
  owners[`${u.txid}:${u.vout}`] = who; return u;
};

const startHeight = await rpc.getBlockCount();
const scenarios: Scenario[] = [];

// ── (1) how wallets do it today: Bob publishes one address and reuses it ─────
{
  const alice = new SimpleKey(), aliceChange = new SimpleKey(), bob = new SimpleKey();
  const bobAddress = bob.p2wpkh.address!;
  await fundAddress(rpc, bobAddress, 0.003);            // prior history: the address is already on chain
  const a = await fundP2tr(alice, 0.01, 'Alice');
  const tx = buildSignedTx([a], [
    { scriptPubKey: new Uint8Array(bob.p2wpkh.output!), valueSat: PAY },
    { scriptPubKey: new Uint8Array(aliceChange.p2tr.output!), valueSat: a.valueSat - PAY - FEE },
  ]);
  const txid = await rpc.sendRawTransaction(tx.toHex()); await rpc.mine(1);
  scenarios.push({ key: 'today', title: 'TODAY', subtitle: 'reused address', txid, tx: await withPrevouts(rpc, await rpc.getRawTransaction(txid)), owners: { ...owners }, paymentSat: PAY, paymentOutputIndex: 0, receiverLabel: 'Bob', reusedAddress: bobAddress });
}

// ── (2) silent payments alone ────────────────────────────────────────────────
{
  const alice = new SimpleKey(), aliceChange = new SimpleKey();
  const bob = new SpWallet();
  const a = await fundP2tr(alice, 0.01, 'Alice');
  const [out] = silentPaymentOutputs({ keys: [{ priv: a.priv, isTaproot: true }], outpoints: [a], payments: [{ address: bob.address, amountSat: PAY }] });
  const tx = buildSignedTx([a], [
    { scriptPubKey: out!.scriptPubKey, valueSat: PAY },
    { scriptPubKey: new Uint8Array(aliceChange.p2tr.output!), valueSat: a.valueSat - PAY - FEE },
  ]);
  const txid = await rpc.sendRawTransaction(tx.toHex()); await rpc.mine(1);
  scenarios.push({ key: 'sp', title: '+ SILENT PAYMENTS', subtitle: 'fresh key, no address', txid, tx: await withPrevouts(rpc, await rpc.getRawTransaction(txid)), owners: { ...owners }, paymentSat: PAY, paymentOutputIndex: 0, receiverLabel: 'Bob' });
}

// ── (3) silent payments + payjoin: what this project does by default ─────────
{
  const alice = new SimpleKey(), aliceChange = new SimpleKey();
  const bob = new SpWallet();
  // Bob already holds a coin (received earlier as a silent payment) — that is what he contributes.
  const funder = new SimpleKey();
  const f = await fundP2tr(funder, 0.008, 'Bob');
  const [bobOut] = silentPaymentOutputs({ keys: [{ priv: f.priv, isTaproot: true }], outpoints: [f], payments: [{ address: bob.address, amountSat: 700_000 }] });
  const fundTx = buildSignedTx([f], [{ scriptPubKey: bobOut!.scriptPubKey, valueSat: 700_000 }, { scriptPubKey: new Uint8Array(new SimpleKey().p2tr.output!), valueSat: f.valueSat - 700_000 - FEE }]);
  const fundTxid = await rpc.sendRawTransaction(fundTx.toHex()); await rpc.mine(1);
  const found = bob.scanDecodedTx(await withPrevouts(rpc, await rpc.getRawTransaction(fundTxid)));
  owners[`${found[0]!.txid}:${found[0]!.vout}`] = 'Bob';

  const a = await fundP2tr(alice, 0.01, 'Alice');
  const server = await startReceiverServer(new PayjoinReceiver(bob.receiverHooks({ isBroadcastable: async (h) => (await rpc.testMempoolAccept(h))[0]!.allowed })));
  let substituted = '';
  try {
    const r = await payWithPayjoin({
      uri: buildPjUri({ sp: bob.address, amountSat: PAY, pj: server.url }),
      inputs: [a], paymentOutputIndex: 0,
      outputs: [{ sp: true, valueSat: PAY }, { scriptPubKey: new Uint8Array(aliceChange.p2tr.output!), valueSat: a.valueSat - PAY - FEE }],
      params: { additionalFeeOutputIndex: 1, maxAdditionalFeeContribution: 1000 },
      broadcast: (h) => rpc.sendRawTransaction(h),
    });
    if (!r.payjoin) throw new Error('payjoin did not happen; is the receiver funded?');
    await rpc.mine(1);
    const tx = await withPrevouts(rpc, await rpc.getRawTransaction(r.txid));
    const mine = bob.scanDecodedTx(tx);
    substituted = tx.vout.find((o) => o.n === mine[0]!.vout)!.scriptPubKey.hex;
    scenarios.push({ key: 'sppj', title: '+ PAYJOIN', subtitle: 'fresh key + joined inputs', txid: r.txid, tx, owners: { ...owners }, paymentSat: PAY, paymentOutputIndex: mine[0]!.vout, receiverLabel: 'Bob' });
  } finally { await server.close(); }
  void substituted;
}

// ── point the surveillance tool at all three ─────────────────────────────────
const index = await buildChainIndex(rpc, startHeight);

export interface Finding { question: string; analystSays: string; truth: string; fooled: boolean }
function investigate(s: Scenario): Finding[] {
  const inputs = s.tx.vin.map((v) => ({ outpoint: `${v.txid}:${v.vout}`, scriptPubKeyHex: v.prevout!.scriptPubKey.hex }));
  const outputs = s.tx.vout.map((o) => ({ index: o.n, scriptPubKeyHex: o.scriptPubKey.hex, valueSat: btc(o.value) }));
  const verdict = analyze({ txid: s.txid, inputs, outputs });

  // Q1 — can the receiver be identified from the chain alone?
  const reused = outputs.map((o) => ({ o, prior: index.occurrencesBefore(o.scriptPubKeyHex, s.txid) })).filter((x) => x.prior > 0);
  const q1: Finding = reused.length > 0
    ? { question: 'Who received this money?', analystSays: `${(s.reusedAddress ?? 'an address').slice(0, 14)}… — an address already seen in ${reused[0]!.prior} earlier tx, so every payment to it links up`, truth: `→ ${s.receiverLabel} is exposed, along with his payment history`, fooled: false }
    : { question: 'Who received this money?', analystSays: 'nothing to go on — every output is a one-time key, never seen before or since', truth: `→ ${s.receiverLabel} stays private; there is no address to search for`, fooled: true };

  // Q2 — common-input-ownership
  const realOwners = [...new Set(inputs.map((i) => s.owners[i.outpoint] ?? '?'))];
  const q2: Finding = {
    question: 'Who owns the inputs?',
    analystSays: inputs.length === 1 ? 'one wallet — a single input, so one owner' : `one wallet — all ${inputs.length} inputs are spent together, so one owner`,
    truth: realOwners.length === 1 ? `→ ${realOwners[0]}’s coins get clustered together` : `→ they are ${realOwners.join(' and ')}: a stranger’s coin is now filed under the payer’s wallet`,
    fooled: realOwners.length > 1,
  };

  // Q3 — payment amount
  const guess = verdict.inferredPayment!;
  const q3: Finding = {
    question: 'How much was paid?',
    analystSays: `${sat(guess.valueSat)} sat`,
    truth: guess.valueSat === s.paymentSat ? `→ the real amount, ${sat(s.paymentSat)} sat, is public` : `→ the real payment was ${sat(s.paymentSat)} sat; the figure is inflated by the receiver’s own coin`,
    fooled: guess.valueSat !== s.paymentSat,
  };
  return [q1, q2, q3];
}

const results = scenarios.map((s) => ({ scenario: s, findings: investigate(s) }));

// ── terminal output ──────────────────────────────────────────────────────────
const LABEL = 19, W = 27, TOTAL = LABEL + W * 3;

function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (let word of text.split(' ')) {
    while (word.length > w) { if (cur) { out.push(cur); cur = ''; } out.push(word.slice(0, w)); word = word.slice(w); }
    if (cur && (cur + ' ' + word).length > w) { out.push(cur); cur = word; } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  return out;
}
/** One logical row: a label plus three cells, each wrapped over as many lines as it needs. */
function row(label: string, cells: string[]): void {
  const wrapped = cells.map((c) => wrap(c, W - 2));
  const height = Math.max(1, ...wrapped.map((w) => w.length));
  for (let i = 0; i < height; i++) {
    console.log((i === 0 ? label : '').padEnd(LABEL) + wrapped.map((w) => (w[i] ?? '').padEnd(W)).join('').trimEnd());
  }
}
const rule = (ch = '─') => console.log(ch.repeat(TOTAL));

console.log('\n' + '═'.repeat(TOTAL));
console.log('  ALICE PAYS BOB 600,000 SAT — THREE WAYS, ON A REAL REGTEST CHAIN');
console.log('  A surveillance tool examines each transaction. Its answers are checked against the truth.');
console.log('═'.repeat(TOTAL) + '\n');

row('', results.map((r) => r.scenario.title));
row('', results.map((r) => r.scenario.subtitle));
rule();
row('the transaction', results.map((r) => `${r.scenario.tx.vin.length} input${r.scenario.tx.vin.length > 1 ? 's' : ''} → ${r.scenario.tx.vout.length} outputs`));
row('truly owned by', results.map((r) => [...new Set(r.scenario.tx.vin.map((v) => r.scenario.owners[`${v.txid}:${v.vout}`] ?? '?'))].join(' + ')));
rule();

for (let q = 0; q < 3; q++) {
  console.log('');
  console.log(`  Q${q + 1}. ${results[0]!.findings[q]!.question}`);
  row('  analyst says', results.map((r) => `\u201c${r.findings[q]!.analystSays}\u201d`));
  row('  in fact', results.map((r) => (r.findings[q]!.fooled ? '✗ WRONG' : '✓ CORRECT')));
  row('', results.map((r) => r.findings[q]!.truth));
}

console.log('');
rule('═');
row('VERDICT', results.map((r) => {
  const n = r.findings.filter((f) => f.fooled).length;
  return n === 0 ? 'everything leaks: who was paid, how much, and which coins are Alice’s' : n === 1 ? 'Bob is hidden, but Alice is still clustered and the amount is public' : 'who, how much, and whose coins — all three answers are wrong';
}));
rule('═');
console.log(`\nsurveillance scored: ${results.map((r) => `${r.scenario.title.replace('+ ', '')} ${r.findings.filter((f) => !f.fooled).length}/3 correct`).join('   ·   ')}\n`);

const columns = results.map((r) => ({
  title: r.scenario.title, subtitle: r.scenario.subtitle, txid: r.scenario.txid,
  inputs: r.scenario.tx.vin.map((v) => ({ label: r.scenario.owners[`${v.txid}:${v.vout}`] ?? '?', valueSat: btc(v.prevout!.value) })),
  outputs: r.scenario.tx.vout.map((o) => ({ label: o.n === r.scenario.paymentOutputIndex ? 'to Bob' : "Alice's change", valueSat: btc(o.value) })),
  findings: r.findings,
}));
writeFileSync(new URL('../out/report.html', import.meta.url), renderReport(columns));
writeFileSync(new URL('../out/report.fragment.html', import.meta.url), renderReportFragment(columns));
console.log('wrote out/report.html — the same comparison as a page\n');
