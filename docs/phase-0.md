# Phase 0 — validate + environment (2026-09-21)

## Competitive gap (re-confirmed)

Pulled all 37 BOSS Battle submissions from Devfolio's API (`boss-battle`, hackathon uuid
`ccf87307…`) and scanned **name, tagline, full description, hashtags and links** of every project
for: payjoin, bip78/77, coinjoin, coinswap, whirlpool, wabisabi, joinmarket, bip352, stonewall,
common-input, mixing/mixer/tumbler.

- Mechanism implementations found: **none**.
- Only heuristic hit: **SatoshiTrace** — runs address-reuse / common-input-ownership *detection*
  ("watch it run the exact same heuristics surveillance firms use"). A dashboard, not a mechanism.
- Privacy-scoring dashboards (the crowded lane): BlockShield AI, Satoshi Sentinel, SatoshiTrace,
  ShadowSync Agent, CypherStack, Cypherpunk — six.
- Non-obvious names checked by full text + source: **MeCuadra** (barter app; its "silent payment code"
  is a bech32m `sp…` string derived from a Nostr key used as a chat contact secret — no Bitcoin
  transactions), **Entropy Trace** (randomness tracing), **W-TVC Protocol** (AI model downgrade
  fraud), Lifeboat (LND channel recovery), Stegashareus (seed storage).

## Environment

- Native `bitcoind` v27.1 regtest, dedicated datadir `infra/bitcoin/`, cookie auth, RPC :18543;
  `infra/regtest.sh {start|stop|cli|fund|mine|reset}`. Miner wallet funds everything.
- Sender/receiver keys live in TypeScript (`src/wallet/simple.ts`); Core is chain backend only.
  This is required for BIP352 (the sender's input private keys feed the derivation) and for
  PayJoin PSBT construction later.

## `silent-pay` baseline

`@silent-pay/core@0.0.6` (Bitshala-Incubator) is used for `createOutputs`, `scanOutputs`,
address encode/decode, `createInputHash`. The `wallet`/`esplora`/`level` packages need an
Esplora + silent-block indexer stack — unnecessary here, because a PayJoin receiver holds the
sender's PSBT and can scan that single transaction directly.

Wrapped/handled on our side (pinned by the 28 official BIP352 vectors, `npm test` → 57/57):
- input public-key extraction rules (P2PKH incl. malleated scriptSig, P2SH-P2WPKH, P2WPKH,
  P2TR incl. NUMS script-path exclusion, uncompressed keys skipped);
- smallest outpoint over **all** inputs (incl. non-contributing ones);
- intermediate point-at-infinity in the key sum (library throws; we sum privately, mod n);
- `createOutputs` returns the 33-byte key in `script`, not a scriptPubKey — wrapped.
- Not enforced by the library: BIP352 K_max per-group limit (irrelevant: one output per recipient).
- Prefix `tsp` for regtest is per BIP352 (testnets share `tsp`).

Live gate (`npm run demo:sp`): receiver address → sender pays 0.2 BTC from P2WPKH →
receiver scans the confirmed tx from chain data → finds output + tweak → spends with
`b_spend + t_k` (BIP340 key-path) → confirmed. Output above.

## Design finding that shapes Phase 1–2 (read from the BIPs, not assumed)

BIP352 derives the receiver's output from **all** transaction inputs. In PayJoin the receiver
adds an input, so the sender's original output no longer matches the final input set.
BIP78 already provides the hook: **payment output substitution** — "the receiver is free to …
change the scriptPubKey output paying to himself", and the sender's checklist does *no check*
on the payment output unless `pjos=0`. So the receiver:
1. scans the sender's original PSBT with its scan key to identify its own output (no metadata needed),
2. adds its input(s),
3. recomputes the BIP352 output for the new input set (it knows `b_scan` and every input pubkey),
4. substitutes the payment output's scriptPubKey (and adds its input value to it).
A stock BIP78 sender accepts this; a stock BIP352 scanner finds it. If the receiver never
replies, the sender broadcasts the original — a normal silent payment (BIP78 fallback).
BIP352 notes the collaborative setting lacks a formal security proof; we'll say so.
