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

import { buildChainIndex } from './cioh.js';

test('chain index counts only prior appearances of an output script', async () => {
  const blocks: Record<number, { height: number; tx: Array<{ txid: string; vout: Array<{ scriptPubKey: { hex: string } }> }> }> = {
    0: { height: 0, tx: [{ txid: 'a', vout: [{ scriptPubKey: { hex: 'REUSED' } }] }] },
    1: { height: 1, tx: [{ txid: 'b', vout: [{ scriptPubKey: { hex: 'REUSED' } }, { scriptPubKey: { hex: 'FRESH1' } }] }] },
    2: { height: 2, tx: [{ txid: 'c', vout: [{ scriptPubKey: { hex: 'REUSED' } }, { scriptPubKey: { hex: 'FRESH2' } }] }] },
  };
  const rpc = { getBlockCount: async () => 2, getBlockHash: async (h: number) => String(h), getBlock: async (hash: string) => blocks[Number(hash)]! };
  const index = await buildChainIndex(rpc, 0);
  assert.equal(index.occurrencesBefore('REUSED', 'a'), 0, 'first use is not reuse');
  assert.equal(index.occurrencesBefore('REUSED', 'b'), 1);
  assert.equal(index.occurrencesBefore('REUSED', 'c'), 2);
  assert.equal(index.occurrencesBefore('FRESH1', 'b'), 0);
  assert.equal(index.occurrencesBefore('FRESH2', 'c'), 0);
  assert.equal(index.occurrencesBefore('NEVER-SEEN', 'c'), 0);
});
