# Demo video — 90 second script

Shot-by-shot, with the exact commands and what to say over each. Written to be recordable in one
take after the pre-flight below.

**Target: 90 seconds.** Judges watch a lot of these. The whole argument lands by 0:60; everything
after is proof.

---

## Pre-flight (do this before you hit record)

```bash
cd ~/sp-payjoin
./infra/regtest.sh start          # must already be running — do not film the startup
npm test                          # confirm 152/152 before filming
rm -rf ~/.spay                    # clean wallets, so the console starts empty
```

- Terminal font size **16pt or larger**. Judges may watch this on a laptop.
- Full-screen the terminal. No tab bars, no notifications, no visible Slack.
- Dark or light, but match the browser theme so the cut does not flash.
- Have `http://127.0.0.1:8080` open in a second window, already loaded.
- Do a dry run once. The surveillance demo takes a few seconds to mine blocks; know the pauses.

---

## 0:00 – 0:12 · The gap

**Screen:** the README, scrolled to *"Why this and not another privacy dashboard"*.

> "Thirty-seven projects were submitted to this hackathon. Six of them score or visualise your
> Bitcoin privacy. None of them change it. We built a mechanism."

*Do not linger. Twelve seconds, then cut.*

## 0:12 – 0:22 · What it does

**Screen:** cut to a clean terminal.

> "Alice pays Bob. Bob's wallet quietly adds one of his own coins to the same transaction. Every
> chain-analysis tool assumes all the inputs in a transaction belong to one person. That assumption
> is now wrong."

## 0:22 – 0:55 · The proof  ← *this is the shot that matters*

**Type, on camera:**

```bash
npm run demo:surveillance
```

> "This builds three real transactions on a regtest chain. The same payment, three ways: how wallets
> do it today with a reused address, then with silent payments, then with silent payments plus
> payjoin. Then it points a surveillance tool at each one and checks its answers against what
> actually happened — we hold the keys, so we know."

**When the table renders, stop talking for two seconds.** Let them read it. Then:

> "Today: it gets all three right. Who was paid, how much, and whose coins they were.
> Add silent payments: the address is gone, but the payer is still clustered and the amount is still
> public.
> Add payjoin: **nothing is right**. It names the wrong owner, and the wrong amount."

**Point at the bottom line:** `3/3 → 2/3 → 0/3`.

> "Both halves are doing work. Silent payments hide who. Payjoin breaks the clustering."

## 0:55 – 1:12 · It is the default, not a setting

**Screen:** switch to the browser at `http://127.0.0.1:8080`.

Click **Fund**, then **Pay**. It falls back — the receiver has no coin yet. Click **Pay** again; this
one joins.

> "The payer never picks a protocol. The same command attempts payjoin if the receiver can do it,
> and sends a plain silent payment if they can't. First payment fell back — the receiver had nothing
> to contribute yet. Second one joined."

**Flip the payjoin toggle off. Click Pay once more.**

> "Receiver turns payjoin off entirely — same button, still private, just no join. There is no
> privacy setting to forget to switch on."

## 1:12 – 1:25 · It is real, not a mock

**Screen:** cut back to the terminal.

```bash
npm test
```

> "A hundred and fifty-two tests. The payjoin sender reproduces BIP78's own test vectors
> byte-for-byte, and all twenty-eight official silent-payment vectors pass. We also found a bug in
> Bitshala's own silent-pay library while building this — it corrupts a wallet's scan key — and we're
> reporting it upstream."

## 1:25 – 1:30 · Close

**Screen:** the repo, or the report page.

> "Regtest only, and the limitations are written down in the repo, including the one thing this
> composition can't do yet. Mechanism, not a dashboard."

---

## If you only have 60 seconds

Cut §0:12–0:22 and §1:12–1:25. Keep the gap, the surveillance table, and the toggle. The table is
non-negotiable.

## Things that will hurt you

- **Do not** speed up the terminal in post. It reads as faked output.
- **Do not** narrate over the table for the first two seconds. Silence makes people read.
- **Do not** claim it is undetectable. Say *"the heuristic returns a wrong answer"* — precise, and it
  is what the demo actually shows. A Bitcoin-literate judge will respect the distinction and punish
  the overclaim.
- **Do not** show `~/.spay` wallet files. They hold plaintext regtest keys and it looks careless
  even though it's stated as a known limitation.
