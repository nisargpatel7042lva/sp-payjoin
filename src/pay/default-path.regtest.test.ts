/**
 * The Phase 3 gate as a test: one send command, three receiver situations.
 * No protocol flag is ever passed; the outcome differs, the call does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BitcoinRpc } from '../chain/rpc.js';
import { SenderWallet } from '../wallet/sender-wallet.js';
import { SpWallet } from '../sp/wallet.js';
import { PayjoinReceiver } from '../payjoin/receiver.js';
import { startReceiverServer } from '../payjoin/http.js';
import { buildPjUri } from '../payjoin/uri.js';
import { pay } from './pay.js';

const rpc = new BitcoinRpc();
const skip = (await rpc.getBlockCount().then(() => true, () => false)) ? false : 'regtest node not running';
process.env.SPAY_HOME = mkdtempSync(join(tmpdir(), 'spay-test-'));

async function fundedSender(name: string): Promise<SenderWallet> {
  const w = SenderWallet.open(name);
  await rpc.fund(w.address(), 0.02);
  await rpc.mine(1);
  await w.refresh(rpc);
  return w;
}
const chain = { isBroadcastable: async (hex: string) => (await rpc.testMempoolAccept(hex))[0]!.allowed };

test('receiver is a plain silent-payment wallet (no endpoint) → send completes as a direct SP payment', { skip }, async () => {
  const sender = await fundedSender('s1');
  const receiver = SpWallet.open('r1', await rpc.getBlockCount());
  const r = await pay({ wallet: sender, rpc, destination: buildPjUri({ sp: receiver.address, amountSat: 300_000 }) });
  assert.equal(r.payjoin, false);
  assert.equal(r.reason, 'no payjoin endpoint advertised');
  assert.equal(r.tx.ins.length, 1, 'only the sender contributed');
  assert.match(r.summary, /direct silent payment/);
  await rpc.mine(1);
  const found = await receiver.scanChain(rpc);
  assert.equal(found.length, 1, 'receiver finds it by scanning, no interaction needed');
  assert.equal(found[0]!.valueSat, 300_000);
  assert.equal(receiver.balanceSat(), 300_000);
});

test('receiver advertises an endpoint that is down → same command still pays (graceful fallback)', { skip }, async () => {
  const sender = await fundedSender('s2');
  const receiver = SpWallet.open('r2', await rpc.getBlockCount());
  const r = await pay({ wallet: sender, rpc, destination: buildPjUri({ sp: receiver.address, amountSat: 250_000, pj: 'http://127.0.0.1:1/payjoin' }) });
  assert.equal(r.payjoin, false);
  assert.match(r.reason ?? '', /fetch failed|ECONNREFUSED|returned/);
  assert.equal(r.txid, r.originalTxid, 'the original was broadcast');
  await rpc.mine(1);
  assert.equal((await receiver.scanChain(rpc)).length, 1);
});

test('receiver runs the endpoint → same command produces a join, and the receiver stays consistent', { skip }, async () => {
  const sender = await fundedSender('s3');
  const receiver = SpWallet.open('r3', await rpc.getBlockCount());
  // give the receiver a UTXO to contribute (a plain SP payment)
  await pay({ wallet: await fundedSender('s3b'), rpc, destination: buildPjUri({ sp: receiver.address, amountSat: 400_000 }) });
  await rpc.mine(1);
  await receiver.scanChain(rpc);
  assert.equal(receiver.utxos.size, 1);

  const server = await startReceiverServer(new PayjoinReceiver(receiver.receiverHooks(chain)));
  try {
    const r = await pay({ wallet: sender, rpc, destination: buildPjUri({ sp: receiver.address, amountSat: 350_000, pj: server.url }) });
    assert.equal(r.payjoin, true);
    assert.equal(r.tx.ins.length, 2, 'one input from each party');
    assert.match(r.summary, /payjoin/);
    await rpc.mine(1);
    const found = await receiver.scanChain(rpc);
    assert.equal(found.length, 1);
    assert.equal(receiver.utxos.size, 1, 'contributed utxo retired, joined output found');
    assert.equal(found[0]!.valueSat, receiver.balanceSat());
    assert.ok(receiver.balanceSat() > 400_000 + 350_000 - 2_000, 'kept its contribution plus the payment, less its fee share');
  } finally { await server.close(); }
});

test('a destination with no amount anywhere is a usage error, not a silent misfire', { skip }, async () => {
  const sender = await fundedSender('s4');
  await assert.rejects(pay({ wallet: sender, rpc, destination: SpWallet.open('r4').address }), /no amount given/);
});
