/**
 * `npm run gemini:maker`: the mirror maker (docs/gemini-venue.md, "The mirror maker"). Quotes Gemini's
 * sandbox at Gemini production's prices from the maker's own sandbox account, until stopped (Ctrl-C or
 * SIGTERM), then cancels every order of its own.
 *
 *   npm run gemini:maker                    run
 *   npm run gemini:maker -- --cancel-all    cancel every open order of the maker's, and exit
 *
 * Settings come from `.env` (or `ENV_FILE`) and the environment; see `src/maker/settings.ts`. It prints no
 * key and no secret. The sandbox host is fixed: there is no setting that sends its orders anywhere else.
 */
import { loadEnv } from "@mandate/shared";
import { createGeminiClient } from "../src/client";
import { GEMINI_HOSTS } from "../src/environment";
import { MirrorMaker } from "../src/maker/maker";
import { makerSettings } from "../src/maker/settings";
import { createGeminiPrivateClient } from "../src/private";

const say = (line: string) => {
  console.log(`${new Date().toISOString()} maker: ${line}`);
};

const loaded = loadEnv();
say(`settings from ${loaded ?? "the environment only (no .env file found)"}`);
const settings = makerSettings(process.env);
const maker = new MirrorMaker({
  production: createGeminiClient({ baseUrl: GEMINI_HOSTS.production }),
  sandbox: createGeminiClient({ baseUrl: GEMINI_HOSTS.sandbox }),
  account: createGeminiPrivateClient({ environment: "sandbox", credentials: settings.credentials }),
  settings,
  say,
});

if (process.argv.includes("--cancel-all")) {
  const cancelled = await maker.cancelAll();
  say(`cancelled ${String(cancelled)} open order(s) of the maker's`);
} else {
  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      say(`${signal}: cancelling every order of the maker's, then stopping`);
      stop.abort();
    });
  }
  await maker.run(stop.signal);
}
