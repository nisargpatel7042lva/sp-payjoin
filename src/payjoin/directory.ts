/**
 * A minimal store-and-forward directory, modelled on BIP77's mailbox semantics.
 *
 * ⚠️ This is the *shape* of BIP77, not BIP77. A real payjoin directory carries
 * payloads that are HPKE-encrypted to the receiver's key (ElligatorSwift-encoded,
 * padded to 7168 bytes) and reached through Oblivious HTTP so the directory never
 * learns client IPs. None of that is implemented here: this directory sees
 * plaintext PSBTs. Its purpose is to prove that the payjoin logic and the
 * silent-payment layer work unchanged when the receiver hosts nothing — which is
 * the property BIP77 exists to provide. See `docs/design.md` §"Porting to BIP77".
 *
 * Mailbox semantics follow the spec: polling an empty mailbox answers 202
 * ACCEPTED, a full one answers 200 OK with the body.
 */
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';

interface Mailbox { original?: string; proposal?: string }

export class PayjoinDirectory {
  private readonly mailboxes = new Map<string, Mailbox>();
  private server?: Server;
  url = '';

  /** 64-bit short id, as BIP77 uses for mailbox addressing. */
  static newSessionId(): string { return randomBytes(8).toString('hex'); }

  private box(id: string): Mailbox {
    const existing = this.mailboxes.get(id);
    if (existing) return existing;
    const fresh: Mailbox = {};
    this.mailboxes.set(id, fresh);
    return fresh;
  }

  async start(port = 0): Promise<this> {
    this.server = createServer(async (req, res) => {
      const [, id, slot] = (req.url ?? '').split('?')[0]!.split('/');
      if (!id) { res.statusCode = 404; return res.end(); }
      const box = this.box(id);
      const key = slot === 'proposal' ? 'proposal' : 'original';
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        box[key] = Buffer.concat(chunks).toString('utf8').trim();
        res.statusCode = 200; return res.end('ok');
      }
      if (req.method === 'GET') {
        const value = box[key];
        if (!value) { res.statusCode = 202; return res.end(); }   // nothing waiting yet
        res.statusCode = 200; res.setHeader('Content-Type', 'text/plain');
        return res.end(value);
      }
      res.statusCode = 405; res.end();
    });
    this.server.listen(port, '127.0.0.1');
    await once(this.server, 'listening');
    const { port: bound } = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${bound}`;
    return this;
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
  }

  /** What the directory can see. Used by tests to state plainly what it does and does not learn. */
  inspect(id: string): Mailbox { return { ...this.box(id) }; }
}

/** Polls `url` until it answers 200, or the deadline passes. */
export async function pollUntilReady(url: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<string> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  for (;;) {
    const res = await fetch(url);
    if (res.status === 200) return (await res.text()).trim();
    if (res.status !== 202) throw new Error(`directory answered ${res.status}`);
    if (Date.now() > deadline) throw new Error('timed out waiting for the mailbox');
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 100));
  }
}
