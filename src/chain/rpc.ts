/** Minimal Bitcoin Core JSON-RPC client (cookie auth) for the project regtest node. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RpcOptions { url?: string; cookieFile?: string; wallet?: string }

export class BitcoinRpc {
  private readonly url: string;
  private readonly auth: string;
  constructor(opts: RpcOptions = {}) {
    const base = opts.url ?? 'http://127.0.0.1:18543';
    this.url = opts.wallet ? `${base}/wallet/${opts.wallet}` : base;
    const cookie = readFileSync(opts.cookieFile ?? resolve(import.meta.dirname, '../../infra/bitcoin/regtest/.cookie'), 'utf8').trim();
    this.auth = 'Basic ' + Buffer.from(cookie).toString('base64');
  }
  forWallet(name: string): BitcoinRpc { const r = Object.create(BitcoinRpc.prototype) as BitcoinRpc; Object.assign(r, this, { url: `${this.url.replace(/\/wallet\/.*$/, '')}/wallet/${name}` }); return r; }

  async call<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
    const res = await fetch(this.url, { method: 'POST', headers: { Authorization: this.auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: 'sp', method, params }) });
    const body = (await res.json()) as { result: T; error: { code: number; message: string } | null };
    if (body.error) throw new Error(`rpc ${method}: ${body.error.message} (${body.error.code})`);
    return body.result;
  }

  getBlockCount() { return this.call<number>('getblockcount'); }
  getRawTransaction(txid: string) { return this.call<DecodedTx>('getrawtransaction', txid, true); }
  sendRawTransaction(hex: string) { return this.call<string>('sendrawtransaction', hex); }
  testMempoolAccept(hex: string) { return this.call<Array<{ allowed: boolean; 'reject-reason'?: string }>>('testmempoolaccept', [hex]); }
  getBlockHash(height: number) { return this.call<string>('getblockhash', height); }
  /** Verbosity 3: transactions with `prevout` on every non-coinbase input (what SP scanning needs). */
  getBlock(hash: string) { return this.call<{ height: number; tx: DecodedTx[] }>('getblock', hash, 3); }
  scanTxOutSet(descriptors: string[]) { return this.call<{ success: boolean; unspents: Array<{ txid: string; vout: number; scriptPubKey: string; amount: number; height: number }> }>('scantxoutset', 'start', descriptors); }
  getTxOut(txid: string, vout: number) { return this.call<{ value: number; scriptPubKey: { hex: string } } | null>('gettxout', txid, vout, true); }
  /** Miner wallet helpers */
  mine(n = 1) { return this.forWallet('miner').call<string[]>('generatetoaddress', n, '__ADDR__').catch(async () => { const a = await this.forWallet('miner').call<string>('getnewaddress'); return this.call<string[]>('generatetoaddress', n, a); }); }
  async fund(address: string, btc: number): Promise<string> { return this.forWallet('miner').call<string>('sendtoaddress', address, btc); }
}

export interface DecodedTx {
  txid: string; hex: string; version: number; locktime: number;
  vin: Array<{ txid: string; vout: number; scriptSig: { hex: string }; txinwitness?: string[]; sequence: number; prevout?: { value: number; scriptPubKey: { hex: string } } }>;
  vout: Array<{ value: number; n: number; scriptPubKey: { hex: string; type: string; address?: string } }>;
  confirmations?: number;
}
