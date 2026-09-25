/**
 * Local demo console: one process running both sides for real.
 *
 *   /            the page
 *   /payjoin     the receiver's live BIP78 endpoint (what the payer actually POSTs to)
 *   /api/*       state, fund, pay, mine, toggle
 *
 * Nothing here is simulated: payments are built, signed, broadcast and mined on the
 * regtest node, and the receiver finds them by scanning the chain like any wallet.
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { BitcoinRpc, type DecodedTx } from '../chain/rpc.js';
import { SenderWallet } from '../wallet/sender-wallet.js';
import { SpWallet } from '../sp/wallet.js';
import { PayjoinReceiver } from '../payjoin/receiver.js';
import { buildPjUri } from '../payjoin/uri.js';
import { pay } from '../pay/pay.js';
import { withPrevouts } from '../wallet/simple.js';
import { analyze, score } from '../analysis/cioh.js';
import { PayjoinReceiverError } from '../payjoin/errors.js';
import { PAGE } from './page.js';

const rpc = new BitcoinRpc();
const PORT = Number(process.env.PORT ?? 8080);

const sender = SenderWallet.open('web-sender');
const receiver = SpWallet.open('web-receiver', await rpc.getBlockCount());
let payjoinEnabled = true;

const owners: Record<string, string> = {};
const receiverHooks = receiver.receiverHooks({ isBroadcastable: async (hex) => (await rpc.testMempoolAccept(hex))[0]!.allowed });
const payjoinReceiver = new PayjoinReceiver(receiverHooks);

export interface HistoryEntry {
  at: number; txid: string; amountSat: number; payjoin: boolean; reason?: string;
  inputs: Array<{ outpoint: string; owner: string; valueSat: number }>;
  outputs: Array<{ index: number; valueSat: number; mine: boolean }>;
  analyst: { question: string; says: string; fooled: boolean }[];
  log: string[];
}
const history: HistoryEntry[] = [];

const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};
const readBody = async (req: import('node:http').IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

function receiverUri(): string {
  return buildPjUri({ sp: receiver.address, ...(payjoinEnabled ? { pj: `http://127.0.0.1:${PORT}/payjoin` } : {}) });
}

/** Runs the three heuristics over a confirmed transaction and marks them against the truth. */
function analystView(tx: DecodedTx, paymentSat: number, paymentIndex: number) {
  const inputs = tx.vin.map((v) => ({ outpoint: `${v.txid}:${v.vout}`, scriptPubKeyHex: v.prevout!.scriptPubKey.hex }));
  const outputs = tx.vout.map((o) => ({ index: o.n, scriptPubKeyHex: o.scriptPubKey.hex, valueSat: Math.round(o.value * 1e8) }));
  const verdict = analyze({ txid: tx.txid, inputs, outputs });
  const card = score(verdict, { ownerOfOutpoint: owners, paymentSat, paymentOutputIndex: paymentIndex });
  const realOwners = [...new Set(inputs.map((i) => owners[i.outpoint] ?? '?'))];
  return [
    { question: 'Who owns the inputs?', says: `one wallet — ${inputs.length} input${inputs.length > 1 ? 's' : ''}, one owner`, fooled: !card.h1.correct, truth: realOwners.join(' + ') },
    { question: 'How much was paid?', says: `${(verdict.inferredPayment?.valueSat ?? 0).toLocaleString('en-US')} sat`, fooled: !(card.h2?.correct ?? true), truth: `${paymentSat.toLocaleString('en-US')} sat` },
    { question: 'Who received it?', says: 'unknown — the output is a one-time key', fooled: true, truth: 'the receiver, unidentifiable on chain' },
  ];
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  try {
    // ── the receiver's real BIP78 endpoint ──────────────────────────────────
    if (url.pathname === '/payjoin') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
      if (!payjoinEnabled) return json(res, 503, { errorCode: 'unavailable', message: 'payjoin is switched off on this receiver' });
      try {
        const result = await payjoinReceiver.handle({ psbtBase64: (await readBody(req)).trim(), query: url.searchParams });
        res.statusCode = 200; res.setHeader('Content-Type', 'text/plain');
        return res.end(result.proposalBase64);
      } catch (e) {
        const err = e instanceof PayjoinReceiverError ? e : new PayjoinReceiverError('unavailable', 'internal error');
        return json(res, err.errorCode === 'unavailable' ? 503 : 400, err.toJSON());
      }
    }

    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(PAGE); }

    if (url.pathname === '/api/state') {
      await sender.refresh(rpc);
      const found = await receiver.scanChain(rpc);
      for (const u of found) owners[`${u.txid}:${u.vout}`] = 'receiver';
      return json(res, 200, {
        height: await rpc.getBlockCount(),
        payjoinEnabled,
        sender: { address: sender.address(), balanceSat: sender.balanceSat(), utxos: sender.utxos.length },
        receiver: { address: receiver.address, uri: receiverUri(), balanceSat: receiver.balanceSat(), utxos: receiver.utxos.size, exposed: payjoinReceiver.exposedInputs.size },
        history: history.slice().reverse().slice(0, 8),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/fund') {
      const txid = await rpc.fund(sender.address(), 0.5);
      await rpc.mine(1);
      await sender.refresh(rpc);
      for (const u of sender.utxos) owners[`${u.txid}:${u.vout}`] = 'payer';
      return json(res, 200, { txid, balanceSat: sender.balanceSat() });
    }

    if (req.method === 'POST' && url.pathname === '/api/payjoin') {
      payjoinEnabled = JSON.parse(await readBody(req)).enabled === true;
      return json(res, 200, { payjoinEnabled });
    }

    if (req.method === 'POST' && url.pathname === '/api/pay') {
      const { amountSat } = JSON.parse(await readBody(req)) as { amountSat: number };
      if (!Number.isFinite(amountSat) || amountSat < 1000) return json(res, 400, { error: 'amount must be at least 1000 sat' });
      await sender.refresh(rpc);
      for (const u of sender.utxos) owners[`${u.txid}:${u.vout}`] = 'payer';

      const log: string[] = [];
      let result;
      try {
        result = await pay({ wallet: sender, rpc, destination: receiverUri(), amountSat, log: (s) => log.push(s) });
      } catch (e) { return json(res, 400, { error: (e as Error).message }); }

      await rpc.mine(1);
      const tx = await withPrevouts(rpc, await rpc.getRawTransaction(result.txid));
      const mine = receiver.scanDecodedTx(tx);
      for (const u of mine) owners[`${u.txid}:${u.vout}`] = 'receiver';
      const paymentIndex = mine[0]?.vout ?? 0;

      history.push({
        at: Date.now(), txid: result.txid, amountSat, payjoin: result.payjoin, reason: result.reason, log,
        inputs: tx.vin.map((v) => ({ outpoint: `${v.txid}:${v.vout}`, owner: owners[`${v.txid}:${v.vout}`] ?? 'unknown', valueSat: Math.round(v.prevout!.value * 1e8) })),
        outputs: tx.vout.map((o) => ({ index: o.n, valueSat: Math.round(o.value * 1e8), mine: o.n === paymentIndex })),
        analyst: analystView(tx, amountSat, paymentIndex),
      });
      return json(res, 200, { txid: result.txid, payjoin: result.payjoin, reason: result.reason, summary: result.summary });
    }

    res.statusCode = 404; res.end('not found');
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, '127.0.0.1');
await once(server, 'listening');
await receiver.scanChain(rpc);
console.log(`\n  demo console   http://127.0.0.1:${PORT}`);
console.log(`  payer          ${sender.address()}  (${sender.balanceSat()} sat)`);
console.log(`  receiver       ${receiver.address.slice(0, 32)}…  (${receiver.balanceSat()} sat)`);
console.log(`  payjoin        ${payjoinEnabled ? 'on' : 'off'} — the toggle on the page turns the receiver's endpoint off\n`);
