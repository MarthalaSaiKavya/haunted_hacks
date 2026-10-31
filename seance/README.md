# Séance

Phones train one Shakespeare model. Orca, a durable actor, keeps the shared weights. After each save, Agent Relay runs two agents: the Watcher reports the loss, and the Voice continues from “to be”.

The full picture, with diagrams, is in the [repo README](../README.md).

## What runs here

```text
seance/hall/src/actors.ts          Orca and Worker
seance/server.js                   the screen, /join, /publish, the voice trigger
seance/relay/flows/round-closed.flow.ts
                                   Watcher DM, then Voice DM
seance/demo-phone.js               the phone named demo
seance/public/                     /, /join, /intro, /frames
```

`/frames` is only for a screen recording. The main screen does not link to it.

## Run

```bash
cd seance/hall && terse actor dev
```

From the repo root:

```bash
deno run --allow-net --allow-read --allow-write --allow-env --allow-run seance/server.js
deno run --config seance/deno.json --allow-net --allow-read --allow-write seance/demo-phone.js
```

Open `http://127.0.0.1:43131/`.

`terse actor dev` is the local actor host at `http://127.0.0.1:7100`. `terse deploy` from `seance/hall` publishes Orca and Worker. Put `TERSE_ACTOR_URL` and `TERSE_API_KEY` in the server environment only.
