/**
 * Payment destinations. A destination is whatever the payer was given: a bare
 * silent payment address, a bare on-chain address, or a BIP21 URI that may or
 * may not advertise a BIP78 `pj=` endpoint.
 *
 * `sp` carries a BIP352 address. No BIP defines a BIP21 form for silent
 * payments yet, so we use `bitcoin:?sp=<tsp1…>` and also accept the address in
 * the URI path (`bitcoin:tsp1…?pj=…`) or on its own.
 */
export interface Destination {
  /** BIP352 silent payment address, if the destination is one. */
  sp?: string;
  /** Plain on-chain address, if the destination is one. */
  address?: string;
  amountSat?: number;
  /** BIP78 endpoint. Absent ⇒ the receiver cannot payjoin; the payer just sends. */
  pj?: string;
  /** false when the receiver forbids payment output substitution (`pjos=0`). */
  pjos: boolean;
  raw: string;
}

/** BIP21 URI that definitely has a `pj=` endpoint. */
export type PjUri = Destination & { pj: string };

const isSp = (s: string) => /^(sp|tsp)1[02-9ac-hj-np-z]+$/i.test(s);

export function parseDestination(input: string): Destination {
  const s = input.trim();
  if (!/^bitcoin:/i.test(s)) {
    if (isSp(s)) return { sp: s, pjos: true, raw: s };
    if (s.length > 0 && !s.includes(' ')) return { address: s, pjos: true, raw: s };
    throw new Error(`not a payment destination: ${input}`);
  }
  const m = /^bitcoin:([^?]*)\??(.*)$/i.exec(s)!;
  const params = new URLSearchParams(m[2] ?? '');
  const amount = params.get('amount');
  let address = m[1] ?? '';
  let sp = params.get('sp') ?? undefined;
  if (isSp(address)) { sp = address; address = ''; }
  if (!sp && !address) throw new Error('URI names no address');
  return {
    ...(sp ? { sp } : {}),
    ...(address ? { address } : {}),
    ...(amount ? { amountSat: Math.round(Number(amount) * 1e8) } : {}),
    ...(params.get('pj') ? { pj: params.get('pj')! } : {}),
    pjos: params.get('pjos') !== '0',
    raw: s,
  };
}

/** Strict variant for call sites that require a payjoin endpoint. */
export function parsePjUri(uri: string): PjUri {
  const d = parseDestination(uri);
  if (!d.pj) throw new Error('URI has no pj= endpoint');
  return d as PjUri;
}

export function buildPjUri(p: { address?: string; sp?: string; amountSat?: number; pj?: string; pjos?: boolean }): string {
  const q = new URLSearchParams();
  if (p.sp) q.set('sp', p.sp);
  if (p.amountSat !== undefined) q.set('amount', (p.amountSat / 1e8).toFixed(8).replace(/\.?0+$/, ''));
  if (p.pj) q.set('pj', p.pj);
  if (p.pjos === false) q.set('pjos', '0');
  return `bitcoin:${p.address ?? ''}?${q.toString()}`;
}
