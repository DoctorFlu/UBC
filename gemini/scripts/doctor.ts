/**
 * `npm run gemini:doctor`: checks the Gemini trading settings in `.env` (or the environment) before the
 * executor trades with them. Read-only, and it prints no key and no secret; see `src/doctor.ts`.
 *
 * Exit status: 0 ready, 1 not ready (the reason is printed), 2 the sandbox could not be reached.
 */
import { loadEnv } from "@mandate/shared";
import { geminiDoctor } from "../src/doctor";

const loaded = loadEnv();
console.log("Gemini doctor: read-only; prints no key and no secret.");
console.log(`Settings from: ${loaded ?? "the environment only (no .env file found)"}`);
process.exitCode = await geminiDoctor({
  env: process.env,
  say: (line) => {
    console.log(line);
  },
});
