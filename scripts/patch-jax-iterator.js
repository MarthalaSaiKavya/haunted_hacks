// Older phone browsers have matchAll(), but not Iterator.prototype.map.
// jax-js 0.1.9 calls .map() on the matchAll iterator inside einsum, which
// attention uses on every step. Spread to an array first.
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'node_modules/@jax-js/jax/dist/index.js';
let source = readFileSync(file, 'utf8');
const replacements = [
  [
    '[...expr.split("->")[0].matchAll(EINSUM_COMPONENT_RE).map((m) => m[0]).filter((c) => c !== "...")]',
    '[...expr.split("->")[0].matchAll(EINSUM_COMPONENT_RE)].map((m) => m[0]).filter((c) => c !== "...")',
  ],
  [
    '[...part.matchAll(EINSUM_COMPONENT_RE).map((m) => m[0])]',
    '[...part.matchAll(EINSUM_COMPONENT_RE)].map((m) => m[0])',
  ],
];

let changed = 0;
for (const [from, to] of replacements) {
  if (source.includes(from)) {
    source = source.replace(from, to);
    changed++;
  } else if (!source.includes(to)) {
    console.error('jax-js einsum patch did not find its target. The installed file may have changed.');
    process.exit(1);
  }
}

if (changed > 0) writeFileSync(file, source);
console.log(changed ? `patched ${changed} einsum call(s)` : 'jax-js einsum patch already applied');
