/**
 * `npm run gemini:doctor`: checks the Gemini trading settings in `.env` (or the environment) before the
 * executor trades with them (issue #93). Read-only: it places nothing, cancels nothing and never accepts
 * terms. It prints no key and no secret, only whether each is set, the key's documented kind and length.
 *
 * First it finds out which environment the key belongs to, because a key from Gemini's normal site is a
 * production key (real money) and a sandbox key comes only from a separate account on
 * exchange.sandbox.gemini.com. It asks the sandbox the one question any key may ask, POST /v1/roles: the
 * sandbox answers for its own keys and refuses every other key as unknown. It never sends a request signed
 * with the key to production, so a key the sandbox does not know is reported as "not a sandbox key" and
 * the doctor stops there.
 *
 * Only for a sandbox key, and only when GEMINI_ENV agrees, it then checks the key's role, the Prediction
 * Markets terms and the USD balance.
 *
 * Exit status: 0 ready, 1 not ready (the reason is printed), 2 the sandbox could not be reached.
 */
import { loadEnv } from "@mandate/shared";
import {
  createGeminiPrivateClient,
  geminiTradingSettings,
  isGeminiPrivateError,
  keyScope,
  type GeminiPrivateClient,
  type GeminiPrivateError,
  type GeminiTradingSettings,
} from "../src/private-index";

const loaded = loadEnv();

function say(line = ""): void {
  console.log(line);
}

function finish(status: 0 | 1 | 2, verdict: string): never {
  say();
  say(verdict);
  process.exit(status);
}

function reasonOf(error: GeminiPrivateError): string {
  return error.reason ?? (error.status === undefined ? error.kind : `HTTP ${String(error.status)}`);
}

say("Gemini doctor: read-only; prints no key and no secret.");
say(`Settings from: ${loaded ?? "the environment only (no .env file found)"}`);

let settings: GeminiTradingSettings;
try {
  settings = geminiTradingSettings(process.env);
} catch (error) {
  finish(1, `NOT READY: ${error instanceof Error ? error.message : String(error)}`);
}

const rawKey = process.env.GEMINI_API_KEY?.trim() ?? "";
const rawSecret = process.env.GEMINI_API_SECRET?.trim() ?? "";
say(`GEMINI_ENV:        ${settings.environment}${process.env.GEMINI_ENV?.trim() ? "" : " (the default)"}`);
say(
  `GEMINI_API_KEY:    ${rawKey === "" ? "not set" : `set, ${keyScope(rawKey) === "unknown" ? "no documented prefix" : `${keyScope(rawKey)} key`}, ${String(rawKey.length)} characters`}`,
);
say(`GEMINI_API_SECRET: ${rawSecret === "" ? "not set" : `set, ${String(rawSecret.length)} characters`}`);
say(
  `EXECUTOR_VENUE:    ${process.env.EXECUTOR_VENUE?.trim() || "simulated (the default: no order is placed anywhere)"}`,
);

const credentials = settings.credentials;
if (credentials === null) {
  finish(1, "NOT READY: GEMINI_API_KEY and GEMINI_API_SECRET must both be set.");
}
if (keyScope(credentials.apiKey) === "master") {
  finish(
    1,
    "NOT READY: this is a master key, which would have to name an account on every request. " +
      "Create an account-scoped key instead (Settings, API, on the account that will trade).",
  );
}

const sandbox: GeminiPrivateClient = createGeminiPrivateClient({ environment: "sandbox", credentials });

say();
say("1. Which environment is this key from? Asking the sandbox POST /v1/roles (changes nothing).");
let roles: Awaited<ReturnType<GeminiPrivateClient["roles"]>>;
try {
  roles = await sandbox.roles();
  say("   The sandbox knows this key: it is a SANDBOX key (test funds only).");
} catch (error) {
  if (!isGeminiPrivateError(error)) throw error;
  if (error.outcomeUnknown || error.kind === "rate_limited") {
    finish(
      2,
      `UNKNOWN: the sandbox did not answer usefully (${error.message}). Run the doctor again in a minute.`,
    );
  }
  if (error.kind === "auth" && error.reason === "InvalidApiKey") {
    say(`   The sandbox refused it as an unknown key (${reasonOf(error)}): it is NOT a sandbox key.`);
    say("   A key made on exchange.gemini.com is a production key: it trades real money.");
    say("   (This doctor never sends a request signed with it to production, so it checks nothing more.)");
    if (settings.environment === "sandbox") {
      finish(
        1,
        "REFUSED: GEMINI_ENV is sandbox, but this key is not a sandbox key. Do not use it here. Make a " +
          "separate account on https://exchange.sandbox.gemini.com, create an API key there (Settings, API: " +
          "account-scoped, Trader role, time-based nonce), and put that key and its secret in .env.",
      );
    }
    finish(
      1,
      "NOT CHECKED: GEMINI_ENV is production and the key is not a sandbox key, which fits, but this doctor " +
        "makes no call to production. Live trading stays off until it is checked another way.",
    );
  }
  if (error.kind === "auth" && error.reason === "InvalidSignature") {
    finish(
      1,
      "NOT READY: the sandbox knows this key, but GEMINI_API_SECRET is not its secret (InvalidSignature). " +
        "Copy the secret again; Gemini shows it only once, so you may need a new key.",
    );
  }
  if (error.kind === "nonce") {
    finish(
      1,
      `NOT READY: the sandbox knows this key but refused the nonce (${reasonOf(error)}). Create the key with ` +
        "a time-based nonce, check this machine's clock, and make sure no other process uses the key.",
    );
  }
  finish(1, `NOT READY: the sandbox refused the key (${reasonOf(error)}: ${error.message}).`);
}

if (settings.environment === "production") {
  finish(
    1,
    "REFUSED: GEMINI_ENV is production, but this is a sandbox key. Set GEMINI_ENV=sandbox (or unset it) " +
      "to trade test funds with it.",
  );
}

const problems: string[] = [];

say();
say("2. Can the key trade?");
const roleNames = Object.entries(roles)
  .filter(([, on]) => on === true)
  .map(([name]) => name.replace(/^is/, ""));
say(`   Roles: ${roleNames.join(", ") || "none reported"}`);
if (roles.isTrader !== true) problems.push("the key lacks the Trader role, which placing orders needs");

say();
say("3. Has the account accepted the Prediction Markets terms? (Checked, never accepted from here.)");
try {
  const terms = await sandbox.termsStatus();
  say(
    `   ${terms.hasAcceptedLatest ? "Yes" : "No"}: accepted version ${String(terms.acceptedVersion ?? "none")}, ` +
      `latest ${String(terms.latestVersion ?? "unknown")}.`,
  );
  if (!terms.hasAcceptedLatest) {
    problems.push(
      "the latest Prediction Markets terms are not accepted: sign in at https://exchange.sandbox.gemini.com, " +
        "open Prediction Markets and accept them there",
    );
  }
} catch (error) {
  if (!isGeminiPrivateError(error)) throw error;
  say(`   Could not check: ${error.message}`);
  problems.push(`the terms status could not be read (${reasonOf(error)})`);
}

say();
say("4. What can it spend?");
try {
  const usd = (await sandbox.balances()).find((balance) => balance.currency.toUpperCase() === "USD");
  say(`   USD available: ${usd?.available ?? "none"} (amount ${usd?.amount ?? "none"}).`);
  if (!usd || !(Number(usd.available) > 0))
    problems.push("the account has no USD available to buy contracts");
} catch (error) {
  if (!isGeminiPrivateError(error)) throw error;
  say(`   Could not check: ${error.message}`);
  problems.push(`the balances could not be read (${reasonOf(error)})`);
}

if (problems.length > 0) finish(1, `NOT READY: ${problems.join("; ")}.`);
finish(
  0,
  "READY: a sandbox key with the Trader role, the terms accepted and USD to spend. Set EXECUTOR_VENUE=gemini " +
    "to have the executor place approved orders on Gemini's sandbox.",
);
