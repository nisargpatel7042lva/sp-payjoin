/**
 * Sender side of BIP352 on top of @silent-pay/core, with two fixes the raw
 * library needs: private keys are summed here (mod n, with taproot parity
 * negation) so an intermediate zero sum cannot throw, and outputs are returned
 * as real scriptPubKeys (the library returns the 33-byte key in `script`).
 */
import * as ecc from 'tiny-secp256k1';
import { createOutputs, type Outpoint } from '@silent-pay/core';
import { networks, type Network } from 'bitcoinjs-lib';
import { smallestOutpoint } from './inputs.js';

const N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
const toBig = (b: Uint8Array) => BigInt('0x' + Buffer.from(b).toString('hex'));
const fromBig = (n: bigint) => new Uint8Array(Buffer.from(n.toString(16).padStart(64, '0'), 'hex'));

export interface SpInputKey { priv: Uint8Array; isTaproot: boolean }

/** a = Σ a_i (mod n), negating taproot keys whose point has odd Y (BIP352 §Sending). */
export function sumInputPrivateKeys(keys: SpInputKey[]): Uint8Array | undefined {
  let acc = 0n;
  for (const k of keys) {
    let d = toBig(k.priv);
    if (k.isTaproot && ecc.pointFromScalar(k.priv, true)![0] === 0x03) d = N - d;
    acc = (acc + d) % N;
  }
  return acc === 0n ? undefined : fromBig(acc);
}

export interface SpPayment { address: string; amountSat: number }
export interface SpOutput { scriptPubKey: Uint8Array; xOnly: Uint8Array; amountSat: number; address: string }

export interface SpSendParams {
  /** Private keys of the inputs that contribute to the derivation (BIP352 §Inputs). */
  keys: SpInputKey[];
  /** Outpoints of ALL transaction inputs — the smallest one is part of the derivation even if it contributes no key. */
  outpoints: Outpoint[];
  payments: SpPayment[];
  network?: Network;
}

/** Derives P2TR outputs for silent-payment recipients. */
export function silentPaymentOutputs(p: SpSendParams): SpOutput[] {
  const a = sumInputPrivateKeys(p.keys);
  if (!a) throw new Error('input private keys sum to zero');
  const outpoint = smallestOutpoint(p.outpoints);
  const outs = createOutputs([{ key: Buffer.from(a).toString('hex'), isXOnly: false }], outpoint, p.payments.map((x) => ({ address: x.address, amount: x.amountSat })), p.network ?? networks.regtest);
  // createOutputs groups by scan key and preserves per-group order; map back to the payments by position.
  return outs.map((o, i) => {
    const xOnly = o.script.slice(1);
    return { scriptPubKey: new Uint8Array([0x51, 0x20, ...xOnly]), xOnly, amountSat: o.value, address: p.payments[i]?.address ?? '' };
  });
}
