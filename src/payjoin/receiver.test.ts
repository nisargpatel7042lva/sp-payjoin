/** BIP78 receiver: proposal structure, fee accounting, checklist rejections. No chain needed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Psbt } from 'bitcoinjs-lib';
import { PayjoinReceiver, type ReceiverHooks } from './receiver.js';
import { PayjoinReceiverError } from './errors.js';
import { createOriginalPsbt, createSenderContext, verifyAndFillProposal } from './sender.js';
import { finalizedTx, isFinalized, psbtFee, unsignedTx } from './psbt-utils.js';
import { buildPsbt, extractTx, finalizePsbt, signPsbtInput } from '../wallet/psbt-wallet.js';
import { SimpleKey, type KeyedUtxo } from '../wallet/simple.js';

const fakeUtxo = (key: SimpleKey, valueSat: number, seed: number): KeyedUtxo => ({
  txid: Buffer.alloc(32, seed).toString('hex'), vout: seed % 3, valueSat, scriptPubKey: new Uint8Array(key.p2wpkh.output!), priv: key.priv, type: 'p2wpkh',
});

function scenario(opts: { feeParams?: boolean; receiverInput?: KeyedUtxo | undefined; substitute?: Uint8Array; seen?: Set<string>; randomIndex?: number } = {}) {
  const sender = new SimpleKey(), senderChange = new SimpleKey(), receiver = new SimpleKey();
  const senderUtxo = fakeUtxo(sender, 100_000, 1);
  const receiverUtxo = 'receiverInput' in opts ? opts.receiverInput : fakeUtxo(receiver, 50_000, 2);
  const PAY = 60_000, FEE = 400;
  const outputs = [
    { scriptPubKey: new Uint8Array(receiver.p2wpkh.output!), valueSat: PAY },                  // payment (index 0)
    { scriptPubKey: new Uint8Array(senderChange.p2wpkh.output!), valueSat: 100_000 - PAY - FEE }, // change (index 1)
  ];
  const signed = buildPsbt([senderUtxo], outputs);
  signPsbtInput(signed, 0, senderUtxo);
  const params = opts.feeParams ? { additionalFeeOutputIndex: 1, maxAdditionalFeeContribution: 1000 } : {};
  const ctx = createSenderContext(signed, { pjos: true }, outputs[0]!.scriptPubKey, params);
  const seen = opts.seen ?? new Set<string>();
  const hooks: ReceiverHooks = {
    isBroadcastable: async () => true,
    isOwnedScript: (spk) => Buffer.compare(Buffer.from(spk), receiver.p2wpkh.output!) === 0,
    inputSeenBefore: (op) => seen.has(op),
    markInputSeen: (op) => { seen.add(op); },
    selectInput: () => receiverUtxo,
    signInput: (psbt, idx, u) => { signPsbtInput(psbt, idx, u); psbt.finalizeInput(idx); },
    substituteOutput: opts.substitute ? () => opts.substitute : undefined,
  };
  const rx = new PayjoinReceiver(hooks, { randomIndex: () => opts.randomIndex ?? 1 });
  const query = new URLSearchParams(opts.feeParams ? { v: '1', additionalfeeoutputindex: '1', maxadditionalfeecontribution: '1000' } : { v: '1' });
  return { rx, ctx, query, originalB64: createOriginalPsbt(signed).toBase64(), senderUtxo, receiverUtxo, receiver, PAY, FEE, sender };
}

test('proposal: sender input kept unsigned/unfinalized, receiver input finalized at the chosen index, outputs in order', async () => {
  const s = scenario();
  const r = await s.rx.handle({ psbtBase64: s.originalB64, query: s.query });
  const p = Psbt.fromBase64(r.proposalBase64);
  assert.equal(p.data.inputs.length, 2);
  assert.equal(r.ourInputIndex, 1);
  assert.equal(isFinalized(p.data.inputs[0]!), false);
  assert.equal(p.data.inputs[0]!.partialSig, undefined);
  assert.equal(isFinalized(p.data.inputs[1]!), true);
  assert.ok(p.data.inputs[1]!.witnessUtxo);
  const tx = unsignedTx(p);
  assert.equal(tx.ins[0]!.sequence, tx.ins[1]!.sequence, 'same sequence on all inputs');
  assert.equal(Buffer.from(tx.ins[1]!.hash).reverse().toString('hex'), s.receiverUtxo!.txid);
  // receiver output = payment + contributed − receiver's fee share; change untouched (no fee params)
  assert.equal(Number(tx.outs[0]!.value), s.PAY + s.receiverUtxo!.valueSat - r.receiverFeeSat);
  assert.equal(Number(tx.outs[1]!.value), 100_000 - s.PAY - s.FEE);
  assert.equal(r.feeContributionSat, 0);
  assert.ok(r.proposalFeeSat >= r.originalFeeSat, 'absolute fee never decreases');
  assert.ok(r.receiverFeeSat > 0, 'receiver pays for its own input weight');
});

test('proposal passes the sender checklist and the sender can sign + extract a 2-input tx', async () => {
  const s = scenario();
  const r = await s.rx.handle({ psbtBase64: s.originalB64, query: s.query });
  const filled = verifyAndFillProposal(s.ctx, r.proposalBase64);
  signPsbtInput(filled, 0, s.senderUtxo);
  const tx = extractTx(finalizePsbt(filled));
  assert.equal(tx.ins.length, 2);
  assert.ok(tx.ins.every((i) => i.witness.length > 0));
  // fee rate preserved: proposal fee / vsize ≈ original fee / vsize (receiver paid for the extra weight)
  const origTx = finalizedTx(s.ctx.originalPsbt);
  const origRate = s.ctx.originalFee / origTx.virtualSize();
  const newRate = psbtFee(filled) / tx.virtualSize();
  assert.ok(newRate >= origRate * 0.98, `fee rate kept: ${newRate} vs ${origRate}`);
});

test('fee output: with additionalfeeoutputindex/maxadditionalfeecontribution the sender pays the extra input fee, within the caps', async () => {
  const s = scenario({ feeParams: true });
  const r = await s.rx.handle({ psbtBase64: s.originalB64, query: s.query });
  const tx = unsignedTx(Psbt.fromBase64(r.proposalBase64));
  assert.ok(r.feeContributionSat > 0);
  assert.equal(Number(tx.outs[1]!.value), 100_000 - s.PAY - s.FEE - r.feeContributionSat, 'contribution deducted from the change output');
  assert.equal(r.receiverFeeSat, 0, 'receiver paid nothing (contribution covered it)');
  assert.ok(r.feeContributionSat <= 1000 && r.feeContributionSat <= Math.floor(s.ctx.originalFeeRate * 110));
  assert.doesNotThrow(() => verifyAndFillProposal(s.ctx, r.proposalBase64));
});

test('payment output substitution replaces our scriptPubKey; sender accepts it (pjos allowed)', async () => {
  const fresh = new SimpleKey();
  const s = scenario({ substitute: new Uint8Array(fresh.p2tr.output!) });
  const r = await s.rx.handle({ psbtBase64: s.originalB64, query: s.query });
  const tx = unsignedTx(Psbt.fromBase64(r.proposalBase64));
  assert.equal(Buffer.from(tx.outs[0]!.script).toString('hex'), fresh.p2tr.output!.toString('hex'));
  assert.doesNotThrow(() => verifyAndFillProposal(s.ctx, r.proposalBase64));
  // and is refused by a sender that disabled substitution
  const noSub = createSenderContext(s.ctx.signedPsbt, { pjos: false }, s.ctx.paymentScript, {});
  assert.throws(() => verifyAndFillProposal(noSub, r.proposalBase64), /not included in the proposal/);
});

test('disableoutputsubstitution=true suppresses the substitution hook', async () => {
  const fresh = new SimpleKey();
  const s = scenario({ substitute: new Uint8Array(fresh.p2tr.output!) });
  const r = await s.rx.handle({ psbtBase64: s.originalB64, query: new URLSearchParams({ v: '1', disableoutputsubstitution: 'true' }) });
  const tx = unsignedTx(Psbt.fromBase64(r.proposalBase64));
  assert.equal(Buffer.from(tx.outs[0]!.script).toString('hex'), s.receiver.p2wpkh.output!.toString('hex'));
});

const rejects = async (p: Promise<unknown>, code: string, re?: RegExp) =>
  assert.rejects(p, (e: unknown) => e instanceof PayjoinReceiverError && e.errorCode === code && (!re || re.test(e.message)), `expected ${code} ${re ?? ''}`);

test('rejections: version, unfinalized original, own input, seen input, not broadcastable, no receiver output, no input to contribute', async () => {
  const s = scenario();
  await rejects(s.rx.handle({ psbtBase64: s.originalB64, query: new URLSearchParams({ v: '2' }) }), 'version-unsupported');
  await rejects(s.rx.handle({ psbtBase64: s.ctx.signedPsbt.toBase64(), query: s.query }), 'original-psbt-rejected', /finalized/);
  await rejects(s.rx.handle({ psbtBase64: 'not a psbt', query: s.query }), 'original-psbt-rejected', /invalid/);

  // sender spends an input owned by the receiver
  const own = scenario();
  const ownUtxo = fakeUtxo(own.receiver, 100_000, 7);
  const signedOwn = buildPsbt([ownUtxo], [{ scriptPubKey: new Uint8Array(own.receiver.p2wpkh.output!), valueSat: 90_000 }]);
  signPsbtInput(signedOwn, 0, ownUtxo);
  await rejects(own.rx.handle({ psbtBase64: createOriginalPsbt(signedOwn).toBase64(), query: own.query }), 'original-psbt-rejected', /owned by the receiver/);

  // replay of the same original
  const seenSet = new Set<string>();
  const first = scenario({ seen: seenSet });
  await first.rx.handle({ psbtBase64: first.originalB64, query: first.query });
  await rejects(first.rx.handle({ psbtBase64: first.originalB64, query: first.query }), 'original-psbt-rejected', /seen before/);

  // not broadcastable
  const nb = scenario();
  const rxNb = new PayjoinReceiver({ ...(nb.rx as unknown as { hooks: ReceiverHooks }).hooks, isBroadcastable: async () => false });
  await rejects(rxNb.handle({ psbtBase64: nb.originalB64, query: nb.query }), 'original-psbt-rejected', /broadcastable/);

  // original pays someone else entirely
  const other = scenario();
  const stranger = new SimpleKey();
  const su = fakeUtxo(other.sender, 100_000, 9);
  const signedOther = buildPsbt([su], [{ scriptPubKey: new Uint8Array(stranger.p2wpkh.output!), valueSat: 90_000 }]);
  signPsbtInput(signedOther, 0, su);
  await rejects(other.rx.handle({ psbtBase64: createOriginalPsbt(signedOther).toBase64(), query: other.query }), 'original-psbt-rejected', /no output pays/);

  // nothing to contribute
  const none = scenario({ receiverInput: undefined });
  await rejects(none.rx.handle({ psbtBase64: none.originalB64, query: none.query }), 'unavailable');
});

test('not-enough-money when the contributed input cannot cover the extra fee', async () => {
  const tiny = scenario({ receiverInput: fakeUtxo(new SimpleKey(), 10, 3) });
  // payment 60_000 + 10 − fee share is still > dust, so force it: make the receiver output tiny by huge minfeerate
  await rejects(tiny.rx.handle({ psbtBase64: tiny.originalB64, query: new URLSearchParams({ v: '1', minfeerate: '100000' }) }), 'not-enough-money');
});
