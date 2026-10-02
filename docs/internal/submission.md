# Devfolio submission — BOSS Battle, Cypherpunk track

Paste-ready. Field names and limits come from the hackathon's own submission guide (`boss-battle`),
not guessed. Character counts verified.

---

## name  *(required, 2–50)*

```
Silent Payjoin
```

## tagline  *(required, 2–50)*

```
Private by default, not by toggle.
```

Backups, all within limit: `Payjoin, addressed by silent payments.` · `Breaks the heuristic chain analysis runs on.`

## hashtags / technologies  *(required, 1–10)*

Devfolio picks from its own list — choose the nearest matches:

```
Bitcoin · TypeScript · Node.js · Cryptography · Privacy
```

## links  *(0–5)*

```
https://github.com/nisargpatel7042lva/sp-payjoin
```

## platforms  *(0–5)*

```
Web
```

---

## The problem it solves  *(required, markdown)*

Every Bitcoin payment leaks two things.

**Who you paid.** Addresses get reused. A merchant or a donation page publishes one address, and
anyone can pull up every payment it ever received.

**Which coins are yours.** Chain surveillance rests on one assumption — the
*common-input-ownership heuristic*: if a transaction spends several inputs, one person owns them
all. It is how wallets get clustered, and it is right almost all of the time.

This project breaks both, in the same transaction, without the payer doing anything unusual.

**Silent payments (BIP352)** give the receiver one static address that produces a fresh on-chain key
for every payment. Nothing reusable is ever published.

**Payjoin (BIP78)** has the receiver contribute one of their own coins to the payment. Now the
inputs belong to two different people, and the heuristic returns a wrong answer — it files a
stranger's coin under the payer's wallet, and reads the payment as larger than it was.

### Why nobody had already combined them

BIP352 derives the receiver's output from **every input of the transaction**. A payjoin **changes
the input set after the sender has already built and signed it**. The output the sender computed is
wrong the moment the receiver adds a coin — those funds would be unspendable by anyone.

The resolution uses BIP78 exactly as written. Under *payment output substitution* the receiver may
rewrite the scriptPubKey of the output paying itself. So the receiver:

1. runs its **scan key over the sender's PSBT** to recognise which output pays it — no invoice ID,
   no session state, the cryptography *is* the addressing;
2. adds one of its coins, chosen to keep the transaction in the ordinary-payment shape;
3. **recomputes** the BIP352 output for the new input set, using only its scan key and the public
   input keys already in the PSBT;
4. substitutes it.

A stock BIP352 scanner finds the result. A stock BIP78 sender accepts it. Neither BIP changes.

### It is the default, not a feature

There is no privacy flag. `spay pay <address> <amount>` attempts payjoin whenever the receiver
advertises an endpoint, and falls back to a plain silent payment when they do not, when they have no
coin to contribute, when their endpoint is down or hangs, or when their proposal fails any check.
**Every fallback is still private** — the worst case is private addressing without the join, never a
reused address.

### The evidence, not the claim

`npm run demo:surveillance` builds three real transactions on a regtest chain — the same 600,000 sat
payment, three ways — and points a chain-surveillance tool at each, marking its answers against
ground truth:

| Question the analyst asks | Today (reused address) | + Silent payments | + Payjoin |
|---|---|---|---|
| Who received this money? | correct | **wrong** | **wrong** |
| Who owns the inputs? | correct | correct | **wrong** |
| How much was paid? | correct | correct | **wrong** |
| **Score** | **3/3** | **2/3** | **0/3** |

The middle column is the argument: silent payments alone remove the address but leave the payer
clustered and the amount public. Both halves are load-bearing.

`npm run verify:real` answers the obvious follow-up. It builds a real payjoin, holds it back from
the network, and asks Bitcoin Core to judge it — then changes one byte inside a signature and asks
again:

```
→ Core validates the real transaction:   allowed = true   (vsize 212, fee 0.00000826 BTC)
→ one byte changed in a signature:       allowed = false  (Invalid Schnorr signature)
```

Real secp256k1 signatures, verified by real Bitcoin Core v27.1. The coins are worthless by design —
regtest is a private chain — but the protocol and the cryptography are not simulated.

**152 tests.** The BIP78 sender reproduces the BIP's own test vectors byte-for-byte; all 28 official
BIP352 send/receive vectors pass through our derivation layer; 18 tests cover failure modes
(offline, hangs, fee cheating, replay, reentrancy, probing, double-spend) and every one ends in a
completed payment.

We wrote the composition up as a short spec (`docs/design.md`), including the one property it cannot
yet provide and a sketch for fixing it, and the limitations honestly (`docs/limitations.md`,
thirteen of them). It is regtest only, and the library it builds on says the same about itself.

---

## Challenges we ran into  *(required, markdown)*

**1. The silent-payment output is invalidated by the payjoin itself.**
BIP352 derives the recipient's key from the sum of *all* input private keys plus the smallest
outpoint. Payjoin adds an input after the sender has signed, so both terms change and the carefully
derived output would pay a key nobody can spend. We read both BIPs properly instead of guessing and
found the hook already there: BIP78's payment output substitution lets the receiver rewrite the
output paying itself, and the sender's checklist explicitly performs no check on it. The receiver
identifies its own output by scanning the sender's PSBT with its scan key, then recomputes the
output for the joined input set from public data plus its scan key.

**2. A bug in the library, not in our code — and a silent one.**
Payments stopped being found after the first. `@silent-pay/core`'s secp256k1 backend mutates private
keys **in place**, so `scanOutputs()` overwrites the caller's scan key. A wallet finds its first
payment and then never another, with no error anywhere — it reads like a broken indexer. Fixed with
defensive copies and pinned by a regression test. It is Bitshala's own library; we have drafted the
report with a self-contained reproduction and a patch. It was one of six library quirks we had to
wrap, four of which only surfaced because we ran the official BIP352 vectors through our own layer
instead of trusting the library with them.

**3. Discovering, mid-write-up, that the sender cannot verify the substitution.**
We started implementing a sender-side check that the substituted output really pays the intended
silent payment address — then worked the maths and found it is impossible. BIP352's *sender* route
needs the private keys of every input, and the sender will never have the receiver's. Only the
receiver can recompute. We stopped, documented the asymmetry as the composition's one real cost, and
implemented what *is* checkable: the value going to outputs the sender does not own must be at least
what it meant to pay, so a proposal that substitutes the output and guts its value is refused. The
design doc sketches a proper fix — the receiver supplies its half of the ECDH term with a DLEQ proof
— and marks it clearly as unimplemented and unreviewed.

**4. A test that failed and taught us the real threshold.**
Contributing the largest coin makes a payjoin conspicuous. The reference behaviour is to avoid UIH2
(Ghesmati et al. 2022): keep the smallest input larger than the smallest output so the transaction
still reads as an ordinary spend. Our first end-to-end test asserted that and failed — in the
scenario we had written, the sender's change was larger than any coin the receiver held, so *no*
choice could avoid UIH2. The failure taught us the actual rule: **the contribution must exceed the
sender's change.** The receiver now contributes the smallest coin that clears it, which also exposes
less of its wallet than the reference implementation's first-match behaviour.

**5. Making the private path genuinely un-skippable.**
Easy to say, fiddly to build. A receiver may be offline, may accept the connection and never reply,
may have no coin to contribute, may return a malformed or fee-cheating proposal. Every one of those
was originally a hang or a thrown error. There are now 18 failure-mode tests and each ends the same
way: the payment still happens, as a plain silent payment.

---

## pictures  *(required, 1–6 — real screenshots only)*

See [submission-checklist.md](submission-checklist.md) §2 for exactly what to capture.

## video_url

See [demo-script.md](demo-script.md) — a 2:30 terminal-only script, shot by shot.
