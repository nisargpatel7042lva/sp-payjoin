# Phase 1 — BIP78 PayJoin core, plain addresses (2026-09-21)

Decision (with you): implement BIP78 v1 in TypeScript (option C). The `payjoin` npm/WASM bindings
are BIP77-v2-only (no v1 `from_request` receiver, sender only has `createV2PostRequest`);
`payjoin-cli` holds keys in bitcoind; `payjoin-client` (bitcoinjs) is 2021/bitcoinjs v5.

## Built (`src/payjoin/`, `src/wallet/`, `src/analysis/`)

| File | Role |
|---|---|
| `sender.ts` | Port of BIP78's reference sender: `createOriginalPsbt`, request URL params, the full proposal checklist, `minfeerate` check |
| `receiver.ts` | Receiver with injected hooks (broadcastable, ownership, seen-inputs, coin selection, signing, **output substitution**): original-PSBT checklist, random-index input insertion, fee accounting (sender contribution capped by `maxadditionalfeecontribution`, `feerate×110`, dust; receiver pays the rest; `minfeerate` honoured) |
| `client.ts` | Orchestration: sign → original → POST → verify → sign only original inputs → broadcast; any failure ⇒ broadcast the original (BIP78 fallback) |
| `http.ts` | Receiver endpoint (`200 text/plain` PSBT / JSON well-known errors, `Access-Control-Allow-Origin: *`) and sender POST |
| `uri.ts` | BIP21 `pj=` / `pjos=0` |
| `wallet/psbt-wallet.ts` | PSBT build/sign: P2WPKH via bitcoinjs; P2TR key-path signed manually (needed for SP outputs in Phase 2) |
| `analysis/cioh.ts` | The "analyst": common-input-ownership + payment-amount inference, scored against ground truth |

Deviation from the letter of the BIP, matching its own test vector: the proposal keeps
`witnessUtxo` on the sender's inputs (BTCPay does; the sender refills it anyway).

## Tests — `npm test` → 80/80

- `sender.test.ts` (12): **byte-for-byte** reproduction of the BIP78 vectors (`Original PSBT` and
  `payjoin proposal filled with sender's information`), plus every checklist rejection on tampered
  proposals (version/locktime, finalized/signed/keypathed sender input, unfinalized receiver input,
  missing utxo, sequence changes, missing input, fee decrease, over-contribution, decreased output).
- `receiver.test.ts` (7): proposal structure, fee accounting with/without sender contribution,
  substitution hook (+ `disableoutputsubstitution`), all well-known errors, replay defence.
- `regtest.test.ts` (2): real PayJoin over HTTP confirms with one input from each party and the
  heuristic is wrong about it; endpoint down ⇒ original broadcasts and the heuristic is right.
- `analysis/cioh.test.ts` (2), `sp/vectors.test.ts` (57) unchanged.

## Gate — `npm run demo:payjoin`

A: normal payment → analyst H1/H2 both CORRECT. B: PayJoin (receiver added 500 000 sat input,
fee 500→738 sat, sender contributed 238) → H1 "all inputs one entity" **WRONG** (owned by
receiver and sender), H2 "payment = 1 100 000 sat" **WRONG** (actual 600 000).

## Notes / risks

- Loopback `http://`; production needs TLS/onion (BIP78 §Protocol).
- Receiver's probing-attack mitigation is minimal: seen-input set only (no UTXO reuse-on-abort logic).
- `minfeerate` is enforced by the receiver by raising its own fee share; the sender also checks it post-sign.
