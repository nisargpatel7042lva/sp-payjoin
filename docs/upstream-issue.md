# Upstream issue: `@silent-pay/core` scan-key mutation

Filed 2026-10-13 as
[Bitshala-Incubator/silent-pay#105](https://github.com/Bitshala-Incubator/silent-pay/issues/105),
fixed by
[PR #106](https://github.com/Bitshala-Incubator/silent-pay/pull/106) (open).

Verified before filing: `@silent-pay/core` still at 0.0.6, the offending line unchanged on `main`,
no duplicate among the repo's open issues, and `scripts/silent-pay-repro.mjs` still reproduces.
Our workaround stays in `src/sp/keys.ts` (defensive copies), pinned by `src/sp/keys.test.ts`.

---

**Title:** `scanOutputs()` overwrites the caller's scan private key, silently breaking every later scan

---

## Summary

`scanOutputs()` in `packages/core/src/scanning.ts` mutates the `scanPrivateKey` argument in place.
The caller's key is destroyed by the call, so the first scan succeeds and every scan afterwards
silently finds nothing — no exception, no warning, just a wallet that stops seeing its own payments.

## Reproduction

Self-contained, uses only the library's public API:

```js
// npm i @silent-pay/core secp256k1 bitcoinjs-lib && node repro.mjs
import { createOutputs, scanOutputs, createInputHash, encodeSilentPaymentAddress } from '@silent-pay/core';
import secp256k1 from 'secp256k1';
import { networks } from 'bitcoinjs-lib';
import { randomBytes } from 'node:crypto';

const hex = (b) => Buffer.from(b).toString('hex');

const scanPriv  = new Uint8Array(randomBytes(32));
const spendPriv = new Uint8Array(randomBytes(32));
const scanPub   = secp256k1.publicKeyCreate(scanPriv, true);
const spendPub  = secp256k1.publicKeyCreate(spendPriv, true);
const address   = encodeSilentPaymentAddress(scanPub, spendPub, networks.bitcoin);

const inputPriv = new Uint8Array(randomBytes(32));
const inputPub  = secp256k1.publicKeyCreate(inputPriv, true);
const outpoint  = { txid: Buffer.alloc(32, 7).toString('hex'), vout: 0 };
const outputs   = createOutputs([{ key: hex(inputPriv), isXOnly: false }], outpoint,
                                [{ address, amount: 1000 }], networks.bitcoin);

const inputHash  = createInputHash(inputPub, outpoint);
const candidates = [outputs[0].script];

const before = hex(scanPriv);
const first  = scanOutputs(scanPriv, spendPub, inputPub, inputHash, [...candidates]);
const after  = hex(scanPriv);
const second = scanOutputs(scanPriv, spendPub, inputPub, inputHash, [...candidates]);

console.log('scan key before :', before);
console.log('scan key after  :', after);
console.log('mutated         :', before !== after);
console.log('first  scan hits:', first.size);
console.log('second scan hits:', second.size);
```

Output:

```
scan key before : c9c068fd5cd5808c8ff4a79a78dc75145acbef60ab0713de2a7edae3367f37c7
scan key after  : 3a69d3031f4ce2f29614c81710dfc7510ce29c03aa961cd64b0735bf844de1fe
mutated         : true
first  scan hits: 1
second scan hits: 0
```

Same transaction, same arguments, no match the second time.

## Root cause

`packages/core/src/scanning.ts`:

```ts
export const scanOutputs = (scanPrivateKey, spendPublicKey, sumOfInputPublicKeys, inputHash, outputs, labels?) => {
    const ecdhSecret = secp256k1.publicKeyTweakMul(
        sumOfInputPublicKeys,
        secp256k1.privateKeyTweakMul(scanPrivateKey, inputHash),  // ← writes the result into scanPrivateKey
        true,
    );
```

The `secp256k1` bindings write their result into the input buffer when no output buffer is supplied.
Probing each primitive on `secp256k1@5.0.2`:

| primitive | mutates arg0 | mutates arg1 |
|---|---|---|
| `privateKeyTweakMul` | **yes** | no |
| `privateKeyTweakAdd` | **yes** | no |
| `publicKeyTweakMul` | no | no |
| `publicKeyTweakAdd` | no | no |

So the private-key helpers are the hazard, and `scanOutputs` passes a caller-owned key straight into one.

## Scope

| function | status |
|---|---|
| `scanOutputs()` | **affected** — `scanPrivateKey` is destroyed (other arguments are fine) |
| `scanOutputsWithTweak()` | not affected — it uses `publicKeyTweakMul`, which does not mutate |
| `calculateSumOfPrivateKeys()` | not affected **incidentally** — it calls `privateKeyTweakAdd` on arrays it just built with `fromHex`, so the mutation stays internal. The same footgun is one refactor away from biting. |

`packages/wallet` happens to be safe because `matchSilentBlockOutputs` passes
`new Uint8Array(this.scanKey.privateKey)`. Any consumer calling `scanOutputs` directly with its own
key is not.

## Why this is worth fixing above its apparent size

The failure is **silent and delayed**. There is no thrown error; the wallet simply stops finding
payments after the first one, which reads like a scanning or indexing problem rather than a key
being overwritten. We lost real time to it before tracing it here.

## Suggested fix

```diff
     const ecdhSecret = secp256k1.publicKeyTweakMul(
         sumOfInputPublicKeys,
-        secp256k1.privateKeyTweakMul(scanPrivateKey, inputHash),
+        secp256k1.privateKeyTweakMul(new Uint8Array(scanPrivateKey), inputHash),
         true,
     );
```

Two things worth adding alongside it:

1. **A test that pins the contract** — assert the arguments are byte-identical after the call, for
   every exported function. This class of bug cannot be caught by output assertions alone.
2. **Copy at the boundary of any `privateKeyTweak*` call**, so a future refactor cannot reintroduce
   it. This overlaps with #59 (Replace Buffer with Uint8Array), which touches the same call sites.

Happy to open a PR with the fix plus the mutation tests if that is useful.

## Environment

`@silent-pay/core@0.0.6` · `secp256k1@5.0.2` · Node v24.10.0 · Linux

---

## Follow-up

[PR #106](https://github.com/Bitshala-Incubator/silent-pay/pull/106) carries the fix: copy the
scan key before `privateKeyTweakMul` tweaks it, the same copy in `handleLabels` so the invariant
holds at every call site, and four tests under `Scanning: caller-owned arguments` that keep
references to the arguments and compare them after the call. Three of the four fail on upstream
`main` and pass with the change. The package's own suite goes from 104 to 108 passing.

The PR also notes two things found while working on it but deliberately left alone: the `outputs`
array is spliced in place by design, and `jest.config.ts` cannot load on Node 22+ (`module is not
defined in ES module scope`), so upstream's `npm test` does not run on a current Node at all.

Repro script also at `scripts/silent-pay-repro.mjs`.
