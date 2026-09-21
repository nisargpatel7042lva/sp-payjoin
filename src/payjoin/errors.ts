export class PayjoinSenderError extends Error { constructor(msg: string) { super(msg); this.name = 'PayjoinSenderError'; } }

/** BIP78 well-known receiver error codes; anything else is implementation-specific and must not be shown to end users. */
export type WellKnownErrorCode = 'unavailable' | 'not-enough-money' | 'version-unsupported' | 'original-psbt-rejected';
export const WELL_KNOWN_ERRORS: Record<WellKnownErrorCode, string> = {
  unavailable: 'The payjoin endpoint is not available for now.',
  'not-enough-money': 'The receiver added some inputs but could not bump the fee of the payjoin proposal.',
  'version-unsupported': 'This version of payjoin is not supported.',
  'original-psbt-rejected': 'The receiver rejected the original PSBT.',
};

export class PayjoinReceiverError extends Error {
  constructor(public readonly errorCode: WellKnownErrorCode | string, message: string, public readonly supported?: number[]) { super(message); this.name = 'PayjoinReceiverError'; }
  toJSON() { return { errorCode: this.errorCode, message: this.message, ...(this.supported ? { supported: this.supported } : {}) }; }
}
