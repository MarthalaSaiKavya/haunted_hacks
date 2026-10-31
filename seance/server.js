// Séance page and voice.
// The training room itself is the TrainingRoom durable actor on port 7100.
// This process serves the page, hands the phone that actor's WebSocket,
// and asks the saved weights for one real line after each round.

import { actors } from './bridge/generated/index.js';
import { decodeF32 } from './codec.js';
import { speak } from './infer.js';

const PORT = 43131;
const ACTOR_ID = 'hall';
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

const tickets = new Map();
let voiceBusy = false;

function room() {
  return actors.TrainingRoom.get(ACTOR_ID);
}

async function seedFromDisk() {
  let saved;
  try {
    saved = JSON.parse(Deno.readTextFileSync(STATE_URL));
  } catch {
    return;
  }
  if (!saved.weightsB64) return;
  const version = await room().seed({
    version: saved.version ?? 0,
    weightsB64: saved.weightsB64,
    lossHistory: saved.lossHistory ?? [],
    messages: saved.messages ?? [],
    spokenVersion: saved.spokenVersion ?? -1,
  });
  console.log(`actor hall is on version ${version}`);
}

async function maybeSpeak() {
  if (voiceBusy) return;
  const snap = await room().snapshot();
  const previous = snap.version - 1;
  if (!snap.weightsB64 || snap.spokenVersion >= previous || previous < 0) return;
  voiceBusy = true;
  try {
    const line = await speak(decodeF32(snap.weightsB64), 'to be');
    await room().recordLine('The Voice', `It continues: ${line}`, previous);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await room().recordLine('The Voice', `The sample failed: ${message}`, previous);
  } finally {
    voiceBusy = false;
  }
}

function safeFile(base, requestPath) {
  const url = new URL(`.${requestPath}`, base);
  if (!url.pathname.startsWith(base.pathname)) return null;
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

function proxyActorSocket(req, upstreamUrl) {
  const { socket, response } = Deno.upgradeWebSocket(req);
  const upstream = new WebSocket(upstreamUrl);
  const waiting = [];
  let open = false;
  upstream.onopen = () => {
    open = true;
    for (const data of waiting) upstream.send(data);
    waiting.length = 0;
  };
  upstream.onmessage = (event) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(event.data);
  };
  upstream.onclose = () => {
    if (socket.readyState === WebSocket.OPEN) socket.close();
  };
  socket.onmessage = (event) => {
    if (open) upstream.send(event.data);
    else waiting.push(event.data);
  };
  socket.onclose = () => upstream.close();
  socket.onerror = () => upstream.close();
  upstream.onerror = () => {
    if (socket.readyState === WebSocket.OPEN) socket.close();
  };
  return response;
}

await seedFromDisk();
setInterval(() => {
  maybeSpeak().catch((error) => console.error(error));
}, 1000);

Deno.serve({ port: PORT, hostname: '0.0.0.0' }, async (req) => {
  const url = new URL(req.url);

  if (url.pathname === '/actor-ws') {
    const ticket = url.searchParams.get('ticket');
    const upstream = ticket ? tickets.get(ticket) : undefined;
    if (!upstream) return new Response('ticket expired', { status: 404 });
    tickets.delete(ticket);
    return proxyActorSocket(req, upstream);
  }

  if (req.method === 'POST' && url.pathname === '/grant') {
    let name = 'spirit';
    try {
      const body = await req.json();
      name = String(body.name ?? 'spirit').trim().slice(0, 32) || 'spirit';
    } catch {
      // keep the default name
    }
    const grant = await actors.TrainingRoom.prepareWebsocket({
      actorId: ACTOR_ID,
      metadata: { name },
    });
    const ticket = crypto.randomUUID();
    tickets.set(ticket, grant.websocketUrl);
    return Response.json({ ticket }, { headers: { 'cache-control': 'no-store' } });
  }

  if (url.pathname === '/health' || url.pathname === '/rooms') {
    const snap = await room().snapshot();
    const summary = {
      id: ACTOR_ID,
      version: snap.version,
      avgLoss: snap.lossHistory.at(-1)?.avgLoss ?? null,
      durableActor: true,
    };
    if (url.pathname === '/health') {
      return Response.json({ ok: true, room: ACTOR_ID, version: snap.version, durableActor: true });
    }
    return Response.json([summary]);
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
