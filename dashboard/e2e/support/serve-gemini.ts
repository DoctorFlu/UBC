/**
 * `tsx e2e/support/serve-gemini.ts --port 8655`: serves the recorded Gemini responses (see
 * fake-gemini.ts), prints "fake gemini ready" and runs until stopped. Playwright starts it before the
 * console, which reads it through GEMINI_API_URL.
 */
import { parseArgs } from "node:util";

import { startFakeGemini } from "./fake-gemini";

const { values } = parseArgs({ options: { port: { type: "string", default: "8655" } } });
const gemini = await startFakeGemini(Number(values.port));
console.log(`fake gemini ready: ${gemini.url}`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await gemini.stop();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
