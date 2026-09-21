/** Small PSBT helpers over bitcoinjs-lib's Psbt for the BIP78 flows. */
import { Psbt, Transaction, script as bscript } from 'bitcoinjs-lib';
import type { Psbt as _P } from 'bitcoinjs-lib';
type PsbtInput = _P['data']['inputs'][number];

export const unsignedTx = (psbt: Psbt): Transaction => Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());

export const isFinalized = (i: PsbtInput): boolean => !!(i.finalScriptSig || i.finalScriptWitness);

/** Input value from witnessUtxo / nonWitnessUtxo; undefined if neither is present. */
export function inputValue(psbt: Psbt, idx: number): number | undefined {
  const i = psbt.data.inputs[idx]!;
  if (i.witnessUtxo) return Number(i.witnessUtxo.value);
  if (i.nonWitnessUtxo) { const t = Transaction.fromBuffer(i.nonWitnessUtxo); return Number(t.outs[psbt.txInputs[idx]!.index]!.value); }
  return undefined;
}

/** Absolute fee (sat). Throws if any input lacks utxo information. */
export function psbtFee(psbt: Psbt): number {
  let inSum = 0;
  for (let k = 0; k < psbt.data.inputs.length; k++) { const v = inputValue(psbt, k); if (v === undefined) throw new Error(`input ${k} has no utxo info`); inSum += v; }
  const outSum = psbt.txOutputs.reduce((a, o) => a + Number(o.value), 0);
  return inSum - outSum;
}

/** Serializes a witness stack into the PSBT `finalScriptWitness` encoding. */
export function witnessToBytes(stack: Uint8Array[]): Buffer {
  const parts: Buffer[] = [varint(stack.length)];
  for (const item of stack) parts.push(varint(item.length), Buffer.from(item));
  return Buffer.concat(parts);
}
export function witnessFromBytes(b: Buffer): Buffer[] {
  let o = 0; const rd = () => { const [n, len] = readVarint(b, o); o += len; return n; };
  const count = rd(); const out: Buffer[] = [];
  for (let k = 0; k < count; k++) { const len = rd(); out.push(b.subarray(o, o + len)); o += len; }
  return out;
}
function varint(n: number): Buffer {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b;
}
function readVarint(b: Buffer, o: number): [number, number] {
  const f = b[o]!; if (f < 0xfd) return [f, 1]; if (f === 0xfd) return [b.readUInt16LE(o + 1), 3]; return [b.readUInt32LE(o + 1), 5];
}

/** Transaction with all finalized witnesses applied (for vsize/txid of a finalized PSBT). */
export function finalizedTx(psbt: Psbt): Transaction {
  const tx = unsignedTx(psbt);
  psbt.data.inputs.forEach((i, k) => {
    if (i.finalScriptSig) tx.ins[k]!.script = i.finalScriptSig;
    if (i.finalScriptWitness) tx.ins[k]!.witness = witnessFromBytes(i.finalScriptWitness);
  });
  return tx;
}

export const scriptTypeOf = (spk: Uint8Array): string => {
  if (spk.length === 22 && spk[0] === 0 && spk[1] === 20) return 'p2wpkh';
  if (spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20) return 'p2tr';
  if (spk.length === 23 && spk[0] === 0xa9) return 'p2sh';
  if (spk.length === 25 && spk[0] === 0x76) return 'p2pkh';
  if (spk.length === 34 && spk[0] === 0 && spk[1] === 0x20) return 'p2wsh';
  return 'unknown';
};
export const scriptEq = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
export const outpointKey = (hash: Uint8Array, index: number) => `${Buffer.from(hash).toString('hex')}:${index}`;
void bscript;
