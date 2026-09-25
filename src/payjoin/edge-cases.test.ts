/**
 * Failure modes, one test each. The rule everywhere: the payment still happens
 * (the original is broadcast) and nothing hangs, throws, or silently overpays.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { Psbt, Transaction } from 'bitcoinjs-lib';
import { PayjoinReceiver, type ReceiverHooks } from './receiver.js';
import { PayjoinReceiverError } from './errors.js';
import { startReceiverServer } from './http.js';
import { payWithPayjoin } from './client.js';
import { buildPjUri } from './uri.js';
import { createOriginalPsbt } from './sender.js';
import { finalizedTx, unsignedTx } from './psbt-utils.js';
import { buildPsbt, signPsbtInput } from '../wallet/psbt-wallet.js';
import { SimpleKey, type KeyedUtxo } from '../wallet/simple.js';

const utxo = (key: SimpleKey, valueSat: number, seed: number): KeyedUtxo => ({
  txid: Buffer.alloc(32, seed).toString('hex'), vout: 0, valueSat,
  scriptPubKey: new Uint8Array(key.p2wpkh.output!), priv: key.priv, type: 'p2wpkh',
});

const PAY = 60_000, TOTAL = 100_000, FEE = 400;
function parties(receiverValueSat = 50_000) {
  const sender = new SimpleKey(), change = new SimpleKey(), receiver = new SimpleKey();
  return {
    sender, change, receiver,
    senderUtxo: utxo(sender, TOTAL, 1),
    receiverUtxo: receiverValueSat > 0 ? utxo(receiver, receiverValueSat, 2) : undefined,
    outputs: [
      { scriptPubKey: new Uint8Array(receiver.p2wpkh.output!), valueSat: PAY },
      { scriptPubKey: new Uint8Array(change.p2wpkh.output!), valueSat: TOTAL - PAY - FEE },
    ],
  };
}

function hooks(p: ReturnType<typeof parties>, over: Partial<ReceiverHooks> = {}): ReceiverHooks {
  const seen = new Set<string>();
  return {
    isBroadcastable: async () => true,
    isOwnedScript: (spk) => Buffer.compare(Buffer.from(spk), p.receiver.p2wpkh.output!) === 0,
    inputSeenBefore: (op) => seen.has(op),
    markInputSeen: (op) => { seen.add(op); },
    selectInput: () => p.receiverUtxo,
    signInput: (psbt, idx, u) => { signPsbtInput(psbt, idx, u); psbt.finalizeInput(idx); },
    ...over,
  };
}

/** Sends through the real client against `pj`, returning what the payer ends up with. */
async function send(p: ReturnType<typeof parties>, pj: string, extra: Partial<Parameters<typeof payWithPayjoin>[0]> = {}) {
  const broadcast: string[] = [];
  const result = await payWithPayjoin({
    uri: buildPjUri({ address: p.receiver.p2wpkh.address!, amountSat: PAY, pj }),
    inputs: [p.senderUtxo], outputs: p.outputs, paymentOutputIndex: 0,
    params: { additionalFeeOutputIndex: 1, maxAdditionalFeeContribution: 1000 },
    requestTimeoutMs: 400,
    broadcast: async (hex) => { broadcast.push(hex); return Transaction.fromHex(hex).getId(); },
    ...extra,
  });
  return { result, broadcast };
}

const originals = new WeakMap<object, string>();
/** The original PSBT this payer would produce — cached so replay tests reuse the exact bytes. */
function originalOf(p: ReturnType<typeof parties>): string {
  const cached = originals.get(p);
  if (cached) return cached;
  const signed = buildPsbt([p.senderUtxo], p.outputs);
  signPsbtInput(signed, 0, p.senderUtxo);
  const b64 = createOriginalPsbt(signed).toBase64();
  originals.set(p, b64);
  return b64;
}

/** A server that returns exactly what `respond` gives, so bad receivers can be simulated. */
async function rawServer(respond: (body: string) => { status: number; body: string } | Promise<{ status: number; body: string }> | 'hang'): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const out = await respond(Buffer.concat(chunks).toString('utf8'));
    if (out === 'hang') return;                       // accept, never answer
    res.statusCode = out.status;
    res.end(out.body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/payjoin`, server, close: () => new Promise((r) => server.close(() => r())) };
}

// ── receiver unreachable or unresponsive ─────────────────────────────────────

test('receiver is offline → payment still goes out as the original', async () => {
  const p = parties();
  const { result } = await send(p, 'http://127.0.0.1:1/payjoin');
  assert.equal(result.payjoin, false);
  assert.equal(result.txid, result.originalTxid);
  assert.match(result.reason ?? '', /fetch failed|ECONNREFUSED/);
});

test('receiver accepts the request then never answers → sender times out and sends directly', async () => {
  const p = parties();
  const s = await rawServer(() => 'hang');
  try {
    const started = Date.now();
    const { result } = await send(p, s.url);
    assert.ok(Date.now() - started < 5_000, 'did not hang');
    assert.equal(result.payjoin, false);
    assert.match(result.reason ?? '', /timed out|abort|TimeoutError/i);
  } finally { await s.close(); }
});

test('receiver dies mid-response (connection reset) → sender sends directly', async () => {
  const p = parties();
  const server = createServer((req, res) => { res.writeHead(200); res.write('cHNidP8B'); req.socket.destroy(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as { port: number };
  try {
    const { result } = await send(p, `http://127.0.0.1:${port}/payjoin`);
    assert.equal(result.payjoin, false);
    assert.equal(result.txid, result.originalTxid);
  } finally { server.close(); }
});

// ── receiver cannot contribute ───────────────────────────────────────────────

test('receiver has no UTXO to contribute → 503 unavailable → sender sends directly', async () => {
  const p = parties(0);
  const s = await startReceiverServer(new PayjoinReceiver(hooks(p)));
  try {
    const { result } = await send(p, s.url);
    assert.equal(result.payjoin, false);
    assert.match(result.reason ?? '', /unavailable/);
  } finally { await s.close(); }
});

test('receiver cannot cover the extra fee → not-enough-money → sender sends directly', async () => {
  const p = parties(300);                      // dust-sized input: cannot pay for its own weight
  const rx = new PayjoinReceiver(hooks(p));
  await assert.rejects(
    rx.handle({ psbtBase64: originalOf(p), query: new URLSearchParams({ v: '1', minfeerate: '50000' }) }),
    (e: unknown) => e instanceof PayjoinReceiverError && e.errorCode === 'not-enough-money',
  );
  const q = parties(300);
  const s = await startReceiverServer(new PayjoinReceiver(hooks(q)));
  try {
    const { result } = await send(q, s.url, { params: { minFeeRate: 50_000 } });
    assert.equal(result.payjoin, false);
    assert.match(result.reason ?? '', /not-enough-money/);
  } finally { await s.close(); }
});

test('unsupported version → 400 version-unsupported with the versions the receiver speaks', async () => {
  const p = parties();
  const rx = new PayjoinReceiver(hooks(p));
  await assert.rejects(
    rx.handle({ psbtBase64: originalOf(p), query: new URLSearchParams({ v: '99' }) }),
    (e: unknown) => e instanceof PayjoinReceiverError && e.errorCode === 'version-unsupported' && JSON.stringify(e.toJSON()).includes('"supported":[1]'),
  );
});

// ── fee disagreement ─────────────────────────────────────────────────────────

/** Builds a proposal by hand so a misbehaving receiver can be simulated exactly. */
function craftProposal(p: ReturnType<typeof parties>, opts: { takeFromChange?: number; addToReceiverOutput?: number }): string {
  const original = Psbt.fromBase64(originalOf(p));
  const tx = finalizedTx(original);
  const out = new Psbt();
  out.setVersion(tx.version); out.setLocktime(tx.locktime);
  out.addInput({ hash: Buffer.from(tx.ins[0]!.hash), index: tx.ins[0]!.index, sequence: tx.ins[0]!.sequence, witnessUtxo: original.data.inputs[0]!.witnessUtxo! });
  out.addInput({ hash: Buffer.from(p.receiverUtxo!.txid, 'hex').reverse(), index: p.receiverUtxo!.vout, sequence: tx.ins[0]!.sequence, witnessUtxo: { script: Buffer.from(p.receiverUtxo!.scriptPubKey), value: p.receiverUtxo!.valueSat } });
  out.addOutput({ script: tx.outs[0]!.script, value: Number(tx.outs[0]!.value) + (opts.addToReceiverOutput ?? 0) });
  out.addOutput({ script: tx.outs[1]!.script, value: Number(tx.outs[1]!.value) - (opts.takeFromChange ?? 0) });
  signPsbtInput(out, 1, p.receiverUtxo!); out.finalizeInput(1);
  return out.toBase64();
}

test('receiver takes more fee than the sender allowed → proposal rejected → sender sends directly', async () => {
  const p = parties();
  const s = await rawServer(() => ({ status: 200, body: craftProposal(p, { takeFromChange: 9_000 }) })); // cap was 1000
  try {
    const { result } = await send(p, s.url);
    assert.equal(result.payjoin, false);
    assert.match(result.reason ?? '', /more than maxadditionalfeecontribution/);
    assert.equal(result.txid, result.originalTxid);
  } finally { await s.close(); }
});

test('receiver adds weight without raising the fee, dropping below minfeerate → sender sends directly', async () => {
  const p = parties();
  // the whole contributed input goes to the receiver's own output: absolute fee unchanged, vsize up ⇒ rate down
  const s = await rawServer(() => ({ status: 200, body: craftProposal(p, { addToReceiverOutput: p.receiverUtxo!.valueSat }) }));
  try {
    const { result } = await send(p, s.url, { params: { minFeeRate: 4 } });
    assert.equal(result.payjoin, false);
    assert.match(result.reason ?? '', /minfeerate/);
    assert.equal(result.txid, result.originalTxid);
  } finally { await s.close(); }
});

test('receiver returns garbage → sender sends directly instead of crashing', async () => {
  const p = parties();
  for (const body of ['not a psbt at all', '', 'cHNidP8BAAoCAAAAAAAAAAAAAAA=']) {
    const s = await rawServer(() => ({ status: 200, body }));
    try {
      const { result } = await send(p, s.url);
      assert.equal(result.payjoin, false, `body: ${body}`);
      assert.equal(result.txid, result.originalTxid);
    } finally { await s.close(); }
  }
});

// ── replay / reentrancy / probing ────────────────────────────────────────────

test('the same original posted twice → second is rejected (replay)', async () => {
  const p = parties();
  const rx = new PayjoinReceiver(hooks(p));
  await rx.handle({ psbtBase64: originalOf(p), query: new URLSearchParams({ v: '1' }) });
  await assert.rejects(
    rx.handle({ psbtBase64: originalOf(p), query: new URLSearchParams({ v: '1' }) }),
    (e: unknown) => e instanceof PayjoinReceiverError && e.errorCode === 'original-psbt-rejected' && /seen before/.test(e.message),
  );
});

test('a payjoin proposal fed back as a new original → rejected (reentrant payjoin)', async () => {
  const p = parties();
  // Pin the insertion index so the sender's (already-seen) input is examined first:
  // otherwise the receiver's own contributed input trips the "owned by the receiver"
  // check instead, which is a correct rejection but a different one.
  const rx = new PayjoinReceiver(hooks(p), { randomIndex: () => 1 });
  const first = await rx.handle({ psbtBase64: originalOf(p), query: new URLSearchParams({ v: '1' }) });
  assert.equal(first.ourInputIndex, 1);
  // finalise the proposal the way the sender would, then offer it back as a fresh original
  const proposal = Psbt.fromBase64(first.proposalBase64);
  signPsbtInput(proposal, 0, p.senderUtxo);
  proposal.data.inputs.forEach((i, k) => { if (!i.finalScriptWitness && !i.finalScriptSig) proposal.finalizeInput(k); });
  await assert.rejects(
    rx.handle({ psbtBase64: proposal.toBase64(), query: new URLSearchParams({ v: '1' }) }),
    (e: unknown) => e instanceof PayjoinReceiverError && e.errorCode === 'original-psbt-rejected' && /seen before/.test(e.message),
  );
});

test('reentrancy is caught wherever the receiver’s own input lands in the proposal', async () => {
  for (const at of [0, 1]) {
    const p = parties();
    const rx = new PayjoinReceiver(hooks(p), { randomIndex: () => at });
    const first = await rx.handle({ psbtBase64: originalOf(p), query: new URLSearchParams({ v: '1' }) });
    const proposal = Psbt.fromBase64(first.proposalBase64);
    signPsbtInput(proposal, at === 0 ? 1 : 0, p.senderUtxo);
    proposal.data.inputs.forEach((i, k) => { if (!i.finalScriptWitness && !i.finalScriptSig) proposal.finalizeInput(k); });
    await assert.rejects(
      rx.handle({ psbtBase64: proposal.toBase64(), query: new URLSearchParams({ v: '1' }) }),
      (e: unknown) => e instanceof PayjoinReceiverError && e.errorCode === 'original-psbt-rejected' && /(seen before|owned by the receiver)/.test(e.message),
      `receiver input at index ${at}`,
    );
  }
});

test('probing: repeated requests re-offer the same UTXO instead of walking the wallet', async () => {
  const receiver = new SimpleKey();
  const wallet = [utxo(receiver, 50_000, 2), utxo(receiver, 70_000, 3), utxo(receiver, 90_000, 4)];
  const offered: string[] = [];
  const rx = new PayjoinReceiver({
    isBroadcastable: async () => true,
    isOwnedScript: (spk) => Buffer.compare(Buffer.from(spk), receiver.p2wpkh.output!) === 0,
    inputSeenBefore: () => false,            // a prober uses fresh inputs every time
    markInputSeen: () => {},
    selectInput: ({ exposed }) => {
      const pick = wallet.find((u) => exposed.includes(`${u.txid}:${u.vout}`)) ?? wallet.sort((a, b) => b.valueSat - a.valueSat)[0]!;
      offered.push(`${pick.txid}:${pick.vout}`);
      return pick;
    },
    signInput: (psbt, idx, u) => { signPsbtInput(psbt, idx, u); psbt.finalizeInput(idx); },
  });
  for (let probe = 0; probe < 4; probe++) {
    const attacker = new SimpleKey();
    const probeUtxo = utxo(attacker, TOTAL, 10 + probe);
    const signed = buildPsbt([probeUtxo], [
      { scriptPubKey: new Uint8Array(receiver.p2wpkh.output!), valueSat: PAY },
      { scriptPubKey: new Uint8Array(new SimpleKey().p2wpkh.output!), valueSat: TOTAL - PAY - FEE },
    ]);
    signPsbtInput(signed, 0, probeUtxo);
    await rx.handle({ psbtBase64: createOriginalPsbt(signed).toBase64(), query: new URLSearchParams({ v: '1' }) });
  }
  assert.equal(new Set(offered).size, 1, `leaked ${new Set(offered).size} utxos to a prober: ${[...new Set(offered)].join(', ')}`);
  assert.equal(rx.exposedInputs.size, 1);
});

test('a sender input the receiver owns is refused, and the receiver never signs it', async () => {
  const p = parties();
  const ownUtxo = utxo(p.receiver, TOTAL, 9);
  const signed = buildPsbt([ownUtxo], [{ scriptPubKey: new Uint8Array(p.receiver.p2wpkh.output!), valueSat: PAY }]);
  signPsbtInput(signed, 0, ownUtxo);
  const rx = new PayjoinReceiver(hooks(p));
  await assert.rejects(
    rx.handle({ psbtBase64: createOriginalPsbt(signed).toBase64(), query: new URLSearchParams({ v: '1' }) }),
    (e: unknown) => e instanceof PayjoinReceiverError && /owned by the receiver/.test(e.message),
  );
});

test('every well-known error travels over HTTP as JSON the sender can read', async () => {
  const p = parties(0);
  const s = await startReceiverServer(new PayjoinReceiver(hooks(p)));
  try {
    const res = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: originalOf(p) });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = await res.json() as { errorCode: string; message: string };
    assert.equal(body.errorCode, 'unavailable');
    assert.ok(body.message.length > 0);
    assert.equal(unsignedTx(Psbt.fromBase64(originalOf(p))).ins.length, 1, 'original untouched');
  } finally { await s.close(); }
});

test('a substituted silent-payment output that short-changes the payer is refused', async () => {
  // Output substitution removes BIP78's script check on the payment output, and a
  // silent-payment sender cannot recompute the substituted script to verify it.
  // The amount is still checkable, and it is.
  const receiver = new SimpleKey(), sender = new SimpleKey(), change = new SimpleKey();
  const senderUtxo = utxo(sender, TOTAL, 21);
  const receiverUtxo = utxo(receiver, 50_000, 22);
  const outputs = [
    { scriptPubKey: new Uint8Array(receiver.p2tr.output!), valueSat: PAY },
    { scriptPubKey: new Uint8Array(change.p2wpkh.output!), valueSat: TOTAL - PAY - FEE },
  ];
  const signed = buildPsbt([senderUtxo], outputs);
  signPsbtInput(signed, 0, senderUtxo);
  const originalB64 = createOriginalPsbt(signed).toBase64();

  // A malicious proposal: substitutes the payment output to a different script AND
  // guts its value, keeping the absolute fee legitimate so earlier checks pass.
  const original = Psbt.fromBase64(originalB64);
  const tx = finalizedTx(original);
  const evil = new Psbt();
  evil.setVersion(tx.version); evil.setLocktime(tx.locktime);
  evil.addInput({ hash: Buffer.from(tx.ins[0]!.hash), index: tx.ins[0]!.index, sequence: tx.ins[0]!.sequence, witnessUtxo: original.data.inputs[0]!.witnessUtxo! });
  evil.addInput({ hash: Buffer.from(receiverUtxo.txid, 'hex').reverse(), index: receiverUtxo.vout, sequence: tx.ins[0]!.sequence, witnessUtxo: { script: Buffer.from(receiverUtxo.scriptPubKey), value: receiverUtxo.valueSat } });
  evil.addOutput({ script: Buffer.from(new SimpleKey().p2tr.output!), value: 1_000 });          // substituted, and tiny
  evil.addOutput({ script: tx.outs[1]!.script, value: Number(tx.outs[1]!.value) + 49_000 });    // the rest pushed to sender change
  signPsbtInput(evil, 1, receiverUtxo); evil.finalizeInput(1);

  const s = await rawServer(() => ({ status: 200, body: evil.toBase64() }));
  try {
    const broadcast: string[] = [];
    const r = await payWithPayjoin({
      uri: buildPjUri({ sp: 'tsp1qqexample', amountSat: PAY, pj: s.url }),
      inputs: [senderUtxo], outputs, paymentOutputIndex: 0,
      requestTimeoutMs: 400,
      broadcast: async (hex) => { broadcast.push(hex); return Transaction.fromHex(hex).getId(); },
    });
    assert.equal(r.payjoin, false, 'refused the short payment');
    assert.match(r.reason ?? '', /pays 1000 < 60000/);
    assert.equal(r.txid, r.originalTxid, 'the honest original went out instead');
  } finally { await s.close(); }
});
