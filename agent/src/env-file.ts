import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_ENV_FILE } from "@mandate/shared";

/**
 * Path of the `.env` file: `ENV_FILE` if set (relative paths resolve against the directory the
 * command was started from), otherwise `<repo root>/.env`.
 */
export function resolveEnvFile(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["ENV_FILE"]?.trim();
  if (configured === undefined || configured === "") return DEFAULT_ENV_FILE;
  // npm runs workspace scripts inside the package directory; INIT_CWD is where the user ran npm.
  return path.resolve(env["INIT_CWD"] ?? process.cwd(), configured);
}

/** Loads the `.env` file into `process.env` if it exists. Variables already set win. */
export function loadEnvFile(file = resolveEnvFile()): boolean {
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}

/**
 * Returns `content` with `key` set to `value`. Every existing assignment of `key` (with or without
 * `export`) is replaced in place; every other line, including comments, blank lines and line
 * endings, is kept byte for byte. If `key` is absent, a line is appended.
 */
export function upsertEnvVar(content: string, key: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid variable name: ${key}`);
  if (/[\r\n]/.test(value)) throw new Error("Value must be a single line");
  const pattern = new RegExp(`^(\\s*(?:export\\s+)?)${key}\\s*=.*$`);
  const lines = content.split(/(?<=\n)/).map((line) => {
    const ending = /\r?\n$/.exec(line)?.[0] ?? "";
    return { body: line.slice(0, line.length - ending.length), ending };
  });
  if (lines.some(({ body }) => pattern.test(body))) {
    return lines
      .map(({ body, ending }) => {
        const match = pattern.exec(body);
        return `${match === null ? body : `${match[1] ?? ""}${key}=${value}`}${ending}`;
      })
      .join("");
  }
  const separator = content === "" || content.endsWith("\n") ? "" : "\n";
  return `${content}${separator}${key}=${value}\n`;
}

/**
 * Sets one variable in an env file without touching the others. The file is written to a
 * temporary sibling with mode 600 and renamed into place, so it is never readable by others and
 * never left half written.
 */
export function writeEnvVar(file: string, key: string, value: string): void {
  const target = existsSync(file) ? realpathSync(file) : file;
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  const next = upsertEnvVar(current, key, value);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  writeFileSync(temp, next, { mode: 0o600, flag: "wx" });
  renameSync(temp, target);
}
