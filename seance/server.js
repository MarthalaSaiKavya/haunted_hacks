// Séance page and voice.
// Orca is the shared durable actor on port 7100. Each phone also has a Worker actor.
// This process serves the page, hands the phone that actor's WebSocket,
// and asks the saved weights for one real line after each round.

import { actors } from './bridge/generated/index.js';

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
const traces = [];
let voiceBusy = false;

function logTrace(entry) {
  const row = {
    at: entry.at || Date.now(),
    name: entry.name || 'server',
    event: entry.event,
    detail: entry.detail || '',
  };
  traces.push(row);
  if (traces.length > 200) traces.shift();
  console.log(`[trace] ${row.name} ${row.event} ${row.detail}`);
}
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

// One closed version becomes one Agent Relay flow.
// The Watcher DMs the loss. The Voice continues "to be" from the saved weights and DMs back.
async function runRoundFlow(snap, last) {
  const weightsPath = await Deno.makeTempFile({ prefix: 'orca-weights-', suffix: '.b64' });
  const resultPath = await Deno.makeTempFile({ prefix: 'orca-relay-', suffix: '.json' });
  await Deno.writeTextFile(weightsPath, snap.weightsB64);
  const input = JSON.stringify({
    version: last.version,
    loss: last.avgLoss.toFixed(3),
    weightsPath,
    resultPath,
    speakScript: new URL('./relay/flows/speak-line.js', import.meta.url).pathname,
    relayBin,
    denoBin: Deno.execPath(),
  });
  const flowPath = new URL('./relay/flows/round-closed.flow.ts', import.meta.url).pathname;
  const proc = new Deno.Command(relayBin, {
    args: ['flows', 'run', flowPath, '--input', input, '--json', '--no-observer-link', '--local-agent'],
    cwd: relayCwd,
    stdout: 'piped',
    stderr: 'piped',
    signal: AbortSignal.timeout(180000),
  });
  const out = await proc.output();
  const text = new TextDecoder().decode(out.stdout).trim();
  const err = new TextDecoder().decode(out.stderr).trim();
  if (out.code !== 0) throw new Error(err || text || `round flow exited ${out.code}`);
  const result = JSON.parse(await Deno.readTextFile(resultPath));
  await Deno.remove(weightsPath).catch(() => {});
  await Deno.remove(resultPath).catch(() => {});
  if (!result.ask || !result.reply) throw new Error('round flow returned no lines');
  await room().recordLine('The Watcher', `To the Voice: ${result.ask}`, snap.spokenVersion);
  await room().recordLine('The Voice', `To the Watcher: ${result.reply}`, last.version);
}

// Once a second: if a version closed and the Voice has not answered it, run the flow once.
// The check uses status() so the weights are only read when a new line is actually due.
async function exchange() {
  if (voiceBusy) return;
  voiceBusy = true;
  try {
    const clock = await room().status();
    const last = clock.lossHistory.at(-1);
    if (!last) return;
    if (last.version <= clock.spokenVersion || asked.has(last.version)) return;
    const snap = await room().snapshot();
    if (!snap.weightsB64) return;
    asked.add(last.version);
    try {
      await runRoundFlow(snap, last);
    } catch (error) {
      asked.delete(last.version);
      throw error;
    }
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
      const name = String(message.name ?? 'a phone').slice(0, 32);
      const result = await room().submitChange({
        name,
        deltaB64: String(message.deltaB64 ?? ''),
        tokens: Number(message.tokens),
        loss: Number(message.loss),
        baseVersion: Number(message.baseVersion),
      });
      logTrace({
        name,
        event: result.accepted ? 'publish-ok' : 'publish-rejected',
        detail: `v${message.baseVersion}->${result.version} loss ${Number(message.loss).toFixed(2)} pieces ${message.tokens} ${result.reason || ''}`.trim(),
      });
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Orca did not accept the change';
      logTrace({ name: String(message.name ?? 'a phone'), event: 'publish-error', detail: reason });
      return Response.json({ accepted: false, version: 0, reason, weightsB64: '' }, { status: 502 });
    }
  }

  if (req.method === 'POST' && url.pathname === '/trace') {
    let entry = {};
    try { entry = await req.json(); } catch { entry = {}; }
    logTrace({
      name: String(entry.name ?? 'phone').slice(0, 32),
      event: String(entry.event ?? 'note').slice(0, 40),
      detail: String(entry.detail ?? '').slice(0, 180),
      at: Number(entry.at) || Date.now(),
    });
    return Response.json({ ok: true });
  }

  if (url.pathname === '/debug') {
    let clock = null;
    try {
      const snap = await room().status();
      clock = {
        version: snap.version,
        deadlineMs: snap.deadlineMs,
        submissions: snap.submissions,
        spokenVersion: snap.spokenVersion,
        phones: snap.phones,
      };
    } catch (error) {
      clock = { error: error instanceof Error ? error.message : String(error) };
    }
    return Response.json({ clock, traces: traces.slice(-80) }, { headers: { 'cache-control': 'no-store' } });
  }

  if (url.pathname === '/clock') {
    try {
      const snap = await room().status();
      return Response.json({
        version: snap.version,
        deadlineMs: snap.deadlineMs,
        submissions: snap.submissions,
        lastSave: snap.lastSave,
      }, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'clock failed';
      logTrace({ name: 'server', event: 'clock-error', detail: reason });
      return Response.json({ version: null, deadlineMs: 0, submissions: 0, reason }, { status: 502 });
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

  if (url.pathname === '/weights') {
    const snap = await room().snapshot();
    return Response.json({
      version: snap.version,
      weightsB64: snap.weightsB64,
    }, { headers: { 'cache-control': 'no-store' } });
  }

  if (url.pathname === '/live') {
    const snap = await room().status();
    return Response.json({
      version: snap.version,
      spokenVersion: snap.spokenVersion,
      deadlineMs: snap.deadlineMs,
      submissions: snap.submissions,
      messages: snap.messages,
      lastSave: snap.lastSave,
      lossHistory: snap.lossHistory,
      phones: snap.phones,
    }, { headers: { 'cache-control': 'no-store' } });
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
  if (url.pathname === '/frames') {
    return serveFile(new URL('./public/frames.html', ROOT));
  }
  if (url.pathname === '/intro') {
    return serveFile(new URL('./public/intro.html', ROOT));
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
