/**
 * `npm run gemini:maker:doctor`: checks the mirror maker's settings, both sandbox accounts and the rungs
 * it would quote. Read-only, and it prints no key and no secret; see `src/maker/doctor.ts`.
 *
 * Exit status: 0 ready, 1 not ready (the reason is printed), 2 the sandbox could not be reached.
 */
import { loadEnv } from "@mandate/shared";
import { createGeminiClient } from "../src/client";
import { GEMINI_HOSTS } from "../src/environment";
import { makerDoctor } from "../src/maker/doctor";

const loaded = loadEnv();
console.log("Mirror maker doctor: read-only; prints no key and no secret.");
console.log(`Settings from: ${loaded ?? "the environment only (no .env file found)"}`);
process.exitCode = await makerDoctor({
  env: process.env,
  say: (line) => {
    console.log(line);
  },
  production: createGeminiClient({ baseUrl: GEMINI_HOSTS.production }),
  sandbox: createGeminiClient({ baseUrl: GEMINI_HOSTS.sandbox }),
});
