/**
 * The same silent-payment payjoin, over an asynchronous directory instead of a
 * receiver-hosted endpoint. Nothing in the SP layer or the payjoin logic changes:
 * only the transport passed to the sender differs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BitcoinRpc } from '../chain/rpc.js';
import { SimpleKey, fundAddress, withPrevouts, buildSignedTx, type KeyedUtxo } from '../wallet/simple.js';
import { SpWallet } from '../sp/wallet.js';
import { silentPaymentOutputs } from '../sp/send.js';
import { PayjoinReceiver } from './receiver.js';
import { PayjoinDirectory } from './directory.js';
import { asyncDirectoryTransport, runAsyncReceiver } from './transport-async.js';
import { payWithPayjoin } from './client.js';
import { buildPjUri } from './uri.js';

const rpc = new BitcoinRpc();
const skip = (await rpc.getBlockCount().then(() => true, () => false)) ? false : 'regtest node not running';
const chain = { isBroadcastable: async (hex: string) => (await rpc.testMempoolAccept(hex))[0]!.allowed };
const p2tr = async (k: SimpleKey, btc: number): Promise<KeyedUtxo> => ({ ...(await fundAddress(rpc, k.p2tr.address!, btc)), priv: k.p2trPriv, type: 'p2tr' });

/** Gives the receiver a coin the normal way: someone pays its silent payment address. */
async function fundSpWallet(wallet: SpWallet, amountSat: number): Promise<void> {
  const funder = new SimpleKey();
  const f = await p2tr(funder, 0.02);
  const [o] = silentPaymentOutputs({ keys: [{ priv: f.priv, isTaproot: true }], outpoints: [f], payments: [{ address: wallet.address, amountSat }] });
  const tx = buildSignedTx([f], [{ scriptPubKey: o!.scriptPubKey, valueSat: amountSat }, { scriptPubKey: new Uint8Array(new SimpleKey().p2tr.output!), valueSat: f.valueSat - amountSat - 400 }]);
  const txid = await rpc.sendRawTransaction(tx.toHex());
  await rpc.mine(1);
  wallet.scanDecodedTx(await withPrevouts(rpc, await rpc.getRawTransaction(txid)));
}

test('silent-payment payjoin completes over an async directory, with the receiver hosting nothing', { skip }, async () => {
  const receiver = new SpWallet();
  await fundSpWallet(receiver, 900_000);

  const directory = await new PayjoinDirectory().start();
  const sessionId = PayjoinDirectory.newSessionId();
  const mailbox = `${directory.url}/${sessionId}`;

  // The receiver only ever makes outbound requests — it never binds a port.
  const events: string[] = [];
  const running = runAsyncReceiver({
    receiver: new PayjoinReceiver(receiver.receiverHooks(chain)),
    mailboxUrl: mailbox,
    onEvent: (e) => events.push(e.type),
  });

  try {
    const alice = new SimpleKey(), change = new SimpleKey();
    const a = await p2tr(alice, 0.008);
    const PAY = 600_000, FEE = 600;
    const r = await payWithPayjoin({
      uri: buildPjUri({ sp: receiver.address, amountSat: PAY, pj: mailbox }),
      inputs: [a], paymentOutputIndex: 0,
      outputs: [{ sp: true, valueSat: PAY }, { scriptPubKey: new Uint8Array(change.p2tr.output!), valueSat: a.valueSat - PAY - FEE }],
      params: { additionalFeeOutputIndex: 1, maxAdditionalFeeContribution: 1000 },
      transport: asyncDirectoryTransport({ pollIntervalMs: 50 }),
      broadcast: (hex) => rpc.sendRawTransaction(hex),
    });

    assert.equal(r.payjoin, true, 'the join happened without the receiver hosting an endpoint');
    assert.equal(r.tx.ins.length, 2);
    await running.done;
    assert.deepEqual(events, ['waiting', 'received', 'answered']);

    await rpc.mine(1);
    const tx = await withPrevouts(rpc, await rpc.getRawTransaction(r.txid));
    assert.ok((tx.confirmations ?? 0) >= 1);

    // The silent-payment layer is untouched by the transport swap: the receiver
    // still finds its recomputed output by ordinary BIP352 scanning.
    const found = receiver.scanDecodedTx(tx);
    assert.equal(found.length, 1);
    assert.equal(receiver.utxos.size, 1, 'contributed coin retired, joined output found');
    assert.equal(found[0]!.valueSat, receiver.balanceSat());

    // And the shape still defeats UIH2.
    const minIn = Math.min(...tx.vin.map((v) => Math.round(v.prevout!.value * 1e8)));
    const minOut = Math.min(...tx.vout.map((o) => Math.round(o.value * 1e8)));
    assert.ok(minIn > minOut, `min input ${minIn} > min output ${minOut}`);
  } finally {
    running.stop();
    await directory.stop();
  }
});

test('the receiver never answering leaves the payer with a completed silent payment', { skip }, async () => {
  const receiver = new SpWallet();
  const directory = await new PayjoinDirectory().start();
  const mailbox = `${directory.url}/${PayjoinDirectory.newSessionId()}`;   // nobody is polling it

  try {
    const alice = new SimpleKey(), change = new SimpleKey();
    const a = await p2tr(alice, 0.008);
    const PAY = 500_000, FEE = 600;
    const started = Date.now();
    const r = await payWithPayjoin({
      uri: buildPjUri({ sp: receiver.address, amountSat: PAY, pj: mailbox }),
      inputs: [a], paymentOutputIndex: 0,
      outputs: [{ sp: true, valueSat: PAY }, { scriptPubKey: new Uint8Array(change.p2tr.output!), valueSat: a.valueSat - PAY - FEE }],
      transport: asyncDirectoryTransport({ pollIntervalMs: 50 }),
      requestTimeoutMs: 700,
      broadcast: (hex) => rpc.sendRawTransaction(hex),
    });
    assert.equal(r.payjoin, false);
    assert.equal(r.txid, r.originalTxid);
    assert.ok(Date.now() - started < 8_000, 'gave up rather than waiting forever');

    // Still a silent payment: the receiver finds it by scanning, no interaction at all.
    await rpc.mine(1);
    receiver.scanDecodedTx(await withPrevouts(rpc, await rpc.getRawTransaction(r.txid)));
    assert.equal(receiver.balanceSat(), PAY);
  } finally { await directory.stop(); }
});

test('what the directory can see: plaintext here, and why BIP77 encrypts it', { skip }, async () => {
  const receiver = new SpWallet();
  await fundSpWallet(receiver, 900_000);
  const directory = await new PayjoinDirectory().start();
  const sessionId = PayjoinDirectory.newSessionId();
  const mailbox = `${directory.url}/${sessionId}`;
  const running = runAsyncReceiver({ receiver: new PayjoinReceiver(receiver.receiverHooks(chain)), mailboxUrl: mailbox });
  try {
    const alice = new SimpleKey(), change = new SimpleKey();
    const a = await p2tr(alice, 0.008);
    await payWithPayjoin({
      uri: buildPjUri({ sp: receiver.address, amountSat: 600_000, pj: mailbox }),
      inputs: [a], paymentOutputIndex: 0,
      outputs: [{ sp: true, valueSat: 600_000 }, { scriptPubKey: new Uint8Array(change.p2tr.output!), valueSat: a.valueSat - 600_600 }],
      transport: asyncDirectoryTransport({ pollIntervalMs: 50 }),
      broadcast: (hex) => rpc.sendRawTransaction(hex),
    });
    await running.done;
    const seen = directory.inspect(sessionId);
    // This is the honest gap: our stand-in directory holds both PSBTs in the clear.
    // BIP77 fixes exactly this with HPKE to the receiver's key, plus OHTTP for IP privacy.
    assert.ok(seen.original && seen.original.startsWith('cHNidP'), 'directory holds the original PSBT in plaintext');
    assert.ok(seen.proposal && seen.proposal.startsWith('cHNidP'), 'and the proposal too');
  } finally { running.stop(); await directory.stop(); }
});
