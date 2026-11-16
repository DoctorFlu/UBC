import { createGeminiClient, type GeminiClient } from "@mandate/gemini";

/**
 * The Gemini client the dev scripts use: Gemini's public API, or `GEMINI_API_URL` when set, the same
 * variable the console reads. One retry and an 8 s timeout, so a script fails quickly when Gemini is down.
 */
export function devGeminiClient(): GeminiClient {
  const baseUrl = process.env.GEMINI_API_URL?.trim();
  return createGeminiClient({ maxRetries: 1, timeoutMs: 8_000, ...(baseUrl ? { baseUrl } : {}) });
}
