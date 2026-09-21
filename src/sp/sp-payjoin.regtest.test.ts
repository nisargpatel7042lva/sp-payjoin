/** End-to-end on regtest: PayJoin addressed by a silent payment address; receiver wallet stays consistent. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BitcoinRpc } from '../chain/rpc.js';
import { SimpleKey, fundAddress, withPrevouts, buildSignedTx, type KeyedUtxo } from '../wallet/simple.js';
import { SpWallet } from './wallet.js';
import { silentPaymentOutputs } from './send.js';
import { PayjoinReceiver } from '../payjoin/receiver.js';
import { startReceiverServer } from '../payjoin/http.js';
import { payWithPayjoin } from '../payjoin/client.js';
import { buildPjUri } from '../payjoin/uri.js';
import { Psbt } from 'bitcoinjs-lib';
import { unsignedTx } from '../payjoin/psbt-utils.js';

const rpc = new BitcoinRpc();
const skip = (await rpc.getBlockCount().then(() => true, () => false)) ? false : 'regtest node not running';
const chain = { isBroadcastable: async (hex: string) => (await rpc.testMempoolAccept(hex))[0]!.allowed };
const p2trUtxo = async (key: SimpleKey, btc: number): Promise<KeyedUtxo> => ({ ...(await fundAddress(rpc, key.p2tr.address!, btc)), priv: key.p2trPriv, type: 'p2tr' });

test('SP + PayJoin end-to-end; receiver wallet finds, tracks and spends everything', { skip }, async () => {
  const receiver = new SpWallet();

  // 1. A normal silent payment funds the receiver (this UTXO will be contributed to the PayJoin).
  const alice = new SimpleKey();
  const aliceUtxo = await p2trUtxo(alice, 0.02);
  const [spOut] = silentPaymentOutputs({ keys: [{ priv: aliceUtxo.priv, isTaproot: true }], outpoints: [aliceUtxo], payments: [{ address: receiver.address, amountSat: 700_000 }] });
  const fundTx = buildSignedTx([aliceUtxo], [{ scriptPubKey: spOut!.scriptPubKey, valueSat: 700_000 }, { scriptPubKey: new Uint8Array(new SimpleKey().p2tr.output!), valueSat: aliceUtxo.valueSat - 700_000 - 400 }]);
  const fundTxid = await rpc.sendRawTransaction(fundTx.toHex()); await rpc.mine(1);
  receiver.scanDecodedTx(await withPrevouts(rpc, await rpc.getRawTransaction(fundTxid)));
  assert.equal(receiver.utxos.size, 1);
  assert.equal(receiver.balanceSat(), 700_000);
  const contributed = [...receiver.utxos.values()][0]!;

  // 2. Bob pays the receiver's silent payment address with PayJoin.
  const bob = new SimpleKey(), bobChange = new SimpleKey();
  const bobUtxo = await p2trUtxo(bob, 0.01);
  const rx = new PayjoinReceiver(receiver.receiverHooks(chain));
  const server = await startReceiverServer(rx);
  const PAY = 600_000, FEE = 600;
  let proposal: Awaited<ReturnType<PayjoinReceiver['handle']>> | undefined;
  const server2 = await startReceiverServer(rx, { onProposal: (p) => { proposal = p; } });
  await server.close();
  try {
    const uri = buildPjUri({ sp: receiver.address, amountSat: PAY, pj: server2.url });
    const r = await payWithPayjoin({
      uri, inputs: [bobUtxo], paymentOutputIndex: 0,
      outputs: [{ sp: true, valueSat: PAY }, { scriptPubKey: new Uint8Array(bobChange.p2tr.output!), valueSat: bobUtxo.valueSat - PAY - FEE }],
      params: { additionalFeeOutputIndex: 1, maxAdditionalFeeContribution: 1000 },
      broadcast: (hex) => rpc.sendRawTransaction(hex),
    });
    assert.equal(r.payjoin, true);
    await rpc.mine(1);
    const finalTx = await withPrevouts(rpc, await rpc.getRawTransaction(r.txid));
    assert.ok((finalTx.confirmations ?? 0) >= 1, 'confirmed');

    // the join happened: Bob's input and the receiver's SP-received UTXO are both inputs
    const ins = finalTx.vin.map((v) => `${v.txid}:${v.vout}`);
    assert.ok(ins.includes(`${bobUtxo.txid}:${bobUtxo.vout}`));
    assert.ok(ins.includes(`${contributed.txid}:${contributed.vout}`));

    // the original (sender-derived) output was substituted: it is NOT in the final tx
    const originalSpScript = Buffer.from(unsignedTx(Psbt.fromBase64(r.originalBase64)).outs[0]!.script).toString('hex');
    assert.ok(!finalTx.vout.some((o) => o.scriptPubKey.hex === originalSpScript), 'sender-derived output replaced');
    assert.ok(proposal, 'receiver produced a proposal');

    // 3. Standard BIP352 scanning of the confirmed tx finds the substituted output and retires the spent one.
    const added = receiver.scanDecodedTx(finalTx);
    assert.equal(added.length, 1, `exactly one new output found by scanning; log=${JSON.stringify(receiver.log)} vout=${JSON.stringify(finalTx.vout.map((o) => [o.n, o.scriptPubKey.hex.slice(0, 12), o.value]))}`);
    assert.equal(receiver.utxos.size, 1);
    assert.equal(receiver.spent.size, 1);
    assert.ok(receiver.spent.has(`${contributed.txid}:${contributed.vout}`));
    const expectedValue = PAY + contributed.valueSat - proposal!.receiverFeeSat;
    assert.equal(added[0]!.valueSat, expectedValue);
    assert.equal(receiver.balanceSat(), expectedValue);
    assert.ok(finalTx.vout.some((o) => o.n === added[0]!.vout && o.scriptPubKey.hex === Buffer.from(added[0]!.scriptPubKey).toString('hex')));

    // 4. The receiver can spend what it found (b_spend + t_k), proving the recomputed output is really its own.
    const dest = new SimpleKey();
    const spend = buildSignedTx([added[0]!], [{ scriptPubKey: new Uint8Array(dest.p2wpkh.output!), valueSat: added[0]!.valueSat - 300 }]);
    const ok = await rpc.testMempoolAccept(spend.toHex());
    assert.equal(ok[0]!.allowed, true, ok[0]!['reject-reason'] ?? 'rejected');
    const spendTxid = await rpc.sendRawTransaction(spend.toHex()); await rpc.mine(1);
    receiver.scanDecodedTx(await withPrevouts(rpc, await rpc.getRawTransaction(spendTxid)));
    assert.equal(receiver.utxos.size, 0);
    assert.equal(receiver.balanceSat(), 0);
  } finally { await server2.close(); }
});

test('receiver-side derivation equals sender-side derivation for the same input set (random keys, mixed p2wpkh/p2tr)', () => {
  for (let i = 0; i < 10; i++) {
    const w = new SpWallet();
    const a = new SimpleKey(), b = new SimpleKey();
    const inputs = [
      { txid: Buffer.alloc(32, i + 1).toString('hex'), vout: 1, priv: a.priv, type: 'p2wpkh' as const, script: new Uint8Array(a.p2wpkh.output!) },
      { txid: Buffer.alloc(32, i + 2).toString('hex'), vout: 0, priv: b.p2trPriv, type: 'p2tr' as const, script: new Uint8Array(b.p2tr.output!) },
    ];
    const [senderSide] = silentPaymentOutputs({ keys: inputs.map((x) => ({ priv: x.priv, isTaproot: x.type === 'p2tr' })), outpoints: inputs, payments: [{ address: w.address, amountSat: 1 }] });
    const views = inputs.map((x) => ({ txid: x.txid, vout: x.vout, scriptSigHex: '', witness: x.type === 'p2wpkh' ? ['', Buffer.from(a.pub).toString('hex')] : [], prevoutScriptPubKeyHex: Buffer.from(x.script).toString('hex') }));
    assert.equal(Buffer.from(w.deriveForInputs(views, 0)).toString('hex'), Buffer.from(senderSide!.scriptPubKey).toString('hex'));
  }
});
