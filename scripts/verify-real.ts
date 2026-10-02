/**
 * Proof that nothing here is mocked: build a real payjoin, hold it back from the
 * network, and let Bitcoin Core judge it — first intact, then with one byte of a
 * signature changed.
 */
import { BitcoinRpc } from '../src/chain/rpc.js';
import { SimpleKey, fundAddress, withPrevouts, buildSignedTx, type KeyedUtxo } from '../src/wallet/simple.js';
import { SpWallet } from '../src/sp/wallet.js';
import { silentPaymentOutputs } from '../src/sp/send.js';
import { PayjoinReceiver } from '../src/payjoin/receiver.js';
import { startReceiverServer } from '../src/payjoin/http.js';
import { payWithPayjoin } from '../src/payjoin/client.js';
import { buildPjUri } from '../src/payjoin/uri.js';

const rpc = new BitcoinRpc();
const say = (s = '') => console.log(s);
const kv = (k: string, v: unknown) => console.log(`  ${k.padEnd(26)} ${v}`);
const chain = { isBroadcastable: async (h: string) => (await rpc.testMempoolAccept(h))[0]!.allowed };
const p2tr = async (k: SimpleKey, btc: number): Promise<KeyedUtxo> => ({ ...(await fundAddress(rpc, k.p2tr.address!, btc)), priv: k.p2trPriv, type: 'p2tr' });

say('\n  IS ANY OF THIS REAL?  — Bitcoin Core decides, not us\n' + '  '.padEnd(74, '─'));
const info = await rpc.call<{ subversion: string }>('getnetworkinfo');
kv('bitcoin core', `${info.subversion}  (regtest, block ${await rpc.getBlockCount()})`);

// Bob receives a coin the ordinary way, then contributes it to a payjoin.
const bob = new SpWallet();
const funder = new SimpleKey();
const f = await p2tr(funder, 0.02);
const [o] = silentPaymentOutputs({ keys: [{ priv: f.priv, isTaproot: true }], outpoints: [f], payments: [{ address: bob.address, amountSat: 900_000 }] });
const ft = buildSignedTx([f], [{ scriptPubKey: o!.scriptPubKey, valueSat: 900_000 }, { scriptPubKey: new Uint8Array(new SimpleKey().p2tr.output!), valueSat: f.valueSat - 900_400 }]);
const ftx = await rpc.sendRawTransaction(ft.toHex()); await rpc.mine(1);
bob.scanDecodedTx(await withPrevouts(rpc, await rpc.getRawTransaction(ftx)));
kv('bob received', `${bob.balanceSat()} sat by scanning the chain for his silent payment address`);

const alice = new SimpleKey(), change = new SimpleKey();
const a = await p2tr(alice, 0.008);
const server = await startReceiverServer(new PayjoinReceiver(bob.receiverHooks(chain)));
let rawHex = '';
await payWithPayjoin({
  uri: buildPjUri({ sp: bob.address, amountSat: 600_000, pj: server.url }),
  inputs: [a], paymentOutputIndex: 0,
  outputs: [{ sp: true, valueSat: 600_000 }, { scriptPubKey: new Uint8Array(change.p2tr.output!), valueSat: a.valueSat - 600_600 }],
  params: { additionalFeeOutputIndex: 1, maxAdditionalFeeContribution: 1000 },
  broadcast: async (hex) => { rawHex = hex; return 'held-back'; },
});
await server.close();

const tx = await rpc.call<{ vin: Array<{ txinwitness?: string[] }>; vout: unknown[] }>('decoderawtransaction', rawHex);
kv('payjoin built', `${tx.vin.length} inputs (one from each party), ${tx.vout.length} outputs`);
say();

const good = (await rpc.testMempoolAccept(rawHex))[0]!;
say(`  → Core validates the real transaction:   allowed = ${good.allowed}   (vsize ${good.vsize}, fee ${good.fees?.base} BTC)`);

const sig = tx.vin[0]!.txinwitness![0]!;
const at = rawHex.indexOf(sig);
const tampered = rawHex.slice(0, at + 20) + (rawHex[at + 20] === '0' ? '1' : '0') + rawHex.slice(at + 21);
const bad = (await rpc.testMempoolAccept(tampered))[0]!;
say(`  → one byte changed in a signature:       allowed = ${bad.allowed}   (${bad['reject-reason']})`);
say();
say(good.allowed && !bad.allowed
  ? '  Real secp256k1 signatures, verified by real Bitcoin Core. The coins are worthless\n  by design — regtest is a private chain — but the protocol and the cryptography are not.\n'
  : '  unexpected result\n');
