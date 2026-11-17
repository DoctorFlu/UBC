/**
 * deploy/build-site.sh's settings, run for real with bash in --dry-run mode (it builds nothing, so these
 * tests need no Docker): which public values it bakes into the landing page and where it writes it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const deployDir = join(import.meta.dirname, "..");
const script = join(deployDir, "build-site.sh");
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;

let dir: string;
let envFile: string;

function dryRun(env: Record<string, string> = {}): { status: number | null; output: string } {
  const result = spawnSync("bash", [script, "--dry-run"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", MANDATE_ENV_FILE: envFile, ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe.skipIf(!hasBash)("deploy/build-site.sh", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mandate-site-"));
    envFile = join(dir, "mandate.env");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("links to https://<MANDATE_HOST> and writes to site/out by default", () => {
    writeFileSync(
      envFile,
      "MANDATE_HOST=8080-abc.instabox.tech\nMANDATE_PUBLIC_URL=\nCONSOLE_PASSWORD_HASH=\n",
    );
    const { status, output } = dryRun();
    expect(status).toBe(0);
    expect(output).toContain("NEXT_PUBLIC_APP_URL=https://8080-abc.instabox.tech\n");
    expect(output).toContain("NEXT_PUBLIC_SCORECARD_AGENT=(the site's default)\n");
    expect(output).toContain("NEXT_PUBLIC_REPO_URL=(none)\n");
    expect(output).toContain(`folder: ${deployDir}/../site/out\n`);
  });

  it("prefers MANDATE_PUBLIC_URL, then the env file's site settings, then the environment", () => {
    writeFileSync(
      envFile,
      [
        "MANDATE_HOST=app.example.com",
        "MANDATE_PUBLIC_URL=https://app.example.com:8443",
        "NEXT_PUBLIC_SCORECARD_AGENT='0x70997970C51812dc3A010C7d01b50e0d17dc79C8'",
        'NEXT_PUBLIC_REPO_URL="https://github.com/example/repo"',
        "MANDATE_SITE_DIR=/srv/mandate-site",
        "",
      ].join("\n"),
    );
    let { output } = dryRun();
    expect(output).toContain("NEXT_PUBLIC_APP_URL=https://app.example.com:8443\n");
    expect(output).toContain("NEXT_PUBLIC_SCORECARD_AGENT=0x70997970C51812dc3A010C7d01b50e0d17dc79C8\n");
    expect(output).toContain("NEXT_PUBLIC_REPO_URL=https://github.com/example/repo\n");
    expect(output).toContain("folder: /srv/mandate-site\n");

    ({ output } = dryRun({ NEXT_PUBLIC_APP_URL: "https://other.example.com", MANDATE_SITE_DIR: "site-out" }));
    expect(output).toContain("NEXT_PUBLIC_APP_URL=https://other.example.com\n");
    expect(output).toContain(`folder: ${deployDir}/site-out\n`);
  });

  it("refuses to build without an app address, and works without an env file", () => {
    const missing = dryRun();
    expect(missing.status).toBe(1);
    expect(missing.output).toContain("Set MANDATE_HOST");

    const fromEnvironment = dryRun({ MANDATE_HOST: "localhost:13080" });
    expect(fromEnvironment.status).toBe(0);
    expect(fromEnvironment.output).toContain("NEXT_PUBLIC_APP_URL=https://localhost:13080\n");
  });
});
