/**
 * Phase 0 gate: silent payments standalone on regtest (no PayJoin).
 *   1. receiver derives a silent payment address (tsp1...)
 *   2. sender funds a P2WPKH key, derives the BIP352 output for that address, broadcasts
 *   3. receiver scans the confirmed transaction from the chain, finds the output, derives the tweak
 *   4. receiver spends the found output with b_spend + t_k, broadcasts
 */
import { BitcoinRpc } from '../src/chain/rpc.js';
import { newReceiverKeys, spAddress, scanTx } from '../src/sp/keys.js';
import { derivationContext } from '../src/sp/inputs.js';
import { silentPaymentOutputs } from '../src/sp/send.js';
import { SimpleKey, fundAddress, buildSignedTx, toView, withPrevouts, spUtxo } from '../src/wallet/simple.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const step = (s: string) => console.log(`\n[${s}]`);
const kv = (k: string, v: unknown) => console.log(`   ${k.padEnd(18)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);

const rpc = new BitcoinRpc();
kv('regtest height', await rpc.getBlockCount());

step('1. receiver: silent payment address');
const receiver = newReceiverKeys();
const address = spAddress(receiver);
kv('scan pub', hex(receiver.scanPub));
kv('spend pub', hex(receiver.spendPub));
kv('address', address);

step('2. sender: fund a P2WPKH key and pay the silent payment address');
const sender = new SimpleKey();
const utxo = await fundAddress(rpc, sender.p2wpkh.address!, 0.5);
kv('sender utxo', `${utxo.txid}:${utxo.vout} (${utxo.valueSat} sat)`);
const PAY = 20_000_000, FEE = 300;
const [spOut] = silentPaymentOutputs({ keys: [{ priv: sender.priv, isTaproot: false }], outpoints: [utxo], payments: [{ address, amountSat: PAY }] });
kv('derived output', `P2TR ${hex(spOut!.xOnly)}`);
const change = new SimpleKey();
const tx1 = buildSignedTx(
  [{ ...utxo, priv: sender.priv, type: 'p2wpkh' }],
  [{ scriptPubKey: spOut!.scriptPubKey, valueSat: PAY }, { scriptPubKey: new Uint8Array(change.p2wpkh.output!), valueSat: utxo.valueSat - PAY - FEE }],
);
const txid1 = await rpc.sendRawTransaction(tx1.toHex());
await rpc.mine(1);
kv('broadcast', `${txid1} (confirmed)`);

step('3. receiver: scan the on-chain transaction (only scan key + public data)');
const chainTx = await withPrevouts(rpc, await rpc.getRawTransaction(txid1));
const ctx = derivationContext(toView(chainTx))!;
kv('sum input pubkeys', hex(ctx.sumPubkeys));
kv('input_hash', hex(ctx.inputHash));
const found = scanTx(receiver, ctx.sumPubkeys, ctx.inputHash, chainTx.vout.map((o) => ({ vout: o.n, scriptPubKeyHex: o.scriptPubKey.hex })));
kv('matches', found.map((m) => ({ vout: m.vout, tweak: hex(m.tweak).slice(0, 16) + '…' })));
if (found.length !== 1 || hex(found[0]!.xOnly) !== hex(spOut!.xOnly)) throw new Error('receiver did not find the payment');
kv('amount received', chainTx.vout[found[0]!.vout]!.value * 1e8 + ' sat');

step('4. receiver: spend the silent payment output (b_spend + t_k)');
const dest = new SimpleKey();
const spIn = spUtxo(receiver, chainTx, found[0]!.vout, found[0]!.tweak);
const tx2 = buildSignedTx([spIn], [{ scriptPubKey: new Uint8Array(dest.p2wpkh.output!), valueSat: spIn.valueSat - FEE }]);
const accept = await rpc.testMempoolAccept(tx2.toHex());
kv('mempool accept', accept[0]);
const txid2 = await rpc.sendRawTransaction(tx2.toHex());
await rpc.mine(1);
kv('spent in', `${txid2} (confirmed)`);

console.log('\nRESULT: silent payment send → scan → spend OK');
