# sp-payjoin — PayJoin (BIP78) addressed by silent payments (BIP352)

A PayJoin sender/receiver flow where the receiver is addressed by a BIP352 silent
payment address, and the private (receiver-contributes-an-input) path is the default
send experience. Breaks the common-input-ownership heuristic and address reuse at once.

Built for the Bitshala BOSS Battle hackathon, Cypherpunk track.

## Status

- **Phase 0 — validate + environment: done.** See `docs/phase-0.md`.
- **Phase 1 — BIP78 PayJoin core (plain addresses): done.** See `docs/phase-1.md`. `npm run demo:payjoin`

## Layout

```
infra/regtest.sh      start/stop/fund/mine a dedicated regtest bitcoind (cookie auth, port 18543)
src/chain/rpc.ts      minimal Core JSON-RPC client
src/sp/inputs.ts      BIP352 input-pubkey extraction, key sum, smallest-outpoint, input_hash
src/sp/keys.ts        receiver keys, address, scanTx(), spendingKey()
src/sp/send.ts        sender: private-key sum (mod n, taproot parity) + P2TR outputs via @silent-pay/core
src/sp/vectors.test.ts  all 28 official BIP352 send+receive vectors through our layer
src/wallet/simple.ts  keys, funding, manual P2WPKH/P2TR(BIP340) signing
scripts/sp-baseline.ts  Phase 0 gate: SP send → chain scan → spend on regtest
```

## Run

```bash
./infra/regtest.sh start
npm test            # BIP352 vectors (no node needed)
npm run demo:sp     # live regtest round trip
```
