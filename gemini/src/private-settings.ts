/**
 * Gemini trading settings from the environment, shared by the executor and `npm run gemini:doctor`.
 *
 * GEMINI_ENV           sandbox (default) or production.
 * GEMINI_LIVE_TRADING  must be "on" as well before production is used: real money is never traded
 *                      because of one setting.
 * GEMINI_API_KEY       the API key (account-scoped, made on the environment's own site).
 * GEMINI_API_SECRET    its secret.
 *
 * Error messages name a setting, never its value, except GEMINI_ENV and GEMINI_LIVE_TRADING, which hold
 * no secret.
 */
import { geminiEnvironmentSetting, type GeminiEnvironment } from "./environment";
import type { GeminiCredentials } from "./private";

export interface GeminiTradingSettings {
  environment: GeminiEnvironment;
  /** True only for production with GEMINI_LIVE_TRADING=on. */
  allowProduction: boolean;
  /** Null while either the key or the secret is unset. */
  credentials: GeminiCredentials | null;
}

export function geminiTradingSettings(env: Record<string, string | undefined>): GeminiTradingSettings {
  const environment = geminiEnvironmentSetting(env);
  const live = env.GEMINI_LIVE_TRADING?.trim() ?? "";
  if (live !== "" && live !== "on") {
    throw new Error(`GEMINI_LIVE_TRADING must be "on" or unset, got "${live}"`);
  }
  if (environment === "production" && live !== "on") {
    throw new Error(
      "GEMINI_ENV is production, which trades real money, but GEMINI_LIVE_TRADING is not on. " +
        "Set both to trade for real, or set GEMINI_ENV=sandbox.",
    );
  }
  const apiKey = env.GEMINI_API_KEY?.trim() ?? "";
  const apiSecret = env.GEMINI_API_SECRET?.trim() ?? "";
  return {
    environment,
    allowProduction: environment === "production",
    credentials: apiKey !== "" && apiSecret !== "" ? { apiKey, apiSecret } : null,
  };
}

/**
 * What a key is, from its documented prefix only: "account" (account-scoped), "master" (master, which
 * would need an account name on every request; not supported) or "unknown". Never the key itself.
 */
export function keyScope(apiKey: string): "account" | "master" | "unknown" {
  if (apiKey.startsWith("account-")) return "account";
  if (apiKey.startsWith("master-")) return "master";
  return "unknown";
}
