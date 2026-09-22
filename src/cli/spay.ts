#!/usr/bin/env node
/**
 * spay — send and receive bitcoin privately by default.
 *
 *   spay receive                 run a receiving wallet with a payjoin endpoint
 *   spay receive --no-payjoin    run a plain silent-payment wallet (no endpoint)
 *   spay address                 show this wallet's silent payment address
 *   spay balance                 show both wallets' balances
 *   spay fund <btc>              (regtest) fund the sender wallet from the miner
 *   spay pay <destination> <sat> pay someone; privacy is not a flag
 */
import { BitcoinRpc } from '../chain/rpc.js';
import { SenderWallet } from '../wallet/sender-wallet.js';
import { SpWallet } from '../sp/wallet.js';
import { PayjoinReceiver } from '../payjoin/receiver.js';
import { startReceiverServer } from '../payjoin/http.js';
import { buildPjUri } from '../payjoin/uri.js';
import { pay } from '../pay/pay.js';
import { buildSignedTx, type KeyedUtxo } from '../wallet/simple.js';
import { SimpleKey } from '../wallet/simple.js';
import { writeFileSync, rmSync } from 'node:fs';
import { walletPath } from '../wallet/store.js';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, dflt?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const rpc = new BitcoinRpc();
const say = (s = '') => console.log(s);
const die = (s: string): never => { console.error(`error: ${s}`); process.exit(1); };

switch (cmd) {
  case 'receive': {
    const wallet = SpWallet.open(opt('wallet', 'receiver')!, Number(opt('from', '0')));
    const payjoinEnabled = !flag('no-payjoin');
    say(`silent payment address:\n  ${wallet.address}\n`);
    let uri = buildPjUri({ sp: wallet.address, ...(opt('amount') ? { amountSat: Number(opt('amount')) } : {}) });
    let close = async () => {};
    if (payjoinEnabled) {
      const rx = new PayjoinReceiver(wallet.receiverHooks({ isBroadcastable: async (hex) => (await rpc.testMempoolAccept(hex))[0]!.allowed }));
      const server = await startReceiverServer(rx, { port: Number(opt('port', '0')), onProposal: (p) => {
        say(`  ← payjoin request: contributed ${p.contributed.valueSat} sat input, recomputed output, fee ${p.originalFeeSat}→${p.proposalFeeSat} sat`);
      } });
      close = server.close;
      uri = buildPjUri({ sp: wallet.address, ...(opt('amount') ? { amountSat: Number(opt('amount')) } : {}), pj: server.url });
      say(`payjoin endpoint: ${server.url}`);
    } else {
      say('payjoin endpoint: (disabled — plain silent-payment wallet)');
    }
    say(`\npay me with:\n  ${uri}\n`);
    const pidFile = walletPath(`${opt('wallet', 'receiver')}.pid`).replace(/\.json$/, '');
    writeFileSync(pidFile, String(process.pid));
    say(`scanning from height ${wallet.scannedHeight + 1}… (ctrl-c to stop)`);
    const tick = async () => {
      const before = wallet.balanceSat();
      const found = await wallet.scanChain(rpc);
      for (const u of found) say(`  ✓ received ${u.valueSat} sat  (${u.txid}:${u.vout})`);
      if (found.length || wallet.balanceSat() !== before) say(`  balance: ${wallet.balanceSat()} sat in ${wallet.utxos.size} utxo(s)`);
    };
    await tick();
    const timer = setInterval(() => { void tick(); }, 2000);
    const stop = () => { clearInterval(timer); rmSync(pidFile, { force: true }); void close().then(() => process.exit(0)); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    break;
  }

  case 'address': {
    say(SpWallet.open(opt('wallet', 'receiver')!).address);
    break;
  }

  case 'balance': {
    const sender = SenderWallet.open(opt('sender', 'sender')!);
    await sender.refresh(rpc);
    const receiver = SpWallet.open(opt('wallet', 'receiver')!);
    await receiver.scanChain(rpc);
    say(`sender   ${String(sender.balanceSat()).padStart(12)} sat   ${sender.address()}`);
    say(`receiver ${String(receiver.balanceSat()).padStart(12)} sat   ${receiver.address.slice(0, 24)}…`);
    break;
  }

  case 'fund': {
    const btc = Number(args[1] ?? die('usage: spay fund <btc>'));
    const wallet = SenderWallet.open(opt('sender', 'sender')!);
    const txid = await rpc.fund(wallet.address(), btc);
    await rpc.mine(1);
    await wallet.refresh(rpc);
    say(`funded ${btc} BTC → ${wallet.address()}  (${txid})`);
    say(`balance: ${wallet.balanceSat()} sat`);
    break;
  }

  case 'pay': {
    const destination = args[1] ?? die('usage: spay pay <destination> <sat>');
    const amountSat = args[2] ? Number(args[2]) : undefined;
    const wallet = SenderWallet.open(opt('sender', 'sender')!);
    const r = await pay({ wallet, rpc, destination, amountSat, log: (s) => say(`  · ${s}`) });
    say('');
    say(r.summary);
    say(`txid: ${r.txid}`);
    if (!flag('no-mine')) { await rpc.mine(1); say('(mined 1 block)'); }
    break;
  }

  case 'spend-all': { // receiver-side convenience: prove found funds are spendable
    const wallet = SpWallet.open(opt('wallet', 'receiver')!);
    await wallet.scanChain(rpc);
    const utxos = [...wallet.utxos.values()] as KeyedUtxo[];
    if (!utxos.length) die('nothing to spend');
    const total = utxos.reduce((a, u) => a + u.valueSat, 0);
    const fee = 200 + utxos.length * 60;
    const tx = buildSignedTx(utxos, [{ scriptPubKey: new Uint8Array(new SimpleKey().p2wpkh.output!), valueSat: total - fee }]);
    const txid = await rpc.sendRawTransaction(tx.toHex());
    await rpc.mine(1);
    say(`spent ${utxos.length} utxo(s) (${total} sat) → ${txid}`);
    break;
  }

  default:
    say(`spay — private-by-default bitcoin payments (BIP352 silent payments + BIP78 payjoin)

  spay receive [--no-payjoin] [--port N] [--wallet NAME] [--amount SAT]
  spay address [--wallet NAME]
  spay balance
  spay fund <btc>
  spay pay <destination> [sat]        destination: tsp1… | bcrt1… | bitcoin:?sp=…&pj=…
  spay spend-all

Sending privately is what happens when you send: payjoin is attempted whenever the
receiver advertises an endpoint, and a plain silent payment goes out when it does not.`);
}
