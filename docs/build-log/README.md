# Build log

A record of how the project was built, one entry per phase. Each was implemented, tested and
reviewed before the next began.

**These are historical.** Figures quoted inside them (test counts in particular) were true at the
time of writing and are not the current numbers — see the root `README.md` for those.

| Phase | What it covers |
|---|---|
| [0](phase-0.md) | Validating the gap; regtest environment; BIP352 layer over `@silent-pay/core` against the official vectors |
| [1](phase-1.md) | BIP78 payjoin in TypeScript, reproducing the BIP's own test vectors byte-for-byte |
| [2](phase-2.md) | Silent-payment addressing: identify-by-scanning, recompute, substitute |
| [3](phase-3.md) | One send path — the CLI, two-party flow, private by default |
| [4](phase-4.md) | The before/after surveillance demonstration |
| [5](phase-5.md) | Edge cases: timeouts, refusals, replay, reentrancy, probing, double-spend |
| [6](phase-6.md) | Privacy-aware receiver coin selection (avoiding UIH2) |

Packaging (README, submission copy, demo script) followed phase 6 and has no separate entry.
