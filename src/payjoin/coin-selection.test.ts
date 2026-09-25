/** UIH2-avoiding contribution choice (Ghesmati et al. 2022 / rust-payjoin try_preserving_privacy). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avoidsUih2, chooseContribution, type SelectionContext } from './coin-selection.js';

// Alice pays 60,000 and keeps 39,600 change. Her single input is 100,000.
// Output 0 pays the receiver, output 1 is Alice's change.
const ctx: SelectionContext = { outputValuesSat: [60_000, 39_600], ourOutputIndex: 0, inputValuesSat: [100_000] };
const c = (outpoint: string, valueSat: number) => ({ outpoint, valueSat });

test('a contribution larger than the sender’s change keeps the ordinary-payment shape', () => {
  // post: inputs {100_000, 50_000} min 50_000 · outputs {110_000, 39_600} min 39_600 → 50_000 > 39_600 ✓
  assert.equal(avoidsUih2(ctx, 50_000), true);
});

test('a contribution smaller than the sender’s change gives the payjoin away', () => {
  // post: inputs min 20_000 · outputs min 39_600 → 20_000 < 39_600, the classic UIH2 tell
  assert.equal(avoidsUih2(ctx, 20_000), false);
});

test('the boundary is strict: equal is not greater', () => {
  assert.equal(avoidsUih2(ctx, 39_600), false);
  assert.equal(avoidsUih2(ctx, 39_601), true);
});

test('the heuristic is only defined for the two-output shape', () => {
  assert.equal(avoidsUih2({ ...ctx, outputValuesSat: [60_000, 39_600, 1_000] }, 50_000), false);
});

test('the receiver’s own output is counted after the contribution is added, not before', () => {
  // Receiver output starts at 1,000 — below the 39,600 change. A 50,000 contribution
  // lifts it to 51,000, so the smallest output is still the change and the shape holds.
  const small: SelectionContext = { outputValuesSat: [1_000, 39_600], ourOutputIndex: 0, inputValuesSat: [100_000] };
  assert.equal(avoidsUih2(small, 50_000), true);
});

test('chooses a qualifying candidate over one that would betray the payjoin', () => {
  const picked = chooseContribution([c('a:0', 20_000), c('b:0', 45_000), c('d:0', 500_000)], ctx);
  assert.equal(picked?.outpoint, 'b:0');
  assert.equal(avoidsUih2(ctx, picked!.valueSat), true);
});

test('among qualifying candidates, exposes the smallest one', () => {
  // 45_000, 500_000 and 900_000 all produce the ordinary-payment shape; the
  // smallest achieves it while revealing the least of the wallet.
  const picked = chooseContribution([c('big:0', 900_000), c('mid:0', 500_000), c('small:0', 45_000)], ctx);
  assert.equal(picked?.outpoint, 'small:0');
});

test('falls back to the largest candidate when none can avoid UIH2', () => {
  const picked = chooseContribution([c('a:0', 1_000), c('b:0', 9_000), c('d:0', 500)], ctx);
  assert.equal(picked?.outpoint, 'b:0', 'largest, so the payment at least succeeds');
  assert.equal(avoidsUih2(ctx, picked!.valueSat), false);
});

test('an exposed UTXO wins over a fresh one, even a better-shaped fresh one', () => {
  // Re-offering a coin a prober has already seen leaks nothing; a fresh coin does.
  const picked = chooseContribution([c('fresh:0', 45_000), c('seen:0', 20_000)], ctx, { exposed: ['seen:0'] });
  assert.equal(picked?.outpoint, 'seen:0');
});

test('within the exposed set, still prefer the one that avoids UIH2', () => {
  const picked = chooseContribution([c('seen-bad:0', 20_000), c('seen-good:0', 45_000)], ctx, { exposed: ['seen-bad:0', 'seen-good:0'] });
  assert.equal(picked?.outpoint, 'seen-good:0');
});

test('no candidates → nothing to contribute', () => {
  assert.equal(chooseContribution([], ctx), undefined);
});
