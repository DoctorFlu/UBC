import type { CallToolResult } from "@modelcontextprotocol/server";
import type * as z from "zod";
import type { OptionalEnvKey } from "../config";
import type { AppContext, ToolContext } from "../context";
import { scrubText } from "../logger";
import { ToolError, type ToolErrorCode } from "./errors";

/** Behaviour hints shown to the client. All four are required so every tool states them. */
export interface ToolAnnotations {
  /** The tool only reads. */
  readonly readOnlyHint: boolean;
  /** The tool may change or remove something that cannot be undone. */
  readonly destructiveHint: boolean;
  /** Calling it again with the same arguments has no further effect. */
  readonly idempotentHint: boolean;
  /** The tool talks to systems outside this server (chain, Gemini, console). */
  readonly openWorldHint: boolean;
}

/** What a handler returns: data matching the output schema, and one or two sentences for the model. */
export interface ToolOutput<T> {
  readonly structured: T;
  /** Short, plain-language summary. Never include untrusted third-party text here. */
  readonly summary: string;
}

export interface ToolSpec<I extends z.ZodObject, O extends z.ZodObject> {
  /** snake_case verb phrase, for example `get_policy`. The model sees it through a meta-tool. */
  readonly name: string;
  readonly title: string;
  /** Say what it does, when to use it, and what it returns. The model has nothing else to go on. */
  readonly description: string;
  readonly inputSchema: I;
  /** Keep it free of transforms: the server validates the handler's data against it as-is. */
  readonly outputSchema: O;
  readonly annotations: ToolAnnotations;
  /** Environment variables without which this tool cannot work. The server refuses to start without them. */
  readonly requires?: readonly OptionalEnvKey[];
  /** Time budget for one call. Defaults to the server's `toolTimeoutMs`. */
  readonly timeoutMs?: number;
  /** May be sync or async. Throw `ToolError` for real errors; return a verdict for denials. */
  readonly handler: (
    input: z.output<I>,
    ctx: ToolContext,
  ) => ToolOutput<z.input<O>> | Promise<ToolOutput<z.input<O>>>;
}

/** A tool with its types erased, as the registry and the server hold it. */
export interface Tool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject;
  readonly outputSchema: z.ZodObject;
  readonly annotations: ToolAnnotations;
  readonly requires: readonly OptionalEnvKey[];
  readonly timeoutMs: number | undefined;
  /** Validates the input, runs the handler and validates its output. Throws `ToolError` on failure. */
  run(input: unknown, ctx: ToolContext): Promise<ToolOutput<Record<string, unknown>>>;
}

const TOOL_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export function defineTool<I extends z.ZodObject, O extends z.ZodObject>(spec: ToolSpec<I, O>): Tool {
  if (!TOOL_NAME.test(spec.name)) throw new Error(`Tool name must be snake_case: ${spec.name}`);
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    annotations: spec.annotations,
    requires: spec.requires ?? [],
    timeoutMs: spec.timeoutMs,
    async run(input, ctx) {
      const parsedInput = spec.inputSchema.safeParse(input ?? {});
      if (!parsedInput.success) throw new ToolError("INVALID_INPUT", describeIssues(parsedInput.error));
      const output = await spec.handler(parsedInput.data, ctx);
      const parsedOutput = spec.outputSchema.safeParse(output.structured);
      if (!parsedOutput.success) {
        throw new ToolError("INTERNAL", "The tool produced a result that does not match its output schema.", {
          cause: new Error(describeIssues(parsedOutput.error)),
        });
      }
      return { structured: parsedOutput.data, summary: output.summary };
    },
  };
}

/** Field paths and rule messages only: never the offending values, which may be secrets. */
export function describeIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.length === 0 ? "(arguments)" : issue.path.join(".");
    return `${path}: ${issue.message}`;
  });
  const more = error.issues.length > 5 ? ` (and ${error.issues.length - 5} more)` : "";
  return `Invalid arguments. ${parts.join("; ")}${more}.`;
}

/** Result for a real error: a stable code and a short message, never a stack trace. */
export function toolErrorResult(code: ToolErrorCode, message: string, requestId: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    _meta: { "mandate/error": { code, requestId } },
  };
}

class Timeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Timeout());
      reject(new Timeout());
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function argumentShape(args: unknown): { argKeys: string[]; argBytes: number } {
  const argKeys = args !== null && typeof args === "object" ? Object.keys(args).slice(0, 20) : [];
  try {
    return { argKeys, argBytes: Buffer.byteLength(JSON.stringify(args ?? {})) };
  } catch {
    return { argKeys, argBytes: -1 };
  }
}

/**
 * Runs one tool call: time budget, abort signal, logging and conversion to an MCP result.
 * Real errors become `isError` results with a stable code. Unexpected errors are logged (scrubbed)
 * and reported to the model only as `INTERNAL` with the request id.
 */
export async function invokeTool(
  tool: Tool,
  args: unknown,
  app: AppContext,
  scope: { requestId: string; signal?: AbortSignal },
): Promise<CallToolResult> {
  const started = performance.now();
  const logger = app.logger.child({ requestId: scope.requestId, tool: tool.name });
  const controller = new AbortController();
  const onAbort = () => {
    controller.abort(scope.signal?.reason);
  };
  scope.signal?.addEventListener("abort", onAbort, { once: true });

  let result: CallToolResult;
  let outcome: string;
  let errorCode: ToolErrorCode | undefined;
  let status: unknown;
  try {
    const ctx: ToolContext = { ...app, logger, requestId: scope.requestId, signal: controller.signal };
    const timeoutMs = tool.timeoutMs ?? app.config.limits.toolTimeoutMs;
    const output = await withTimeout(tool.run(args, ctx), timeoutMs, controller);
    status = output.structured["status"];
    result = { content: [{ type: "text", text: output.summary }], structuredContent: output.structured };
    outcome = "ok";
  } catch (error) {
    if (error instanceof ToolError) {
      errorCode = error.code;
      result = toolErrorResult(error.code, error.message, scope.requestId);
      if (error.code === "INTERNAL") {
        logger.error("tool.internal_error", { cause: describeCause(error.cause) });
      }
    } else if (error instanceof Timeout) {
      errorCode = "TIMEOUT";
      result = toolErrorResult(
        "TIMEOUT",
        "The tool did not finish in time. Try again shortly.",
        scope.requestId,
      );
    } else {
      errorCode = "INTERNAL";
      logger.error("tool.internal_error", { cause: describeCause(error) });
      result = toolErrorResult(
        "INTERNAL",
        `Something went wrong on the server (request ${scope.requestId}).`,
        scope.requestId,
      );
    }
    outcome = "error";
  } finally {
    scope.signal?.removeEventListener("abort", onAbort);
  }

  logger.info("tool.call", {
    outcome,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(typeof status === "string" ? { status } : {}),
    durationMs: Math.round(performance.now() - started),
    ...argumentShape(args),
  });
  return result;
}

function describeCause(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: scrubText(error.message).slice(0, 500) };
  return { name: typeof error, message: "non-error value thrown" };
}
