/**
 * BIP352 "Inputs For Shared Secret Derivation": which inputs contribute a
 * public key, how to extract it, and the outpoint ordering rule. Wraps
 * @silent-pay/core, which takes the already-extracted keys.
 */
import * as ecc from 'tiny-secp256k1';
import { createHash } from 'node:crypto';
import { createInputHash, type Outpoint } from '@silent-pay/core';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytes = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

/** BIP341 NUMS point H: taproot outputs whose internal key is H have no key path and are skipped. */
export const NUMS_H = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';

export interface TxInputView {
  txid: string; vout: number;
  scriptSigHex: string;
  witness: string[];
  prevoutScriptPubKeyHex: string;
}

const isP2PKH = (spk: Uint8Array) => spk.length === 25 && spk[0] === 0x76 && spk[1] === 0xa9 && spk[2] === 0x14 && spk[23] === 0x88 && spk[24] === 0xac;
const isP2SH = (spk: Uint8Array) => spk.length === 23 && spk[0] === 0xa9 && spk[1] === 0x14 && spk[22] === 0x87;
const isP2WPKH = (spk: Uint8Array) => spk.length === 22 && spk[0] === 0x00 && spk[1] === 0x14;
const isP2TR = (spk: Uint8Array) => spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20;

function hash160(b: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('ripemd160').update(createHash('sha256').update(b).digest()).digest());
}

/** Parses the pushes of a scriptSig (only what P2PKH / P2SH-P2WPKH need). */
function scriptPushes(script: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []; let i = 0;
  while (i < script.length) {
    const op = script[i++]!;
    let len = 0;
    if (op >= 1 && op <= 75) len = op;
    else if (op === 0x4c) { len = script[i++]!; }
    else if (op === 0x4d) { len = script[i]! | (script[i + 1]! << 8); i += 2; }
    else continue;
    out.push(script.slice(i, i + len)); i += len;
  }
  return out;
}

/**
 * Returns the 33-byte compressed public key this input contributes, or
 * undefined if the input type is excluded from the derivation (BIP352 §Inputs).
 */
export function inputPublicKey(input: TxInputView): Uint8Array | undefined {
  const spk = bytes(input.prevoutScriptPubKeyHex);
  const scriptSig = bytes(input.scriptSigHex);
  const witness = input.witness.map(bytes);

  if (isP2TR(spk)) {
    // Script path spend with NUMS internal key → skip; otherwise the output key (assume even Y).
    if (witness.length >= 2) {
      const last = witness[witness.length - 1]!;
      const hasAnnex = last[0] === 0x50 && witness.length >= 2;
      const stack = hasAnnex ? witness.slice(0, -1) : witness;
      if (stack.length >= 2) {
        const control = stack[stack.length - 1]!;
        if ((control.length - 1) % 32 === 0 && hex(control.slice(1, 33)) === NUMS_H) return undefined;
      }
    }
    return new Uint8Array([0x02, ...spk.slice(2)]);
  }
  if (isP2WPKH(spk)) {
    const pk = witness[1];
    return pk && pk.length === 33 ? pk : undefined;
  }
  if (isP2SH(spk)) {
    // Only P2SH-P2WPKH: redeemScript is the last scriptSig push and must be 0014{20}.
    const pushes = scriptPushes(scriptSig);
    const redeem = pushes[pushes.length - 1];
    if (redeem && isP2WPKH(redeem) && witness[1]?.length === 33) return witness[1];
    return undefined;
  }
  if (isP2PKH(spk)) {
    // Scan scriptSig pushes for the compressed key whose hash160 matches (malleability-safe, per BIP).
    const target = hex(spk.slice(3, 23));
    for (const p of scriptPushes(scriptSig)) if (p.length === 33 && hex(hash160(p)) === target) return p;
    return undefined;
  }
  return undefined;
}

/** Sum of contributing input public keys (compressed, 33 bytes). Undefined if none contribute. */
export function sumInputPublicKeys(keys: Uint8Array[]): Uint8Array | undefined {
  // An intermediate sum may hit the point at infinity (tiny-secp256k1 returns null);
  // only a *final* infinity means "no key" (BIP352 vector: intermediate zero, final non-zero).
  let acc: Uint8Array | null = null;
  for (const k of keys) acc = acc === null ? k : ecc.pointAdd(acc, k, true);
  return acc ?? undefined;
}

/** Lexicographically smallest outpoint by serialized (txid LE || vout LE) bytes. */
export function smallestOutpoint(outpoints: Outpoint[]): Outpoint {
  const ser = (o: Outpoint) => Buffer.concat([Buffer.from(o.txid, 'hex').reverse(), Buffer.from(new Uint32Array([o.vout]).buffer)]);
  return outpoints.slice().sort((a, b) => Buffer.compare(ser(a), ser(b)))[0]!;
}

/** Everything the receiver needs from a transaction to scan it. */
export function derivationContext(inputs: TxInputView[]): { sumPubkeys: Uint8Array; inputHash: Uint8Array; outpoint: Outpoint } | undefined {
  const keys = inputs.map(inputPublicKey).filter((k): k is Uint8Array => k !== undefined);
  const sumPubkeys = sumInputPublicKeys(keys);
  if (!sumPubkeys) return undefined;
  const outpoint = smallestOutpoint(inputs.map((i) => ({ txid: i.txid, vout: i.vout })));
  return { sumPubkeys, inputHash: createInputHash(sumPubkeys, outpoint), outpoint };
}
