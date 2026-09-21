/** Silent-payment receiver keys and spending-key derivation (BIP352), on top of @silent-pay/core. */
import * as ecc from 'tiny-secp256k1';
import { randomBytes } from 'node:crypto';
import { networks, type Network } from 'bitcoinjs-lib';
import { encodeSilentPaymentAddress, decodeSilentPaymentAddress, scanOutputs } from '@silent-pay/core';

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
  const matches = scanOutputs(keys.scanPriv, keys.spendPub, sumPubkeys, inputHash, candidates);
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
