/**
 * Where the executor records settlements: the console's executor API (`CONSOLE_EXECUTOR_ROUTES`). The
 * Policy contract cannot hold them (see `@mandate/shared` settlement.ts), so the console is the system of
 * record, and each record carries the executor's signature instead of a transaction.
 */
import {
  CONSOLE_EXECUTOR_ROUTES,
  consoleErrorSchema,
  putSettlementRequestSchema,
  type PutSettlementRequest,
} from "@mandate/shared";

/**
 * - `stored`: the console stored it now; `duplicate`: it already held this exact record.
 * - `conflict`: it already holds a different record for this intent. The first record stands; sending
 *   again cannot change it.
 * - `retry`: not stored this time (console down, not synced to the fill yet, or it refused); try later.
 */
export type SinkResult =
  | { status: "stored" | "duplicate" }
  | { status: "conflict"; detail: string }
  | { status: "retry"; detail: string };

export interface SettlementSink {
  record(request: PutSettlementRequest): Promise<SinkResult>;
}

export interface ConsoleSinkOptions {
  /** The console's base URL, for example `http://localhost:3000`. */
  consoleUrl: string;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

export function consoleSettlementSink(options: ConsoleSinkOptions): SettlementSink {
  const base = options.consoleUrl.replace(/\/+$/, "");
  const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 8_000;
  return {
    async record(request) {
      const body = putSettlementRequestSchema.parse(request);
      const path = CONSOLE_EXECUTOR_ROUTES.settlement(body.document.intentId);
      let response: Response;
      try {
        response = await send(`${base}${path}`, {
          method: "PUT",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return { status: "retry", detail: `the console at ${base} did not answer (${errorText(error)})` };
      }
      if (response.status === 201) return { status: "stored" };
      if (response.status === 200) return { status: "duplicate" };
      const parsed = consoleErrorSchema.safeParse(await response.json().catch(() => undefined));
      const detail = parsed.success
        ? `${parsed.data.error.code}: ${parsed.data.error.message}`
        : `HTTP ${String(response.status)}`;
      if (response.status === 409 && parsed.success && parsed.data.error.code === "conflict") {
        return { status: "conflict", detail };
      }
      return { status: "retry", detail: `the console answered ${detail}` };
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
