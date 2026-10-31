# The original in-memory coordinator. The séance demo uses seance/hall instead.
FROM denoland/deno:2.2.0

WORKDIR /app

COPY server.ts .
RUN deno cache server.ts

EXPOSE 7010
ENV PORT=7010

CMD ["run", "--allow-net", "--allow-env", "server.ts"]
