/**
 * Whether Gemini's live (production) public API can be used by a suite step that reads it, and what to say
 * when it cannot. A third party being down is not a failure of our code, so a step that needs live
 * Gemini runs on the recording instead (or, for a step that only proves something live, runs nothing),
 * says so in one stable line, and exits with `RECORDED_EXIT_CODE`, which no failure of ours uses.
 *
 * Gemini publishes its status on an Atlassian Statuspage (https://status.gemini.com). When that page's
 * API answers and lists a maintenance in progress, the banner names it; otherwise it says nothing about
 * the cause, never a guess.
 */
import { createGeminiClient, isGeminiError, type GeminiClient } from "../src/index";

/** The exit status of a run that passed on the recording because live Gemini was unavailable. */
export const RECORDED_EXIT_CODE = 3;

/** The first word of the banner line, stable for `grep`. */
export const LIVE_GEMINI_UNAVAILABLE = "LIVE GEMINI UNAVAILABLE";

export type LiveGemini = { available: true } | { available: false; reason: string };

const STATUS_URL = "https://status.gemini.com/api/v2/scheduled-maintenances/active.json";

/** Codes that mean Gemini, not our code, failed: it errored, timed out, was unreachable or limited us. */
function isGeminiSide(error: unknown): boolean {
  if (!isGeminiError(error)) return false;
  if (error.code === "http") return error.status === undefined || error.status >= 500;
  return (
    error.code === "timeout" ||
    error.code === "network" ||
    error.code === "rate_limited" ||
    // A spot market that is not trading normally (the wide-spread guard, where the client has it).
    (error.code as string) === "spot_unavailable"
  );
}

/** The name of a maintenance Gemini's status page reports in progress, or null when it reports none or cannot say. */
export async function maintenanceInProgress(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(STATUS_URL, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      scheduled_maintenances?: { name?: unknown; status?: unknown }[];
    };
    const active = (body.scheduled_maintenances ?? []).find((m) => m.status === "in_progress");
    return typeof active?.name === "string" ? active.name : null;
  } catch {
    return null;
  }
}

/**
 * Reads what the step needs from live Gemini (the BTC ladders and spot). Available, or unavailable with a
 * reason, when Gemini's side failed. Any other failure (a 4xx, an answer we cannot read) is thrown: that
 * may be ours, and must fail the step.
 */
export async function checkLiveGemini(
  options: {
    asset?: string;
    /** Tests pass a stand-in; by default Gemini production's public API. */
    client?: Pick<GeminiClient, "listLadders" | "getSpot">;
    /** Tests pass a stand-in for the status page. */
    maintenance?: () => Promise<string | null>;
  } = {},
): Promise<LiveGemini> {
  const asset = options.asset ?? "BTC";
  const client = options.client ?? createGeminiClient({ maxRetries: 1, timeoutMs: 8_000 });
  try {
    const ladders = await client.listLadders(asset);
    if (ladders.length === 0)
      return { available: false, reason: `Gemini production lists no open ${asset} ladder` };
    await client.getSpot(asset);
    return { available: true };
  } catch (error) {
    if (!isGeminiSide(error)) throw error;
    const at = new Date().toISOString().slice(11, 19);
    const what =
      isGeminiError(error) && error.code === "http" && error.status !== undefined
        ? `answered HTTP ${String(error.status)}`
        : isGeminiError(error) && (error.code as string) === "spot_unavailable"
          ? "has a spot market that is not trading normally"
          : isGeminiError(error)
            ? `failed (${error.code})`
            : "failed";
    const maintenance = await (options.maintenance ?? maintenanceInProgress)();
    const status = maintenance === null ? "" : `; Gemini's status page reports "${maintenance}" in progress`;
    return { available: false, reason: `Gemini production ${what} at ${at} UTC${status}` };
  }
}

/** The one banner line, for example `LIVE GEMINI UNAVAILABLE: ran on the recorded ladder because ...`. */
export function bannerLine(what: string, reason: string): string {
  return `${LIVE_GEMINI_UNAVAILABLE}: ${what} because ${reason}`;
}
