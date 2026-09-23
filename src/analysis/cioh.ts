/**
 * What a naive chain-analysis tool concludes from a transaction, and a checker
 * that scores those conclusions against ground truth (which we have on regtest).
 *
 * Heuristics implemented (the ones BIP78 says it breaks):
 *   H1  common-input-ownership: every input of a tx is controlled by one entity.
 *   H2  payment-amount inference: with one "external" output, the amount paid is that output's value.
 */
export interface AnalyzedInput { outpoint: string; scriptPubKeyHex: string }
export interface AnalyzedOutput { index: number; scriptPubKeyHex: string; valueSat: number }
export interface AnalyzedTx { txid: string; inputs: AnalyzedInput[]; outputs: AnalyzedOutput[] }

export interface Verdict {
  /** H1: the single entity the analyst assigns all inputs to (labelled by the first input). */
  inputCluster: { entity: string; outpoints: string[] };
  /** H2: analyst's guess at the payment output and amount (the output whose script type / freshness marks it as not-change). */
  inferredPayment?: { index: number; valueSat: number };
}

/** The analyst: no keys, only the transaction. */
export function analyze(tx: AnalyzedTx, changeHint?: (o: AnalyzedOutput) => boolean): Verdict {
  const entity = `owner-of(${tx.inputs[0]!.outpoint})`;
  const inputCluster = { entity, outpoints: tx.inputs.map((i) => i.outpoint) };
  // Naive change detection: if exactly two outputs, the "payment" is whichever the hint does not flag as change;
  // with no hint, guess the round-amount output (payments tend to be round) and otherwise the larger one.
  let inferredPayment: Verdict['inferredPayment'];
  if (tx.outputs.length === 2) {
    const [a, b] = tx.outputs as [AnalyzedOutput, AnalyzedOutput];
    const pick = changeHint ? (changeHint(a) ? b : a) : (a.valueSat % 10_000 === 0 && b.valueSat % 10_000 !== 0 ? a : b.valueSat % 10_000 === 0 && a.valueSat % 10_000 !== 0 ? b : a.valueSat > b.valueSat ? a : b);
    inferredPayment = { index: pick.index, valueSat: pick.valueSat };
  }
  return { inputCluster, inferredPayment };
}

export interface GroundTruth { ownerOfOutpoint: Record<string, string>; paymentSat: number; paymentOutputIndex: number }

export interface Scorecard {
  h1: { claim: string; correct: boolean; detail: string };
  h2?: { claim: string; correct: boolean; detail: string };
}

/** Scores the analyst's verdict against what we know. */
export function score(v: Verdict, truth: GroundTruth): Scorecard {
  const owners = new Set(v.inputCluster.outpoints.map((o) => truth.ownerOfOutpoint[o] ?? 'unknown'));
  const h1 = {
    claim: `all ${v.inputCluster.outpoints.length} inputs belong to one entity`,
    correct: owners.size === 1,
    detail: owners.size === 1 ? `true: all inputs are ${[...owners][0]}'s` : `FALSE: inputs are owned by ${[...owners].join(' and ')}`,
  };
  const h2 = v.inferredPayment && {
    claim: `payment amount is ${v.inferredPayment.valueSat} sat (output ${v.inferredPayment.index})`,
    correct: v.inferredPayment.valueSat === truth.paymentSat && v.inferredPayment.index === truth.paymentOutputIndex,
    detail: v.inferredPayment.valueSat === truth.paymentSat ? 'true' : `FALSE: actual payment was ${truth.paymentSat} sat`,
  };
  return { h1, h2 };
}

/**
 * H3, address reuse: how many times an output script has appeared on chain
 * before this transaction. A reused address is what lets a surveillance tool
 * search for a merchant and pull up every payment they ever received.
 * Silent payments make every output a fresh key, so this always answers 0.
 */
export interface ChainIndex { occurrencesBefore(scriptPubKeyHex: string, txid: string): number }

export async function buildChainIndex(rpc: {
  getBlockCount(): Promise<number>;
  getBlockHash(h: number): Promise<string>;
  getBlock(hash: string): Promise<{ height: number; tx: Array<{ txid: string; vout: Array<{ scriptPubKey: { hex: string } }> }> }>;
}, fromHeight = 0): Promise<ChainIndex> {
  const seen = new Map<string, string[]>(); // script → txids, in block order
  const tip = await rpc.getBlockCount();
  for (let h = fromHeight; h <= tip; h++) {
    const block = await rpc.getBlock(await rpc.getBlockHash(h));
    for (const tx of block.tx) for (const o of tx.vout) {
      const list = seen.get(o.scriptPubKey.hex) ?? [];
      if (!list.includes(tx.txid)) list.push(tx.txid);
      seen.set(o.scriptPubKey.hex, list);
    }
  }
  return {
    occurrencesBefore(script, txid) {
      const list = seen.get(script) ?? [];
      const i = list.indexOf(txid);
      return i < 0 ? list.length : i;
    },
  };
}
