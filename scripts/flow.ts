/** The payment flow as a diagram — what happens, and where the novel step is. */
console.log(String.raw`
  HOW ONE PAYMENT WORKS — and where the new idea is
  ──────────────────────────────────────────────────────────────────────────────────

   ALICE  (payer)                                  BOB  (receiver)
                                                   publishes ONE static address
                                                   bitcoin:?sp=tsp1q…&pj=…
   ┌─────────────────────────────┐
   │ derive P  (BIP352)          │   from Alice's inputs only
   │ build + sign the "original" │   already a complete silent payment
   └─────────────────────────────┘
                 │
                 │   POST original PSBT
                 ▼
                              ┌──────────────────────────────────────────────┐
                              │ 1  scan the PSBT with Bob's SCAN KEY         │
                              │      → recognises its own output             │
                              │      no invoice id · no session state        │
                              │                                              │
                              │ 2  add one of Bob's coins                    │
                              │      → the input set changed, so the         │
                              │        output Alice derived is now WRONG     │
                              │                                              │
                              │ 3  recompute P' for the NEW input set        │
                              │      b_scan + the PUBLIC input keys          │
                              │                                              │
                              │ 4  substitute the output script  (BIP78)     │
                              └──────────────────────────────────────────────┘
                 ┌────────────────────────────┘
                 │   proposal PSBT
                 ▼
   ┌─────────────────────────────┐
   │ run the BIP78 checklist     │   reject and fall back on anything odd
   │ sign ONLY Alice's inputs    │
   └─────────────────────────────┘
                 │
                 ▼
   ╔══════════════════════════════════════════════════════════════════════════════╗
   ║  BROADCAST — 2 inputs, 2 different owners                                    ║
   ║                                                                              ║
   ║  "every input belongs to one person" — the assumption nearly all chain       ║
   ║  analysis rests on — is now FALSE. And no address was ever published.        ║
   ╚══════════════════════════════════════════════════════════════════════════════╝

  Why step 3 is the crux: BIP352 derives the output from EVERY input, so a payjoin
  invalidates it. Only Bob can recompute — his route needs his scan key and the
  public input keys. Alice's route would need the private keys of every input,
  including Bob's, which she will never have.
`);
