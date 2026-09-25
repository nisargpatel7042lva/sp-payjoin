# Phase 6 — privacy-aware receiver coin selection (2026-09-25)

The remaining substantive gap: the receiver contributed its **largest** coin, which makes the
joined transaction conspicuous. A payjoin is only private if the result looks like an ordinary
payment.

## The heuristic being defeated

BIP78 specifies no selection algorithm, so the reference is rust-payjoin's
`try_preserving_privacy`, which avoids **UIH2** from
[Ghesmati et al. 2022, *Unnecessary Input Heuristics and PayJoin Transactions*](https://eprint.iacr.org/2022/589):

| | condition | what an analyst reads |
|---|---|---|
| **UIH1** | smallest input **>** smallest output | a normal spend with optimally-chosen change — nothing to see |
| **UIH2** | smallest input **<** smallest output | an input was added that wasn't needed to fund the payment — *payjoin suspected* |

Concretely: the contribution must exceed the **sender's change**, or the transaction advertises
itself. Contributing a coin that is merely *large* does not help; contributing one that is large
enough does.

## What the receiver now does (`src/payjoin/coin-selection.ts`)

1. **An already-exposed coin wins.** Re-offering a coin a sender has already seen leaks nothing;
   offering a fresh one hands a prober another piece of the wallet (BIP78 §probing, Phase 5).
   Within that set, still prefer one that avoids UIH2.
2. Otherwise the **smallest coin that avoids UIH2**. Every qualifying coin produces the same shape,
   so the smallest one buys it while revealing the least.
3. Otherwise the largest coin — no privacy claim, but the payment still goes through.

### Two deliberate deviations from rust-payjoin

- It computes the smallest output as `min(min over all original outputs, receiverOutput + candidate)`,
  which leaves the receiver's *pre*-contribution output in the minimum even though that output grows.
  Its own doc comment says post-contribution amounts are what matter, so we compute exactly that.
  The difference only ever makes us **less** conservative; it never selects a candidate that fails
  the real UIH2 test.
- It returns the **first** qualifying candidate the caller offers. We return the **smallest**
  qualifying one, which achieves the identical shape while exposing less value.

## Tests — 148 total (12 new), two clean consecutive runs

`coin-selection.test.ts` (11): the shape holds / fails either side of the boundary, strict
inequality, two-output-only, post-contribution accounting, smallest-qualifying preference,
exposed-coin precedence, UIH2 preference within the exposed set, fallback, empty.

`sp-payjoin.regtest.test.ts` (+1, live chain): a receiver holding **30 000 / 1 500 000 / 900 000 /
5 000** sat is paid 600 000 from an 800 000 coin (change ≈ 199 400). Only 900 000 and 1 500 000
clear the change; the receiver contributes **900 000** — not the largest, and not the first that
qualifies — and the confirmed transaction satisfies `min(input) > min(output)`.

## Honest limit

This defeats *this* heuristic. A receiver whose coins are all smaller than the sender's change
cannot avoid UIH2 at all, and the code correctly falls back rather than pretending otherwise.
Amount correlation, input-type uniformity and the round-fee-rate tell remain unaddressed
(see `docs/limitations.md` §6).
