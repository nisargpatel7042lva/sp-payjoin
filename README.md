# sp-payjoin

**PayJoin (BIP78) addressed by silent payments (BIP352), with the private path as the default path.**

Alice pays Bob. Bob's wallet quietly adds one of his own coins to the same transaction. Chain
surveillance assumes every input in a transaction belongs to one person — that assumption is now
false. And Bob is addressed by a static silent payment address, so there is no reusable address on
the chain to search for either.

The payer never chooses a protocol. `spay pay <address> <amount>` attempts payjoin whenever the
receiver can do it, and sends a plain silent payment when they cannot. Both paths are private; only
the join differs.

## Why this and not another privacy dashboard

At the time of writing, 37 projects had been submitted to this hackathon. We pulled the full list
from Devfolio's API and keyword-scanned every name, tagline, description and tag for *payjoin,
coinjoin, coinswap, bip78, bip352, mixing* and a dozen related terms.

**Six teams built tools that score or visualise your privacy. Zero built a mechanism that changes
it.** The single keyword hit was a project that *detects* the common-input-ownership heuristic.

Measuring the problem is not the same as fixing it. This is a mechanism.

## See the point in 30 seconds

```bash
./infra/regtest.sh start
npm run demo:surveillance
```

Alice pays Bob 600,000 sat three ways on a real regtest chain — today's reused address, then silent
payments, then silent payments + payjoin — and a chain-surveillance tool answers three questions
about each transaction. Its answers are marked against ground truth, because we hold the keys.

| | TODAY | + SILENT PAYMENTS | + PAYJOIN |
|---|---|---|---|
| Who received this money? | ✓ correct | ✗ wrong | ✗ wrong |
| Who owns the inputs? | ✓ correct | ✓ correct | **✗ wrong** |
| How much was paid? | ✓ correct | ✓ correct | **✗ wrong** |
| | *3/3 correct* | *2/3* | **0/3** |

The middle column is the point: silent payments alone remove the address but leave the payer
clustered and the amount public. The join is what makes the last two answers false. Both halves are
load-bearing.

Also writes `out/report.html` — the same comparison as a page, for slides or screenshots.

## Try it yourself

```bash
npm run web                  # a console at http://127.0.0.1:8080 driving both sides for real
npm run demo:two-party       # two independent processes: a join, then a graceful fallback
npm test                     # 152 tests, including the BIP78 and BIP352 official vectors
```

## Status

- **Phase 0 — validate + environment: done.** See `docs/phase-0.md`.
- **Phase 1 — BIP78 PayJoin core (plain addresses): done.** See `docs/phase-1.md`. `npm run demo:payjoin`
- **Phase 2 — silent payment addressing: done.** See `docs/phase-2.md`. `npm run demo:sp-payjoin`
- **Phase 3 — private by default (CLI, two parties): done.** See `docs/phase-3.md`. `npm run demo:two-party`
- **Phase 4 — the before/after demo: done.** See `docs/phase-4.md`. `npm run demo:surveillance`
- **Phase 5 — edge cases hardened: done.** See `docs/phase-5.md`. Every failure mode falls back to a plain silent payment.
- **Phase 6 — privacy-aware coin selection: done.** See `docs/phase-6.md`. The receiver picks a contribution that keeps the transaction in the ordinary-payment shape (avoids UIH2).

**[The design, written up](docs/design.md)** — how silent payments and payjoin compose, why the
receiver can recompute the output and the sender cannot, what that costs, and how it ports to BIP77.

**[Submission copy](docs/submission.md)** · **[Demo video script](docs/demo-script.md)**

**[Known limitations, assumptions and open risks](docs/limitations.md)** — read this before judging
what the project claims. Regtest only; `@silent-pay/core` is experimental and so is this.

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

## See the point in 30 seconds

```bash
npm run demo:surveillance
```

Alice pays Bob 600,000 sat three ways on a real regtest chain — today's reused address, silent
payments, then silent payments + payjoin — and a surveillance tool answers three questions about
each. It scores **3/3 → 2/3 → 0/3**. Also writes `out/report.html`.

## Click through it

```bash
./infra/regtest.sh start
npm run web                 # then open http://127.0.0.1:8080
```

A local console running both sides in one process: fund the payer, press **Pay**, and watch the
transaction get built, offered to the receiver, joined or not, broadcast and mined. The toggle
switches the receiver's payjoin endpoint off so you can watch the same button fall back to a plain
silent payment. Every payment card shows the inputs with their real owners and what a
chain-analysis tool concludes. Set `PORT` to use a different port.

Pay twice: the first payment gives the receiver a coin, so the second one has something to join with.

## Use it

```bash
./infra/regtest.sh start
npm run spay -- fund 0.5                 # payer gets regtest coins
npm run spay -- receive                  # terminal 1: prints an address + payjoin URI
npm run spay -- pay '<uri>' 400000       # terminal 2: no protocol flag, ever
```

`spay pay` attempts PayJoin whenever the receiver advertises an endpoint and sends a plain silent
payment when it does not. Both paths are private; only the join differs.
