import type { LogLevel } from "./config";

export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Structured logger that writes one JSON object per line.
 *
 * Never pass secrets, tokens, headers or raw tool arguments. As a second line of defence, fields
 * whose names look sensitive and strings that look like private keys are redacted, and `Secret`
 * values serialize as `[redacted]` on their own.
 */
export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger;
}

export type LogSink = (line: string) => void;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /authorization|cookie|password|secret|token|private.?key|api.?key|mnemonic|seed/i;
const PRIVATE_KEY_LIKE = /0x[0-9a-fA-F]{64}/g;
const URL_PATH = /\b(https?:\/\/[^\s/?#]+)[/?#]\S*/g;

/**
 * Removes things that should never reach a log from free text such as an upstream error message:
 * 32-byte hex strings (private keys) and URL paths and queries (hosted RPC URLs carry API keys).
 */
export function scrubText(text: string): string {
  return text.replace(PRIVATE_KEY_LIKE, "[redacted]").replace(URL_PATH, "$1/[redacted]");
}

function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 4) return "[truncated]";
  if ("toJSON" in value && typeof value.toJSON === "function") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(inner, depth + 1);
  }
  return out;
}

export function createLogger(
  options: { level?: LogLevel; sink?: LogSink; base?: LogFields; now?: () => Date } = {},
): Logger {
  const threshold = LEVELS[options.level ?? "info"];
  const sink: LogSink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const base = options.base ?? {};

  const write = (level: LogLevel, event: string, fields?: LogFields) => {
    if (LEVELS[level] < threshold) return;
    const record = redact({ ...base, ...fields }) as Record<string, unknown>;
    sink(JSON.stringify({ ts: now().toISOString(), level, event, ...record }));
  };

  return {
    debug: (event, fields) => {
      write("debug", event, fields);
    },
    info: (event, fields) => {
      write("info", event, fields);
    },
    warn: (event, fields) => {
      write("warn", event, fields);
    },
    error: (event, fields) => {
      write("error", event, fields);
    },
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

/** A logger that discards everything, for tests. */
export const silentLogger: Logger = createLogger({ sink: () => undefined });
