/**
 * Sender orchestration: original PSBT → POST → verify proposal → sign → broadcast.
 * On any endpoint/verification failure the sender falls back to broadcasting the
 * original transaction (BIP78: the original MUST be broadcastable).
 */
import { Psbt, Transaction } from 'bitcoinjs-lib';
import { parsePjUri, type PjUri } from './uri.js';
import { buildRequestUrl, checkMinFeeRate, createSenderContext, verifyAndFillProposal, type SenderOptionalParams } from './sender.js';
import { postOriginalPsbt } from './http.js';
import { buildPsbt, extractTx, finalizePsbt, signPsbtInput } from '../wallet/psbt-wallet.js';
import { finalizedTx, psbtFee } from './psbt-utils.js';
import type { KeyedUtxo, TxOut } from '../wallet/simple.js';
import { address as baddress, networks, type Network } from 'bitcoinjs-lib';

export interface PayjoinSendParams {
  uri: string | PjUri;
  inputs: KeyedUtxo[];
  /** The payment output (to the URI address) and any change/batch outputs, in the order they should appear. */
  outputs: TxOut[];
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
  const uri = typeof p.uri === 'string' ? parsePjUri(p.uri) : p.uri;
  const log = p.log ?? (() => {});
  const network = p.network ?? networks.regtest;
  const paymentScript = uri.address ? new Uint8Array(baddress.toOutputScript(uri.address, network)) : p.outputs[p.paymentOutputIndex]!.scriptPubKey;

  // 1. signed (unfinalized) PSBT, as a normal wallet would prepare to pay.
  const signed = buildPsbt(p.inputs, p.outputs);
  p.inputs.forEach((u, k) => signPsbtInput(signed, k, u));
  const params: SenderOptionalParams = p.params ?? {};
  const ctx = createSenderContext(signed, uri, paymentScript, params);
  const originalTx = finalizedTx(ctx.originalPsbt);
  const originalBase64 = ctx.originalPsbt.toBase64();
  log(`original tx ${originalTx.getId()} fee ${ctx.originalFee} sat (${ctx.originalFeeRate.toFixed(2)} sat/vB), ${originalTx.ins.length} in / ${originalTx.outs.length} out`);

  // 2. POST to the payjoin endpoint; fall back to the original on any failure.
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
