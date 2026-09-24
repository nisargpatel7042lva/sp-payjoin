# Phase 5 — edge cases (2026-09-24)

Every failure mode ends the same way: **the payment still happens**. The payjoin is abandoned and
the original transaction — itself a complete, private silent payment — is broadcast. Nothing hangs,
throws to the caller, or pays twice.

## Fixed in this phase

| Problem | Before | Now |
|---|---|---|
| Receiver accepts the connection and never answers | `fetch` waited indefinitely — the payment hung | `AbortSignal.timeout` (default 30 s, configurable via `requestTimeoutMs`) → fall back |
| Proposal fails a check *after* signing (e.g. below `minfeerate`) | `payWithPayjoin` threw; the caller had a signed payment and no broadcast | caught → fall back and broadcast the original |
| Probing: an attacker posts many originals to enumerate the receiver's UTXOs | each request could expose a different coin | BIP78 mitigation: exposed outpoints are tracked and **re-offered in priority**, so a prober learns one coin, not the wallet |

`PayjoinReceiver.exposedInputs` is the tracked set (injectable and persistable via
`ReceiverOptions.exposedInputs`); `SpWallet` honours the hint in its coin selection.

## Tests — 136 total, all passing (3 consecutive clean runs)

`src/payjoin/edge-cases.test.ts` (15, in-memory and deterministic):

- receiver offline · accepts then never answers (asserts it returns in under 5 s) · dies mid-response
- receiver has no UTXO → `unavailable` · cannot cover the added weight → `not-enough-money`
- unsupported version → `version-unsupported`, carrying the versions the receiver speaks
- receiver takes more fee than `maxadditionalfeecontribution` → proposal rejected
- receiver adds weight without raising the fee, dropping below `minfeerate` → proposal rejected
- receiver returns garbage (three shapes) → no crash
- replay: the same original posted twice · reentrancy: a proposal fed back as a new original,
  checked with the receiver's input at **both** possible indices
- probing: four crafted originals from different senders → exactly one UTXO exposed
- a sender input the receiver owns → refused, never signed
- well-known errors arrive over HTTP as JSON with `Access-Control-Allow-Origin: *`

`src/payjoin/double-spend.regtest.test.ts` (2, live node):

- the sender takes the proposal and broadcasts the **original** anyway: the payment confirms, the
  proposal is then rejected by the node as a conflict, and the coin the receiver exposed is still
  unspent and still spendable by the receiver
- repeated probes against a live wallet re-offer the same coin

## Notes

- A flake found and fixed while hardening: the receiver inserts its input at a random index
  (BIP78 requires this), so a reentrant PSBT can trip *either* "seen before" or "owned by the
  receiver" depending on ordering. Both are correct; the test now pins the index where it asserts
  a specific message and covers both orderings separately.
- Still out of scope, and honest about it: no persistence of `exposedInputs` across restarts (the
  set is injectable, so a caller can persist it), and the receiver does not watch the mempool to
  detect that an original was broadcast — it re-offers exposed coins unconditionally, which is the
  conservative reading of BIP78's "reused in priority".
