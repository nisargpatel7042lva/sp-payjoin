# Working with the ecosystem: what we had to wrap

Six places where a library did something surprising and we had to work around it. Collected here
because the next person building on `@silent-pay/core` — Bitshala's own silent-payments library —
will hit the same ones, and because "what did you have to work around?" is a fair question to ask
of any project that leans on young dependencies.

Every item below is pinned by a test, so a dependency bump cannot quietly undo the workaround.

---

## 1. `scanOutputs()` destroys the caller's scan key — the one that cost us real time

**`@silent-pay/core@0.0.6`.** The `secp256k1` bindings write their result *into the first argument*
when no output buffer is given, and `scanOutputs()` passes a caller-owned private key straight into
`privateKeyTweakMul`. The caller's scan key is overwritten by the call.

The failure is silent and delayed: the first scan succeeds, and every scan after it finds nothing.
No exception. It reads like a broken indexer, not a corrupted key.

```ts
// src/sp/keys.ts — pass copies, or the wallet's scan key is gone after one scan
scanOutputs(new Uint8Array(keys.scanPriv), new Uint8Array(keys.spendPub), …)
```

Probed across the primitives: `privateKeyTweakMul` and `privateKeyTweakAdd` mutate their first
argument; the `publicKeyTweak*` pair do not. So `scanOutputsWithTweak()` is unaffected, and
`calculateSumOfPrivateKeys()` escapes only because it tweaks arrays it built itself — one refactor
from biting.

Pinned by `src/sp/keys.test.ts`. Full report with a runnable reproduction:
[upstream-issue.md](upstream-issue.md) · repro: [`scripts/silent-pay-repro.mjs`](../scripts/silent-pay-repro.mjs).

## 2. `createOutputs()` does not return a scriptPubKey

Its `Output.script` field holds the **33-byte compressed public key**, not a script. Writing it into
a transaction as-is produces an output nobody can spend. The real scriptPubKey is `0x51 0x20` +
the 32-byte x-only key.

Wrapped in `src/sp/send.ts`, which returns both forms explicitly (`scriptPubKey` and `xOnly`).

## 3. The sender-side key sum throws on an intermediate zero

BIP352 has a test vector — *"Input keys intermediate sum is zero but final sum is non-zero"* — where
adding the inputs in order passes through the point at infinity before landing somewhere valid.
`createOutputs()` propagates the library's throw and fails the whole payment.

We sum the private keys ourselves modulo *n* (handling taproot parity), so an intermediate zero is
just arithmetic, and only a **final** zero is an error. The same care applies on the public side:
`tiny-secp256k1`'s `pointAdd` returns `null` at infinity, so `sumInputPublicKeys` treats only the
final result as meaningful (`src/sp/inputs.ts`).

Both are pinned by the official vector, which fails without the fix.

## 4. `K_max` is not enforced

BIP352 caps how many outputs one recipient group may produce. The library does not check it, so the
relevant vector cannot pass through `createOutputs`. Irrelevant in practice here — we send one
output per recipient — and skipped explicitly with a comment rather than silently
(`src/sp/vectors.test.ts`).

## 5. `ecpair@3` and `bitcoinjs-lib@6` disagree about signature types

`ecpair` v3 returns `Uint8Array` from `sign()`; `bitcoinjs-lib` v6 type-checks for `Buffer` and
throws `Expected property "signature" of type Buffer, got Uint8Array`. Every signing path fails at
once, which at least makes it easy to find.

A one-function adapter fixes it (`bufferSigner` in `src/wallet/psbt-wallet.ts`) rather than pinning
an older `ecpair`.

## 6. `bitcoinjs-lib@6` wants plain numbers for output values

Not BigInt — `Transaction.addOutput(script, value)` runs `value` through a `Satoshi` type check that
rejects `BigInt`. Worth knowing because v7 moves to BigInt, so this is the kind of line that breaks
on upgrade.

---

## Why these are written down

Two reasons beyond bookkeeping.

The first is that **item 1 is a genuine bug in a library the Bitshala ecosystem maintains**, and the
honest thing is to report it rather than quietly route around it. The report is drafted with a
reproduction and a patch.

The second is that four of the six are only visible because we ran the **official BIP352 test
vectors** through our own layer rather than trusting that the library handled them. Items 2, 3 and 4
were each surfaced by a vector failing. That is the argument for testing against spec vectors even
when you are using someone else's implementation of the spec.
