/** BIP78 transport: receiver HTTP endpoint and sender POST. Plain http on loopback for regtest; production must use TLS/onion. */
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { PayjoinReceiverError } from './errors.js';
import type { PayjoinReceiver, ProposalResult } from './receiver.js';

export async function startReceiverServer(receiver: PayjoinReceiver, opts: { port?: number; host?: string; onProposal?: (r: ProposalResult) => void } = {}): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8').trim();
    const query = new URL(req.url ?? '/', 'http://x').searchParams;
    try {
      const result = await receiver.handle({ psbtBase64: body, query });
      opts.onProposal?.(result);
      res.statusCode = 200; res.setHeader('Content-Type', 'text/plain'); res.end(result.proposalBase64);
    } catch (e) {
      const err = e instanceof PayjoinReceiverError ? e : new PayjoinReceiverError('unavailable', 'internal error');
      res.statusCode = err.errorCode === 'version-unsupported' ? 400 : err.errorCode === 'unavailable' ? 503 : 400;
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(err.toJSON()));
    }
  });
  const host = opts.host ?? '127.0.0.1';
  server.listen(opts.port ?? 0, host);
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return { url: `http://${host}:${port}/payjoin`, server, close: () => new Promise((r) => server.close(() => r())) };
}

export class PayjoinHttpError extends Error { constructor(public readonly status: number, public readonly body: string) { super(`payjoin endpoint returned ${status}: ${body}`); } }

export async function postOriginalPsbt(url: string, originalBase64: string): Promise<string> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: originalBase64 });
  const text = await res.text();
  if (res.status !== 200) throw new PayjoinHttpError(res.status, text);
  return text.trim();
}
