# Submission checklist

Deadline **2026-10-05 18:29 UTC**. Work top to bottom; nothing here takes more than a few minutes.

---

## 1. Verify the thing still works (10 min)

Run each and confirm the stated result. If any fails, stop and fix before writing copy.

```bash
cd ~/sp-payjoin
./infra/regtest.sh start          # → "regtest up: height N"
npm test                          # → 152 pass, 0 fail
npm run demo:surveillance         # → the table ending 3/3 · 2/3 · 0/3
npm run demo:two-party            # → a join, then a graceful fallback
npm run web                       # → http://127.0.0.1:8080 loads; Fund, Pay, Pay again
```

Then open **https://github.com/nisargpatel7042lva/sp-payjoin** in a logged-out browser window and
confirm:

- [ ] the four Mermaid diagrams render (GitHub draws them; if one shows raw text, it did not parse)
- [ ] the repo is public, MIT licence is detected in the sidebar
- [ ] no stray files at the root — should be exactly: `README.md`, `LICENSE`, `package.json`,
      `package-lock.json`, `tsconfig.json`, `.gitignore`, and the `docs/ infra/ scripts/ src/` folders

## 2. Screenshots (20 min)

The form requires **1–6 real screenshots** and explicitly forbids generated stand-ins. Save them to
`screenshots/` in the repo folder — that directory is gitignored, so they stay off GitHub as you
wanted, while remaining next to the project on your machine.

Capture in this order; **#1 is the one that wins or loses attention.**

| # | What | How to get it | Must be visible |
|---|---|---|---|
| 1 | **The surveillance table** | `npm run demo:surveillance`, screenshot the final screen | the three columns and the `3/3 · 2/3 · 0/3` line |
| 2 | **The report page** | open `out/report.html` in a browser | the three scenario cards and the red/green verdicts |
| 3 | **The web console, mid-join** | `npm run web`, Fund → Pay → Pay, screenshot after the second | a card reading *"payjoin — receiver contributed an input"* with the WRONG verdicts |
| 4 | **The test suite** | `npm test`, screenshot the tail | `152 pass`, `0 fail` |
| 5 | *(optional)* **Two-party flow** | `npm run demo:two-party` | the join and the fallback in one frame |

Before each shot: terminal font **16pt+**, full screen, no notifications, no other tabs. Crop out
your taskbar and anything personal.

## 3. Video (30 min including retakes)

Follow [demo-script.md](demo-script.md) — 90 seconds, shot by shot, with the narration written out.
Record, watch it once, upload to YouTube **unlisted** (or Loom), and paste the link in `video_url`.

Do not speed up the terminal in post; it reads as faked.

## 4. Fill the Devfolio form

Everything is written in [submission.md](submission.md), already inside the field limits.

- [ ] **name** — `Silent Payjoin`
- [ ] **tagline** — `Private by default, not by toggle.`
- [ ] **hashtags** — Bitcoin, TypeScript, Node.js, Cryptography, Privacy (pick nearest from their list)
- [ ] **links** — `https://github.com/nisargpatel7042lva/sp-payjoin`
- [ ] **platforms** — Web
- [ ] **The problem it solves** — paste the long answer
- [ ] **Challenges we ran into** — paste the long answer
- [ ] **pictures** — the screenshots from §2
- [ ] **video_url** — from §3

## 5. Last pass before you hit submit

- [ ] Read the submission back once, out loud. It should not overclaim: the demo shows *three
      textbook heuristics returning wrong answers*, not that payjoin is undetectable.
- [ ] The repo link opens for a logged-out visitor.
- [ ] `git status` is clean and everything is pushed.
- [ ] No screenshots or video files got committed (`git ls-files | grep -iE '\.(png|jpg|mp4)$'`
      should print nothing).

## Optional, high value if you have an hour

File the upstream bug report ([../upstream-issue.md](../upstream-issue.md)) on
`Bitshala-Incubator/silent-pay` from your own GitHub account, and link it in the submission. It is
their library, they are judging, and the report comes with a runnable reproduction and a patch.
Offering the PR lands better than the report alone.
