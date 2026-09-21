import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newReceiverKeys, scanTx, deriveOutput, spendingKey } from './keys.js';
import { silentPaymentOutputs } from './send.js';
import { derivationContext } from './inputs.js';
import { SimpleKey } from '../wallet/simple.js';
import { spAddress } from './keys.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

test('scanning does not mutate the receiver keys (library tweaks private keys in place)', () => {
  const keys = newReceiverKeys();
  const a = new SimpleKey();
  const input = { txid: Buffer.alloc(32, 3).toString('hex'), vout: 0, priv: a.p2trPriv, scriptPubKey: new Uint8Array(a.p2tr.output!) };
  const [out] = silentPaymentOutputs({ keys: [{ priv: input.priv, isTaproot: true }], outpoints: [input], payments: [{ address: spAddress(keys), amountSat: 1 }] });
  const ctx = derivationContext([{ txid: input.txid, vout: 0, scriptSigHex: '', witness: [], prevoutScriptPubKeyHex: hex(input.scriptPubKey) }])!;
  const before = { scan: hex(keys.scanPriv), spend: hex(keys.spendPriv) };
  const outputs = [{ vout: 0, scriptPubKeyHex: hex(out!.scriptPubKey) }];
  const first = scanTx(keys, ctx.sumPubkeys, ctx.inputHash, outputs);
  const second = scanTx(keys, ctx.sumPubkeys, ctx.inputHash, outputs);
  assert.equal(first.length, 1);
  assert.deepEqual(second, first, 'second scan with the same keys finds the same output');
  assert.deepEqual({ scan: hex(keys.scanPriv), spend: hex(keys.spendPriv) }, before, 'keys unchanged');
  // derive agrees with scan and with the sender, and the spending key reproduces the output key
  const d = deriveOutput(keys, ctx.sumPubkeys, ctx.inputHash, 0);
  assert.equal(hex(d.xOnly), hex(out!.xOnly));
  assert.equal(hex(d.tweak), hex(first[0]!.tweak));
  assert.equal(hex(spendingKey(keys, d.tweak).length === 32 ? d.xOnly : new Uint8Array()), hex(out!.xOnly));
});
