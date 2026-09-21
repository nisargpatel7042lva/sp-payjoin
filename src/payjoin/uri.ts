/** BIP21 URI with BIP78 parameters (`pj`, `pjos`). Minimal: address, amount, pj, pjos. */
export interface PjUri { address: string; amountSat?: number; pj: string; pjos: boolean; raw: string }

export function parsePjUri(uri: string): PjUri {
  const m = /^bitcoin:([^?]*)\??(.*)$/i.exec(uri);
  if (!m) throw new Error('not a bitcoin: URI');
  const params = new URLSearchParams(m[2] ?? '');
  const pj = params.get('pj');
  if (!pj) throw new Error('URI has no pj= endpoint');
  const amount = params.get('amount');
  return { address: m[1] ?? '', amountSat: amount ? Math.round(Number(amount) * 1e8) : undefined, pj, pjos: params.get('pjos') !== '0', raw: uri };
}

export function buildPjUri(p: { address: string; amountSat?: number; pj: string; pjos?: boolean }): string {
  const q = new URLSearchParams();
  if (p.amountSat !== undefined) q.set('amount', (p.amountSat / 1e8).toFixed(8).replace(/\.?0+$/, ''));
  q.set('pj', p.pj);
  if (p.pjos === false) q.set('pjos', '0');
  return `bitcoin:${p.address}?${q.toString()}`;
}
