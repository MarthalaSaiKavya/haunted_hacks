// Séance page and voice.
// Orca is the shared durable actor on port 7100. Each phone also has a Worker actor.
// This process serves the page, hands the phone that actor's WebSocket,
// and asks the saved weights for one real line after each round.

import { actors } from './bridge/generated/index.js';
import { decodeF32 } from './codec.js';
import { speak } from './infer.js';

const PORT = 43131;
const ACTOR_ID = 'orca';
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
const asked = new Set();
const relayBin = new URL('./relay/node_modules/.bin/agent-relay', import.meta.url).pathname;
const relayCwd = new URL('./relay/', import.meta.url).pathname;

// The one shared model. Every phone sends its change here.
function room() {
  return actors.Orca.get(ACTOR_ID);
}

// If an older file has a higher version than the actor, copy it in once.
async function seedFromDisk() {
  let saved = null;
  for (const name of ['./state/orca-seed.json', './state/hall.json']) {
    try {
      saved = JSON.parse(Deno.readTextFileSync(new URL(name, import.meta.url)));
      break;
    } catch {
      saved = null;
    }
  }
  if (!saved?.weightsB64) return;
  const version = await room().seed({
    version: saved.version ?? 0,
    weightsB64: saved.weightsB64,
    lossHistory: saved.lossHistory ?? [],
    messages: saved.messages ?? [],
    spokenVersion: saved.spokenVersion ?? -1,
  });
  console.log(`orca is on version ${version}`);
}

// Run one Agent Relay command and return its JSON.
// Example: relay(['message','dm','send','voice','hello','--as','watcher'])
async function relay(args) {
  const proc = new Deno.Command(relayBin, {
    args,
    cwd: relayCwd,
    stdout: 'piped',
    stderr: 'piped',
    signal: AbortSignal.timeout(8000),
  });
  const out = await proc.output();
  const text = new TextDecoder().decode(out.stdout).trim();
  const err = new TextDecoder().decode(out.stderr).trim();
  if (out.code !== 0) throw new Error(err || text || `agent-relay exited ${out.code}`);
  const start = text.search(/[{[]/);
  return start === -1 ? text : JSON.parse(text.slice(start));
}

// After a new round, the Watcher DMs the Voice the real mean loss. Once per version.
async function watcherStep(snap) {
  const last = snap.lossHistory.at(-1);
  if (!last || !snap.weightsB64) return;
  if (last.version <= snap.spokenVersion || asked.has(last.version)) return;
  const text = `Version ${last.version} closed. Mean loss ${last.avgLoss.toFixed(3)}. Continue from "to be".`;
  await relay(['message', 'dm', 'send', 'voice', text, '--as', 'watcher']);
  await room().recordLine('The Watcher', `To the Voice: ${text}`, snap.spokenVersion);
  asked.add(last.version);
}

// The Voice reads the Watcher's DM, runs the saved model, and DMs the line back.
async function voiceStep() {
  const inbox = await relay(['message', 'inbox', 'check', '--as', 'voice']);
  for (const dm of inbox.unreadDms ?? []) {
    if (dm.from !== 'watcher' || !dm.conversationId) continue;
    const listed = await relay(['message', 'dm', 'list', dm.conversationId, '--as', 'voice', '--limit', '20']);
    const messages = Array.isArray(listed) ? listed : [];
    const request = messages.find((item) =>
      item.from?.name === 'watcher' && /^Version \d+ closed\. Mean loss [0-9.]+/.test(item.text ?? '')
    );
    if (!request) {
      if (dm.lastMessage?.id) await relay(['message', 'inbox', 'mark_read', dm.lastMessage.id, '--as', 'voice']);
      continue;
    }
    const closed = Number(request.text.match(/^Version (\d+)/)[1]);
    const snap = await room().snapshot();
    if (!snap.weightsB64 || closed <= snap.spokenVersion) {
      await relay(['message', 'inbox', 'mark_read', request.id, '--as', 'voice']);
      continue;
    }
    let reply;
    try {
      const line = await speak(decodeF32(snap.weightsB64), 'to be');
      reply = `It continues: ${line}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply = `The sample failed: ${message}`;
    }
    await relay(['message', 'dm', 'send', 'watcher', reply, '--as', 'voice']);
    await room().recordLine('The Voice', `To the Watcher: ${reply}`, closed);
    await relay(['message', 'inbox', 'mark_read', request.id, '--as', 'voice']);
  }
}

// Once a second: let the Watcher speak, then let the Voice answer. Never overlap.
async function exchange() {
  if (voiceBusy) return;
  voiceBusy = true;
  try {
    const snap = await room().snapshot();
    await watcherStep(snap);
    await voiceStep();
  } finally {
    voiceBusy = false;
  }
}

// Join a URL onto a folder and refuse anything that escapes that folder.
function safeFile(base, requestPath) {
  const url = new URL(`.${requestPath}`, base);
  if (!url.pathname.startsWith(base.pathname)) return null;
  return url;
}

// Read one file from disk and send it to the browser. Missing file is a 404.
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

// The actor's socket is on this machine. Copy bytes both ways so a phone can use it.
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

try {
  await seedFromDisk();
} catch (error) {
  console.error('could not copy the saved model into Orca', error);
}
setInterval(() => {
  exchange().catch((error) => console.error(error));
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

  if (req.method === 'POST' && url.pathname === '/publish') {
    let message;
    try {
      message = await req.json();
    } catch {
      return Response.json({ accepted: false, version: 0, reason: 'the change was not valid JSON', weightsB64: '' }, { status: 400 });
    }
    try {
      const result = await room().submitChange({
        name: String(message.name ?? 'a phone').slice(0, 32),
        deltaB64: String(message.deltaB64 ?? ''),
        tokens: Number(message.tokens),
        loss: Number(message.loss),
        baseVersion: Number(message.baseVersion),
      });
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Orca did not accept the change';
      return Response.json({ accepted: false, version: 0, reason, weightsB64: '' }, { status: 502 });
    }
  }

  if (req.method === 'POST' && url.pathname === '/grant') {
    let name = 'phone';
    let workerId = '';
    let body = {};
    try {
      body = await req.json();
      name = String(body.name ?? 'phone').trim().slice(0, 32) || 'phone';
      workerId = String(body.workerId ?? '');
    } catch {
      // keep the defaults
    }
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(workerId)) workerId = crypto.randomUUID();
    const role = body.role === 'screen' ? 'screen' : 'phone';
    const orcaGrant = await actors.Orca.prepareWebsocket({
      actorId: ACTOR_ID,
      metadata: { name, role },
    });
    if (role === 'screen') {
      const ticket = crypto.randomUUID();
      tickets.set(ticket, orcaGrant.websocketUrl);
      return Response.json({ ticket, role }, { headers: { 'cache-control': 'no-store' } });
    }
    const workerGrant = await actors.Worker.prepareWebsocket({
      actorId: workerId,
      metadata: { name, role },
    });
    const ticket = crypto.randomUUID();
    const workerTicket = crypto.randomUUID();
    tickets.set(ticket, orcaGrant.websocketUrl);
    tickets.set(workerTicket, workerGrant.websocketUrl);
    return Response.json({ ticket, workerTicket, workerId }, { headers: { 'cache-control': 'no-store' } });
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
  if (url.pathname === '/join' || url.pathname === '/join.html') {
    return serveFile(new URL('./public/join.html', ROOT));
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
