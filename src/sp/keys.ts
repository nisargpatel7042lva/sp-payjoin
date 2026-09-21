/** Silent-payment receiver keys and spending-key derivation (BIP352), on top of @silent-pay/core. */
import * as ecc from 'tiny-secp256k1';
import { randomBytes } from 'node:crypto';
import { networks, type Network } from 'bitcoinjs-lib';
import { encodeSilentPaymentAddress, decodeSilentPaymentAddress, scanOutputs, createTaggedHash } from '@silent-pay/core';

export interface SpReceiverKeys { scanPriv: Uint8Array; spendPriv: Uint8Array; scanPub: Uint8Array; spendPub: Uint8Array }

export function newReceiverKeys(scanPriv = randomBytes(32), spendPriv = randomBytes(32)): SpReceiverKeys {
  return { scanPriv: new Uint8Array(scanPriv), spendPriv: new Uint8Array(spendPriv), scanPub: ecc.pointFromScalar(scanPriv, true)!, spendPub: ecc.pointFromScalar(spendPriv, true)! };
}

export const spAddress = (k: SpReceiverKeys, network: Network = networks.regtest): string =>
  encodeSilentPaymentAddress(k.scanPub, k.spendPub, network);

export const decodeSp = (address: string, network: Network = networks.regtest) => decodeSilentPaymentAddress(address, network);

export interface SpMatch { vout: number; xOnly: Uint8Array; tweak: Uint8Array }

/**
 * Scans a transaction's taproot outputs for payments to these keys.
 * `sumPubkeys`/`inputHash` come from `derivationContext`.
 */
export function scanTx(keys: SpReceiverKeys, sumPubkeys: Uint8Array, inputHash: Uint8Array, outputs: Array<{ vout: number; scriptPubKeyHex: string }>): SpMatch[] {
  const taproot = outputs.filter((o) => o.scriptPubKeyHex.length === 68 && o.scriptPubKeyHex.startsWith('5120'));
  const candidates = taproot.map((o) => new Uint8Array(Buffer.from('02' + o.scriptPubKeyHex.slice(4), 'hex')));
  // @silent-pay/core's secp256k1 backend tweaks private keys IN PLACE (privateKeyTweakMul mutates
  // its argument), so pass copies or the wallet's scan key is corrupted after the first scan.
  const matches = scanOutputs(new Uint8Array(keys.scanPriv), new Uint8Array(keys.spendPub), new Uint8Array(sumPubkeys), new Uint8Array(inputHash), candidates);
  const out: SpMatch[] = [];
  for (const [pubHex, tweak] of matches) {
    const o = taproot.find((t) => t.scriptPubKeyHex.slice(4) === pubHex.slice(2))!;
    out.push({ vout: o.vout, xOnly: new Uint8Array(Buffer.from(pubHex.slice(2), 'hex')), tweak });
  }
  return out.sort((a, b) => a.vout - b.vout);
}

/** d = b_spend + t_k (mod n). BIP340 signing handles Y-parity. */
export function spendingKey(keys: SpReceiverKeys, tweak: Uint8Array): Uint8Array {
  const d = ecc.privateAdd(keys.spendPriv, tweak);
  if (!d) throw new Error('invalid spending key');
  return d;
}

/**
 * Receiver-side derivation of the k-th output for a given input set:
 *   ecdh = b_scan · input_hash · A_sum ;  t_k = hash_BIP0352/SharedSecret(ecdh ‖ ser32(k)) ;  P_k = B_spend + t_k·G
 * Used to (re)build the output when the input set changes (PayJoin output substitution).
 */
export function deriveOutput(keys: SpReceiverKeys, sumPubkeys: Uint8Array, inputHash: Uint8Array, k: number): { xOnly: Uint8Array; scriptPubKey: Uint8Array; tweak: Uint8Array } {
  const step = ecc.pointMultiply(sumPubkeys, inputHash, true);
  const ecdh = step && ecc.pointMultiply(step, keys.scanPriv, true);
  if (!ecdh) throw new Error('ecdh at infinity');
  const ser32 = new Uint8Array([(k >>> 24) & 0xff, (k >>> 16) & 0xff, (k >>> 8) & 0xff, k & 0xff]);
  const tweak = createTaggedHash('BIP0352/SharedSecret', new Uint8Array([...ecdh, ...ser32]));
  const P = ecc.pointAddScalar(keys.spendPub, tweak, true);
  if (!P) throw new Error('output at infinity');
  const xOnly = P.slice(1);
  return { xOnly, scriptPubKey: new Uint8Array([0x51, 0x20, ...xOnly]), tweak };
}
