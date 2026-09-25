/**
 * How the original PSBT reaches the receiver and the proposal comes back.
 *
 * BIP78 v1 defines this as a direct HTTP POST to an endpoint the receiver hosts.
 * BIP77 (v2) replaces that with an untrusted directory the two sides poll, so the
 * receiver needs no public server — but it reuses BIP78's receiver and sender
 * checklists **verbatim** (BIP77 §"Receiver's Original PSBT checklist" and
 * §"Sender's Proposal PSBT checklist" both say "the same as BIP 78").
 *
 * So the protocol logic — and the silent-payment layer built on top of it — is
 * independent of how the two messages travel. This interface is that seam.
 */
import { buildRequestUrl, type SenderOptionalParams } from './sender.js';
import { postOriginalPsbt } from './http.js';

export interface ExchangeParams {
  /** Whatever the `pj=` parameter contained: a URL, a directory mailbox, … */
  endpoint: string;
  originalBase64: string;
  params: SenderOptionalParams;
  timeoutMs?: number;
}

export interface PayjoinTransport {
  readonly name: string;
  /** Deliver the original PSBT and return the receiver's proposal PSBT (base64). */
  exchange(p: ExchangeParams): Promise<string>;
}

/** BIP78 v1: POST the original to the receiver's endpoint, read the proposal from the response. */
export const httpV1Transport: PayjoinTransport = {
  name: 'bip78-v1-http',
  exchange: ({ endpoint, originalBase64, params, timeoutMs }) =>
    postOriginalPsbt(buildRequestUrl(endpoint, params), originalBase64, { timeoutMs }),
};
