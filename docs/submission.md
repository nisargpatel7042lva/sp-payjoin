# Devfolio submission — BOSS Battle, Cypherpunk track

Copy-paste ready. Field names and limits come from the hackathon's own submission guide
(`boss-battle`), not guessed. **Character counts are verified** — see the check at the bottom.

---

## name  *(required, 2–50 chars)*

```
Silent Payjoin
```

Alternative if you prefer the repo name: `sp-payjoin`

## tagline  *(required, 2–50 chars)*

```
Private by default, not by toggle.
```

Alternatives, all within limit:
- `Payjoin, addressed by silent payments.`
- `Breaks the heuristic chain analysis runs on.`

## hashtags / technologies  *(required, 1–10)*

Devfolio picks these from its own list, so match the closest available:

```
Bitcoin · TypeScript · Node.js · Cryptography · Privacy
```

## links  *(0–5; include the repo)*

```
https://github.com/nisargpatel7042lva/sp-payjoin
```

## platforms  *(0–5)*

```
Web
```

---

## The problem it solves  *(required, markdown)*

Every Bitcoin payment you make leaks two things.

**Who you paid.** Addresses get reused. A merchant or a donation page publishes one address, and
anyone can pull up every payment it ever received.

**Which coins are yours.** Chain surveillance rests on one assumption — the
*common-input-ownership heuristic*: if a transaction spends several inputs, one person owns them
all. It is how wallets get clustered, and it is right almost all of the time.

This project breaks both, in the same transaction, without the payer doing anything unusual.

**Silent payments (BIP352)** give the receiver one static address that produces a fresh on-chain key
for every payment. Nothing reusable is ever published.

**Payjoin (BIP78)** has the receiver contribute one of their own coins to the payment. Now the
inputs belong to two different people, and the heuristic returns a wrong answer — it clusters a
stranger's coin into the payer's wallet, and it reads the payment as larger than it was.

The two do not obviously compose, and that is the interesting part. BIP352 derives the receiver's
output from **every input of the transaction**, but a payjoin **changes the input set after the
sender has already built and signed it**. The output the sender computed is wrong the moment the
receiver adds a coin.

The resolution uses BIP78 exactly as written. Under *payment output substitution* the receiver may
change the scriptPubKey of the output paying itself. So the receiver runs its **scan key over the
sender's PSBT** to recognise which output pays it — no invoice id, no session state, the
cryptography is the addressing — adds its input, **recomputes** the BIP352 output for the new input
set, and substitutes it. A stock BIP352 scanner finds the result; a stock BIP78 sender accepts it.

**And it is the default.** There is no privacy flag. `spay pay <address> <amount>` attempts payjoin
whenever the receiver advertises an endpoint, and falls back to a plain silent payment when they do
not, when they have no coin to contribute, when their endpoint is down, or when their proposal fails
any check. Every fallback is still private — the worst case is private addressing without the join,
never a reused address.

**The evidence, not the claim.** `npm run demo:surveillance` builds three real transactions on a
regtest chain and points a surveillance tool at each. It scores **3/3 → 2/3 → 0/3**. The middle
column matters: silent payments alone remove the address but leave the payer clustered and the
amount public. The join is what makes the remaining answers false.

Conformance is checked, not asserted: the BIP78 sender reproduces the BIP's own test vectors
byte-for-byte, and all 28 official BIP352 send/receive vectors pass. 152 tests.

We also wrote the composition up as a short spec (`docs/design.md`), including the one property it
cannot yet provide, and the limitations honestly (`docs/limitations.md`). It is regtest only, and
the library it builds on says the same about itself.

---

## Challenges we ran into  *(required, markdown)*

**1. The silent-payment output is invalidated by the payjoin itself.**
BIP352 derives the recipient's key from the sum of *all* input private keys plus the smallest
outpoint. Payjoin adds an input after the sender has signed. Both terms change, so the output the
sender carefully derived would pay a key nobody can spend. We read both BIPs properly instead of
guessing and found the hook already there: BIP78's payment output substitution lets the receiver
rewrite the output paying itself, and the sender's checklist explicitly performs no check on it. The
receiver identifies its own output by scanning the sender's PSBT with its scan key, then recomputes
the output for the joined input set — using only public data plus its own scan key.

**2. A bug in the library, not in our code — and a nasty one.**
Payments stopped being found after the first. `@silent-pay/core`'s secp256k1 backend mutates private
keys **in place**, so calling `scanOutputs()` silently corrupts the caller's scan key. A wallet finds
its first payment and then never another, with no error anywhere. Fixed by passing defensive copies
and pinned with a regression test. It is Bitshala's own library, and we will report it upstream.

**3. Discovering, mid-write-up, that the sender cannot verify the substitution.**
We started implementing a sender-side check that the substituted output really pays the intended
silent payment address — then worked the maths and found it is impossible. BIP352's *sender* route
needs the private keys of every input, and the sender will never have the receiver's. Only the
receiver can recompute. We stopped, documented the asymmetry as the composition's one real cost, and
implemented what *is* checkable: the value going to outputs the sender does not own must be at least
what it meant to pay, so a proposal that substitutes the output and guts its value is refused. The
design doc sketches a proper fix (the receiver supplies its half of the ECDH term with a DLEQ proof)
and marks it clearly as unimplemented.

**4. A test that failed and taught us the actual threshold.**
Contributing the *largest* coin makes a payjoin conspicuous. The reference behaviour is to avoid
UIH2 (Ghesmati et al. 2022): keep the smallest input larger than the smallest output, so the
transaction still reads as an ordinary spend. Our first end-to-end test asserted that and failed —
because in the scenario we had written, the sender's change was larger than any coin the receiver
held, so *no* choice could avoid UIH2. The failure taught us the real rule: **the contribution must
exceed the sender's change**. The receiver now contributes the smallest coin that clears it, which
also exposes less of its wallet than the reference implementation's first-match behaviour.

**5. Making the private path genuinely un-skippable.**
Easy to say, fiddly to build. A receiver may be offline, may accept the connection and never reply,
may have no coin to contribute, may send a malformed or fee-cheating proposal. Every one of those
used to be a hang or a thrown error. There are now 17 failure-mode tests, and each ends the same
way: the payment still happens, as a plain silent payment.

---

## Screenshots to attach  *(required, 1–6 — must be real screenshots)*

The form requires genuine screenshots of the running project. Capture these:

1. **`npm run demo:surveillance`** — the three-column table ending `3/3 → 2/3 → 0/3`. *This is the
   money shot; make it #1.*
2. **`out/report.html`** open in a browser — the same comparison as a page.
3. **`npm run web`** at `http://127.0.0.1:8080` after two payments — one card reading *"payjoin —
   receiver contributed an input"* with the WRONG verdicts visible.
4. **`npm test`** — the `152 pass / 0 fail` summary.
5. *(optional)* **`npm run demo:two-party`** — the join and the fallback side by side.

## video_url

See `docs/demo-script.md` for a shot-by-shot 90-second script.
