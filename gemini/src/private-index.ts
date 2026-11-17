/**
 * `@mandate/gemini/private`: the signed client for Gemini's private Prediction Markets endpoints, kept
 * apart from the package's main entry because it uses Node's crypto and handles API secrets. Browser
 * code imports `@mandate/gemini` and never reaches this file.
 */
export {
  createGeminiPrivateClient,
  GEMINI_ENVIRONMENTS,
  GEMINI_HOSTS,
  isLoopbackTestUrl,
  privateOrderSchema,
  settledPositionSchema,
  type Balance,
  type GeminiCredentials,
  type GeminiEnvironment,
  type GeminiPrivateClient,
  type GeminiPrivateClientOptions,
  type KeyRoles,
  type LimitOrderRequest,
  type PrivateOrder,
  type SettledPosition,
  type TermsStatus,
} from "./private";
export {
  classifyAnswer,
  GeminiPrivateError,
  isGeminiPrivateError,
  type GeminiPrivateErrorKind,
} from "./private-errors";
export { geminiTradingSettings, keyScope, type GeminiTradingSettings } from "./private-settings";
