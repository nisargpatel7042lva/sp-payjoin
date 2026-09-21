# Phase 2 — silent payment addressing for PayJoin (2026-09-21)

## What changed

- **Sender** (`payjoin/client.ts`): a `bitcoin:?sp=<tsp1…>&pj=…` URI makes the payment output a
  BIP352-derived P2TR script computed from the sender's own inputs (`sp/send.ts`). The original
  transaction is therefore a valid plain silent payment — the BIP78 fallback stays private.
- **Receiver** (`sp/wallet.ts` → `PayjoinReceiver` hooks):
  - `identifyOutputs`: recognises its output in the original by *scanning it with the scan key*
    (no address, invoice id or metadata needed);
  - `selectInput`: contributes one of its silent-payment-received UTXOs (P2TR, spend key `b_spend + t_k`);
  - `substituteOutput`: BIP352 derives the output from **all** inputs, so once the receiver's input is
    added the sender's output is stale; the receiver recomputes `P_k` for the joined input set
    (`deriveOutput`: `b_scan · input_hash · A_sum`) and substitutes the scriptPubKey — permitted by
    BIP78 payment output substitution, which the sender checklist explicitly does not check.
- **Receiver protocol** (`payjoin/receiver.ts`): `identifyOutputs` hook; substitution hook now receives
  the final input set (with sender witnesses, so P2WPKH pubkeys are extractable) and runs per receiver output with its `k`.
- **Signing**: P2TR key-path signatures are written as `tapKeySig` so the sender's PSBT stays
  unfinalized until `createOriginalPsbt` (BIP78 flow) and the receiver can `finalizeInput` its own.

## Bug found in `@silent-pay/core` (worked around)

Its `secp256k1` backend's `privateKeyTweakMul` mutates the private key **in place**, so
`scanOutputs()` corrupts the caller's scan private key after one call. Symptom: a wallet finds its
first payment and then never another. Fix: `scanTx` passes copies (`sp/keys.ts`); regression test
`sp/keys.test.ts`. Worth reporting upstream.

## Tests — `npm test` → 111/111 (stable over 3 runs)

- `sp/vectors.test.ts` +28: receiver-side `deriveOutput` reproduces every BIP352 receive vector.
- `sp/keys.test.ts`: keys unchanged across scans; derive == scan == sender.
- `sp/sp-payjoin.regtest.test.ts`: (1) plain SP payment → wallet finds it; (2) SP+PayJoin: both
  inputs in the confirmed tx, sender-derived output absent, substituted output present;
  (3) standard scan of the confirmed tx: contributed UTXO retired, exactly one new UTXO found,
  balance = old + payment − receiver fee share; (4) the wallet spends it (confirmed).
  Plus a property test: receiver-side derivation == sender-side for random mixed P2WPKH/P2TR input sets.
- Phase 1 suites unchanged (fixed a parallel-mining flake: `confirmations >= 1`).

## Gate — `npm run demo:sp-payjoin`

Static `tsp1…` address → plain SP payment found by scanning → PayJoin: receiver identifies its
output by scanning the original, contributes its SP UTXO, recomputes the output (`8f99…` replaced by
`2957…`), tx confirms with one input per party → analyst H1 and H2 both WRONG, no address anywhere →
wallet scan: balance 700 000 → 1 300 000 sat, one UTXO → receiver spends it.

## Notes

- BIP21 `sp=` is a convention (BIP352 defines no URI form); the address is also accepted in the path.
- BIP352 states collaborative-input derivation lacks a formal security proof; our receiver only ever
  adds its *own* keys to the sum and is the party scanning, so nothing is delegated to a third party.
