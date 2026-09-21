/**
 * Minimal key-holding wallet pieces for regtest: P2WPKH / P2TR keys, funding
 * via the miner, UTXO lookup, and signing. Bitcoin Core is only the chain
 * backend; all keys live here so BIP352 derivations can use them.
 */
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';
import { initEccLib, networks, payments, Psbt, Transaction, type Network } from 'bitcoinjs-lib';
import { randomBytes } from 'node:crypto';
import type { BitcoinRpc, DecodedTx } from '../chain/rpc.js';
import type { TxInputView } from '../sp/inputs.js';
import { spendingKey, type SpReceiverKeys } from '../sp/keys.js';

initEccLib(ecc);
const ECPair = ECPairFactory(ecc);
export const NET: Network = networks.regtest;

export interface Utxo { txid: string; vout: number; valueSat: number; scriptPubKey: Uint8Array }

export interface KeyedUtxo extends Utxo { priv: Uint8Array; type: 'p2wpkh' | 'p2tr'; /** for SP-derived outputs: full spending key already tweaked */ }

export class SimpleKey {
  readonly priv: Uint8Array;
  readonly pub: Uint8Array;
  constructor(priv: Uint8Array = randomBytes(32)) { this.priv = new Uint8Array(priv); this.pub = ecc.pointFromScalar(this.priv, true)!; }
  get p2wpkh() { return payments.p2wpkh({ pubkey: Buffer.from(this.pub), network: NET }); }
  /** Key-path-only P2TR (BIP86-style tweak with no script tree). */
  get p2tr() { return payments.p2tr({ internalPubkey: Buffer.from(this.pub.slice(1)), network: NET }); }
  /** Private key for the P2TR output key (internal key tweaked per BIP341, parity-adjusted). */
  get p2trPriv(): Uint8Array {
    const internal = this.pub.slice(1); // no script tree: tweak = H_TapTweak(internal)
    const t = taggedHash('TapTweak', internal);
    let d = this.priv;
    if (this.pub[0] === 0x03) d = ecc.privateNegate(d);
    return ecc.privateAdd(d, t)!;
  }
}

import { createHash } from 'node:crypto';
export function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  const th = createHash('sha256').update(tag).digest();
  return new Uint8Array(createHash('sha256').update(th).update(th).update(msg).digest());
}

export const toView = (tx: DecodedTx): TxInputView[] =>
  tx.vin.map((v) => ({ txid: v.txid, vout: v.vout, scriptSigHex: v.scriptSig.hex, witness: v.txinwitness ?? [], prevoutScriptPubKeyHex: v.prevout?.scriptPubKey.hex ?? '' }));

/** Fills prevout scriptPubKeys (getrawtransaction verbose=true omits them for non-mempool txs) */
export async function withPrevouts(rpc: BitcoinRpc, tx: DecodedTx): Promise<DecodedTx> {
  for (const v of tx.vin) {
    if (!v.prevout) { const p = await rpc.getRawTransaction(v.txid); const o = p.vout[v.vout]!; v.prevout = { value: o.value, scriptPubKey: { hex: o.scriptPubKey.hex } }; }
  }
  return tx;
}

/** Sends `btc` from the miner to `address`, mines a block, and returns the resulting UTXO. */
export async function fundAddress(rpc: BitcoinRpc, address: string, btc: number): Promise<Utxo> {
  const txid = await rpc.fund(address, btc);
  await rpc.mine(1);
  const tx = await rpc.getRawTransaction(txid);
  const vout = tx.vout.findIndex((o) => o.scriptPubKey.address === address);
  return { txid, vout, valueSat: Math.round(tx.vout[vout]!.value * 1e8), scriptPubKey: new Uint8Array(Buffer.from(tx.vout[vout]!.scriptPubKey.hex, 'hex')) };
}

export interface TxOut { scriptPubKey: Uint8Array; valueSat: number }

/**
 * Builds and fully signs a transaction spending `inputs` (P2WPKH keys or P2TR
 * outputs whose *output-key* private key is given) to `outputs`.
 * P2TR key-path signatures are produced manually (BIP340 over the sighash) so
 * silent-payment outputs (raw output key = P_k, no BIP341 tweak) can be spent.
 */
export function buildSignedTx(inputs: KeyedUtxo[], outputs: TxOut[], opts: { locktime?: number; sequence?: number } = {}): Transaction {
  const tx = new Transaction();
  tx.version = 2;
  tx.locktime = opts.locktime ?? 0;
  for (const i of inputs) tx.addInput(Buffer.from(i.txid, 'hex').reverse(), i.vout, opts.sequence ?? 0xffffffff);
  for (const o of outputs) tx.addOutput(Buffer.from(o.scriptPubKey), o.valueSat);
  const prevScripts = inputs.map((i) => Buffer.from(i.scriptPubKey));
  const prevValues = inputs.map((i) => i.valueSat);
  inputs.forEach((inp, idx) => {
    if (inp.type === 'p2wpkh') {
      const pub = Buffer.from(ecc.pointFromScalar(inp.priv, true)!);
      const scriptCode = payments.p2pkh({ pubkey: pub, network: NET }).output!;
      const hash = tx.hashForWitnessV0(idx, scriptCode, inp.valueSat, Transaction.SIGHASH_ALL);
      const sig = ECPair.fromPrivateKey(Buffer.from(inp.priv)).sign(hash);
      const der = Buffer.concat([require_bip66_encode(sig), Buffer.from([Transaction.SIGHASH_ALL])]);
      tx.setWitness(idx, [der, pub]);
    } else {
      const hash = tx.hashForWitnessV1(idx, prevScripts, prevValues, Transaction.SIGHASH_DEFAULT);
      const sig = ecc.signSchnorr(hash, inp.priv, randomBytes(32));
      tx.setWitness(idx, [Buffer.from(sig)]);
    }
  });
  return tx;
}

import { encode as bip66encode } from 'bip66';
function require_bip66_encode(sig64: Uint8Array): Buffer {
  const b = Buffer.from(sig64);
  const r = toDER(b.subarray(0, 32)); const s = toDER(b.subarray(32, 64));
  return Buffer.from(bip66encode(r, s));
}
function toDER(x: Buffer): Buffer { let i = 0; while (x[i] === 0 && i < x.length - 1) i++; const b = x.subarray(i); return b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b; }

/** A silent-payment output the receiver found, ready to spend. */
export function spUtxo(keys: SpReceiverKeys, tx: DecodedTx, vout: number, tweak: Uint8Array): KeyedUtxo {
  const o = tx.vout[vout]!;
  return { txid: tx.txid, vout, valueSat: Math.round(o.value * 1e8), scriptPubKey: new Uint8Array(Buffer.from(o.scriptPubKey.hex, 'hex')), priv: spendingKey(keys, tweak), type: 'p2tr' };
}

export { Psbt, Transaction };
