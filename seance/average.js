// Token-weighted federated average.
// new = old + sum(tokens * delta) / sum(tokens)
// An empty room treats the old weights as zeros of the delta's length,
// so the first offering is the spirit's full weight vector.

// Example: start from nothing. Phone A (1 token) offers [1, 0]. Phone B (1 token) offers [0, 3].
// The room becomes [0.5, 1.5]. A phone that trained more tokens pulls the average harder.
export function applyAverage(weights, offerings) {
  if (offerings.length === 0) return weights;
  const width = offerings[0].delta.length;
  for (const offering of offerings) {
    if (offering.delta.length !== width) {
      throw new Error(`delta length ${offering.delta.length} != ${width}`);
    }
    if (!(offering.tokens > 0)) throw new Error('tokens must be positive');
  }
  const base = weights.length === width ? Float32Array.from(weights) : new Float32Array(width);
  let tokenSum = 0;
  for (const offering of offerings) tokenSum += offering.tokens;
  for (let i = 0; i < width; i++) {
    let acc = 0;
    for (const offering of offerings) acc += offering.tokens * offering.delta[i];
    base[i] += acc / tokenSum;
  }
  return base;
}
