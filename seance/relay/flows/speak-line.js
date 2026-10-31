// Read one saved weight file and print the line the model continues from "to be".
// The round-closed flow calls this. It does not train and does not change Orca.

import { speak } from "../../infer.js";
import { decodeF32 } from "../../codec.js";

const path = Deno.args[0];
if (!path) throw new Error("pass the weights file");
const line = await speak(decodeF32(Deno.readTextFileSync(path)), "to be");
console.log(line);
