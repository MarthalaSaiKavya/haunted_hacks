# Séance

Phones train a tiny Shakespeare model and send only the change in the weights. The room is a durable actor (`seance/hall`, class `TrainingRoom`). `@Persisted` fields hold the version, weights, loss history, and transcript. The actor handles one update at a time and saves before it answers. Its WebSocket is what the page uses.

Two processes:

```bash
cd seance/hall && bunx durable-actors dev
deno run --allow-net --allow-read --allow-write --allow-env seance/server.js
```

`terse deploy` from `seance/hall` publishes that same actor to Terse. It requires `terse auth login` first. This machine is not logged in, so the actor is running on the local durable-actors runtime instead.
