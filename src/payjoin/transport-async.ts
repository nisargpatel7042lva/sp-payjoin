/**
 * Asynchronous payjoin over a directory (BIP77's shape — see `directory.ts` for
 * what is and is not implemented).
 *
 * The receiver makes **only outbound requests**: it polls its mailbox for an
 * original PSBT and posts the proposal back. It hosts nothing, which is the whole
 * point of v2 and the reason v1 adoption stalled.
 *
 * Everything between receiving the original and returning the proposal — the
 * receiver checklist, coin selection, the silent-payment output recomputation —
 * is the exact same code the v1 transport drives.
 */
import { pollUntilReady } from './directory.js';
import type { PayjoinReceiver, ProposalResult } from './receiver.js';
import type { PayjoinTransport } from './transport.js';
import { PayjoinReceiverError } from './errors.js';

/** Sender side: drop the original in the mailbox, wait for the proposal to appear. */
export function asyncDirectoryTransport(opts: { pollIntervalMs?: number } = {}): PayjoinTransport {
  return {
    name: 'async-directory',
    async exchange({ endpoint, originalBase64, params, timeoutMs }) {
      const url = new URL(endpoint);
      for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k.toLowerCase(), String(v));
      const drop = await fetch(url.toString(), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: originalBase64 });
      if (!drop.ok) throw new Error(`directory refused the original: ${drop.status}`);
      return pollUntilReady(`${url.origin}${url.pathname}/proposal`, { timeoutMs: timeoutMs ?? 30_000, intervalMs: opts.pollIntervalMs });
    },
  };
}

export interface AsyncReceiverHandle { stop(): void; done: Promise<ProposalResult | undefined>; error?: Error }

/**
 * Receiver side: poll the mailbox, run the normal payjoin receiver, post the proposal.
 * Returns immediately; `done` resolves with the proposal once one is produced.
 */
export function runAsyncReceiver(params: {
  receiver: PayjoinReceiver;
  mailboxUrl: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onEvent?: (e: { type: 'waiting' | 'received' | 'answered' | 'refused'; detail?: string }) => void;
}): AsyncReceiverHandle {
  let stopped = false;
  const done = (async (): Promise<ProposalResult | undefined> => {
    const deadline = Date.now() + (params.timeoutMs ?? 30_000);
    params.onEvent?.({ type: 'waiting' });
    while (!stopped && Date.now() < deadline) {
      const res = await fetch(params.mailboxUrl);
      if (res.status === 200) {
        const originalBase64 = (await res.text()).trim();
        params.onEvent?.({ type: 'received' });
        const query = new URL(params.mailboxUrl).searchParams;
        try {
          const result = await params.receiver.handle({ psbtBase64: originalBase64, query });
          await fetch(`${params.mailboxUrl.split('?')[0]}/proposal`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: result.proposalBase64 });
          params.onEvent?.({ type: 'answered' });
          return result;
        } catch (e) {
          // A refusal is a normal outcome; the sender falls back to the original.
          const err = e instanceof PayjoinReceiverError ? e : new PayjoinReceiverError('unavailable', 'internal error');
          params.onEvent?.({ type: 'refused', detail: err.errorCode });
          return undefined;
        }
      }
      await new Promise((r) => setTimeout(r, params.pollIntervalMs ?? 100));
    }
    return undefined;
  })();
  return { stop: () => { stopped = true; }, done };
}
