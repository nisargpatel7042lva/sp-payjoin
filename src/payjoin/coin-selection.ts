/**
 * Which UTXO the receiver should contribute.
 *
 * A payjoin is only private if the result looks like an ordinary payment. The
 * heuristic that gives it away is **UIH2** (Ghesmati et al. 2022, "Unnecessary
 * Input Heuristics and PayJoin Transactions", eprint 2022/589):
 *
 *   UIH1 — smallest input  >  smallest output  ⇒ looks like a normal spend with
 *          optimally-selected change; nothing to see.
 *   UIH2 — smallest input  <  smallest output  ⇒ an input was added that was not
 *          needed to fund the payment, which is exactly what a payjoin does.
 *
 * So we pick a candidate that keeps the transaction in the UIH1 shape, matching
 * rust-payjoin's `try_preserving_privacy`, and fall back to the first candidate
 * when no candidate can achieve it.
 *
 * Deviation from rust-payjoin, deliberate: when computing the smallest output it
 * takes `min(min over all original outputs, receiverOutput + candidate)`, which
 * keeps the receiver's *pre*-contribution output in the minimum even though that
 * output grows. Its own doc comment says the post-contribution amounts are what
 * matter, so we compute exactly that. The difference only ever makes us less
 * conservative — it never selects a candidate that fails the real UIH2 test.
 */
export interface ContributionCandidate { outpoint: string; valueSat: number }

export interface SelectionContext {
  /** Values of the outputs in the sender's original transaction. */
  outputValuesSat: readonly number[];
  /** Index of the output that pays the receiver — the one the contribution is added to. */
  ourOutputIndex: number;
  /** Values of the sender's inputs. */
  inputValuesSat: readonly number[];
}

/** True if adding `candidate` leaves the transaction in the "ordinary payment" (UIH1) shape. */
export function avoidsUih2(ctx: SelectionContext, candidateSat: number): boolean {
  // Only meaningful for the 2-output shape the heuristic is defined over.
  if (ctx.outputValuesSat.length !== 2) return false;
  const postOutputs = ctx.outputValuesSat.map((v, i) => (i === ctx.ourOutputIndex ? v + candidateSat : v));
  const minOut = Math.min(...postOutputs);
  const minIn = Math.min(...ctx.inputValuesSat, candidateSat);
  return minIn > minOut;
}

export interface ChooseOptions {
  /** Outpoints already revealed to some sender (BIP78 probing mitigation). */
  exposed?: readonly string[];
}

/**
 * Picks the UTXO to contribute.
 *
 * Priority, highest first:
 *  1. An already-exposed UTXO. Re-offering one leaks nothing new, whereas offering
 *     a fresh coin hands a prober another piece of the wallet (BIP78 §probing).
 *     Within the exposed set we still prefer one that avoids UIH2.
 *  2. Otherwise, the **smallest** candidate that avoids UIH2. Any qualifying coin
 *     produces the same shape, so the smallest one buys that shape while revealing
 *     the least about the wallet. (rust-payjoin returns the first candidate the
 *     caller happens to offer; choosing deliberately costs nothing and leaks less.)
 *  3. Otherwise, the largest candidate — no privacy claim, but the payment works.
 */
export function chooseContribution<T extends ContributionCandidate>(
  candidates: readonly T[],
  ctx: SelectionContext,
  opts: ChooseOptions = {},
): T | undefined {
  if (candidates.length === 0) return undefined;
  const exposed = opts.exposed ?? [];
  const alreadyExposed = candidates.filter((c) => exposed.includes(c.outpoint));
  const pool = alreadyExposed.length > 0 ? alreadyExposed : candidates;
  const bySize = [...pool].sort((a, b) => a.valueSat - b.valueSat);
  return bySize.find((c) => avoidsUih2(ctx, c.valueSat)) ?? bySize[bySize.length - 1];
}
