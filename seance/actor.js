// Earlier room, before the durable actor. server.js does not call this anymore.
// Kept so the first version of the circle is still readable.
// One training room. One id. Calls run one at a time.
// Weights, version, loss, and the circle's speech are written to disk
// before the call returns. Connected spirits are not durable: a restart
// keeps the model and forgets who was in the room.

import { applyAverage } from './average.js';
import { decodeF32, encodeF32 } from './codec.js';

const QUORUM = 1;
const ROUND_MS = 12000;
const GRACE_MS = 3000;
const SLEEP_MS = 10000;

export function createRoom({ id, readState, writeState }) {
  const saved = readState() ?? {};
  const room = {
    id,
    version: saved.version ?? 0,
    weights: saved.weightsB64 ? decodeF32(saved.weightsB64) : new Float32Array(0),
    lossHistory: saved.lossHistory ?? [],
    messages: saved.messages ?? [],
    spokenVersion: saved.spokenVersion ?? -1,
    offerings: [],
    tokenSum: 0,
    deadlineMs: Date.now() + ROUND_MS,
    submitSent: false,
    lastActive: Date.now(),
    dormant: false,
    clients: new Map(),
  };
  let chain = Promise.resolve();

  // Run room changes in a line, so two phones cannot edit weights at once.
  function enqueue(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  }

  // Write version, weights, loss, and messages to seance/state/hall.json.
  function persist() {
    writeState({
      id: room.id,
      version: room.version,
      weightsB64: room.weights.length ? encodeF32(room.weights) : '',
      lossHistory: room.lossHistory,
      messages: room.messages.slice(-40),
      spokenVersion: room.spokenVersion,
    });
  }

  // Mark the room busy, so the 10 second sleep timer starts over.
  function touch() {
    room.lastActive = Date.now();
    room.dormant = false;
  }

  // Names of phones connected right now. Not saved across a restart.
  function clientList() {
    return [...room.clients.values()].map((client) => ({
      id: client.id,
      name: client.name,
      joinedAt: client.joinedAt,
    }));
  }

  // The snapshot the page draws. includeWeights is true only when the phone needs the model.
  function view(includeWeights) {
    const last = room.lossHistory.at(-1);
    return {
      roomId: room.id,
      version: room.version,
      weightsB64: includeWeights && room.weights.length ? encodeF32(room.weights) : '',
      lossHistory: room.lossHistory,
      avgLoss: last ? last.avgLoss : null,
      messages: room.messages,
      clients: clientList(),
      deadlineMs: room.deadlineMs,
      dormant: room.dormant,
      submissions: room.offerings.length,
      quorum: QUORUM,
      spokenVersion: room.spokenVersion,
    };
  }

  // Append one transcript line and keep only the latest 40.
  function say(from, text) {
    room.messages.push({ at: Date.now(), from, text });
    if (room.messages.length > 40) room.messages.shift();
  }

  // Average the offerings, store the mean loss, and start the next 12 second round.
  function finishRound(now) {
    if (room.offerings.length === 0) return false;
    const lossSum = room.offerings.reduce((sum, item) => sum + item.loss, 0);
    const avgLoss = lossSum / room.offerings.length;
    room.weights = applyAverage(room.weights, room.offerings);
    room.lossHistory.push({ version: room.version, avgLoss });
    say('The Watcher', `Version ${room.version} closes. Mean loss ${avgLoss.toFixed(3)}, from ${room.offerings.length} offering${room.offerings.length === 1 ? '' : 's'}.`);
    room.version += 1;
    room.offerings = [];
    room.tokenSum = 0;
    room.deadlineMs = now + ROUND_MS;
    room.submitSent = false;
    touch();
    persist();
    return true;
  }

  return {
    view,
    say(from, text) {
      return enqueue(() => {
        touch();
        say(from, text);
        persist();
        return view(false);
      });
    },
    markSpoken(version) {
      return enqueue(() => {
        room.spokenVersion = version;
        persist();
        return view(false);
      });
    },
    join(client) {
      return enqueue(() => {
        touch();
        room.clients.set(client.id, client);
        return view(true);
      });
    },
    leave(clientId) {
      return enqueue(() => {
        room.clients.delete(clientId);
        return view(false);
      });
    },
    loss(clientId, loss, tokens) {
      return enqueue(() => {
        const client = room.clients.get(clientId);
        if (!client || !(tokens > 0) || typeof loss !== 'number') return view(false);
        touch();
        client.loss = loss;
        client.tokens = tokens;
        const already = room.messages.some((message) => message.from === 'The Watcher' && message.versionMark === room.version);
        if (!already) {
          room.messages.push({
            at: Date.now(),
            from: 'The Watcher',
            versionMark: room.version,
            text: `${client.name} is in the circle. Loss ${loss.toFixed(3)} on this step.`,
          });
          if (room.messages.length > 40) room.messages.shift();
          persist();
        }
        return view(false);
      });
    },
    publish(clientId, payload) {
      return enqueue(() => {
        const client = room.clients.get(clientId);
        if (!client) return { ok: false, reason: 'you are not in the circle', view: view(false) };
        if (payload.baseVersion !== room.version) {
          return { ok: false, reason: `the room is on version ${room.version}`, view: view(true) };
        }
        const delta = payload.delta;
        if (!(delta instanceof Float32Array) || delta.length === 0) {
          return { ok: false, reason: 'empty offering', view: view(false) };
        }
        if (room.weights.length !== 0 && delta.length !== room.weights.length) {
          return { ok: false, reason: `offering length ${delta.length} does not match the room`, view: view(false) };
        }
        if (!(payload.tokens > 0) || typeof payload.loss !== 'number') {
          return { ok: false, reason: 'loss and tokens are required', view: view(false) };
        }
        touch();
        room.offerings.push({ delta, tokens: payload.tokens, loss: payload.loss });
        room.tokenSum += payload.tokens;
        const closed = room.offerings.length >= QUORUM ? finishRound(Date.now()) : false;
        if (!closed) persist();
        return { ok: true, closed, view: view(closed || room.weights.length > 0) };
      });
    },
    tick(now) {
      return enqueue(() => {
        const idle = now - room.lastActive;
        if (!room.dormant && idle >= SLEEP_MS && room.offerings.length === 0) {
          room.dormant = true;
          persist();
          return { kind: 'sleep', view: view(false) };
        }
        if (!room.submitSent && now >= room.deadlineMs - GRACE_MS) {
          room.submitSent = true;
          return { kind: 'submit', view: view(false) };
        }
        if (now >= room.deadlineMs) {
          if (room.offerings.length > 0) {
            finishRound(now);
            return { kind: 'round', view: view(true) };
          }
          room.deadlineMs = now + ROUND_MS;
          room.submitSent = false;
          return { kind: 'roll', view: view(false) };
        }
        return { kind: 'quiet', view: view(false) };
      });
    },
    weights() {
      return room.weights;
    },
    needsVoice() {
      const previous = room.version - 1;
      return room.weights.length > 0 && room.spokenVersion < previous && previous >= 0;
    },
  };
}
