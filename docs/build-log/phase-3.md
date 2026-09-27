# Phase 3 — the private path is the default path (2026-09-22)

## The shape of it

There is one send call and no protocol flag:

```
spay pay <destination> <sat>
```

`<destination>` is whatever the payer was handed — a bare `tsp1…` silent payment address, a bare
on-chain address, or a `bitcoin:?sp=…&pj=…` URI. `pay()` (`src/pay/pay.ts`) always:

1. builds an ordinary payment — a **BIP352-derived output** when the destination is an SP address;
2. **attempts PayJoin** whenever the destination advertises a `pj=` endpoint;
3. **broadcasts the ordinary payment** if the join cannot happen.

Privacy is therefore not something the payer opts into. Every outcome below came from the *same*
command; only the receiver differed:

| receiver | outcome |
|---|---|
| payjoin endpoint + a UTXO to contribute | joined transaction, inputs from both parties |
| payjoin endpoint, no UTXO yet (503 `unavailable`) | plain silent payment |
| endpoint advertised but down | plain silent payment |
| plain SP wallet, no endpoint at all | plain silent payment |

Every fallback is still a silent payment, so the worst case is *private addressing without the join*
— never a plain reused address.

## Built

| File | Role |
|---|---|
| `payjoin/uri.ts` | `parseDestination`: bare SP / bare address / BIP21, `pj` **optional** |
| `payjoin/client.ts` | no endpoint ⇒ broadcast the original; same code path as a failed join |
| `pay/pay.ts` | the one send path: select coins → build → attempt join → summarise |
| `wallet/sender-wallet.ts` | payer wallet: P2TR keys, `scantxoutset` UTXO discovery, largest-first selection, change |
| `wallet/store.ts` | JSON wallet files under `$SPAY_HOME` (regtest keys, not a keystore) |
| `sp/wallet.ts` | + persistence and `scanChain()` (every tx in every new block; a real deployment wants a BIP352 index) |
| `cli/spay.ts` | `receive` (daemon + endpoint + scanner), `pay`, `address`, `balance`, `fund`, `spend-all` |
| `scripts/two-party-demo.sh` | the gate: two independent processes, both situations |

## Tests — `npm test` → 118/118

New: `pay/pay.test.ts` (destination parsing incl. bare SP/address/`pjos=0`/errors; coin selection)
and `pay/default-path.regtest.test.ts` — one `pay()` call against (a) a plain SP wallet, (b) a dead
endpoint, (c) a live endpoint. Asserts the fallbacks complete **without error or manual
intervention**, the receiver finds the money by scanning either way, and the join case leaves the
receiver's wallet consistent (contributed UTXO retired, joined output found, balance preserved).

## Gate — `npm run demo:two-party`

Starts a real `spay receive` process, pays it from a separate `spay pay` process (falls back the
first time — the receiver has nothing to contribute yet; joins the second time), then repeats
against a `--no-payjoin` receiver. Prints both sides' logs.

Manual equivalent, two terminals:

```bash
npm run spay -- receive                      # terminal 1: prints the URI
npm run spay -- pay '<uri>' 400000           # terminal 2
```

## Notes / risks

- Wallet files hold raw private keys in plaintext under `$SPAY_HOME` — regtest only, stated in the CLI docs.
- `scanChain` walks every transaction of every block; fine on regtest, not for mainnet.
- The receiver contributes its largest UTXO; no privacy-aware coin selection yet (BIP78 suggests
  matching amounts to mimic ordinary payments — a Phase 4 candidate).
- `spay receive` writes a pidfile so scripts can stop it; `npx`/`tsx` wrappers make `$!` the wrong pid.
