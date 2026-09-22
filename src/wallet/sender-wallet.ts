/**
 * The payer's wallet: a few P2TR keys, UTXOs discovered with `scantxoutset`,
 * simple coin selection, and change back to a fresh key. Keys live here (not in
 * Core) because BIP352 derivation needs the input private keys.
 */
import { randomBytes } from 'node:crypto';
import type { BitcoinRpc } from '../chain/rpc.js';
import { SimpleKey, type KeyedUtxo, type TxOut } from './simple.js';
import { loadJson, saveJson, walletPath } from './store.js';

interface SenderFile { version: 1; keys: string[] }

export class SenderWallet {
  private readonly keys: SimpleKey[];
  utxos: KeyedUtxo[] = [];

  private constructor(private readonly path: string, keys: SimpleKey[]) { this.keys = keys; }

  static open(name = 'sender'): SenderWallet {
    const path = walletPath(name);
    const file = loadJson<SenderFile>(path);
    if (file) return new SenderWallet(path, file.keys.map((h) => new SimpleKey(Buffer.from(h, 'hex'))));
    const w = new SenderWallet(path, [new SimpleKey(randomBytes(32))]);
    w.save();
    return w;
  }

  save(): void { saveJson(this.path, { version: 1, keys: this.keys.map((k) => Buffer.from(k.priv).toString('hex')) } satisfies SenderFile); }

  /** A P2TR address to receive/fund into. */
  address(): string { return this.keys[0]!.p2tr.address!; }
  newKey(): SimpleKey { const k = new SimpleKey(randomBytes(32)); this.keys.push(k); this.save(); return k; }
  changeOutput(valueSat: number): TxOut { return { scriptPubKey: new Uint8Array(this.newKey().p2tr.output!), valueSat }; }

  balanceSat(): number { return this.utxos.reduce((a, u) => a + u.valueSat, 0); }

  /** Rescans the UTXO set for every address this wallet owns. */
  async refresh(rpc: BitcoinRpc): Promise<KeyedUtxo[]> {
    const byScript = new Map(this.keys.map((k) => [k.p2tr.output!.toString('hex'), k]));
    const res = await rpc.scanTxOutSet(this.keys.map((k) => `addr(${k.p2tr.address!})`));
    this.utxos = res.unspents
      .filter((u) => byScript.has(u.scriptPubKey))
      .map((u) => ({ txid: u.txid, vout: u.vout, valueSat: Math.round(u.amount * 1e8), scriptPubKey: new Uint8Array(Buffer.from(u.scriptPubKey, 'hex')), priv: byScript.get(u.scriptPubKey)!.p2trPriv, type: 'p2tr' as const }));
    return this.utxos;
  }

  /** Largest-first selection covering `targetSat` plus an estimated fee. */
  select(targetSat: number, feeRateSatVb = 4): { inputs: KeyedUtxo[]; feeSat: number; changeSat: number } {
    const sorted = [...this.utxos].sort((a, b) => b.valueSat - a.valueSat);
    const inputs: KeyedUtxo[] = [];
    let total = 0;
    for (const u of sorted) {
      inputs.push(u); total += u.valueSat;
      // vsize ≈ 11 overhead + 58/taproot input + 43/taproot output (payment + change)
      const fee = Math.ceil(feeRateSatVb * (11 + inputs.length * 58 + 2 * 43));
      if (total >= targetSat + fee + 330) return { inputs, feeSat: fee, changeSat: total - targetSat - fee };
    }
    throw new Error(`insufficient funds: have ${total} sat, need ${targetSat} sat + fee`);
  }
}
