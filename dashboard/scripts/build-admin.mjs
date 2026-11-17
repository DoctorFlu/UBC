// Bundles the operator's account commands (scripts/admin.ts) into one file that plain Node runs, with no
// node_modules: the console image ships only Next's standalone server, so `npm run console:admin` is not
// there. Node's own modules (node:sqlite among them) stay imports; everything else is inlined.
//
//   node scripts/build-admin.mjs [out file]     (default .next/admin.mjs)
//
// In the image: docker compose exec console node dashboard/admin.mjs claim-code
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const dashboard = resolve(here, "..");
const outfile = resolve(process.cwd(), process.argv[2] ?? resolve(dashboard, ".next", "admin.mjs"));
const require = createRequire(import.meta.url);

await build({
  entryPoints: [resolve(here, "admin.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // The console's server modules start with `import "server-only"`; outside Next it is an empty module.
  alias: { "server-only": require.resolve("next/dist/compiled/server-only/empty.js") },
  // Some bundled packages are CommonJS and call require() for Node's modules, which ESM output has no
  // global for.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  tsconfig: resolve(dashboard, "tsconfig.json"),
  logLevel: "warning",
  legalComments: "none",
});
console.log(`admin command bundled to ${outfile}`);
