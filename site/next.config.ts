import type { NextConfig } from "next";

/**
 * The landing page is a static export (`next build` writes `out/`): no server, no secrets, no cookies.
 * Its settings are public and read at build time; see docs/configuration.md.
 */

function url(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (value === "") return "";
  if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
    throw new Error(`${name} must be an http(s) URL, got "${value}"`);
  }
  return value.replace(/\/+$/, "");
}

function address(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} must be a 0x address, got "${value}"`);
  return value;
}

const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: true,
  devIndicators: false,
  // `next dev` would otherwise write an AGENTS.md here.
  agentRules: false,
  // Pinned so every build inlines them; an unset NEXT_PUBLIC_ variable would stay a runtime lookup.
  env: {
    NEXT_PUBLIC_APP_URL: url("NEXT_PUBLIC_APP_URL", "http://localhost:3000"),
    // The devchain's agent (anvil account 1), which the local stack and the hosted demo chain both use.
    NEXT_PUBLIC_SCORECARD_AGENT: address(
      "NEXT_PUBLIC_SCORECARD_AGENT",
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    ),
    NEXT_PUBLIC_REPO_URL: url("NEXT_PUBLIC_REPO_URL", ""),
    // The page's own public origin: link previews need absolute image URLs. The stack serves it on 3001.
    NEXT_PUBLIC_SITE_URL: url("NEXT_PUBLIC_SITE_URL", "http://localhost:3001"),
  },
};

export default nextConfig;
