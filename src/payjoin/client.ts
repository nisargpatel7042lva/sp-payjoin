/**
 * Sender orchestration: original PSBT → POST → verify proposal → sign → broadcast.
 * On any endpoint/verification failure the sender falls back to broadcasting the
 * original transaction (BIP78: the original MUST be broadcastable).
 */
import { Psbt, Transaction } from 'bitcoinjs-lib';
import { parseDestination, type Destination } from './uri.js';
import { buildRequestUrl, checkMinFeeRate, createSenderContext, verifyAndFillProposal, type SenderOptionalParams } from './sender.js';
import { postOriginalPsbt } from './http.js';
import { buildPsbt, extractTx, finalizePsbt, signPsbtInput } from '../wallet/psbt-wallet.js';
import { finalizedTx, psbtFee } from './psbt-utils.js';
import type { KeyedUtxo, TxOut } from '../wallet/simple.js';
import { address as baddress, networks, type Network } from 'bitcoinjs-lib';
import { silentPaymentOutputs } from '../sp/send.js';

export interface PayjoinSendParams {
  /** Bare SP address, bare on-chain address, or BIP21 URI (with or without `pj=`). */
  uri: string | Destination;
  inputs: KeyedUtxo[];
  /**
   * Outputs in order. For a silent-payment URI, put a placeholder `{ sp: true, valueSat }` at the
   * payment position: the P2TR script is derived from `inputs` (BIP352) before signing.
   */
  outputs: Array<TxOut | { sp: true; valueSat: number }>;
  paymentOutputIndex: number;
  params?: SenderOptionalParams;
  network?: Network;
  broadcast(txHex: string): Promise<string>;
  log?: (s: string) => void;
}

export interface PayjoinSendResult {
  txid: string;
  payjoin: boolean;           // false → original broadcast (fallback)
  tx: Transaction;
  originalTxid: string;
  originalBase64: string;
  proposalBase64?: string;
  reason?: string;
}

export async function payWithPayjoin(p: PayjoinSendParams): Promise<PayjoinSendResult> {
  const uri = typeof p.uri === 'string' ? parseDestination(p.uri) : p.uri;
  const log = p.log ?? (() => {});
  const network = p.network ?? networks.regtest;
  // Resolve silent-payment placeholders: derive the BIP352 output(s) from our inputs.
  let outputs: TxOut[];
  if (uri.sp) {
    const spOuts = silentPaymentOutputs({
      keys: p.inputs.map((u) => ({ priv: u.priv, isTaproot: u.type === 'p2tr' })),
      outpoints: p.inputs.map((u) => ({ txid: u.txid, vout: u.vout })),
      payments: p.outputs.filter((o): o is { sp: true; valueSat: number } => 'sp' in o).map((o) => ({ address: uri.sp!, amountSat: o.valueSat })),
      network,
    });
    let k = 0;
    outputs = p.outputs.map((o) => ('sp' in o ? { scriptPubKey: spOuts[k++]!.scriptPubKey, valueSat: o.valueSat } : o));
    log(`silent payment: derived ${spOuts.length} P2TR output(s) for ${uri.sp.slice(0, 14)}… from ${p.inputs.length} input(s)`);
  } else {
    if (p.outputs.some((o) => 'sp' in o)) throw new Error('sp placeholder output but URI has no silent payment address');
    outputs = p.outputs as TxOut[];
  }
  const paymentScript = uri.address ? new Uint8Array(baddress.toOutputScript(uri.address, network)) : outputs[p.paymentOutputIndex]!.scriptPubKey;

  // 1. signed (unfinalized) PSBT, as a normal wallet would prepare to pay.
  const signed = buildPsbt(p.inputs, outputs);
  p.inputs.forEach((u, k) => signPsbtInput(signed, k, u));
  const params: SenderOptionalParams = p.params ?? {};
  const ctx = createSenderContext(signed, uri, paymentScript, params);
  const originalTx = finalizedTx(ctx.originalPsbt);
  const originalBase64 = ctx.originalPsbt.toBase64();
  log(`original tx ${originalTx.getId()} fee ${ctx.originalFee} sat (${ctx.originalFeeRate.toFixed(2)} sat/vB), ${originalTx.ins.length} in / ${originalTx.outs.length} out`);

  // 2. POST to the payjoin endpoint; fall back to the original whenever payjoin
  //    is not possible — no endpoint advertised, endpoint down, or a bad proposal.
  //    The original is a complete payment on its own (and, for an `sp=` destination,
  //    a normal silent payment), so the payer never has to choose a protocol.
  if (!uri.pj) {
    log('receiver advertises no payjoin endpoint; sending directly');
    const txid = await p.broadcast(originalTx.toHex());
    return { txid, payjoin: false, tx: originalTx, originalTxid: originalTx.getId(), originalBase64, reason: 'no payjoin endpoint advertised' };
  }
  let proposalBase64: string;
  try {
    proposalBase64 = await postOriginalPsbt(buildRequestUrl(uri.pj, params), originalBase64);
  } catch (e) {
    log(`payjoin request failed (${(e as Error).message}); broadcasting original`);
    const txid = await p.broadcast(originalTx.toHex());
    return { txid, payjoin: false, tx: originalTx, originalTxid: originalTx.getId(), originalBase64, reason: (e as Error).message };
  }

  // 3. verify + fill, 4. sign our inputs, finalize, broadcast.
  let proposal: Psbt;
  try {
    proposal = verifyAndFillProposal(ctx, proposalBase64);
  } catch (e) {
    log(`proposal rejected (${(e as Error).message}); broadcasting original`);
    const txid = await p.broadcast(originalTx.toHex());
    return { txid, payjoin: false, tx: originalTx, originalTxid: originalTx.getId(), originalBase64, proposalBase64, reason: (e as Error).message };
  }
  const ours = new Map(p.inputs.map((u) => [`${u.txid}:${u.vout}`, u]));
  proposal.txInputs.forEach((i, k) => {
    const key = `${Buffer.from(i.hash).reverse().toString('hex')}:${i.index}`;
    const u = ours.get(key);
    if (u) signPsbtInput(proposal, k, u); // never sign anything that was not in the original
  });
  finalizePsbt(proposal);
  const tx = extractTx(proposal);
  checkMinFeeRate(ctx, tx, psbtFee(proposal));
  const txid = await p.broadcast(tx.toHex());
  log(`payjoin tx ${txid} fee ${psbtFee(proposal)} sat, ${tx.ins.length} in / ${tx.outs.length} out`);
  return { txid, payjoin: tx.ins.length > originalTx.ins.length, tx, originalTxid: originalTx.getId(), originalBase64, proposalBase64 };
}
