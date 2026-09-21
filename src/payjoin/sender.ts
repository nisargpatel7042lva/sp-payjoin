/**
 * BIP78 sender: a faithful port of the BIP's "Reference sender's implementation".
 *
 *   createOriginalPsbt(signed)          finalize + strip confidential fields → the `original` PSBT
 *   buildRequest(uri, params)           endpoint URL with the optional query parameters
 *   verifyAndFillProposal(ctx, proposal) the sender checklist; fills our inputs/outputs back in
 *
 * Signing the verified proposal and broadcasting are left to the wallet (see wallet/signing.ts).
 */
import { Psbt, Transaction } from 'bitcoinjs-lib';
import { PayjoinSenderError } from './errors.js';
import type { PjUri } from './uri.js';
import { finalizedTx, isFinalized, psbtFee, scriptEq, unsignedTx } from './psbt-utils.js';

export interface SenderOptionalParams {
  /** Output index (in the sender's own PSBT) the receiver may subtract fee from. */
  additionalFeeOutputIndex?: number;
  /** Max sats the receiver may subtract for additional-input fees. */
  maxAdditionalFeeContribution?: number;
  /** sat/vB floor for the final payjoin tx. */
  minFeeRate?: number;
  disableOutputSubstitution?: boolean;
}

export interface SenderContext {
  signedPsbt: Psbt;                // all sender inputs signed, NOT finalized
  originalPsbt: Psbt;              // what was sent
  paymentScript?: Uint8Array;      // scriptPubKey of the BIP21 address (payment output)
  allowOutputSubstitution: boolean;
  params: SenderOptionalParams;
  originalFee: number;
  originalFeeRate: number;         // sat/vB of the original tx
}

/** BIP78 CreateOriginalPSBT: finalize, then remove keypaths / partial sigs / unknowns / global xpubs. */
export function createOriginalPsbt(signed: Psbt): Psbt {
  const original = Psbt.fromBase64(signed.toBase64());
  if (original.data.inputs.every(isFinalized)) throw new PayjoinSenderError('The original PSBT should not be finalized.');
  original.finalizeAllInputs();
  original.data.inputs.forEach((i) => { delete i.bip32Derivation; delete i.partialSig; delete i.unknownKeyVals; delete i.tapBip32Derivation; });
  original.data.outputs.forEach((o) => { delete o.bip32Derivation; delete o.unknownKeyVals; delete o.tapBip32Derivation; });
  delete original.data.globalMap.globalXpub;
  return original;
}

export function buildRequestUrl(pj: string, p: SenderOptionalParams): string {
  const url = new URL(pj);
  url.searchParams.set('v', '1');
  if (p.additionalFeeOutputIndex !== undefined && p.maxAdditionalFeeContribution !== undefined) {
    url.searchParams.set('additionalfeeoutputindex', String(p.additionalFeeOutputIndex));
    url.searchParams.set('maxadditionalfeecontribution', String(p.maxAdditionalFeeContribution));
  }
  if (p.minFeeRate !== undefined) url.searchParams.set('minfeerate', String(p.minFeeRate));
  if (p.disableOutputSubstitution) url.searchParams.set('disableoutputsubstitution', 'true');
  return url.toString();
}

export function createSenderContext(signedPsbt: Psbt, uri: Pick<PjUri, 'pjos'>, paymentScript: Uint8Array | undefined, params: SenderOptionalParams = {}): SenderContext {
  const originalPsbt = createOriginalPsbt(signedPsbt);
  const originalFee = psbtFee(signedPsbt);
  const vsize = finalizedTx(originalPsbt).virtualSize();
  return {
    signedPsbt, originalPsbt, paymentScript, params,
    allowOutputSubstitution: !params.disableOutputSubstitution && uri.pjos,
    originalFee,
    originalFeeRate: originalFee / vsize,
  };
}

/**
 * The sender's payjoin proposal checklist (BIP78 §"Sender's payjoin proposal checklist"),
 * returning the proposal with our inputs' utxo/keypath info filled in, ready to sign.
 */
export function verifyAndFillProposal(ctx: SenderContext, proposalB64: string): Psbt {
  const proposal = Psbt.fromBase64(proposalB64);
  const { signedPsbt, originalPsbt, params } = ctx;
  if (proposal.data.globalMap.globalXpub && proposal.data.globalMap.globalXpub.length > 0) throw new PayjoinSenderError('GlobalXPubs should not be included in the receiver\'s PSBT');

  const originalTx = unsignedTx(originalPsbt);
  const proposalTx = unsignedTx(proposal);
  if (proposalTx.version !== originalTx.version) throw new PayjoinSenderError('The proposal PSBT changed the transaction version');
  if (proposalTx.locktime !== originalTx.locktime) throw new PayjoinSenderError('The proposal PSBT changed the nLocktime');

  const feeOutputIdx = params.additionalFeeOutputIndex !== undefined && params.maxAdditionalFeeContribution !== undefined ? params.additionalFeeOutputIndex : undefined;
  const feeOutput = feeOutputIdx !== undefined ? originalTx.outs[feeOutputIdx] : undefined;

  // ── inputs ──────────────────────────────────────────────────────────────────
  const ourInputs = originalTx.ins.map((txin, k) => ({ txin, signed: signedPsbt.data.inputs[k]!, original: originalPsbt.data.inputs[k]! }));
  const sequences = new Set<number>();
  let queue = 0;
  proposal.data.inputs.forEach((pin, k) => {
    if (pin.bip32Derivation?.length || pin.tapBip32Derivation?.length) throw new PayjoinSenderError('The receiver added keypaths to an input');
    if (pin.partialSig?.length || pin.tapKeySig || pin.tapScriptSig?.length) throw new PayjoinSenderError('The receiver added partial signatures to an input');
    const ptxin = proposalTx.ins[k]!;
    const next = ourInputs[queue];
    const isOurs = next !== undefined && scriptEq(next.txin.hash, ptxin.hash) && next.txin.index === ptxin.index;
    if (isOurs) {
      queue++;
      if (next.txin.sequence !== ptxin.sequence) throw new PayjoinSenderError('The proposal modified the sequence of one of our inputs');
      if (isFinalized(pin)) throw new PayjoinSenderError('The receiver finalized one of our inputs');
      sequences.add(ptxin.sequence);
      // Fill up the info from our signed PSBT so we can sign and compute fees.
      const s = next.signed;
      if (s.nonWitnessUtxo) pin.nonWitnessUtxo = s.nonWitnessUtxo;
      if (s.witnessUtxo) pin.witnessUtxo = s.witnessUtxo;
      if (s.bip32Derivation) pin.bip32Derivation = s.bip32Derivation;
      if (s.tapBip32Derivation) pin.tapBip32Derivation = s.tapBip32Derivation;
      if (s.tapInternalKey) pin.tapInternalKey = s.tapInternalKey;
      if (s.redeemScript) pin.redeemScript = s.redeemScript;
      if (s.witnessScript) pin.witnessScript = s.witnessScript;
    } else {
      if (!isFinalized(pin)) throw new PayjoinSenderError('The receiver did not finalize one of their inputs');
      if (!pin.nonWitnessUtxo && !pin.witnessUtxo) throw new PayjoinSenderError('The receiver did not specify non_witness_utxo or witness_utxo for one of their inputs');
      sequences.add(ptxin.sequence);
    }
  });
  if (queue !== ourInputs.length) throw new PayjoinSenderError('Some of our inputs are not included in the proposal');
  if (sequences.size !== 1) throw new PayjoinSenderError('Mixed sequence detected in the proposal');

  // ── fee ─────────────────────────────────────────────────────────────────────
  const newFee = psbtFee(proposal);
  const additionalFee = newFee - ctx.originalFee;
  if (additionalFee < 0) throw new PayjoinSenderError('The receiver decreased absolute fee');

  // ── outputs ─────────────────────────────────────────────────────────────────
  const ourOutputs = originalTx.outs.map((txout, k) => ({ txout, signed: signedPsbt.data.outputs[k]! }));
  let oq = 0;
  proposal.data.outputs.forEach((pout, k) => {
    if (pout.bip32Derivation?.length || pout.tapBip32Derivation?.length) throw new PayjoinSenderError('The receiver added keypaths to an output');
    const ptxout = proposalTx.outs[k]!;
    const orig = ourOutputs[oq];
    if (!orig) return;
    const isOriginal = scriptEq(orig.txout.script, ptxout.script);
    const isPayment = ctx.paymentScript !== undefined && scriptEq(orig.txout.script, ctx.paymentScript);
    const substituted = !isOriginal && ctx.allowOutputSubstitution && isPayment;
    if (!isOriginal && !substituted) return;
    oq++;
    if (feeOutput !== undefined && orig.txout === feeOutput) {
      const actualContribution = Number(feeOutput.value) - Number(ptxout.value);
      if (actualContribution > params.maxAdditionalFeeContribution!) throw new PayjoinSenderError('The actual contribution is more than maxadditionalfeecontribution');
      if (actualContribution > additionalFee) throw new PayjoinSenderError('The actual contribution is not only paying fee');
      const additionalInputs = proposalTx.ins.length - originalTx.ins.length;
      if (actualContribution > ctx.originalFeeRate * 110 * additionalInputs) throw new PayjoinSenderError('The actual contribution is not only paying for additional inputs');
    } else if (ctx.allowOutputSubstitution && isPayment) {
      // That's the payment output, the receiver may have changed it.
    } else if (Number(orig.txout.value) > Number(ptxout.value)) {
      throw new PayjoinSenderError('The receiver decreased the value of one of the outputs');
    }
    if (orig.signed.bip32Derivation) pout.bip32Derivation = orig.signed.bip32Derivation;
    if (orig.signed.tapBip32Derivation) pout.tapBip32Derivation = orig.signed.tapBip32Derivation;
    if (orig.signed.redeemScript) pout.redeemScript = orig.signed.redeemScript;
    if (orig.signed.witnessScript) pout.witnessScript = orig.signed.witnessScript;
  });
  if (oq !== ourOutputs.length) {
    const remaining = ourOutputs.slice(oq);
    const onlyPaymentMissing = ctx.allowOutputSubstitution && remaining.length === 1 && ctx.paymentScript !== undefined && scriptEq(remaining[0]!.txout.script, ctx.paymentScript);
    if (!onlyPaymentMissing) throw new PayjoinSenderError('Some of our outputs are not included in the proposal');
  }
  return proposal;
}

/** After signing: enforce `minfeerate` on the final transaction (BIP78 last checklist item). */
export function checkMinFeeRate(ctx: SenderContext, finalTx: Transaction, fee: number): void {
  if (ctx.params.minFeeRate !== undefined && fee / finalTx.virtualSize() < ctx.params.minFeeRate) {
    throw new PayjoinSenderError(`payjoin fee rate below minfeerate ${ctx.params.minFeeRate}`);
  }
}
