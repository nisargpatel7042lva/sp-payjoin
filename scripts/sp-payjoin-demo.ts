/**
 * Phase 2 gate: PayJoin addressed by a BIP352 silent payment address, end to end on regtest,
 * with the receiver wallet's state checked before and after.
 */
import { Psbt } from 'bitcoinjs-lib';
import { BitcoinRpc } from '../src/chain/rpc.js';
import { SimpleKey, fundAddress, withPrevouts, buildSignedTx, type KeyedUtxo } from '../src/wallet/simple.js';
import { SpWallet } from '../src/sp/wallet.js';
import { silentPaymentOutputs } from '../src/sp/send.js';
import { PayjoinReceiver } from '../src/payjoin/receiver.js';
import { startReceiverServer } from '../src/payjoin/http.js';
import { payWithPayjoin } from '../src/payjoin/client.js';
import { buildPjUri } from '../src/payjoin/uri.js';
import { unsignedTx } from '../src/payjoin/psbt-utils.js';
import { analyze, score } from '../src/analysis/cioh.js';

const rpc = new BitcoinRpc();
const step = (s: string) => console.log(`\n${'─'.repeat(78)}\n${s}`);
const kv = (k: string, v: unknown) => console.log(`   ${k.padEnd(22)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const sat = (btc: number) => Math.round(btc * 1e8);
const p2trUtxo = async (key: SimpleKey, btc: number): Promise<KeyedUtxo> => ({ ...(await fundAddress(rpc, key.p2tr.address!, btc)), priv: key.p2trPriv, type: 'p2tr' });
const owners: Record<string, string> = {};

step('1. receiver: one static silent payment address, nothing else published');
const receiver = new SpWallet();
kv('address', receiver.address);
kv('wallet utxos', receiver.utxos.size);

step('2. someone pays it normally (a plain BIP352 payment) → receiver scans and finds the output');
{
  const alice = new SimpleKey();
  const a = await p2trUtxo(alice, 0.02);
  const [o] = silentPaymentOutputs({ keys: [{ priv: a.priv, isTaproot: true }], outpoints: [a], payments: [{ address: receiver.address, amountSat: 700_000 }] });
  const tx = buildSignedTx([a], [{ scriptPubKey: o!.scriptPubKey, valueSat: 700_000 }, { scriptPubKey: new Uint8Array(new SimpleKey().p2tr.output!), valueSat: a.valueSat - 700_400 }]);
  const txid = await rpc.sendRawTransaction(tx.toHex()); await rpc.mine(1);
  const found = receiver.scanDecodedTx(await withPrevouts(rpc, await rpc.getRawTransaction(txid)));
  kv('found by scanning', found.map((u) => `${u.txid.slice(0, 16)}…:${u.vout} ${u.valueSat} sat (P2TR ${hex(u.scriptPubKey).slice(4, 20)}…)`));
  kv('wallet balance', `${receiver.balanceSat()} sat`);
  owners[`${found[0]!.txid}:${found[0]!.vout}`] = 'receiver';
}

step('3. Bob pays the same address with PayJoin (default send path)');
const bob = new SimpleKey(), bobChange = new SimpleKey();
const bobUtxo = await p2trUtxo(bob, 0.01);
owners[`${bobUtxo.txid}:${bobUtxo.vout}`] = 'sender';
const rx = new PayjoinReceiver(receiver.receiverHooks({ isBroadcastable: async (h) => (await rpc.testMempoolAccept(h))[0]!.allowed }));
let originalScript = '', substitutedScript = '';
const server = await startReceiverServer(rx, { onProposal: (p) => {
  kv('receiver', `identified its output by scanning the original; contributed ${p.contributed.txid.slice(0, 16)}…:${p.contributed.vout} (${p.contributed.valueSat} sat) at input index ${p.ourInputIndex}`);
  const out = unsignedTx(Psbt.fromBase64(p.proposalBase64)).outs[p.ourOutputIndex]!;
  substitutedScript = hex(out.script);
  kv('receiver', `recomputed BIP352 output for the joined input set → P2TR ${substitutedScript.slice(4, 20)}…; fee ${p.originalFeeSat}→${p.proposalFeeSat} sat (sender contributed ${p.feeContributionSat}, receiver ${p.receiverFeeSat})`);
} });
const PAY = 600_000, FEE = 600;
const uri = buildPjUri({ sp: receiver.address, amountSat: PAY, pj: server.url });
kv('BIP21 URI', uri);
const r = await payWithPayjoin({
  uri, inputs: [bobUtxo], paymentOutputIndex: 0,
  outputs: [{ sp: true, valueSat: PAY }, { scriptPubKey: new Uint8Array(bobChange.p2tr.output!), valueSat: bobUtxo.valueSat - PAY - FEE }],
  params: { additionalFeeOutputIndex: 1, maxAdditionalFeeContribution: 1000 },
  broadcast: (h) => rpc.sendRawTransaction(h),
  log: (s) => kv('sender', s),
});
await server.close();
originalScript = hex(unsignedTx(Psbt.fromBase64(r.originalBase64)).outs[0]!.script);
await rpc.mine(1);
const finalTx = await withPrevouts(rpc, await rpc.getRawTransaction(r.txid));
kv('confirmed txid', r.txid);
kv('payjoin?', r.payjoin);
kv('sender-derived output', `P2TR ${originalScript.slice(4, 20)}… present in final tx: ${finalTx.vout.some((o) => o.scriptPubKey.hex === originalScript)}`);
kv('substituted output', `P2TR ${substitutedScript.slice(4, 20)}… present in final tx: ${finalTx.vout.some((o) => o.scriptPubKey.hex === substitutedScript)}`);

step('4. analyst view of the confirmed transaction');
console.log('   inputs:');
for (const v of finalTx.vin) console.log(`      ${v.txid.slice(0, 16)}…:${v.vout}  ${sat(v.prevout!.value).toString().padStart(9)} sat   truth: ${owners[`${v.txid}:${v.vout}`]}`);
console.log('   outputs:');
for (const o of finalTx.vout) console.log(`      #${o.n} ${sat(o.value).toString().padStart(9)} sat   P2TR ${o.scriptPubKey.hex.slice(4, 20)}…  (${o.scriptPubKey.hex === substitutedScript ? 'receiver, silent payment' : 'sender change'})`);
const recvIdx = finalTx.vout.findIndex((o) => o.scriptPubKey.hex === substitutedScript);
const card = score(analyze({ txid: finalTx.txid, inputs: finalTx.vin.map((v) => ({ outpoint: `${v.txid}:${v.vout}`, scriptPubKeyHex: v.prevout!.scriptPubKey.hex })), outputs: finalTx.vout.map((o) => ({ index: o.n, scriptPubKeyHex: o.scriptPubKey.hex, valueSat: sat(o.value) })) }), { ownerOfOutpoint: owners, paymentSat: PAY, paymentOutputIndex: recvIdx });
console.log(`   H1 common-input-ownership: "${card.h1.claim}" → ${card.h1.correct ? 'CORRECT' : 'WRONG'} (${card.h1.detail})`);
if (card.h2) console.log(`   H2 payment amount:         "${card.h2.claim}" → ${card.h2.correct ? 'CORRECT' : 'WRONG'} (${card.h2.detail})`);
console.log('   address reuse:             none — the receiver never put an on-chain address anywhere; both outputs are one-time P2TR keys');

step('5. receiver wallet after a standard BIP352 scan of the confirmed tx');
const before = receiver.balanceSat();
const added = receiver.scanDecodedTx(finalTx);
kv('spent (contributed)', [...receiver.spent.keys()].map((k) => k.slice(0, 16) + '…'));
kv('found', added.map((u) => `${u.txid.slice(0, 16)}…:${u.vout} ${u.valueSat} sat`));
kv('balance', `${before} → ${receiver.balanceSat()} sat  (= ${before} + ${PAY} payment − receiver fee share)`);
kv('utxo count', receiver.utxos.size);

step('6. receiver spends what it found (proves the recomputed output is really its own)');
{
  const u = [...receiver.utxos.values()][0]!;
  const tx = buildSignedTx([u], [{ scriptPubKey: new Uint8Array(new SimpleKey().p2wpkh.output!), valueSat: u.valueSat - 300 }]);
  const txid = await rpc.sendRawTransaction(tx.toHex()); await rpc.mine(1);
  receiver.scanDecodedTx(await withPrevouts(rpc, await rpc.getRawTransaction(txid)));
  kv('spend txid', `${txid} (confirmed)`);
  kv('balance', `${receiver.balanceSat()} sat, utxos ${receiver.utxos.size}`);
}
console.log(`\nRESULT: ${r.payjoin && !card.h1.correct && added.length === 1 ? 'silent-payment PayJoin confirmed; receiver wallet consistent; heuristic wrong' : 'FAILED'}`);
