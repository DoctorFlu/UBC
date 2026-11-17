/**
 * Serves the static export in `out/` the way a plain static host does (Caddy's file_server in the
 * deployment): files by path, `index.html` for a folder, `404.html` with status 404 for anything else.
 *
 * Usage: npm run serve -w @mandate/site -- --port 3001
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { port: { type: "string", default: "3001" } } });
const port = Number(values.port);
const root = resolve(import.meta.dirname, "..", "out");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

function fileFor(urlPath: string): string | null {
  const path = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const candidates = [join(root, path), join(root, path, "index.html"), join(root, `${path}.html`)];
  return (
    candidates.find((file) => file.startsWith(root) && existsSync(file) && statSync(file).isFile()) ?? null
  );
}

if (!existsSync(join(root, "index.html"))) {
  console.error(`No build in ${root}. Run \`npm run build -w @mandate/site\` first.`);
  process.exit(1);
}

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const file = fileFor(url.pathname);
  const status = file === null ? 404 : 200;
  const served = file ?? join(root, "404.html");
  response.writeHead(status, { "content-type": TYPES[extname(served)] ?? "application/octet-stream" });
  createReadStream(served).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`site ready on http://localhost:${String(port)}`);
});
