# Séance

Phones train a tiny Shakespeare model and send only the change in the weights. Orca (`seance/hall`, class `Orca`, id `orca`) is the one shared actor. It keeps the averaged weights. Each phone also has its own Worker actor, which only remembers that phone.

Two processes:

```bash
cd seance/hall && terse actor dev
deno run --allow-net --allow-read --allow-write --allow-env --allow-run seance/server.js
```

`terse actor dev` serves Orca and Worker at `http://127.0.0.1:7100`. The page talks to that local runtime unless `TERSE_ACTOR_URL` and `TERSE_API_KEY` are set in the environment of `seance/server.js`.

`terse deploy` from `seance/hall` publishes the same two actors. The hosted address is `https://api.useterse.ai/cmvwscatj00t9jy2azovudy8m/actors`. Keep the API key in that server environment. Do not put it in the page or in git.

The Watcher and the Voice are two Agent Relay agents. After a round the Watcher DMs the Voice with the measured loss. The Voice reads that DM, runs the saved weights, and DMs the reply back. Those two lines are also written into the room transcript.
