// When Orca closes a version, the Watcher tells the Voice the loss.
// The Voice reads the saved weights, continues from "to be", and replies.
// Training has already finished before this flow starts.

import { flow } from "@relayflows/surface";

type Round = {
  version: number;
  loss: string;
  weightsPath: string;
  resultPath: string;
  speakScript: string;
  relayBin: string;
  denoBin: string;
};

function sh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export default flow<Round>("seance-round", async (f, input) => {
  const ask = `Version ${input.version} closed. Mean loss ${input.loss}. Continue from "to be".`;
  await f.run(
    `${sh(input.relayBin)} message dm send voice ${sh(ask)} --as watcher`,
    { timeout: "30s" },
  );
  const spoken = await f.run(
    `${sh(input.denoBin)} run --allow-read --allow-env --allow-net ${sh(input.speakScript)} ${sh(input.weightsPath)}`,
    { timeout: "3m" },
  );
  const reply = `It continues: ${spoken.trim().split("\n").at(-1) ?? ""}`;
  await f.run(
    `${sh(input.relayBin)} message dm send watcher ${sh(reply)} --as voice`,
    { timeout: "30s" },
  );
  await f.run(`printf %s ${sh(JSON.stringify({ ask, reply }))} > ${sh(input.resultPath)}`, { timeout: "10s" });
  f.done("success");
});
