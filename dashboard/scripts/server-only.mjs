// Lets plain Node (with tsx) load the console's server modules outside Next.js: `server-only` resolves to
// Next's own empty stand-in, as the vitest config does. Use with `tsx --import ./scripts/server-only.mjs`.
import { register } from "node:module";

register("./server-only-hooks.mjs", import.meta.url);
