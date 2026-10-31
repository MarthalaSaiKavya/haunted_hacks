# Séance

One training room. Phones join it, train a tiny Shakespeare model, and send only the change in the weights. The room applies a token-weighted average and keeps the result on disk. The Watcher reports losses it has actually seen. The Voice asks the saved model to continue “to be” and posts that line.

```bash
deno run --allow-net --allow-read --allow-write --allow-env seance/server.js
```

Open the printed port. The circle starts by itself.
