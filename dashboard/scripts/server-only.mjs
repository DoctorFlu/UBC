// Lets plain Node (with tsx) load the console's server modules outside Next.js: `server-only` resolves to
// Next's own empty stand-in, as the vitest config does. Use with `tsx --import ./scripts/server-only.mjs`.
import * as nodeModule from "node:module";
import { pathToFileURL } from "node:url";

const EMPTY = pathToFileURL(
  nodeModule.createRequire(import.meta.url).resolve("next/dist/compiled/server-only/empty.js"),
).href;

if (typeof nodeModule.registerHooks === "function") {
  // Node 22.15 and later: in-thread hooks, without `register()`'s deprecation warning.
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "server-only") return { url: EMPTY, shortCircuit: true };
      return next(specifier, context);
    },
  });
} else {
  nodeModule.register("./server-only-hooks.mjs", import.meta.url);
}
