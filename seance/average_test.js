// Tiny check for applyAverage. Run with: deno run seance/average_test.js
// First case starts from zeros. Second case adds onto [10, 10].

import { applyAverage } from './average.js';

// Fail the script if any number is more than a millionth away from the expected value.
function assertClose(actual, expected) {
  if (actual.length !== expected.length) throw new Error(`length ${actual.length} != ${expected.length}`);
  for (let i = 0; i < actual.length; i++) {
    if (Math.abs(actual[i] - expected[i]) > 1e-6) {
      throw new Error(`index ${i}: ${actual[i]} != ${expected[i]}`);
    }
  }
}

const first = applyAverage(new Float32Array(0), [
  { delta: Float32Array.from([1, 0]), tokens: 1 },
  { delta: Float32Array.from([0, 3]), tokens: 1 },
]);
assertClose(first, Float32Array.from([0.5, 1.5]));

const second = applyAverage(Float32Array.from([10, 10]), [
  { delta: Float32Array.from([1, 0]), tokens: 3 },
  { delta: Float32Array.from([0, 2]), tokens: 1 },
]);
assertClose(second, Float32Array.from([10.75, 10.5]));

console.log('average ok');
