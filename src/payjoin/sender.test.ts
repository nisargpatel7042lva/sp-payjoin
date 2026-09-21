/** BIP78 sender vs. the BIP's own test vectors (P2SH-P2WPKH, 2 sat/vB, fee output 0, max contribution 182). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Psbt } from 'bitcoinjs-lib';
import { buildRequestUrl, createOriginalPsbt, createSenderContext, verifyAndFillProposal } from './sender.js';
import { PayjoinSenderError } from './errors.js';
import { psbtFee, unsignedTx, finalizedTx } from './psbt-utils.js';

const V = JSON.parse(readFileSync(new URL('./fixtures/bip78-vectors.json', import.meta.url), 'utf8')) as { maxAdditionalFeeContributionSat: number; additionalFeeOutputIndex: number; originalFeeRateSatVb: number; psbts: Record<string, string> };
const signed = () => Psbt.fromBase64(V.psbts['Unfinalized signed PSBT']!);
const proposalB64 = V.psbts['payjoin proposal']!;
const paymentScript = unsignedTx(signed()).outs[1]!.script; // vector: output 1 is the payment (output 0 is the fee/change output)
const params = { additionalFeeOutputIndex: V.additionalFeeOutputIndex, maxAdditionalFeeContribution: V.maxAdditionalFeeContributionSat };
const ctx = () => createSenderContext(signed(), { pjos: true }, paymentScript, params);

test('createOriginalPsbt reproduces the vector\'s Original PSBT byte-for-byte', () => {
  assert.equal(createOriginalPsbt(signed()).toBase64(), V.psbts['Original PSBT']);
});

test('original fee rate is 2 sat/vB as stated by the vector', () => {
  const c = ctx();
  assert.equal(Math.round(c.originalFeeRate), V.originalFeeRateSatVb);
  assert.equal(c.originalFee, psbtFee(signed()));
});

test('verifyAndFillProposal reproduces "payjoin proposal filled with sender\'s information"', () => {
  const filled = verifyAndFillProposal(ctx(), proposalB64);
  assert.equal(filled.toBase64(), V.psbts["payjoin proposal filled with sender's information"]);
});

test('request URL carries v=1 and the optional parameters', () => {
  const u = new URL(buildRequestUrl('https://example.com/pj', { ...params, minFeeRate: 1.5 }));
  assert.equal(u.searchParams.get('v'), '1');
  assert.equal(u.searchParams.get('additionalfeeoutputindex'), '0');
  assert.equal(u.searchParams.get('maxadditionalfeecontribution'), '182');
  assert.equal(u.searchParams.get('minfeerate'), '1.5');
  assert.equal(u.searchParams.get('disableoutputsubstitution'), null);
});

// ── checklist negatives: each tampered proposal must be rejected ───────────────
const tampered = (mutate: (p: Psbt) => void): string => { const p = Psbt.fromBase64(proposalB64); mutate(p); return p.toBase64(); };
const rejects = (b64: string, re: RegExp, c = ctx()) => assert.throws(() => verifyAndFillProposal(c, b64), (e: unknown) => e instanceof PayjoinSenderError && re.test(e.message), `expected ${re}`);

test('rejects changed version / locktime', () => {
  rejects(tampered((p) => { p.setVersion(1); }), /transaction version/);
  rejects(tampered((p) => { p.setLocktime(5); }), /nLocktime/);
});
test('rejects a sender input that the receiver finalized, or that carries partial sigs / keypaths', () => {
  const orig = Psbt.fromBase64(V.psbts['Original PSBT']!);
  rejects(tampered((p) => { p.data.inputs[0]!.finalScriptWitness = orig.data.inputs[0]!.finalScriptWitness; }), /finalized one of our inputs/);
  rejects(tampered((p) => { p.data.inputs[0]!.partialSig = signed().data.inputs[0]!.partialSig; }), /partial signatures/);
  rejects(tampered((p) => { p.data.inputs[0]!.bip32Derivation = signed().data.inputs[0]!.bip32Derivation; }), /keypaths to an input/);
});
test('rejects a receiver input that is not finalized or has no utxo info', () => {
  rejects(tampered((p) => { delete p.data.inputs[1]!.finalScriptWitness; delete p.data.inputs[1]!.finalScriptSig; }), /did not finalize/);
  rejects(tampered((p) => { delete p.data.inputs[1]!.witnessUtxo; }), /witness_utxo/);
});
test('rejects changed sequence on our input and mixed sequences', () => {
  rejects(tampered((p) => { p.setInputSequence(0, 0xfffffffd); }), /sequence/);
  rejects(tampered((p) => { p.setInputSequence(1, 0); }), /Mixed sequence/);
});
test('rejects a missing sender input', () => {
  rejects(tampered((p) => { p.data.globalMap.unsignedTx.toBuffer(); (p as unknown as { __CACHE: { __TX: { ins: unknown[] } } }).__CACHE.__TX.ins.splice(0, 1); p.data.inputs.splice(0, 1); }), /not included in the proposal|Some of our inputs/);
});
test('rejects fee decrease and over-contribution', () => {
  // decreasing absolute fee: bump the receiver output value
  rejects(tampered((p) => { (p as unknown as { __CACHE: { __TX: { outs: { value: number }[] } } }).__CACHE.__TX.outs[1]!.value += 1000; }), /decreased absolute fee/);
  // contribution above the sender's cap (fee output 0 reduced by more than 182)
  const tight = createSenderContext(signed(), { pjos: true }, paymentScript, { ...params, maxAdditionalFeeContribution: 100 });
  rejects(proposalB64, /more than maxadditionalfeecontribution/, tight);
});
test('a non-payment output whose value decreased is rejected when substitution is disabled', () => {
  const noSub = createSenderContext(signed(), { pjos: false }, paymentScript, params);
  const originalPayment = Number(unsignedTx(signed()).outs[1]!.value);
  // the proposal's payment output is original + receiver input; only a value *below the original* is a violation
  rejects(tampered((p) => { (p as unknown as { __CACHE: { __TX: { outs: { value: number }[] } } }).__CACHE.__TX.outs[1]!.value = originalPayment - 1; }), /decreased the value/, noSub);
  assert.doesNotThrow(() => verifyAndFillProposal(noSub, tampered((p) => { (p as unknown as { __CACHE: { __TX: { outs: { value: number }[] } } }).__CACHE.__TX.outs[1]!.value = originalPayment; })));
});
test('finalized tx of the vector proposal has 2 inputs (sender + receiver)', () => {
  assert.equal(finalizedTx(Psbt.fromBase64(proposalB64)).ins.length, 2);
});
