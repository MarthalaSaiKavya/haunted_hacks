// One real continuation from the room's saved weights.
// Uses the same nano Shakespeare model as the browser, on Wasm.

import { init, defaultDevice, numpy as np, random, tree } from '@jax-js/jax';
import { initParams, inference, resolveConfig } from '../gpt.js';
import { buildBPETokenizer } from '../bpe.js';

let ready = null;

function prepare() {
  if (!ready) {
    ready = (async () => {
      const devices = await init();
      if (!devices.includes('wasm')) {
        throw new Error(`wasm is not available (${devices.join(', ')})`);
      }
      defaultDevice('wasm');
      const tokUrl = new URL('../data/shakespeare.tok.json', import.meta.url);
      const tok = JSON.parse(Deno.readTextFileSync(tokUrl));
      const tokenizer = buildBPETokenizer(tok.merges);
      const cfg = resolveConfig('nano');
      return { tokenizer, cfg };
    })();
  }
  return ready;
}

function loadWeights(flat, templateParams) {
  let offset = 0;
  return tree.map((leaf) => {
    const chunk = flat.slice(offset, offset + leaf.size);
    offset += leaf.size;
    const next = np.array(chunk).reshape(leaf.shape);
    leaf.dispose();
    return next;
  }, templateParams);
}

export async function speak(flat, prompt) {
  const { tokenizer, cfg } = await prepare();
  const fresh = await initParams(tokenizer.vocabSize, cfg, random.key(7));
  const params = loadWeights(flat, fresh);
  const samples = await inference(params, cfg, tokenizer, random.key(11), {
    prompt,
    numSamples: 1,
    temperature: 0.8,
  });
  tree.dispose(params);
  const line = samples[0];
  if (typeof line !== 'string') throw new Error('inference returned no text');
  return line;
}
