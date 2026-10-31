// The demo phone. Browser phones freeze when more than one of them trains,
// so this process is the one that keeps the shared version moving.
// The join page sees the name "demo" and does not start its own model.

import { init, defaultDevice } from '@jax-js/jax';
import { train, buildBPETokenizer } from '../train.js';
import { encodeF32, decodeF32 } from './codec.js';

const ORIGIN = 'http://127.0.0.1:43131';
const NAME = 'demo';
const WORKER_ID = 'demo-phone';

let version = 0;
let deadline = 0;
let deadlineArmed = false;
let ws = null;
let roundStart = null;
let steps = 0;
let lossSum = 0;
let tokens = 0;
let lastFlat = null;
let sending = false;
let reload = false;

function trace(event, detail) {
  console.log(`[demo] ${event} ${detail || ''}`);
  fetch(`${ORIGIN}/trace`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: NAME, event, detail: detail || '' }),
  }).catch(() => {});
}

function noteDeadline(ms) {
  if (!ms || ms === deadline) return;
  deadline = ms;
  if (ms > Date.now()) deadlineArmed = true;
}

function noteMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.version != null && msg.version !== version && !sending) {
    if (steps > 0) reload = true;
    version = msg.version;
  }
  noteDeadline(msg.deadlineMs);
}

async function pollClock() {
  try {
    const response = await fetch(`${ORIGIN}/clock`, { cache: 'no-store' });
    if (!response.ok) return;
    const body = await response.json();
    noteDeadline(body.deadlineMs);
    if (body.version != null && body.version !== version && !sending) {
      if (steps > 0 && body.version > version) reload = true;
      version = body.version;
    }
  } catch {
    // The next guess tries again.
  }
}

async function connectSocket(ticket) {
  if (ws) {
    try { ws.close(); } catch { /* already closed */ }
  }
  const socket = new WebSocket(`${ORIGIN.replace('http', 'ws')}/actor-ws?ticket=${ticket}`);
  ws = socket;
  socket.onmessage = (event) => noteMessage(event.data);
  socket.onclose = () => trace('socket', 'closed');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket timeout')), 10000);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('socket failed')); };
  });
}

async function ensureSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  try {
    await join();
    trace('socket', 'joined');
  } catch (error) {
    trace('socket', error instanceof Error ? error.message : String(error));
  }
}

async function join() {
  const response = await fetch(`${ORIGIN}/grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: NAME, role: 'phone', workerId: WORKER_ID }),
  });
  if (!response.ok) throw new Error(`grant ${response.status}`);
  const grant = await response.json();
  await connectSocket(grant.ticket);
}

async function loadWeights() {
  const response = await fetch(`${ORIGIN}/weights`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`weights ${response.status}`);
  const body = await response.json();
  version = body.version;
  trace('weights', `version ${body.version}`);
  return decodeF32(body.weightsB64);
}

let lastPoll = 0;

async function publish() {
  if (Date.now() - lastPoll > 1000) {
    lastPoll = Date.now();
    await pollClock();
  }
  if (sending || steps < 1 || !lastFlat || !roundStart || !deadlineArmed) return;
  if (Date.now() < deadline - 3000) return;
  sending = true;
  const flat = lastFlat;
  const pieceCount = Math.max(1, tokens);
  const loss = lossSum / steps;
  const base = version;
  const delta = new Float32Array(flat.length);
  for (let i = 0; i < flat.length; i++) delta[i] = flat[i] - roundStart[i];
  try {
    const response = await fetch(`${ORIGIN}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: NAME,
        deltaB64: encodeF32(delta),
        tokens: pieceCount,
        loss,
        baseVersion: base,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    if (result.accepted) {
      version = result.version;
      roundStart = new Float32Array(flat);
      steps = 0;
      lossSum = 0;
      tokens = 0;
      trace('send-ok', `version ${result.version} pieces ${pieceCount} loss ${loss.toFixed(2)}`);
      return;
    }
    trace('send-rejected', result.reason || '');
    if (String(result.reason || '').includes('version')) reload = true;
  } catch (error) {
    trace('send-fail', error instanceof Error ? error.message : String(error));
  } finally {
    sending = false;
  }
}

async function lesson() {
  const tok = JSON.parse(await Deno.readTextFile(new URL('../data/shakespeare.tok.json', import.meta.url)));
  const trainData = new Uint16Array(await Deno.readFile(new URL('../data/shakespeare.train.bin', import.meta.url)));
  const valData = new Uint16Array(await Deno.readFile(new URL('../data/shakespeare.val.bin', import.meta.url)));
  return { tokenizer: buildBPETokenizer(tok.merges), trainData, valData };
}

async function run() {
  const devices = await init();
  const device = devices.includes('wasm') ? 'wasm' : 'cpu';
  defaultDevice(device);
  trace('device', device);
  const data = await lesson();
  await join();
  let weights = await loadWeights();
  while (true) {
    reload = false;
    roundStart = weights.length ? weights : null;
    steps = 0;
    lossSum = 0;
    tokens = 0;
    const bag = {};
    const handle = train(device, data.trainData, data.valData, data.tokenizer, {
      model: 'nano',
      handle: bag,
      initialWeights: weights.length ? weights : undefined,
      steps: 999999,
      seed: 1,
      valEvery: 99999,
    });
    while (!reload) {
      await publish();
      if (reload) break;
      const event = await handle.next();
      if (event.done) break;
      const step = event.value;
      if (step.type !== 'step') continue;
      steps += 1;
      lossSum += step.loss;
      tokens += step.batchSize ?? 8;
      if (bag.getFlat) lastFlat = new Float32Array(bag.getFlat());
      if (ws && ws.readyState === WebSocket.OPEN && steps % 40 === 0) {
        ws.send(JSON.stringify({ type: 'loss', loss: step.loss, tokens }));
      }
      if (steps % 40 === 0) await ensureSocket();
      if (steps === 1 || steps % 20 === 0) {
        trace('guess', `step ${step.step} loss ${step.loss.toFixed(2)} pieces ${tokens}`);
      }
    }
    weights = await loadWeights();
  }
}

await run();
