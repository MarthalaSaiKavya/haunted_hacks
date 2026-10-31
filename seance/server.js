// Séance room. One actor, many spirits, two voices that only report
// what the room actually measured.

import { createRoom } from './actor.js';
import { decodeF32 } from './codec.js';
import { speak } from './infer.js';

const PORT = 43131;
const ROOT = new URL('./', import.meta.url);
const STATE_URL = new URL('./state/hall.json', import.meta.url);
const ENGINE = new URL('../', import.meta.url);
const JAX = new URL('../node_modules/@jax-js/jax/', import.meta.url);
const OPTAX = new URL('../node_modules/@jax-js/optax/', import.meta.url);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

function readState() {
  try {
    return JSON.parse(Deno.readTextFileSync(STATE_URL));
  } catch {
    return null;
  }
}

function writeState(state) {
  Deno.mkdirSync(new URL('./state/', import.meta.url), { recursive: true });
  const tmp = new URL('./state/hall.json.tmp', import.meta.url);
  Deno.writeTextFileSync(tmp, JSON.stringify(state));
  Deno.renameSync(tmp, STATE_URL);
}

const room = createRoom({ id: 'hall', readState, writeState });
const sockets = new Set();
let voiceBusy = false;

function send(ws, body) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(body));
}

function broadcast(body) {
  const text = JSON.stringify(body);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(text);
    else sockets.delete(ws);
  }
}

async function maybeSpeak() {
  if (voiceBusy || !room.needsVoice()) return;
  voiceBusy = true;
  const weights = room.weights();
  const version = room.view(false).version - 1;
  try {
    const line = await speak(weights, 'to be');
    await room.say('The Voice', `It continues: ${line}`);
    await room.markSpoken(version);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await room.say('The Voice', `The sample failed: ${message}`);
    await room.markSpoken(version);
  } finally {
    voiceBusy = false;
    broadcast({ type: 'pulse', ...room.view(false) });
  }
}

setInterval(() => {
  room.tick(Date.now()).then((result) => {
    if (result.kind === 'submit') broadcast({ type: 'submit', ...result.view });
    else if (result.kind === 'round') {
      broadcast({ type: 'round', ...result.view });
      maybeSpeak();
    } else if (result.kind === 'sleep' || result.kind === 'roll') {
      broadcast({ type: 'pulse', ...result.view });
    }
  });
}, 250);

function safeFile(base, requestPath) {
  const url = new URL(`.${requestPath}`, base);
  const basePath = base.pathname;
  if (!url.pathname.startsWith(basePath)) return null;
  return url;
}

function serveFile(url) {
  try {
    const bytes = Deno.readFileSync(url);
    const name = url.pathname;
    const ext = name.slice(name.lastIndexOf('.'));
    return new Response(bytes, {
      headers: {
        'content-type': TYPES[ext] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

function handleSocket(req) {
  const { socket, response } = Deno.upgradeWebSocket(req);
  let clientId = null;
  sockets.add(socket);

  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      send(socket, { type: 'reject', reason: 'invalid JSON' });
      return;
    }
    if (msg.type === 'join') {
      clientId = crypto.randomUUID().slice(0, 8);
      const name = String(msg.name ?? 'spirit').trim().slice(0, 32) || 'spirit';
      const view = await room.join({ id: clientId, name, joinedAt: Date.now() });
      send(socket, { type: 'hello', clientId, ...view });
      broadcast({ type: 'pulse', ...room.view(false) });
      return;
    }
    if (!clientId) {
      send(socket, { type: 'reject', reason: 'join first' });
      return;
    }
    if (msg.type === 'loss') {
      const view = await room.loss(clientId, msg.loss, msg.tokens);
      broadcast({ type: 'pulse', ...view });
      return;
    }
    if (msg.type === 'publish') {
      const result = await room.publish(clientId, {
        delta: decodeF32(msg.deltaB64),
        tokens: msg.tokens,
        loss: msg.loss,
        baseVersion: msg.baseVersion,
      });
      if (!result.ok) {
        send(socket, { type: 'reject', reason: result.reason, ...result.view });
        return;
      }
      if (result.closed) {
        broadcast({ type: 'round', ...result.view });
        maybeSpeak();
      } else {
        broadcast({ type: 'pulse', ...result.view });
      }
      return;
    }
    send(socket, { type: 'reject', reason: 'unknown message' });
  };

  const drop = async () => {
    sockets.delete(socket);
    if (clientId) {
      const view = await room.leave(clientId);
      broadcast({ type: 'pulse', ...view });
    }
  };
  socket.onclose = drop;
  socket.onerror = drop;
  return response;
}

await room.say('The Watcher', 'The Watcher is seated. I will only report a loss I have seen.');

Deno.serve({ port: PORT, hostname: '0.0.0.0' }, (req) => {
  const url = new URL(req.url);
  if (url.pathname === '/ws') return handleSocket(req);
  if (url.pathname === '/health') {
    const view = room.view(false);
    return Response.json({ ok: true, room: view.roomId, version: view.version, spirits: view.clients.length });
  }
  if (url.pathname === '/rooms') {
    const view = room.view(false);
    return Response.json([{
      id: view.roomId,
      version: view.version,
      avgLoss: view.avgLoss,
      spirits: view.clients.length,
      dormant: view.dormant,
    }]);
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveFile(new URL('./public/index.html', ROOT));
  }
  if (url.pathname === '/codec.js') return serveFile(new URL('./codec.js', ROOT));

  if (url.pathname.startsWith('/engine/data/')) {
    const file = safeFile(ENGINE, `/data/${url.pathname.slice('/engine/data/'.length)}`);
    return file ? serveFile(file) : new Response('not found', { status: 404 });
  }
  if (url.pathname === '/engine/train.js' || url.pathname === '/engine/gpt.js' || url.pathname === '/engine/bpe.js') {
    return serveFile(safeFile(ENGINE, `/${url.pathname.slice('/engine/'.length)}`));
  }
  if (url.pathname.startsWith('/vendor/jax/')) {
    const file = safeFile(JAX, `/${url.pathname.slice('/vendor/jax/'.length)}`);
    return file ? serveFile(file) : new Response('not found', { status: 404 });
  }
  if (url.pathname.startsWith('/vendor/optax/')) {
    const file = safeFile(OPTAX, `/${url.pathname.slice('/vendor/optax/'.length)}`);
    return file ? serveFile(file) : new Response('not found', { status: 404 });
  }
  return new Response('not found', { status: 404 });
});

console.log(`seance http://0.0.0.0:${PORT}`);
