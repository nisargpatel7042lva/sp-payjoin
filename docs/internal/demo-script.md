# Demo video script — terminal only

**Target 2:30.** Everything happens in a terminal; there is no web UI in this cut. A 90-second
version is at the bottom if the submission caps you.

The argument lands in three moves: **what we built** → **proof the privacy claim is true** →
**proof none of it is faked**. Architecture comes early and briefly, because judges need the shape
before the evidence means anything.

---

## Pre-flight — do this before recording

```bash
cd ~/sp-payjoin
./infra/regtest.sh start      # must already be up; never film the startup
npm test                      # confirm 152 pass before you record
clear
```

- Terminal **16pt or larger**, full screen, dark theme, nothing else on screen.
- Window at least 100 columns wide — the surveillance table is 100 wide and **wraps badly if narrow**.
  Check with `tput cols`.
- Notifications off. No visible file paths with your name if you can avoid it.
- Dry-run the whole thing once. Know where the pauses are.

---

## 0:00 – 0:15 · The assumption

**Screen:** terminal, blank. Nothing moves. Let the claim land before anything happens.
**Say:**

> "Almost every Bitcoin surveillance tool rests on one assumption: if a transaction spends several
> coins, one person owns them all. It's right almost every time — it's how wallets get clustered,
> how exchanges build profiles, how a payment gets traced back to you.
>
> We made it wrong."

### Two alternates, if that voice isn't yours

**The two leaks** — plainer, better if the judge may not be deep in Bitcoin:

> "Pay someone in Bitcoin and you leak two things you never agreed to: who you paid, because
> addresses get reused — and which coins are yours, because everything you spend together gets
> filed under one name. This fixes both, in a single transaction, and nobody has to switch
> anything on."

**The strange fact** — most arresting, drops you straight into the mechanism:

> "In the transaction I'm about to show you, the person being paid secretly added their own money
> to it. Their wallet did that automatically. The payer never knew, never chose it — and that one
> move breaks the main tool chain surveillance runs on."

*Pick one and commit. Don't stack them.*

## 0:15 – 0:40 · What it is

**Type:** `npm run arch`
**Say, over the output:**

> "Two Bitcoin standards that nobody had combined. Silent payments, BIP352, give the receiver one
> static address that produces a fresh key for every payment — so there's no reusable address on the
> chain. Payjoin, BIP78, has the receiver secretly add one of their own coins to your payment — so
> the assumption that all inputs belong to one person becomes false."

**Point at `src/pay/`:**

> "And this is the part that makes it a product: one send path. Payjoin is attempted automatically
> and falls back to a plain silent payment if it can't happen. There's no privacy setting to forget
> to switch on."

## 0:40 – 1:05 · How the two actually fit together

**Screen:** stay on the `npm run arch` output.
**Say:**

> "Combining them isn't obvious, and that's the interesting part. BIP352 derives the receiver's
> output from *every input in the transaction* — but payjoin adds an input *after* the sender has
> already built and signed it. The output the sender computed is now wrong.
>
> The fix uses BIP78 exactly as written. The receiver scans the sender's PSBT with its scan key to
> recognise its own output — no invoice ID, no session state, the cryptography *is* the addressing —
> adds its coin, recomputes the output for the new input set, and substitutes it. BIP78 explicitly
> permits that substitution."

*This is the one dense passage. Say it slowly; it is the intellectual core of the submission.*

## 1:05 – 1:55 · The proof ← **the shot that matters**

**Type:** `npm run demo:surveillance`
**Say while it builds:**

> "This builds three real transactions on a regtest chain. The same payment, three ways: how wallets
> do it today with a reused address, then with silent payments, then with silent payments plus
> payjoin. Then it points a chain-surveillance tool at each one and marks its answers against what
> actually happened — we hold the keys, so we know the truth."

**When the table appears, STOP TALKING for two full seconds.** Let them read. Then:

> "Today: all three correct. Who was paid, how much, whose coins they were.
> Silent payments: the address is gone — but the payer is still clustered and the amount is public.
> Payjoin on top: **nothing is right.** Wrong owner, wrong amount."

**Point at the bottom line — `3/3 · 2/3 · 0/3`:**

> "The middle column is the whole argument. Both halves are doing work. Silent payments hide who.
> Payjoin breaks the clustering. Neither alone is enough."

## 1:55 – 2:15 · Private by default

**Type:** `npm run demo:two-party`
**Say:**

> "Two separate processes, a receiver and a payer. First payment: the receiver has no coin to
> contribute yet, so it falls back to a plain silent payment — automatically. Second payment: now it
> has one, so it becomes a real join. Same command both times, no flags.
>
> Then the receiver turns payjoin off completely — still private, just no join. Every fallback is
> still a silent payment. The worst case is private addressing without the join; never a reused
> address."

*The output is long. Let it scroll and talk over it; don't wait for it to finish.*

## 2:15 – 2:35 · None of this is faked

**Type:** `npm run verify:real`
**Say:**

> "Last thing, because 'it works on my machine' isn't evidence. This builds a real payjoin, holds it
> back from the network, and asks Bitcoin Core to judge it. Core accepts it. Then we change a single
> byte inside one signature and ask again —"

**When the rejection line appears:**

> "— *invalid Schnorr signature.* That's real Bitcoin Core doing real script verification on real
> secp256k1 signatures. The coins are worthless by design, it's a private regtest chain, but the
> protocol and the cryptography are not simulated."

## 2:35 – 2:50 · Close

**Type:** `npm test` *(let it run; it takes ~3 seconds)*
**Say over it:**

> "A hundred and fifty-two tests. The payjoin sender reproduces BIP78's own test vectors
> byte-for-byte; all twenty-eight official silent-payment vectors pass. We also found a real bug in
> Bitshala's own silent-pay library along the way — it silently corrupts a wallet's scan key — and
> we're reporting it upstream with a patch.
>
> It's regtest only, and every limitation is written down in the repo, including the one thing this
> composition still can't do. Plenty of projects will tell you how exposed you are. This one
> changes it."

*The last line is where the "dashboards vs mechanism" point belongs — after they have watched it
work, not before. Said up front it sounds like positioning; said here it sounds like a result.*

---

## Timing at a glance

| Time | Command | The point being made |
|---|---|---|
| 0:00 | *(nothing)* | the assumption surveillance rests on — and that we broke it |
| 0:15 | `npm run arch` | what was built, and that privacy is the default |
| 0:40 | *(same screen)* | why combining the two BIPs is non-obvious |
| 1:05 | `npm run demo:surveillance` | **3/3 → 2/3 → 0/3** |
| 1:55 | `npm run demo:two-party` | join when possible, fall back cleanly, no flags |
| 2:15 | `npm run verify:real` | Core rejects a tampered signature — it's real |
| 2:35 | `npm test` | 152 tests, spec vectors, the upstream bug |

## The 90-second cut

Keep **0:00 the assumption**, **1:05 the surveillance table**, **2:15 verify:real**, and a 10-second close.
Drop the architecture and two-party sections. The table is non-negotiable; it is the only thing a
judge will still remember tomorrow.

## Things that will cost you marks

- **Don't speed up the terminal in post.** It reads as faked output, which is fatal for this project.
- **Don't narrate over the table for the first two seconds.** Silence makes people read.
- **Don't say "undetectable."** Say *"the heuristic returns a wrong answer."* An analyst who suspects
  payjoin can subtract the receiver's contribution, and a Bitcoin-literate judge knows that. The
  precise claim is stronger than the big one because it survives the follow-up question.
- **Don't say "testnet."** It is **regtest** — a private chain on your own machine.
- **Don't show `~/.spay`.** Those files hold plaintext regtest keys; it is a documented limitation,
  but it looks careless on camera.
- **Don't demo the web console in this cut.** It exists (`npm run web`) but a half-shown UI invites
  questions you don't need. The terminal is the honest surface for a protocol project.
