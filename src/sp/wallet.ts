/**
 * A silent-payment receiver wallet: scan/spend keys, the UTXOs it has found by
 * scanning transactions (standard BIP352 rules), and the PayJoin receiver hooks
 * that make it (a) recognise its own output in a sender's original transaction,
 * (b) contribute one of its SP-received UTXOs, and (c) recompute its output for
 * the joined input set (BIP78 payment output substitution).
 */
import { Transaction } from 'bitcoinjs-lib';
import type { Psbt } from 'bitcoinjs-lib';
import { derivationContext, type TxInputView } from './inputs.js';
import { deriveOutput, newReceiverKeys, scanTx, spAddress, spendingKey, type SpReceiverKeys } from './keys.js';
import type { KeyedUtxo } from '../wallet/simple.js';
import type { DecodedTx } from '../chain/rpc.js';
import type { ProposalInput, ReceiverHooks } from '../payjoin/receiver.js';
import { signPsbtInput } from '../wallet/psbt-wallet.js';
import { loadJson, saveJson, walletPath } from '../wallet/store.js';
import { toView } from '../wallet/simple.js';

export interface SpUtxo extends KeyedUtxo { tweak: Uint8Array; foundIn: string }

export class SpWallet {
  readonly keys: SpReceiverKeys;
  readonly address: string;
  readonly utxos = new Map<string, SpUtxo>();
  readonly spent = new Map<string, SpUtxo>();
  readonly log: string[] = [];
  /** Height of the last block scanned (exclusive lower bound for the next scan). */
  scannedHeight = 0;
  private path?: string;

  constructor(keys: SpReceiverKeys = newReceiverKeys()) { this.keys = keys; this.address = spAddress(keys); }

  /** Opens (or creates) a persistent wallet file: keys + scan height. UTXOs are re-derived by scanning. */
  static open(name = 'receiver', startHeight = 0): SpWallet {
    const path = walletPath(name);
    const file = loadJson<{ version: 1; scanPriv: string; spendPriv: string; scannedHeight: number }>(path);
    const w = file
      ? new SpWallet(newReceiverKeys(Buffer.from(file.scanPriv, 'hex'), Buffer.from(file.spendPriv, 'hex')))
      : new SpWallet();
    w.path = path;
    w.scannedHeight = file?.scannedHeight ?? startHeight;
    if (!file) w.save();
    return w;
  }

  save(): void {
    if (!this.path) return;
    saveJson(this.path, { version: 1, scanPriv: Buffer.from(this.keys.scanPriv).toString('hex'), spendPriv: Buffer.from(this.keys.spendPriv).toString('hex'), scannedHeight: this.scannedHeight });
  }

  /**
   * Scans new blocks for payments to this address and for spends of our UTXOs.
   * This is the trustless-but-naive path (every transaction in every block); a
   * real deployment would use a BIP352 index / block filters.
   */
  async scanChain(rpc: { getBlockCount(): Promise<number>; getBlockHash(h: number): Promise<string>; getBlock(hash: string): Promise<{ height: number; tx: DecodedTx[] }> }): Promise<SpUtxo[]> {
    const tip = await rpc.getBlockCount();
    const found: SpUtxo[] = [];
    for (let h = this.scannedHeight + 1; h <= tip; h++) {
      const block = await rpc.getBlock(await rpc.getBlockHash(h));
      for (const tx of block.tx) {
        if (tx.vin.every((v) => !v.prevout)) continue; // coinbase
        found.push(...this.scanDecodedTx(tx));
      }
      this.scannedHeight = h;
    }
    this.save();
    return found;
  }

  balanceSat(): number { return [...this.utxos.values()].reduce((a, u) => a + u.valueSat, 0); }
  isOwnedScript(spk: Uint8Array): boolean { const h = Buffer.from(spk).toString('hex'); return [...this.utxos.values()].some((u) => Buffer.from(u.scriptPubKey).toString('hex') === h); }

  /** Standard BIP352 scan of a confirmed transaction: adds outputs paying us, removes inputs that spent ours. */
  scanDecodedTx(tx: DecodedTx): SpUtxo[] {
    for (const v of tx.vin) { const op = `${v.txid}:${v.vout}`; const u = this.utxos.get(op); if (u) { this.utxos.delete(op); this.spent.set(op, u); this.log.push(`spent ${op} in ${tx.txid}`); } }
    const found = this.findOutputs(toView(tx), tx.vout.map((o) => ({ index: o.n, scriptPubKeyHex: o.scriptPubKey.hex, valueSat: Math.round(o.value * 1e8) })));
    const added: SpUtxo[] = [];
    for (const f of found) {
      const op = `${tx.txid}:${f.index}`;
      if (this.utxos.has(op) || this.spent.has(op)) continue;
      const u: SpUtxo = { txid: tx.txid, vout: f.index, valueSat: f.valueSat, scriptPubKey: new Uint8Array(Buffer.from(f.scriptPubKeyHex, 'hex')), priv: spendingKey(this.keys, f.tweak), type: 'p2tr', tweak: f.tweak, foundIn: tx.txid };
      this.utxos.set(op, u); added.push(u); this.log.push(`found ${op} (${f.valueSat} sat) in ${tx.txid}`);
    }
    return added;
  }

  /** Outputs (with their tweaks) of a transaction that pay this wallet, from inputs + outputs only. */
  findOutputs(inputs: TxInputView[], outputs: Array<{ index: number; scriptPubKeyHex: string; valueSat: number }>) {
    const ctx = derivationContext(inputs);
    if (!ctx) return [];
    return scanTx(this.keys, ctx.sumPubkeys, ctx.inputHash, outputs.map((o) => ({ vout: o.index, scriptPubKeyHex: o.scriptPubKeyHex })))
      .map((m) => ({ index: m.vout, tweak: m.tweak, scriptPubKeyHex: outputs.find((o) => o.index === m.vout)!.scriptPubKeyHex, valueSat: outputs.find((o) => o.index === m.vout)!.valueSat }));
  }

  /** BIP352 output for the k-th payment to us given an arbitrary input set. */
  deriveForInputs(inputs: TxInputView[], k: number): Uint8Array {
    const ctx = derivationContext(inputs);
    if (!ctx) throw new Error('no eligible inputs');
    return deriveOutput(this.keys, ctx.sumPubkeys, ctx.inputHash, k).scriptPubKey;
  }

  /** PayJoin receiver hooks backed by this wallet. */
  receiverHooks(chain: { isBroadcastable(txHex: string): Promise<boolean> }, opts: { seen?: Set<string> } = {}): ReceiverHooks {
    const seen = opts.seen ?? new Set<string>();
    const asView = (i: ProposalInput): TxInputView => ({ txid: i.txid, vout: i.vout, scriptSigHex: i.scriptSigHex, witness: i.witness, prevoutScriptPubKeyHex: Buffer.from(i.scriptPubKey).toString('hex') });
    return {
      isBroadcastable: (hex) => chain.isBroadcastable(hex),
      isOwnedScript: (spk) => this.isOwnedScript(spk),
      inputSeenBefore: (op) => seen.has(op),
      markInputSeen: (op) => { seen.add(op); },
      // Identify our outputs by scanning the original transaction with the scan key.
      identifyOutputs: ({ inputs, outputs }) => this.findOutputs(inputs.map(asView), outputs.map((o) => ({ index: o.index, scriptPubKeyHex: Buffer.from(o.scriptPubKey).toString('hex'), valueSat: o.valueSat }))).map((f) => f.index),
      // Contribute one of our silent-payment UTXOs: an already-exposed one first
      // (BIP78 probing mitigation), otherwise the largest.
      selectInput: (_original, exposed) => {
        const all = [...this.utxos.values()];
        return all.find((u) => exposed.includes(`${u.txid}:${u.vout}`)) ?? all.sort((a, b) => b.valueSat - a.valueSat)[0];
      },
      signInput: (psbt: Psbt, idx, u) => { signPsbtInput(psbt, idx, u); psbt.finalizeInput(idx); },
      // Our input changed the input set → recompute output k for the joined transaction.
      substituteOutput: ({ index, ourOutputs, inputs }) => this.deriveForInputs(inputs.map(asView), ourOutputs.indexOf(index)),
    };
  }
}

export { Transaction };
