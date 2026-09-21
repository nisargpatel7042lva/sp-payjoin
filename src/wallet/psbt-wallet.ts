/**
 * PSBT construction and signing for wallet-held keys.
 *   P2WPKH inputs: signed through bitcoinjs (partialSig), finalizable by the standard finalizer.
 *   P2TR inputs:   BIP340 key-path signature computed here and written as finalScriptWitness
 *                  (covers silent-payment outputs whose output key is P_k with no BIP341 tweak).
 */
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';
import { Psbt, Transaction, initEccLib } from 'bitcoinjs-lib';
import { randomBytes } from 'node:crypto';
import type { KeyedUtxo, TxOut } from './simple.js';
import { unsignedTx, witnessToBytes } from '../payjoin/psbt-utils.js';

initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

export interface BuildPsbtOptions { sequence?: number; locktime?: number; version?: number }

/** Unsigned PSBT with witnessUtxo filled for every input. */
export function buildPsbt(inputs: KeyedUtxo[], outputs: TxOut[], opts: BuildPsbtOptions = {}): Psbt {
  const psbt = new Psbt();
  psbt.setVersion(opts.version ?? 2);
  psbt.setLocktime(opts.locktime ?? 0);
  for (const i of inputs) {
    psbt.addInput({ hash: i.txid, index: i.vout, sequence: opts.sequence ?? 0xfffffffd, witnessUtxo: { script: Buffer.from(i.scriptPubKey), value: i.valueSat } });
  }
  for (const o of outputs) psbt.addOutput({ script: Buffer.from(o.scriptPubKey), value: o.valueSat });
  return psbt;
}

/** Signs input `idx` with `utxo.priv` (partialSig for P2WPKH; finalized witness for P2TR). */
export function signPsbtInput(psbt: Psbt, idx: number, utxo: KeyedUtxo): void {
  if (utxo.type === 'p2wpkh') {
    psbt.signInput(idx, bufferSigner(utxo.priv));
    return;
  }
  const tx = unsignedTx(psbt);
  const prevScripts = psbt.data.inputs.map((i) => { if (!i.witnessUtxo) throw new Error('taproot signing needs witnessUtxo on every input'); return i.witnessUtxo.script; });
  const prevValues = psbt.data.inputs.map((i) => Number(i.witnessUtxo!.value));
  const hash = tx.hashForWitnessV1(idx, prevScripts, prevValues, Transaction.SIGHASH_DEFAULT);
  const sig = ecc.signSchnorr(hash, utxo.priv, randomBytes(32));
  psbt.updateInput(idx, { finalScriptWitness: witnessToBytes([sig]) });
}

/** Finalizes inputs that still need it (P2TR inputs are already final after signing). */
export function finalizePsbt(psbt: Psbt): Psbt {
  psbt.data.inputs.forEach((i, k) => { if (!i.finalScriptWitness && !i.finalScriptSig) psbt.finalizeInput(k); });
  return psbt;
}

export function extractTx(psbt: Psbt): Transaction { return psbt.extractTransaction(true); }

/** ecpair v3 returns Uint8Array signatures; bitcoinjs-lib v6 wants Buffers. */
function bufferSigner(priv: Uint8Array) {
  const kp = ECPair.fromPrivateKey(Buffer.from(priv));
  return { publicKey: Buffer.from(kp.publicKey), sign: (h: Buffer, lowR?: boolean) => Buffer.from(kp.sign(h, lowR)) };
}
