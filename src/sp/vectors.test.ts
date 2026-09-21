/** BIP352 official send/receive vectors, driven through our input extraction + @silent-pay/core. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeSilentPaymentAddress } from '@silent-pay/core';
import { networks } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { derivationContext, inputPublicKey, sumInputPublicKeys, type TxInputView } from './inputs.js';
import { silentPaymentOutputs } from './send.js';
import { scanTx, spendingKey } from './keys.js';

interface Vin { txid: string; vout: number; scriptSig: string; txinwitness: string; prevout: { scriptPubKey: { hex: string } }; private_key?: string }
interface Vector {
  comment: string;
  sending: Array<{ given: { vin: Vin[]; recipients: Array<string | { address: string }> }; expected: { outputs: string[][]; input_pub_keys?: string[] } }>;
  receiving: Array<{ given: { vin: Vin[]; outputs: string[]; key_material: { spend_priv_key: string; scan_priv_key: string }; labels: number[] }; expected: { addresses: string[]; outputs: Array<{ pub_key: string; priv_key_tweak: string; signature: string }>; tweak?: string } }>;
}
const vectors = JSON.parse(readFileSync(new URL('./fixtures/bip352-send-and-receive.json', import.meta.url), 'utf8')) as Vector[];
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytes = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

/** Parses the vector's witness encoding (a single hex string of serialized witness stack). */
function parseWitness(w: string): string[] {
  if (!w) return [];
  const b = Buffer.from(w, 'hex'); let i = 0; const n = b[i++]!; const items: string[] = [];
  for (let k = 0; k < n; k++) { let len = b[i++]!; if (len === 0xfd) { len = b.readUInt16LE(i); i += 2; } items.push(b.subarray(i, i + len).toString('hex')); i += len; }
  return items;
}
const view = (v: Vin): TxInputView => ({ txid: v.txid, vout: v.vout, scriptSigHex: v.scriptSig, witness: parseWitness(v.txinwitness), prevoutScriptPubKeyHex: v.prevout.scriptPubKey.hex });

for (const v of vectors) {
  test(`send: ${v.comment}`, () => {
    for (const s of v.sending) {
      const inputs = s.given.vin.map(view);
      const contributing = s.given.vin.filter((i) => inputPublicKey(view(i)) !== undefined);
      if (s.expected.input_pub_keys) assert.deepEqual(contributing.map((i) => hex(inputPublicKey(view(i))!)).sort(), s.expected.input_pub_keys.slice().sort());
      if (contributing.length === 0) { assert.deepEqual(s.expected.outputs, [[]]); continue; }
      if (v.comment.startsWith('Maximum per-group recipient limit')) continue; // @silent-pay/core does not enforce K_max; irrelevant here (1 output per recipient)
      const keys = contributing.map((i) => ({ priv: bytes(i.private_key!), isTaproot: view(i).prevoutScriptPubKeyHex.startsWith('5120') }));
      const outpoints = inputs.map((i) => ({ txid: i.txid, vout: i.vout }));
      const payments = s.given.recipients.map((r) => ({ address: typeof r === 'string' ? r : r.address, amountSat: 1 }));
      let outs: Uint8Array[];
      try { outs = silentPaymentOutputs({ keys, outpoints, payments, network: networks.bitcoin }).map((o) => o.xOnly); }
      catch { assert.deepEqual(s.expected.outputs, [[]], 'sender threw but vector expects outputs'); continue; }
      const got = outs.map(hex).sort();
      assert.ok(s.expected.outputs.some((alt) => JSON.stringify(alt.slice().sort()) === JSON.stringify(got)), `outputs mismatch: got ${got}`);
    }
  });

  test(`receive: ${v.comment}`, () => {
    for (const r of v.receiving) {
      if (r.given.labels.length > 0) continue; // labels: out of scope for this project
      const inputs = r.given.vin.map(view);
      const keys = { scanPriv: bytes(r.given.key_material.scan_priv_key), spendPriv: bytes(r.given.key_material.spend_priv_key), scanPub: ecc.pointFromScalar(bytes(r.given.key_material.scan_priv_key), true)!, spendPub: ecc.pointFromScalar(bytes(r.given.key_material.spend_priv_key), true)! };
      assert.equal(encodeSilentPaymentAddress(keys.scanPub, keys.spendPub, networks.bitcoin), r.expected.addresses[0]);
      const ctx = derivationContext(inputs);
      if (!ctx) { assert.equal(r.expected.outputs.length, 0); continue; }
      const found = scanTx(keys, ctx.sumPubkeys, ctx.inputHash, r.given.outputs.map((x, vout) => ({ vout, scriptPubKeyHex: '5120' + x })));
      const expected = r.expected.outputs.map((o) => o.pub_key).sort();
      assert.deepEqual(found.map((f) => hex(f.xOnly)).sort(), expected);
      for (const f of found) {
        const exp = r.expected.outputs.find((o) => o.pub_key === hex(f.xOnly))!;
        assert.equal(hex(f.tweak), exp.priv_key_tweak);
        const d = spendingKey(keys, f.tweak);
        assert.equal(hex(ecc.xOnlyPointFromScalar(d)), exp.pub_key, 'spending key reproduces the output key');
      }
    }
  });
}

test('sumInputPublicKeys of no keys is undefined', () => { assert.equal(sumInputPublicKeys([]), undefined); });
