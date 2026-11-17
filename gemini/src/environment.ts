/**
 * Which Gemini the whole stack reads market data from (issue #93 follow-up): one rule, applied by the MCP
 * server, the signal service, the console and the executor alike, so that what the agent plans on, what
 * the owner sees and what the executor checks and trades are the same exchange.
 *
 * EXECUTOR_VENUE=gemini  market data comes from the environment the orders go to: GEMINI_ENV, sandbox by
 *                        default. The sandbox lists other strikes than production (8 of 21 on one BTC
 *                        ladder) and has its own books, so planning on production while trading on the
 *                        sandbox would propose strikes the venue cannot fill.
 * otherwise              production's public API (live prices); the simulated venue places nothing.
 *
 * GEMINI_API_URL may stand in for that host only when it names the same host, or a loopback server (the
 * recorded fake the tests use). Any other host would read one exchange and trade on another, so it is
 * refused, naming the settings. No key is read here: market data is public.
 */

/** Gemini's REST hosts. The sandbox (exchange.sandbox.gemini.com accounts) trades test funds only. */
export const GEMINI_HOSTS = {
  sandbox: "https://api.sandbox.gemini.com",
  production: "https://api.gemini.com",
} as const;

export type GeminiEnvironment = keyof typeof GEMINI_HOSTS;

export const GEMINI_ENVIRONMENTS = Object.keys(GEMINI_HOSTS) as GeminiEnvironment[];

export type ExecutorVenueKind = "simulated" | "gemini";

export interface MarketDataSource {
  /** The exchange environment market data comes from. */
  environment: GeminiEnvironment;
  /** The venue the stack is configured for (EXECUTOR_VENUE). */
  venue: ExecutorVenueKind;
  /** Where public requests go: the environment's host, or a loopback stand-in in tests. */
  baseUrl: string;
  /** The settings that chose it, for logs and error messages, for example "EXECUTOR_VENUE=gemini, GEMINI_ENV=sandbox". */
  settings: string;
}

/** True for `http://127.0.0.1:<port>` and `http://localhost:<port>`, with nothing after the port. */
export function isLoopbackTestUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    url.pathname.replace(/\/+$/, "") === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}

/** EXECUTOR_VENUE: simulated (the default) or gemini. */
export function executorVenueKind(env: Record<string, string | undefined>): ExecutorVenueKind {
  const venue = env.EXECUTOR_VENUE?.trim().toLowerCase() || "simulated";
  if (venue !== "simulated" && venue !== "gemini") {
    throw new Error(`EXECUTOR_VENUE must be simulated or gemini, got "${venue}"`);
  }
  return venue;
}

/** GEMINI_ENV: sandbox (the default) or production. Says nothing about trading, which needs more. */
export function geminiEnvironmentSetting(env: Record<string, string | undefined>): GeminiEnvironment {
  const raw = env.GEMINI_ENV?.trim().toLowerCase() ?? "";
  const environment = raw === "" ? "sandbox" : raw;
  if (environment !== "sandbox" && environment !== "production") {
    throw new Error(`GEMINI_ENV must be sandbox or production, got "${raw}"`);
  }
  return environment;
}

/** The market data source the settings choose. Throws, naming the settings, when they contradict. */
export function marketDataSource(env: Record<string, string | undefined>): MarketDataSource {
  const venue = executorVenueKind(env);
  const environment = venue === "gemini" ? geminiEnvironmentSetting(env) : "production";
  const settings =
    venue === "gemini"
      ? `EXECUTOR_VENUE=gemini, GEMINI_ENV=${environment}`
      : "EXECUTOR_VENUE=simulated (the default)";
  const host = GEMINI_HOSTS[environment];
  const override = env.GEMINI_API_URL?.trim().replace(/\/+$/, "") ?? "";
  if (override !== "" && override !== host && !isLoopbackTestUrl(override)) {
    throw new Error(
      `GEMINI_API_URL is ${override}, but ${settings} means Gemini's ${environment} (${host}). ` +
        "Unset GEMINI_API_URL, or set it to that same host.",
    );
  }
  return { environment, venue, baseUrl: override || host, settings };
}

/** "Gemini's sandbox" or "Gemini (production)", for sentences. */
export function describeEnvironment(environment: GeminiEnvironment): string {
  return environment === "sandbox" ? "Gemini's sandbox" : "Gemini (production)";
}

/**
 * Whether two parts of the stack read the same Gemini; when they do not, one sentence naming both sides'
 * settings and what to change. `self` is the part that checks, `other` the part it asked.
 */
export function environmentMismatch(
  self: { name: string; environment: GeminiEnvironment; settings: string },
  other: { name: string; environment: GeminiEnvironment; settings: string },
): string | null {
  if (self.environment === other.environment) return null;
  return (
    `${self.name} reads ${describeEnvironment(self.environment)} (${self.settings}), but ${other.name} reads ` +
    `${describeEnvironment(other.environment)} (${other.settings}). Give the executor, the console, the MCP ` +
    "server and the signal service the same EXECUTOR_VENUE and GEMINI_ENV."
  );
}

/** The settings an executor's venue announcement stands for, in the words `marketDataSource` uses. */
export function announcedSource(
  venue: ExecutorVenueKind,
  environment: GeminiEnvironment | null,
): { environment: GeminiEnvironment; settings: string } {
  return venue === "gemini" && environment !== null
    ? { environment, settings: `EXECUTOR_VENUE=gemini, GEMINI_ENV=${environment}` }
    : { environment: "production", settings: "EXECUTOR_VENUE=simulated (the default)" };
}
