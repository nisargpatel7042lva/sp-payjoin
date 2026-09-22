/**
 * The one send path. The payer supplies a destination and an amount; this picks
 * coins, builds the payment (silent-payment output when the destination is an SP
 * address), and attempts PayJoin whenever the destination advertises an endpoint.
 * Anything that stops the join — no endpoint, endpoint down, proposal rejected —
 * results in the ordinary payment being broadcast instead. There is no mode flag.
 */
import { address as baddress, networks, type Network } from 'bitcoinjs-lib';
import type { BitcoinRpc } from '../chain/rpc.js';
import { parseDestination, type Destination } from '../payjoin/uri.js';
import { payWithPayjoin, type PayjoinSendResult } from '../payjoin/client.js';
import type { SenderWallet } from '../wallet/sender-wallet.js';
import type { TxOut } from '../wallet/simple.js';

export interface PayParams {
  wallet: SenderWallet;
  rpc: BitcoinRpc;
  destination: string | Destination;
  amountSat?: number;
  feeRateSatVb?: number;
  network?: Network;
  log?: (s: string) => void;
}

export interface PayResult extends PayjoinSendResult {
  destination: Destination;
  amountSat: number;
  /** What the payer should be told, in one line. */
  summary: string;
}

export async function pay(p: PayParams): Promise<PayResult> {
  const dest = typeof p.destination === 'string' ? parseDestination(p.destination) : p.destination;
  const amountSat = p.amountSat ?? dest.amountSat;
  if (amountSat === undefined) throw new Error('no amount given and the destination does not specify one');
  const network = p.network ?? networks.regtest;
  const log = p.log ?? (() => {});

  await p.wallet.refresh(p.rpc);
  const { inputs, feeSat, changeSat } = p.wallet.select(amountSat, p.feeRateSatVb);
  log(`selected ${inputs.length} input(s), ${p.wallet.balanceSat()} sat available, fee ${feeSat} sat`);

  const payment: TxOut | { sp: true; valueSat: number } = dest.sp
    ? { sp: true, valueSat: amountSat }
    : { scriptPubKey: new Uint8Array(baddress.toOutputScript(dest.address!, network)), valueSat: amountSat };
  const outputs = [payment, p.wallet.changeOutput(changeSat)];

  const result = await payWithPayjoin({
    uri: dest, inputs, outputs, paymentOutputIndex: 0, network, log,
    params: { additionalFeeOutputIndex: 1, maxAdditionalFeeContribution: Math.ceil((p.feeRateSatVb ?? 4) * 110) },
    broadcast: (hex) => p.rpc.sendRawTransaction(hex),
  });

  const how = result.payjoin
    ? `payjoin: the receiver contributed an input (${result.tx.ins.length} inputs total)`
    : `direct ${dest.sp ? 'silent payment' : 'payment'}${result.reason ? ` (${result.reason})` : ''}`;
  return { ...result, destination: dest, amountSat, summary: `${amountSat} sat sent — ${how}` };
}
