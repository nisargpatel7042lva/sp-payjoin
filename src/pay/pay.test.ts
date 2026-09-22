/** Destination parsing and coin selection (pure), then the default send path on regtest. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDestination, buildPjUri } from '../payjoin/uri.js';
import { SenderWallet } from '../wallet/sender-wallet.js';
import type { KeyedUtxo } from '../wallet/simple.js';

test('parseDestination accepts a bare silent payment address', () => {
  const d = parseDestination('tsp1qqfdw7qccsm546hukgh9g0qq2zhfa64a0mt355dvhlqcskptr03w8kq4e6qt9rmwpepgr50uyk0xsf988j3y9k6eqhlqgq6ez4v4fxtad0sks9s7x');
  assert.ok(d.sp);
  assert.equal(d.pj, undefined, 'no endpoint ⇒ direct send');
  assert.equal(d.address, undefined);
});

test('parseDestination accepts a bare on-chain address and a URI with/without pj', () => {
  assert.equal(parseDestination('bcrt1q6s3plzg7z2h0myp6dcvg27y7j88cq4fz9zwnf6').address, 'bcrt1q6s3plzg7z2h0myp6dcvg27y7j88cq4fz9zwnf6');
  const withPj = parseDestination(buildPjUri({ sp: 'tsp1qqxyz', amountSat: 1000, pj: 'http://h/pj' }));
  assert.equal(withPj.pj, 'http://h/pj');
  assert.equal(withPj.amountSat, 1000);
  assert.equal(withPj.sp, 'tsp1qqxyz');
  const noPj = parseDestination(buildPjUri({ sp: 'tsp1qqxyz', amountSat: 1000 }));
  assert.equal(noPj.pj, undefined);
  assert.equal(parseDestination('bitcoin:bcrt1qabc?pj=http://h/pj&pjos=0').pjos, false);
  assert.throws(() => parseDestination('bitcoin:?amount=1'), /names no address/);
  assert.throws(() => parseDestination('not a destination'), /not a payment destination/);
});

test('coin selection covers amount + fee, or reports insufficient funds', () => {
  const w = Object.create(SenderWallet.prototype) as SenderWallet;
  const utxo = (valueSat: number, seed: number): KeyedUtxo => ({ txid: Buffer.alloc(32, seed).toString('hex'), vout: 0, valueSat, scriptPubKey: new Uint8Array(34), priv: new Uint8Array(32), type: 'p2tr' });
  w.utxos = [utxo(10_000, 1), utxo(100_000, 2), utxo(50_000, 3)];
  const s = w.select(120_000);
  assert.deepEqual(s.inputs.map((i) => i.valueSat), [100_000, 50_000], 'largest first');
  assert.ok(s.feeSat > 0);
  assert.equal(s.inputs.reduce((a, i) => a + i.valueSat, 0), 120_000 + s.feeSat + s.changeSat);
  assert.throws(() => w.select(10_000_000), /insufficient funds/);
});
