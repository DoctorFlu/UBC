import { createGeminiClient, marketDataSource, type GeminiClient } from "@mandate/gemini";

/**
 * The Gemini client the dev scripts use: the stack's market data source (`marketDataSource`), the same
 * rule the console, the MCP server and the signal service follow. One retry and an 8 s timeout, so a
 * script fails quickly when Gemini is down.
 */
export function devGeminiClient(): GeminiClient {
  return createGeminiClient({
    maxRetries: 1,
    timeoutMs: 8_000,
    baseUrl: marketDataSource(process.env).baseUrl,
  });
}
