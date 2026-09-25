# Known limitations, assumptions and open risks

Everything here is a deliberate scope decision or a known gap, gathered from all five phases.
Each entry says what it is, why it is that way, and what closing it would take. Nothing in this
file is a surprise to the authors; it exists so it is not a surprise to anyone else either.

**The one-line version:** this is a working demonstration on regtest of a real protocol
combination. It is not a wallet you should point at mainnet, and the dependency it builds on
(`@silent-pay/core`) says the same about itself.

---

## 1. Scope: regtest only

| | |
|---|---|
| **What** | Everything is exercised against a local regtest node. There is no mainnet or signet path, and the code does not defend against a hostile network. |
| **Why** | The deliverable is a demonstration that BIP78 + BIP352 compose. `@silent-pay/core` is labelled experimental by its own authors: *"Mainnet use is strictly NOT recommended."* |
| **To close** | Everything else in this document, plus an audit of the BIP352 layer we wrote on top of the library. |

## 2. Key handling

**Private keys are stored in plaintext JSON** under `$SPAY_HOME` (files are written `0600`, which
stops other users on the same machine, not malware running as you, and not a backup that copies the
directory). There is no encryption, no passphrase, no hardware-wallet path.

Keys must live in the application rather than in Bitcoin Core's wallet, because BIP352 derivation
needs the *input private keys* and PayJoin needs PSBT control. That constraint is real; storing them
unencrypted is the shortcut. Closing it means a proper keystore (encrypted at rest, unlocked per
session) and, for the sender side, PSBT signing delegated to an external signer.

Note that BIP78 already warns about hardware wallets here: a payjoin sender signs **two conflicting
transactions**, so a compromised host can extract two payments instead of one. We do not mitigate
that beyond implementing the sender's checklist faithfully.

## 3. Transport is unauthenticated HTTP

The receiver endpoint is plain `node:http` on loopback. BIP78 is explicit: *"Senders SHOULD NOT
accept a URL representing an unencrypted or unauthenticated connection"*, and requires TLS 1.2+ or
a `.onion` service. We are compliant in spirit only because both ends are on one machine.

A real deployment needs TLS with certificate validation, or Tor. That is deployment work, not
protocol work — the `pj=` endpoint in the BIP21 URI is already just a URL.

## 4. Chain scanning does not scale, and ignores reorgs

`SpWallet.scanChain` walks **every transaction in every new block** and runs BIP352 scanning on each.
On regtest that is instant; on mainnet it is a full-node-with-extra-ECC-work design that no light
client could use.

It also only moves **forward**: `scannedHeight` advances and blocks are never revisited, so a chain
reorganisation silently drops or double-counts outputs. And only confirmed blocks are scanned —
a payment sitting in the mempool is invisible until it is mined.

BIP352 anticipates this: the real answer is a silent-payment index (per-transaction 33-byte tweaks)
plus BIP158 block filters, which is exactly what `@silent-pay/indexer` exists to provide. Wiring
that in, plus tracking block hashes so a reorg can be detected and rescanned, is the fix.

## 5. Coin selection is naive on both sides

- **Sender**: largest-first, with a **hardcoded 4 sat/vB** fee rate. There is no call to
  `estimatesmartfee`, no fee-rate argument on the CLI, and no RBF fee bumping (payjoin PSBTs *do*
  signal RBF with sequence `0xfffffffd`, but nothing ever bumps them).
- **Receiver**: *fixed in Phase 6* — it now contributes the smallest coin that keeps the
  transaction in the ordinary-payment shape (avoiding UIH2), preferring an already-exposed coin.
  See `docs/phase-6.md`. The remaining limit is real: if every coin the receiver holds is smaller
  than the sender's change, no choice avoids UIH2 and the code falls back rather than pretending.

BIP78 also mentions adding a round-amount output during "spare change" situations to poison
amount analysis; that is not implemented.

## 6. What the privacy claim does and does not cover

The demo (`npm run demo:surveillance`) shows three textbook heuristics producing wrong answers. Be
precise about what that means:

- The analyst is **naive by construction** — common-input-ownership, payment-amount inference, and
  address reuse. It is not a commercial product with clustering history, exchange KYC data, timing
  analysis, or wallet-fingerprinting.
- The **inflated amount is subtractable**. An analyst who *suspects* payjoin can guess that one
  input is the receiver's and recover the real figure. Payjoin's value is that the shared-ownership
  assumption becomes unreliable across *all* transactions, not that any single one is undetectable.
- Payjoin transactions are **fingerprintable** in other ways we have not addressed: input type
  uniformity, the round-number heuristic, and the BIP78-noted trick of checking whether removing a
  single input yields a round fee rate.
- Silent payments remove the on-chain address, not the **network-level** link: the payer still
  fetches a `pj=` endpoint the receiver controls, which sees the payer's IP unless Tor is used.

## 7. Protocol-level scope decisions

| Decision | Status |
|---|---|
| **BIP352 labels** (`m`-tweaked addresses) | Not implemented; labelled vectors are skipped in the test suite. Fine for a single receiving identity, needed for per-invoice bookkeeping. |
| **BIP21 for silent payments** | `bitcoin:?sp=<tsp1…>` is **our convention** — no BIP defines a URI form for silent payments yet. A bare address and an address in the URI path are also accepted. If a standard lands, this is a one-function change. |
| **Multiple silent-payment outputs in one payjoin** | The code path exists (`substituteOutput` receives the output's index `k`), but is **untested** beyond the single-output case. |
| **Batching / multiple recipients** | Supported by the sender library, not exposed by the CLI. |
| **BIP78 v2 (BIP77)** | Not implemented. We deliberately chose v1 after finding the official `payjoin` WASM bindings are v2-only and would have required a payjoin-directory and OHTTP relay in the critical path. |
| **`witnessUtxo` on the sender's inputs in the proposal** | We keep it, matching BIP78's own test vector and BTCPay's behaviour; the sender refills it regardless. A deviation from the strictest reading of the text, and an intentional one. |
| **Third-party interop** | Never tested against BTCPay, JoinMarket or Wasabi. Correctness rests on BIP78's published vectors (which we reproduce byte-for-byte) and on Bitcoin Core validating every transaction. |

## 8. Probing defence is partial

Phase 5 implements BIP78's mitigation — exposed UTXOs are tracked and re-offered in priority, so a
prober learns one coin rather than walking the wallet. Two gaps remain:

- **`exposedInputs` is not persisted.** The set is injectable via `ReceiverOptions`, so a caller
  *can* persist it, but the CLI does not: restart the receiver and it will expose a fresh coin.
- **The receiver does not watch the mempool.** BIP78 describes reusing the exposed UTXO when the
  original is seen broadcast or double-spent; we re-offer unconditionally instead. That is stricter
  (never leaks a second coin) but it is not the adaptive behaviour BTCPay implements.

## 9. Upstream bug we are working around

`@silent-pay/core@0.0.6`'s `secp256k1` backend mutates private keys **in place**
(`privateKeyTweakMul`), so calling `scanOutputs()` corrupts the caller's scan key. The visible
symptom is a wallet that finds its first payment and then never finds another.

We pass defensive copies in `src/sp/keys.ts` and pin the behaviour with a regression test
(`src/sp/keys.test.ts`). **This has not yet been reported upstream to Bitshala-Incubator/silent-pay**
— it should be.

## 10. Cryptographic caveat we inherit

BIP352 states that collaborative transactions lack a formal security proof:

> *"it is recommended that the keys of all inputs of a transaction belong to the same entity as
> there is no formal proof that the protocol is secure in a collaborative setting."*

A payjoin is exactly such a transaction. In our flow the receiver only ever adds **its own** key to
the input sum and is also the scanning party, so no derivation authority is handed to a third party
— but the caveat is real and we are not claiming to have resolved it.

---

## 11. The sender cannot verify a substituted silent-payment output

A silent-payment payjoin requires output substitution, which removes BIP78's script check on the
payment output — and BIP352's sender-side derivation needs the private keys of *all* inputs, so the
sender cannot recompute the substituted output to check it. The sender does enforce that the value
going to outputs it does not own is at least the amount intended, so a short payment is refused,
but with an unauthenticated transport a man-in-the-middle could redirect the payment.

This is the composition's one genuine cryptographic gap. `docs/design.md` §"A sketch for closing it"
proposes a fix (the receiver supplies its half of the ECDH term with a DLEQ proof); it is not
implemented and has not been reviewed.

## 12. BIP77 is demonstrated in shape only

The sender's transport is injectable and the whole flow runs over an asynchronous directory with the
receiver hosting nothing — but that directory is **not** BIP77: no HPKE, no ElligatorSwift encoding,
no padded payloads, no Oblivious HTTP. It sees both PSBTs in plaintext, and a test asserts so. See
`docs/design.md` §"Porting to BIP77" for the itemised remainder.

## 13. The web console is untested glue

The two files under `src/web/` are a thin HTTP layer over code the test suite does cover
(`pay()`, `PayjoinReceiver`, `SpWallet`, the analyst). The layer itself has **no automated test** —
it is typechecked and was exercised by hand. It is a demo console bound to loopback, not a product:
no authentication, no CSRF protection, both wallets in one process, and it will spend the payer's
coins for anyone who can reach the port.

## Not limitations, just operational notes

- `spay receive` writes a pidfile because `npx`/`tsx` wrappers make `$!` the wrong process.
- Test files run in parallel against one node, so `confirmations` can exceed 1; assertions use `>= 1`.
- The receiver inserts its input at a random index (BIP78 requires this), so a rejected reentrant
  PSBT can surface as either `seen before` or `owned by the receiver`. Both are correct.
