import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const EMPTY = pathToFileURL(require.resolve("next/dist/compiled/server-only/empty.js")).href;

export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: EMPTY, shortCircuit: true };
  return next(specifier, context);
}
