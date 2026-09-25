# Silent Payments as the addressing layer for Payjoin

**Status:** working implementation + open problem
**Applies to:** [BIP 78](https://github.com/bitcoin/bips/blob/master/bip-0078.mediawiki) (Payjoin v1),
[BIP 77](https://github.com/bitcoin/bips/blob/master/bip-0077.md) (Payjoin v2),
[BIP 352](https://github.com/bitcoin/bips/blob/master/bip-0352.mediawiki) (Silent Payments)
**Reference implementation:** this repository

---

## Abstract

A payjoin receiver must give the payer an address. Today that address is either reused — which is
the single most damaging thing a receiver can do to its own privacy — or freshly generated per
invoice, which requires interaction before the payment can even be quoted.

Silent payments solve exactly that problem for ordinary payments: one static address, a fresh
on-chain key per payment, no interaction. But the two do not obviously compose. BIP352 derives the
recipient's output from **every input of the transaction**, and a payjoin **changes the input set
after the sender has built the transaction**. The output the sender computed is wrong the moment
the receiver contributes a coin.

This document describes a composition that works with both BIPs as written, requiring no changes to
either, and names the one property it cannot yet provide.

## The obstruction, precisely

BIP352 sending (§Sending):

```
a_sum       = a₁ + a₂ + … + aₙ            (private keys of all eligible inputs)
input_hash  = hash_BIP0352/Inputs( smallest_outpoint ‖ a_sum·G )
ecdh        = input_hash · a_sum · B_scan
t_k         = hash_BIP0352/SharedSecret( ecdh ‖ ser32(k) )
P_k         = B_spend + t_k·G
```

`a_sum` and `smallest_outpoint` range over **all** inputs. Add one input and both change, so `ecdh`
changes, so `P_k` changes. A payjoin proposal that keeps the sender's original output would send
money to a key the receiver cannot derive — the funds would be unspendable by anyone.

## The mechanism

BIP78 already contains the hook. Under
[payment output substitution](https://github.com/bitcoin/bips/blob/master/bip-0078.mediawiki#payment-output-substitution),
the receiver "is free to decrease the amount or change the scriptPubKey output paying to himself",
and the sender's checklist explicitly performs **no check** on the payment output when substitution
is permitted. So:

1. **Discovery.** The receiver publishes one static silent payment address with a payjoin endpoint:
   `bitcoin:?sp=<sp1…>&pj=<endpoint>`. (BIP21 has no standard form for silent payments; `sp=` is
   this implementation's convention.)
2. **Original.** The payer derives `P_k` from its own inputs exactly as BIP352 specifies and builds
   an ordinary, fully-signed, broadcastable silent payment. This is the BIP78 *Original PSBT*.
3. **Identification.** The receiver runs its **scan key over the original PSBT**, exactly as it
   would over a chain transaction, and learns which output pays it. No invoice identifier, no
   session state, no lookup table — the cryptography is the addressing.
4. **Contribution.** The receiver adds one of its own inputs, chosen so the result keeps the
   ordinary-payment shape (see `docs/phase-6.md`).
5. **Recomputation.** The input set has changed, so the receiver recomputes the output for the new
   set. It can, using only public data and its own scan key:

   ```
   A_sum       = A₁ + A₂ + … + Aₙ          (input public keys, from the PSBT's prevouts)
   input_hash  = hash_BIP0352/Inputs( smallest_outpoint ‖ A_sum )
   ecdh        = b_scan · input_hash · A_sum      ≡ input_hash · a_sum · B_scan
   P'_k        = B_spend + hash_BIP0352/SharedSecret( ecdh ‖ ser32(k) )·G
   ```

6. **Substitution.** The receiver replaces the payment output's scriptPubKey with `P'_k` and adds
   its contribution to that output's value, as BIP78 permits.
7. **Completion.** The payer runs the standard BIP78 sender checklist, signs only its own inputs,
   and broadcasts.

The result is a transaction that a stock BIP352 scanner finds and a stock BIP78 sender accepts.

### Why the receiver can do step 5 and the sender cannot

The ECDH secret is symmetric — `b_scan·(input_hash·A_sum)` equals `input_hash·a_sum·B_scan` — but
the two sides need different material to compute it. The receiver's route needs `b_scan` (which it
has) and the **public** keys of every input (which are in the PSBT). The sender's route needs the
**private** keys of every input, including the receiver's contribution, which it will never have.

This asymmetry is what makes the composition work at all: only the receiver *can* recompute, and it
is also the only party that *needs* to.

## What the sender cannot check

It is the same asymmetry that creates the one real cost, and it should be stated plainly.

In ordinary BIP78 with a fixed address, a sender may set `pjos=0` / `disableoutputsubstitution=true`
and then verify that the payment output's script is untouched and its value did not decrease. With
silent payments the script **must** change, so that check is unavailable: a silent-payment payjoin
requires output substitution, and the sender cannot recompute `P'_k` to confirm the substitution was
honest.

**What remains enforceable, and is enforced here:** the total value going to outputs the sender does
not own must be at least the amount it intended to pay. A proposal that substitutes the payment
output *and* guts its value is rejected and the original is broadcast instead
(`src/payjoin/client.ts`; test: "a substituted silent-payment output that short-changes the payer is
refused"). Combined with an authenticated transport, this bounds the damage to "the receiver
redirected its own funds", which is the receiver's prerogative anyway.

**What is not yet solved:** with an unauthenticated transport, a man-in-the-middle can substitute an
output paying itself the full amount, and the sender cannot tell. BIP78 already requires TLS or
`.onion` for this reason, and BIP77 encrypts to the receiver's key, so in practice the transport
carries this weight. But it is a genuine weakening relative to `pjos=0`, and it should not be
papered over.

### A sketch for closing it

The sender's obstacle is one missing term. Splitting the secret by input ownership:

```
ecdh = input_hash·(a_s + a_r)·B_scan
     = input_hash·a_s·B_scan  +  input_hash·a_r·B_scan
     = T_s (sender computes)  +  T_r (receiver must supply)
```

If the receiver returns `T_r` alongside the proposal, the sender can complete `ecdh`, derive `P'_k`
itself, and verify the substituted script — recovering the guarantee that substitution removed.

`T_r` must be proven well-formed, or it is just another unverified value. The receiver should
accompany it with a **DLEQ proof** that the discrete log relating its input public key `A_r = a_r·G`
to base `G` is the same one relating `T_r` to base `input_hash·B_scan`. This is a standard
two-base Chaum–Pedersen proof, and the same construction already appears elsewhere in Bitcoin
tooling (blind Diffie–Hellman in Cashu).

This is **not implemented here** and is offered as the obvious next piece of work. It needs review
before anyone relies on it: in particular, whether revealing `T_r` leaks anything about the
receiver's input beyond what the transaction already publishes, and how it generalises to a receiver
contributing more than one input.

## Porting to BIP77

BIP77 replaces the receiver-hosted endpoint with an untrusted directory that both sides poll,
removing the requirement that stalled v1 adoption. Everything above survives that change untouched,
and the spec says so directly: BIP77's
[receiver checklist](https://github.com/bitcoin/bips/blob/master/bip-0077.md#receivers-original-psbt-checklist)
and [sender checklist](https://github.com/bitcoin/bips/blob/master/bip-0077.md#senders-proposal-psbt-checklist)
are both defined as "the same as BIP 78", and payment output substitution is explicitly preserved.

The composition touches only the proposal-construction stage, which is identical in both versions.

**Demonstrated here.** The sender's transport is an injected seam (`src/payjoin/transport.ts`), and
the same silent-payment payjoin runs unmodified over an asynchronous store-and-forward directory
where **the receiver hosts nothing and makes only outbound requests**
(`src/payjoin/transport-async.ts`, tests in `async-transport.regtest.test.ts`). That is BIP77's
shape and the property that matters for adoption.

**Not implemented, and required for real BIP77 interoperability:**

| Piece | Why it is not here |
|---|---|
| HPKE Base mode (RFC 9180) with a secp256k1 DHKEM | Non-standard KEM; needs careful implementation |
| ElligatorSwift public-key encoding (64 bytes) | BIP77 wire format for the KEM |
| Fixed 7168-byte padded payloads | Uniform-length messages so the directory learns nothing from size |
| Oblivious HTTP (RFC 9458) + key-config bootstrapping | Prevents the directory linking requests to IPs |
| Directory/relay session semantics, short IDs, expiry | Real deployment surface |

Our stand-in directory holds both PSBTs **in plaintext**, and a test asserts exactly that so the gap
is impossible to overlook ("what the directory can see"). Implementing the list above is
weeks of work whose failure mode is broken cryptography; the honest move was to prove
transport-independence and document the remainder rather than ship a half-built HPKE.

## Privacy analysis

| Heuristic | Ordinary payment | + silent payments | + payjoin |
|---|---|---|---|
| Address reuse — link every payment to one recipient | defeats the receiver | **no address on chain** | no address on chain |
| Common-input-ownership — all inputs share an owner | holds | holds | **false** |
| Payment-amount inference | correct | correct | **inflated by the contribution** |
| UIH2 — an unnecessary input betrays a payjoin | n/a | n/a | avoided by coin selection (`docs/phase-6.md`) |

Measured on real transactions by `npm run demo:surveillance`, which scores a naive analyst
**3/3 → 2/3 → 0/3** across those three cases.

**Not addressed:** amount correlation across payments, input-type uniformity, the round-fee-rate
tell, timing, and the network-level link created by the payer contacting the receiver's endpoint
(BIP77's OHTTP is the answer to the last one). The inflated amount is subtractable by an analyst who
*suspects* payjoin — the durable claim is that the shared-ownership assumption becomes unreliable
across all transactions, not that any single one is undetectable.

## Prior art and status of the idea

BIP352 anticipates collaborative transactions in general terms — it discusses CoinJoin, notes that
using all inputs "protects Alice's privacy in collaborative transaction protocols", and cautions
that **"it is currently not recommended to use this protocol for CoinJoins due to a lack of a formal
security proof"**. That caution applies here too, and is the honest framing: in this composition the
receiver adds only its *own* key to the input sum and is also the scanning party, so no derivation
authority is delegated to a third party — but no proof is claimed.

We have not found a prior description of silent payments used as the addressing layer for payjoin,
specifically the identify-by-scanning and recompute-then-substitute steps. That is a weak claim:
a search for the combination returns this repository, which indicates a polluted search rather than
absence of prior art. Anyone building on this should check the bitcoin-dev archives and the Payjoin
Foundation's work before repeating a novelty claim.

## Implementation notes

- Identification by scanning means the receiver needs **no per-invoice state**, which is what makes
  a single static address workable for a payjoin receiver.
- The receiver must recompute with index `k` matching the output's position among *its own* outputs
  in the original, so multi-output payments to one address stay consistent. Implemented; tested only
  for the single-output case.
- `@silent-pay/core@0.0.6` mutates private keys in place inside `scanOutputs`, silently corrupting a
  wallet's scan key after one call. Worked around with defensive copies (`src/sp/keys.ts`) and
  pinned by a regression test. Should be reported upstream.
- Conformance: the BIP78 sender reproduces the BIP's own test vectors byte-for-byte; all 28 BIP352
  send/receive vectors pass through this implementation's derivation layer.
