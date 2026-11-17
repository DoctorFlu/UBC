/**
 * The Gemini doctor (`npm run gemini:doctor`, issue #93): checks the Gemini trading settings before the
 * executor trades with them. Read-only: it places nothing, cancels nothing and never accepts terms. It
 * prints no key and no secret, only whether each is set, the key's documented kind and its length.
 *
 * First it finds out which environment the key belongs to, because a key from Gemini's normal site is a
 * production key (real money) and a sandbox key comes only from a separate account on
 * exchange.sandbox.gemini.com. It asks the sandbox the one question any key may ask, POST /v1/roles: a
 * key the sandbox answers for is a sandbox key, and Gemini documents InvalidApiKey for a key it does not
 * know. It never sends a request signed with the key to production, so a key the sandbox does not know
 * is reported as "not a sandbox key" and the doctor stops there.
 *
 * Only for a sandbox key, and only when GEMINI_ENV agrees, it then checks the key's role, the Prediction
 * Markets terms and the USD balance.
 */
import { createGeminiPrivateClient, type GeminiCredentials, type GeminiPrivateClient } from "./private";
import { isGeminiPrivateError, type GeminiPrivateError } from "./private-errors";
import { geminiTradingSettings, keyScope, type GeminiTradingSettings } from "./private-settings";

/** 0 ready, 1 not ready (the reason is printed), 2 the sandbox could not be reached. */
export type DoctorStatus = 0 | 1 | 2;

export interface DoctorOptions {
  env: Record<string, string | undefined>;
  /** Where each line goes. */
  say: (line: string) => void;
  /** Builds the signed sandbox client; tests pass one on a fake. */
  sandboxClient?: (credentials: GeminiCredentials) => GeminiPrivateClient;
}

const SANDBOX_SITE = "https://exchange.sandbox.gemini.com";

function reasonOf(error: GeminiPrivateError): string {
  return error.reason ?? (error.status === undefined ? error.kind : `HTTP ${String(error.status)}`);
}

function describeKey(key: string): string {
  if (key === "") return "not set";
  const scope = keyScope(key);
  return `set, ${scope === "unknown" ? "no documented prefix" : `${scope} key`}, ${String(key.length)} characters`;
}

export async function geminiDoctor(options: DoctorOptions): Promise<DoctorStatus> {
  const { env, say } = options;
  const finish = (status: DoctorStatus, verdict: string): DoctorStatus => {
    say("");
    say(verdict);
    return status;
  };

  let settings: GeminiTradingSettings;
  try {
    settings = geminiTradingSettings(env);
  } catch (error) {
    return finish(1, `NOT READY: ${error instanceof Error ? error.message : String(error)}`);
  }
  const key = env.GEMINI_API_KEY?.trim() ?? "";
  const secret = env.GEMINI_API_SECRET?.trim() ?? "";
  say(`GEMINI_ENV:        ${settings.environment}${env.GEMINI_ENV?.trim() ? "" : " (the default)"}`);
  say(`GEMINI_API_KEY:    ${describeKey(key)}`);
  say(`GEMINI_API_SECRET: ${secret === "" ? "not set" : `set, ${String(secret.length)} characters`}`);
  say(
    `EXECUTOR_VENUE:    ${env.EXECUTOR_VENUE?.trim() || "simulated (the default: no order is placed anywhere)"}`,
  );

  const credentials = settings.credentials;
  if (credentials === null) {
    return finish(1, "NOT READY: GEMINI_API_KEY and GEMINI_API_SECRET must both be set.");
  }
  if (keyScope(credentials.apiKey) === "master") {
    return finish(
      1,
      "NOT READY: this is a master key, which would have to name an account on every request. Create an " +
        "account-scoped key instead (Settings, API, on the account that will trade).",
    );
  }

  const sandbox = (
    options.sandboxClient ?? ((c) => createGeminiPrivateClient({ environment: "sandbox", credentials: c }))
  )(credentials);

  say("");
  say("1. Which environment is this key from? Asking the sandbox POST /v1/roles (changes nothing).");
  let roles: Awaited<ReturnType<GeminiPrivateClient["roles"]>>;
  try {
    roles = await sandbox.roles();
    say("   The sandbox answered for this key: it is a SANDBOX key (test funds only).");
  } catch (error) {
    if (!isGeminiPrivateError(error)) throw error;
    if (error.outcomeUnknown || error.kind === "rate_limited") {
      return finish(
        2,
        `UNKNOWN: the sandbox did not answer usefully (${error.message}). Run the doctor again in a minute.`,
      );
    }
    if (error.kind === "auth" && error.reason === "InvalidApiKey") {
      say(`   The sandbox does not know this key (${reasonOf(error)}): it is NOT a sandbox key.`);
      say(
        "   A key made on exchange.gemini.com, the normal site, is a production key: it trades real money.",
      );
      say("   (This doctor never sends a request signed with it to production, so it checks nothing more.)");
      if (settings.environment === "sandbox") {
        return finish(
          1,
          "REFUSED: GEMINI_ENV is sandbox, but this key is not a sandbox key. Do not use it here. Make a " +
            `separate account on ${SANDBOX_SITE}, create an API key there (Settings, API: account-scoped, ` +
            "Trader role, time-based nonce), and put that key and its secret in .env.",
        );
      }
      return finish(
        1,
        "NOT CHECKED: GEMINI_ENV is production and the key is not a sandbox key, which fits, but this " +
          "doctor makes no call to production. Live trading stays off until it is checked another way.",
      );
    }
    if (error.kind === "auth" && error.reason === "InvalidSignature") {
      return finish(
        1,
        "NOT READY: the sandbox refused the signature (InvalidSignature), so GEMINI_API_SECRET is most " +
          "likely not this key's secret. Copy the secret again; Gemini shows it only once, so you may need " +
          "a new key.",
      );
    }
    if (error.kind === "nonce") {
      return finish(
        1,
        `NOT READY: the sandbox refused the nonce (${reasonOf(error)}). Create the key with a time-based ` +
          "nonce, check this machine's clock, and make sure no other process uses the key.",
      );
    }
    return finish(1, `NOT READY: the sandbox refused the key (${reasonOf(error)}: ${error.message}).`);
  }

  if (settings.environment === "production") {
    return finish(
      1,
      "REFUSED: GEMINI_ENV is production, but this is a sandbox key. Set GEMINI_ENV=sandbox (or unset it) " +
        "to trade test funds with it.",
    );
  }

  const problems: string[] = [];

  say("");
  say("2. Can the key trade?");
  const roleNames = Object.entries(roles)
    .filter(([, on]) => on === true)
    .map(([name]) => name.replace(/^is/, ""));
  say(`   Roles: ${roleNames.join(", ") || "none reported"}`);
  if (roles.isTrader !== true) problems.push("the key lacks the Trader role, which placing orders needs");

  say("");
  say("3. Has the account accepted the Prediction Markets terms? (Checked, never accepted from here.)");
  try {
    const terms = await sandbox.termsStatus();
    say(
      `   ${terms.hasAcceptedLatest ? "Yes" : "No"}: accepted version ${String(terms.acceptedVersion ?? "none")}, ` +
        `latest ${String(terms.latestVersion ?? "unknown")}.`,
    );
    if (!terms.hasAcceptedLatest) {
      problems.push(
        `the latest Prediction Markets terms are not accepted: sign in at ${SANDBOX_SITE}, open Prediction ` +
          "Markets and accept them there",
      );
    }
  } catch (error) {
    if (!isGeminiPrivateError(error)) throw error;
    say(`   Could not check: ${error.message}`);
    problems.push(`the terms status could not be read (${reasonOf(error)})`);
  }

  say("");
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

  if (problems.length > 0) return finish(1, `NOT READY: ${problems.join("; ")}.`);
  return finish(
    0,
    "READY: a sandbox key with the Trader role, the terms accepted and USD to spend. Set " +
      "EXECUTOR_VENUE=gemini to have the executor place approved orders on Gemini's sandbox.",
  );
}
