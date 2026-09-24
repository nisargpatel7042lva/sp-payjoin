/**
 * BIP78 receiver. Wallet-specific concerns (chain access, ownership, coin
 * selection, signing) are injected as hooks so the protocol logic stays pure.
 */
import { Psbt, Transaction } from 'bitcoinjs-lib';
import { randomInt } from 'node:crypto';
import { PayjoinReceiverError } from './errors.js';
import { finalizedTx, inputValue, isFinalized, psbtFee, unsignedTx, witnessFromBytes } from './psbt-utils.js';
import type { KeyedUtxo } from '../wallet/simple.js';

export interface ReceiverHooks {
  /** Non-interactive receivers must check the original tx is broadcastable (probing defence). */
  isBroadcastable(txHex: string): Promise<boolean>;
  /** Is this scriptPubKey ours? Used to reject our own inputs (and, without `identifyOutputs`, to find our outputs). */
  isOwnedScript(scriptPubKey: Uint8Array): Promise<boolean> | boolean;
  /**
   * Optional: which outputs of the original pay us, given the whole transaction.
   * Silent-payment receivers need the inputs to recognise their outputs.
   */
  identifyOutputs?(ctx: { inputs: ProposalInput[]; outputs: Array<{ index: number; scriptPubKey: Uint8Array; valueSat: number }> }): Promise<number[]> | number[];
  /** Probing / reentrancy defence: has this outpoint been seen in a previous original PSBT? */
  inputSeenBefore(outpoint: string): Promise<boolean> | boolean;
  markInputSeen(outpoint: string): Promise<void> | void;
  /**
   * The input to contribute. `exposed` lists outpoints already revealed to some
   * sender; BIP78 asks receivers to re-offer those in priority so that a prober
   * who never broadcasts cannot walk the wallet one UTXO at a time.
   */
  selectInput(original: Transaction, exposed: readonly string[]): Promise<KeyedUtxo | undefined> | KeyedUtxo | undefined;
  /** Sign + finalize our input at `idx` in the proposal PSBT. */
  signInput(psbt: Psbt, idx: number, utxo: KeyedUtxo): Promise<void> | void;
  /**
   * Optional: payment output substitution (BIP78 §"Payment output substitution").
   * Called once per output of ours with the FINAL input set (ours included, in final order);
   * returns a replacement scriptPubKey or undefined to keep it.
   */
  substituteOutput?(ctx: { index: number; ourOutputs: number[]; script: Uint8Array; valueSat: number; inputs: ProposalInput[] }): Promise<Uint8Array | undefined> | Uint8Array | undefined;
}

/** An input as the receiver sees it: outpoint, prevout script, and (for the sender's inputs) the original witness/scriptSig. */
export interface ProposalInput { txid: string; vout: number; scriptPubKey: Uint8Array; witness: string[]; scriptSigHex: string; ours: boolean }

export interface ReceiverOptions {
  supportedVersions?: number[];
  dustSat?: number;
  /** Deterministic insertion index (tests). */
  randomIndex?: (n: number) => number;
  /** Outpoints already revealed to senders; shared across requests (and persistable). */
  exposedInputs?: Set<string>;
}

export interface OriginalRequest { psbtBase64: string; query: URLSearchParams }

export interface ProposalResult {
  proposalBase64: string;
  contributed: KeyedUtxo;
  ourInputIndex: number;
  ourOutputIndex: number;
  feeContributionSat: number;   // taken from the sender's fee output
  receiverFeeSat: number;       // paid by us (deducted from our output)
  originalFeeSat: number;
  proposalFeeSat: number;
}

export class PayjoinReceiver {
  private readonly versions: number[];
  private readonly dust: number;
  private readonly randomIndex: (n: number) => number;
  /** Outpoints this receiver has already shown to a sender (BIP78 probing mitigation). */
  readonly exposedInputs: Set<string>;
  constructor(private readonly hooks: ReceiverHooks, opts: ReceiverOptions = {}) {
    this.versions = opts.supportedVersions ?? [1];
    this.dust = opts.dustSat ?? 546;
    this.randomIndex = opts.randomIndex ?? ((n) => randomInt(0, n + 1));
    this.exposedInputs = opts.exposedInputs ?? new Set<string>();
  }

  async handle(req: OriginalRequest): Promise<ProposalResult> {
    const q = req.query;
    const v = Number(q.get('v') ?? '1');
    if (!this.versions.includes(v)) throw new PayjoinReceiverError('version-unsupported', 'The version is not supported anymore', this.versions);

    let original: Psbt;
    try { original = Psbt.fromBase64(req.psbtBase64); } catch { throw new PayjoinReceiverError('original-psbt-rejected', 'invalid PSBT'); }
    if (original.data.inputs.length === 0 || !original.data.inputs.every(isFinalized)) throw new PayjoinReceiverError('original-psbt-rejected', 'original PSBT must be finalized');
    for (let k = 0; k < original.data.inputs.length; k++) if (inputValue(original, k) === undefined) throw new PayjoinReceiverError('original-psbt-rejected', 'missing witness_utxo/non_witness_utxo');

    const originalTx = finalizedTx(original);
    if (!(await this.hooks.isBroadcastable(originalTx.toHex()))) throw new PayjoinReceiverError('original-psbt-rejected', 'original transaction is not broadcastable');

    // ── receiver's original PSBT checklist ──────────────────────────────────
    const prevScripts = original.data.inputs.map((i) => new Uint8Array(i.witnessUtxo!.script));
    for (let k = 0; k < originalTx.ins.length; k++) {
      const op = `${Buffer.from(originalTx.ins[k]!.hash).reverse().toString('hex')}:${originalTx.ins[k]!.index}`;
      if (await this.hooks.isOwnedScript(prevScripts[k]!)) throw new PayjoinReceiverError('original-psbt-rejected', 'original PSBT spends an input owned by the receiver');
      if (await this.hooks.inputSeenBefore(op)) throw new PayjoinReceiverError('original-psbt-rejected', 'input seen before');
    }
    for (let k = 0; k < originalTx.ins.length; k++) await this.hooks.markInputSeen(`${Buffer.from(originalTx.ins[k]!.hash).reverse().toString('hex')}:${originalTx.ins[k]!.index}`);

    const originalInputs: ProposalInput[] = originalTx.ins.map((i, k) => ({ txid: Buffer.from(i.hash).reverse().toString('hex'), vout: i.index, scriptPubKey: prevScripts[k]!, witness: i.witness.map((w) => Buffer.from(w).toString('hex')), scriptSigHex: Buffer.from(i.script).toString('hex'), ours: false }));
    let ourOutputs: number[] = [];
    if (this.hooks.identifyOutputs) {
      ourOutputs = [...(await this.hooks.identifyOutputs({ inputs: originalInputs, outputs: originalTx.outs.map((o, k) => ({ index: k, scriptPubKey: new Uint8Array(o.script), valueSat: Number(o.value) })) }))].sort((a, b) => a - b);
    } else {
      for (let k = 0; k < originalTx.outs.length; k++) if (await this.hooks.isOwnedScript(originalTx.outs[k]!.script)) ourOutputs.push(k);
    }
    if (ourOutputs.length === 0) throw new PayjoinReceiverError('original-psbt-rejected', 'no output pays the receiver');
    const ourOutputIndex = ourOutputs[0]!;

    // ── fee parameters from the sender ──────────────────────────────────────
    const originalFee = psbtFee(original);
    const originalVsize = originalTx.virtualSize();
    const originalFeeRate = originalFee / originalVsize;
    let feeOutputIndex: number | undefined; let maxContribution = 0;
    const afoi = q.get('additionalfeeoutputindex'); const mafc = q.get('maxadditionalfeecontribution');
    if (afoi !== null && mafc !== null) {
      const idx = Number(afoi); const max = Number(mafc);
      if (Number.isInteger(idx) && idx >= 0 && idx < originalTx.outs.length && idx !== ourOutputIndex && Number.isFinite(max) && max > 0) { feeOutputIndex = idx; maxContribution = Math.floor(max); }
    }
    const minFeeRate = q.get('minfeerate') !== null ? Number(q.get('minfeerate')) : 0;
    const disableSubstitution = q.get('disableoutputsubstitution') === 'true';

    // ── contribute an input ─────────────────────────────────────────────────
    const contributed = await this.hooks.selectInput(originalTx, [...this.exposedInputs]);
    if (!contributed) throw new PayjoinReceiverError('unavailable', 'no input available to contribute');
    // Revealed the moment the proposal leaves; a prober learns nothing new by asking again.
    this.exposedInputs.add(`${contributed.txid}:${contributed.vout}`);
    const ourInputIndex = this.randomIndex(originalTx.ins.length);
    const sequence = originalTx.ins[0]!.sequence;

    // ── output substitution (optional) ──────────────────────────────────────
    const scripts = new Map<number, Uint8Array>(ourOutputs.map((k) => [k, new Uint8Array(originalTx.outs[k]!.script)]));
    if (!disableSubstitution && this.hooks.substituteOutput) {
      const inputs = [...originalInputs];
      inputs.splice(ourInputIndex, 0, { txid: contributed.txid, vout: contributed.vout, scriptPubKey: new Uint8Array(contributed.scriptPubKey), witness: [], scriptSigHex: '', ours: true });
      for (const k of ourOutputs) {
        const replacement = await this.hooks.substituteOutput({ index: k, ourOutputs, script: scripts.get(k)!, valueSat: Number(originalTx.outs[k]!.value), inputs });
        if (replacement) scripts.set(k, replacement);
      }
    }

    // ── build the proposal ──────────────────────────────────────────────────
    const build = (ourOutputValue: number, feeOutputValue?: number): Psbt => {
      const p = new Psbt();
      p.setVersion(originalTx.version); p.setLocktime(originalTx.locktime);
      const ins = originalTx.ins.map((i, k) => ({ hash: Buffer.from(i.hash), index: i.index, sequence: i.sequence, witnessUtxo: original.data.inputs[k]!.witnessUtxo! }));
      ins.splice(ourInputIndex, 0, { hash: Buffer.from(contributed.txid, 'hex').reverse(), index: contributed.vout, sequence, witnessUtxo: { script: Buffer.from(contributed.scriptPubKey), value: contributed.valueSat } });
      for (const i of ins) p.addInput({ hash: i.hash, index: i.index, sequence: i.sequence, witnessUtxo: { script: Buffer.from(i.witnessUtxo.script), value: Number(i.witnessUtxo.value) } });
      originalTx.outs.forEach((o, k) => {
        const value = k === ourOutputIndex ? ourOutputValue : k === feeOutputIndex && feeOutputValue !== undefined ? feeOutputValue : Number(o.value);
        p.addOutput({ script: Buffer.from(scripts.get(k) ?? o.script), value });
      });
      return p;
    };

    // Size the final tx: our input signed for real, sender inputs with their original (soon-invalid) witnesses as size stand-ins.
    const sizing = build(Number(originalTx.outs[ourOutputIndex]!.value) + contributed.valueSat);
    await this.hooks.signInput(sizing, ourInputIndex, contributed);
    const sizingTx = unsignedTx(sizing);
    originalTx.ins.forEach((i, k) => { sizingTx.ins[k < ourInputIndex ? k : k + 1]!.witness = i.witness; sizingTx.ins[k < ourInputIndex ? k : k + 1]!.script = i.script; });
    sizingTx.ins[ourInputIndex]!.witness = witnessFromBytes(sizing.data.inputs[ourInputIndex]!.finalScriptWitness!);
    const newVsize = sizingTx.virtualSize();

    let additionalFee = Math.ceil(originalFeeRate * (newVsize - originalVsize));
    if (minFeeRate > 0) additionalFee = Math.max(additionalFee, Math.ceil(minFeeRate * newVsize) - originalFee);
    const feeContribution = feeOutputIndex !== undefined ? Math.min(maxContribution, additionalFee, Math.floor(originalFeeRate * 110), Number(originalTx.outs[feeOutputIndex]!.value) - this.dust) : 0;
    const receiverFee = additionalFee - Math.max(0, feeContribution);
    const ourOutputValue = Number(originalTx.outs[ourOutputIndex]!.value) + contributed.valueSat - receiverFee;
    if (ourOutputValue < this.dust) throw new PayjoinReceiverError('not-enough-money', 'contributed input cannot cover the additional fee');

    const proposal = build(ourOutputValue, feeOutputIndex !== undefined ? Number(originalTx.outs[feeOutputIndex]!.value) - Math.max(0, feeContribution) : undefined);
    await this.hooks.signInput(proposal, ourInputIndex, contributed);
    if (!isFinalized(proposal.data.inputs[ourInputIndex]!)) throw new Error('signInput hook must finalize our input');
    proposal.data.inputs.forEach((i, k) => { if (k !== ourInputIndex && (isFinalized(i) || i.partialSig?.length)) throw new Error('sender inputs must not be finalized/signed'); });

    return {
      proposalBase64: proposal.toBase64(), contributed, ourInputIndex, ourOutputIndex,
      feeContributionSat: Math.max(0, feeContribution), receiverFeeSat: receiverFee, originalFeeSat: originalFee, proposalFeeSat: psbtFee(proposal),
    };
  }
}
