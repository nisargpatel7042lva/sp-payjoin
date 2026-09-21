import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, score } from './cioh.js';

const tx = (ins: string[], outs: number[]) => ({ txid: 't', inputs: ins.map((o) => ({ outpoint: o, scriptPubKeyHex: '' })), outputs: outs.map((v, i) => ({ index: i, scriptPubKeyHex: '', valueSat: v })) });

test('normal payment: H1 and H2 hold', () => {
  const s = score(analyze(tx(['a:0', 'a:1'], [60_000, 39_600])), { ownerOfOutpoint: { 'a:0': 'alice', 'a:1': 'alice' }, paymentSat: 60_000, paymentOutputIndex: 0 });
  assert.equal(s.h1.correct, true);
  assert.equal(s.h2?.correct, true);
});

test('payjoin: H1 clusters two owners together, H2 overstates the payment', () => {
  const s = score(analyze(tx(['a:0', 'b:0'], [110_000, 39_600])), { ownerOfOutpoint: { 'a:0': 'alice', 'b:0': 'bob' }, paymentSat: 60_000, paymentOutputIndex: 0 });
  assert.equal(s.h1.correct, false);
  assert.match(s.h1.detail, /alice and bob/);
  assert.equal(s.h2?.correct, false);
});
