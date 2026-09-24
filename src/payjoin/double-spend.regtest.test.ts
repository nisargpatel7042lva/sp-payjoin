/**
 * Double-spend between the original and the payjoin proposal, on a real node.
 * BIP78 notes the sender holds two conflicting signed transactions; only one can win.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BitcoinRpc } from '../chain/rpc.js';
import { SimpleKey, fundAddress, buildSignedTx, type KeyedUtxo } from '../wallet/simple.js';
import { buildPsbt, extractTx, finalizePsbt, signPsbtInput } from '../wallet/psbt-wallet.js';
import { PayjoinReceiver } from './receiver.js';
import { startReceiverServer, postOriginalPsbt } from './http.js';
import { createSenderContext, verifyAndFillProposal, buildRequestUrl } from './sender.js';
import { finalizedTx } from './psbt-utils.js';

const rpc = new BitcoinRpc();
const skip = (await rpc.getBlockCount().then(() => true, () => false)) ? false : 'regtest node not running';

test('sender abandons the payjoin and broadcasts the original: payment confirms, the proposal is rejected as a conflict, and the receiver keeps its coin', { skip }, async () => {
  const sender = new SimpleKey(), change = new SimpleKey(), receiver = new SimpleKey();
  const senderUtxo: KeyedUtxo = { ...(await fundAddress(rpc, sender.p2wpkh.address!, 0.01)), priv: sender.priv, type: 'p2wpkh' };
  const receiverUtxo: KeyedUtxo = { ...(await fundAddress(rpc, receiver.p2wpkh.address!, 0.005)), priv: receiver.priv, type: 'p2wpkh' };

  const PAY = 600_000, FEE = 500;
  const outputs = [
    { scriptPubKey: new Uint8Array(receiver.p2wpkh.output!), valueSat: PAY },
    { scriptPubKey: new Uint8Array(change.p2wpkh.output!), valueSat: senderUtxo.valueSat - PAY - FEE },
  ];
  const signed = buildPsbt([senderUtxo], outputs);
  signPsbtInput(signed, 0, senderUtxo);
  const ctx = createSenderContext(signed, { pjos: true }, outputs[0]!.scriptPubKey, { additionalFeeOutputIndex: 1, maxAdditionalFeeContribution: 1000 });

  const seen = new Set<string>();
  const rx = new PayjoinReceiver({
    isBroadcastable: async (hex) => (await rpc.testMempoolAccept(hex))[0]!.allowed,
    isOwnedScript: (spk) => Buffer.compare(Buffer.from(spk), receiver.p2wpkh.output!) === 0,
    inputSeenBefore: (op) => seen.has(op), markInputSeen: (op) => { seen.add(op); },
    selectInput: () => receiverUtxo,
    signInput: (psbt, idx, u) => { signPsbtInput(psbt, idx, u); psbt.finalizeInput(idx); },
  });
  const server = await startReceiverServer(rx);
  try {
    // the receiver hands over a proposal and has now exposed a UTXO
    const proposalB64 = await postOriginalPsbt(buildRequestUrl(server.url, ctx.params), ctx.originalPsbt.toBase64());
    assert.equal(rx.exposedInputs.size, 1);
    const proposal = verifyAndFillProposal(ctx, proposalB64);
    signPsbtInput(proposal, proposal.txInputs.findIndex((i) => Buffer.from(i.hash).reverse().toString('hex') === senderUtxo.txid), senderUtxo);
    const payjoinTx = extractTx(finalizePsbt(proposal));

    // …but the sender broadcasts the original instead (or an attacker probing never intended to join)
    const originalTx = finalizedTx(ctx.originalPsbt);
    const originalTxid = await rpc.sendRawTransaction(originalTx.toHex());
    await rpc.mine(1);
    assert.ok(((await rpc.getRawTransaction(originalTxid)).confirmations ?? 0) >= 1, 'the payment confirmed');

    // the payjoin now conflicts: it spends an input the confirmed original already spent
    const accept = await rpc.testMempoolAccept(payjoinTx.toHex());
    assert.equal(accept[0]!.allowed, false, 'conflicting transaction must not be accepted');
    await assert.rejects(rpc.sendRawTransaction(payjoinTx.toHex()), /conflict|missing|already|txn-mempool|bad-txns/i);

    // the receiver exposed a coin but never spent it: still unspent and still spendable
    const utxoStillThere = await rpc.getTxOut(receiverUtxo.txid, receiverUtxo.vout);
    assert.ok(utxoStillThere, 'receiver UTXO was never consumed');
    const sweep = buildSignedTx([receiverUtxo], [{ scriptPubKey: new Uint8Array(new SimpleKey().p2wpkh.output!), valueSat: receiverUtxo.valueSat - 300 }]);
    assert.equal((await rpc.testMempoolAccept(sweep.toHex()))[0]!.allowed, true, 'receiver can still spend it');
  } finally { await server.close(); }
});

test('the receiver re-offers that same exposed coin to the next request rather than a fresh one', { skip }, async () => {
  const receiver = new SimpleKey();
  const coins: KeyedUtxo[] = [
    { ...(await fundAddress(rpc, receiver.p2wpkh.address!, 0.004)), priv: receiver.priv, type: 'p2wpkh' },
    { ...(await fundAddress(rpc, receiver.p2wpkh.address!, 0.006)), priv: receiver.priv, type: 'p2wpkh' },
  ];
  const offered: string[] = [];
  const rx = new PayjoinReceiver({
    isBroadcastable: async (hex) => (await rpc.testMempoolAccept(hex))[0]!.allowed,
    isOwnedScript: (spk) => Buffer.compare(Buffer.from(spk), receiver.p2wpkh.output!) === 0,
    inputSeenBefore: () => false, markInputSeen: () => {},
    selectInput: (_o, exposed) => {
      const pick = coins.find((c) => exposed.includes(`${c.txid}:${c.vout}`)) ?? coins.slice().sort((a, b) => b.valueSat - a.valueSat)[0]!;
      offered.push(`${pick.txid}:${pick.vout}`); return pick;
    },
    signInput: (psbt, idx, u) => { signPsbtInput(psbt, idx, u); psbt.finalizeInput(idx); },
  });

  for (let i = 0; i < 3; i++) {
    const prober = new SimpleKey();
    const u: KeyedUtxo = { ...(await fundAddress(rpc, prober.p2wpkh.address!, 0.01)), priv: prober.priv, type: 'p2wpkh' };
    const outs = [
      { scriptPubKey: new Uint8Array(receiver.p2wpkh.output!), valueSat: 500_000 },
      { scriptPubKey: new Uint8Array(new SimpleKey().p2wpkh.output!), valueSat: u.valueSat - 500_500 },
    ];
    const psbt = buildPsbt([u], outs);
    signPsbtInput(psbt, 0, u);
    const original = createSenderContext(psbt, { pjos: true }, outs[0]!.scriptPubKey, {}).originalPsbt;
    await rx.handle({ psbtBase64: original.toBase64(), query: new URLSearchParams({ v: '1' }) });
  }
  assert.equal(new Set(offered).size, 1, 'a prober learns one UTXO, not the whole wallet');
});
