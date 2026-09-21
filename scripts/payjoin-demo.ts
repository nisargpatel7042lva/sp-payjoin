/**
 * Phase 1 gate: a real BIP78 PayJoin on regtest (plain P2WPKH addresses), then
 * what a naive chain-analysis tool concludes about it — vs. a normal payment.
 */
import { BitcoinRpc } from '../src/chain/rpc.js';
import { SimpleKey, fundAddress, withPrevouts, type KeyedUtxo } from '../src/wallet/simple.js';
import { signPsbtInput } from '../src/wallet/psbt-wallet.js';
import { PayjoinReceiver } from '../src/payjoin/receiver.js';
import { startReceiverServer } from '../src/payjoin/http.js';
import { payWithPayjoin } from '../src/payjoin/client.js';
import { buildPjUri } from '../src/payjoin/uri.js';
import { analyze, score } from '../src/analysis/cioh.js';
import type { DecodedTx } from '../src/chain/rpc.js';

const rpc = new BitcoinRpc();
const step = (s: string) => console.log(`\n${'─'.repeat(78)}\n${s}`);
const kv = (k: string, v: unknown) => console.log(`   ${k.padEnd(20)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const sat = (btc: number) => Math.round(btc * 1e8);
const PAY = 600_000, FEE = 500;

const sender = new SimpleKey(), senderChange = new SimpleKey(), receiver = new SimpleKey();
const owners: Record<string, string> = {};
const fund = async (key: SimpleKey, who: string, btc: number): Promise<KeyedUtxo> => {
  const u = { ...(await fundAddress(rpc, key.p2wpkh.address!, btc)), priv: key.priv, type: 'p2wpkh' as const };
  owners[`${u.txid}:${u.vout}`] = who; return u;
};

function analyst(tx: DecodedTx, paymentOutputIndex: number) {
  const verdict = analyze({ txid: tx.txid, inputs: tx.vin.map((v) => ({ outpoint: `${v.txid}:${v.vout}`, scriptPubKeyHex: v.prevout?.scriptPubKey.hex ?? '' })), outputs: tx.vout.map((o) => ({ index: o.n, scriptPubKeyHex: o.scriptPubKey.hex, valueSat: sat(o.value) })) });
  const card = score(verdict, { ownerOfOutpoint: owners, paymentSat: PAY, paymentOutputIndex });
  console.log('   inputs:');
  for (const v of tx.vin) console.log(`      ${v.txid.slice(0, 16)}…:${v.vout}  ${sat(v.prevout!.value).toString().padStart(9)} sat   truth: ${owners[`${v.txid}:${v.vout}`]}`);
  console.log('   outputs:');
  for (const o of tx.vout) console.log(`      #${o.n} ${sat(o.value).toString().padStart(9)} sat   ${o.scriptPubKey.hex === receiver.p2wpkh.output!.toString('hex') ? '→ receiver' : '→ sender change'}`);
  console.log(`   analyst H1 (common-input-ownership): "${card.h1.claim}"  →  ${card.h1.correct ? 'CORRECT' : 'WRONG'}: ${card.h1.detail}`);
  if (card.h2) console.log(`   analyst H2 (payment amount):          "${card.h2.claim}"  →  ${card.h2.correct ? 'CORRECT' : 'WRONG'}: ${card.h2.detail}`);
  return card;
}

step('A. baseline: a normal payment (sender inputs only)');
{
  const su = await fund(sender, 'sender', 0.01);
  const r = await payWithPayjoin({
    uri: buildPjUri({ address: receiver.p2wpkh.address!, amountSat: PAY, pj: 'http://127.0.0.1:1/payjoin' }), // no receiver listening → fallback
    inputs: [su], paymentOutputIndex: 0,
    outputs: [{ scriptPubKey: new Uint8Array(receiver.p2wpkh.output!), valueSat: PAY }, { scriptPubKey: new Uint8Array(senderChange.p2wpkh.output!), valueSat: su.valueSat - PAY - FEE }],
    broadcast: (hex) => rpc.sendRawTransaction(hex), log: (s) => kv('sender', s),
  });
  await rpc.mine(1);
  kv('confirmed txid', r.txid);
  analyst(await withPrevouts(rpc, await rpc.getRawTransaction(r.txid)), 0);
}

step('B. PayJoin: receiver contributes an input (BIP78 over HTTP)');
{
  const su = await fund(sender, 'sender', 0.01);
  const ru = await fund(receiver, 'receiver', 0.005);
  const seen = new Set<string>();
  const rx = new PayjoinReceiver({
    isBroadcastable: async (hex) => (await rpc.testMempoolAccept(hex))[0]!.allowed,
    isOwnedScript: (spk) => Buffer.compare(Buffer.from(spk), receiver.p2wpkh.output!) === 0,
    inputSeenBefore: (op) => seen.has(op), markInputSeen: (op) => { seen.add(op); },
    selectInput: () => ru,
    signInput: (psbt, idx, u) => { signPsbtInput(psbt, idx, u); psbt.finalizeInput(idx); },
  });
  const server = await startReceiverServer(rx, { onProposal: (p) => kv('receiver', `added input ${p.contributed.txid.slice(0, 16)}…:${p.contributed.vout} (${p.contributed.valueSat} sat) at index ${p.ourInputIndex}; fee ${p.originalFeeSat}→${p.proposalFeeSat} sat (sender contributed ${p.feeContributionSat}, receiver ${p.receiverFeeSat})`) });
  const uri = buildPjUri({ address: receiver.p2wpkh.address!, amountSat: PAY, pj: server.url });
  kv('BIP21 URI', uri);
  const r = await payWithPayjoin({
    uri, inputs: [su], paymentOutputIndex: 0,
    outputs: [{ scriptPubKey: new Uint8Array(receiver.p2wpkh.output!), valueSat: PAY }, { scriptPubKey: new Uint8Array(senderChange.p2wpkh.output!), valueSat: su.valueSat - PAY - FEE }],
    params: { additionalFeeOutputIndex: 1, maxAdditionalFeeContribution: 1000 },
    broadcast: (hex) => rpc.sendRawTransaction(hex), log: (s) => kv('sender', s),
  });
  await server.close();
  await rpc.mine(1);
  kv('confirmed txid', r.txid);
  kv('payjoin?', r.payjoin);
  const tx = await withPrevouts(rpc, await rpc.getRawTransaction(r.txid));
  const recvIdx = tx.vout.findIndex((o) => o.scriptPubKey.hex === receiver.p2wpkh.output!.toString('hex'));
  const card = analyst(tx, recvIdx);
  console.log(`\nRESULT: ${r.payjoin && tx.confirmations === 1 && !card.h1.correct ? 'PayJoin confirmed and the common-input-ownership heuristic drew the wrong conclusion' : 'FAILED'}`);
}
