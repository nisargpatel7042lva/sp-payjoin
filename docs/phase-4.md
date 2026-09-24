# Phase 4 — the demo moment (2026-09-23)

`npm run demo:surveillance` — one screen, ~30 seconds, no prior context needed.

## What it does

Alice pays Bob **600,000 sat three times** on the regtest chain, and a surveillance tool is pointed
at each of the three confirmed transactions:

1. **TODAY** — a reused address, Alice's input only (how wallets work now)
2. **+ SILENT PAYMENTS** — a fresh one-time key, Alice's input only
3. **+ PAYJOIN** — a fresh one-time key *and* an input contributed by Bob (this project's default)

The tool answers three questions about each, and every answer is scored against ground truth (we
hold the keys, so we know who owns what):

| question | heuristic | TODAY | + SP | + PAYJOIN |
|---|---|---|---|---|
| Who received this money? | address reuse — a script that appeared in an earlier tx | ✓ correct | ✗ wrong | ✗ wrong |
| Who owns the inputs? | common-input-ownership | ✓ correct | ✓ correct | **✗ wrong** |
| How much was paid? | payment-amount inference | ✓ correct | ✓ correct | **✗ wrong** |

**Surveillance scores 3/3 → 2/3 → 0/3.** The two-step structure is the point: silent payments alone
remove the address but leave the payer clustered and the amount public; the join is what makes the
remaining two answers false.

The address-reuse check is a real chain-wide scan (`buildChainIndex` in `src/analysis/cioh.ts`
walks every block and counts prior appearances of each output script), not an assertion.

## Output

- Terminal: three aligned columns, each question showing what the analyst concluded, whether it was
  right, and the privacy consequence in plain words.
- `out/report.html`: the same comparison as a single standalone page (light/dark) for slides,
  screenshots, or the submission write-up. `out/report.fragment.html` is the body-only variant
  for hosting; both come from one renderer in `src/analysis/report.ts` so they cannot drift.

## Honesty notes

- Numbers come from transactions actually mined on regtest in that run; the txids are printed in the
  report footer and can be inspected with `./infra/regtest.sh cli getrawtransaction <txid> true`.
- The tool is a *naive* analyst: the three textbook heuristics, not a commercial product with
  clustering history, exchange data or timing analysis. The claim is narrow and stated as such —
  these specific heuristics produce wrong answers, which is exactly what BIP78 §"Impacted heuristics"
  predicts.
- The inflated payment figure (1,300,000 vs 600,000) is a consequence of the receiver's contributed
  input landing in its own output; an analyst who *suspects* payjoin can subtract it. Payjoin's
  value is that it makes the common-input assumption unreliable for everyone, not that it is
  undetectable.
