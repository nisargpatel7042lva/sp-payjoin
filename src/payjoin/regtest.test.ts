/** Integration on regtest: real PayJoin over HTTP confirms with inputs from both parties; heuristic is wrong on it. Skipped if the node is down. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BitcoinRpc } from '../chain/rpc.js';
import { SimpleKey, fundAddress, withPrevouts, type KeyedUtxo } from '../wallet/simple.js';
import { signPsbtInput } from '../wallet/psbt-wallet.js';
import { PayjoinReceiver } from './receiver.js';
import { startReceiverServer } from './http.js';
import { payWithPayjoin } from './client.js';
import { buildPjUri } from './uri.js';
import { analyze, score } from '../analysis/cioh.js';

const rpc = new BitcoinRpc();
const nodeUp = await rpc.getBlockCount().then(() => true, () => false);
const skip = nodeUp ? false : 'regtest node not running (infra/regtest.sh start)';

async function setup() {
  const sender = new SimpleKey(), senderChange = new SimpleKey(), receiver = new SimpleKey();
  const senderUtxo: KeyedUtxo = { ...(await fundAddress(rpc, sender.p2wpkh.address!, 0.01)), priv: sender.priv, type: 'p2wpkh' };
  const receiverUtxo: KeyedUtxo = { ...(await fundAddress(rpc, receiver.p2wpkh.address!, 0.005)), priv: receiver.priv, type: 'p2wpkh' };
  const seen = new Set<string>();
  const rx = new PayjoinReceiver({
    isBroadcastable: async (hex) => (await rpc.testMempoolAccept(hex))[0]!.allowed,
    isOwnedScript: (spk) => Buffer.compare(Buffer.from(spk), receiver.p2wpkh.output!) === 0,
    inputSeenBefore: (op) => seen.has(op), markInputSeen: (op) => { seen.add(op); },
    selectInput: () => receiverUtxo,
    signInput: (psbt, idx, u) => { signPsbtInput(psbt, idx, u); psbt.finalizeInput(idx); },
  });
  return { sender, senderChange, receiver, senderUtxo, receiverUtxo, rx };
}

test('regtest: payjoin confirms with one input from each party; sender got the receiver\'s proposal', { skip }, async () => {
  const s = await setup();
  const server = await startReceiverServer(s.rx);
  try {
    const PAY = 600_000, FEE = 500;
    const uri = buildPjUri({ address: s.receiver.p2wpkh.address!, amountSat: PAY, pj: server.url });
    const r = await payWithPayjoin({
      uri, inputs: [s.senderUtxo], paymentOutputIndex: 0,
      outputs: [{ scriptPubKey: new Uint8Array(s.receiver.p2wpkh.output!), valueSat: PAY }, { scriptPubKey: new Uint8Array(s.senderChange.p2wpkh.output!), valueSat: s.senderUtxo.valueSat - PAY - FEE }],
      params: { additionalFeeOutputIndex: 1, maxAdditionalFeeContribution: 1000 },
      broadcast: (hex) => rpc.sendRawTransaction(hex),
    });
    assert.equal(r.payjoin, true);
    await rpc.mine(1);
    const tx = await withPrevouts(rpc, await rpc.getRawTransaction(r.txid));
    assert.equal(tx.confirmations, 1);
    const ins = tx.vin.map((v) => `${v.txid}:${v.vout}`);
    assert.ok(ins.includes(`${s.senderUtxo.txid}:${s.senderUtxo.vout}`), 'sender input present');
    assert.ok(ins.includes(`${s.receiverUtxo.txid}:${s.receiverUtxo.vout}`), 'receiver input present');
    const recvOut = tx.vout.find((o) => o.scriptPubKey.hex === s.receiver.p2wpkh.output!.toString('hex'))!;
    assert.ok(Math.round(recvOut.value * 1e8) >= PAY + s.receiverUtxo.valueSat - 200, 'receiver output = payment + contributed − small fee share');
    assert.notEqual(r.txid, r.originalTxid);

    // the analyst is wrong about this transaction
    const verdict = analyze({ txid: tx.txid, inputs: tx.vin.map((v) => ({ outpoint: `${v.txid}:${v.vout}`, scriptPubKeyHex: v.prevout!.scriptPubKey.hex })), outputs: tx.vout.map((o) => ({ index: o.n, scriptPubKeyHex: o.scriptPubKey.hex, valueSat: Math.round(o.value * 1e8) })) });
    const card = score(verdict, { ownerOfOutpoint: { [`${s.senderUtxo.txid}:${s.senderUtxo.vout}`]: 'sender', [`${s.receiverUtxo.txid}:${s.receiverUtxo.vout}`]: 'receiver' }, paymentSat: PAY, paymentOutputIndex: recvOut.n });
    assert.equal(card.h1.correct, false, card.h1.detail);
  } finally { await server.close(); }
});

test('regtest: endpoint unreachable → original transaction is broadcast (fallback), heuristic is right about it', { skip }, async () => {
  const s = await setup();
  const PAY = 600_000, FEE = 500;
  const uri = buildPjUri({ address: s.receiver.p2wpkh.address!, amountSat: PAY, pj: 'http://127.0.0.1:1/payjoin' });
  const r = await payWithPayjoin({
    uri, inputs: [s.senderUtxo], paymentOutputIndex: 0,
    outputs: [{ scriptPubKey: new Uint8Array(s.receiver.p2wpkh.output!), valueSat: PAY }, { scriptPubKey: new Uint8Array(s.senderChange.p2wpkh.output!), valueSat: s.senderUtxo.valueSat - PAY - FEE }],
    broadcast: (hex) => rpc.sendRawTransaction(hex),
  });
  assert.equal(r.payjoin, false);
  assert.equal(r.txid, r.originalTxid);
  await rpc.mine(1);
  const tx = await withPrevouts(rpc, await rpc.getRawTransaction(r.txid));
  assert.equal(tx.vin.length, 1);
  const card = score(analyze({ txid: tx.txid, inputs: tx.vin.map((v) => ({ outpoint: `${v.txid}:${v.vout}`, scriptPubKeyHex: '' })), outputs: tx.vout.map((o) => ({ index: o.n, scriptPubKeyHex: o.scriptPubKey.hex, valueSat: Math.round(o.value * 1e8) })) }), { ownerOfOutpoint: { [`${s.senderUtxo.txid}:${s.senderUtxo.vout}`]: 'sender' }, paymentSat: PAY, paymentOutputIndex: 0 });
  assert.equal(card.h1.correct, true);
});
