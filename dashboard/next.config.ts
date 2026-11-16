import type { NextConfig } from "next";

if (process.env.NEXT_PUBLIC_DEV_SIGNER === "1" && process.env.NODE_ENV === "production") {
  // The dev signer uses a public anvil test key. It is allowed in a production build only
  // because someone set the flag on purpose (end-to-end tests, a local demo). Say so loudly.
  console.warn(
    "\n[dashboard] NEXT_PUBLIC_DEV_SIGNER=1: this build signs with a PUBLIC anvil test key. Never deploy it.\n",
  );
}

const nextConfig: NextConfig = {
  // Runs as a long-lived Node server (`next start`): later issues add a webhook route and a
  // server-sent events route, so this is deliberately not a static export.
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  // `next dev` would otherwise write an AGENTS.md here; the README points agents at the
  // version-matched docs in node_modules/next/dist/docs instead.
  agentRules: false,
  // Next.js inlines a NEXT_PUBLIC_ variable only when it is set; an unset one stays a runtime
  // lookup and the code behind it ships. Pinning a default here makes it always inline, so a
  // build without the dev signer flag folds the signer's branch (and its public test key) away.
  // The chain is not a build flag: the server decides it at runtime from POLICY_* and the RPC URL.
  env: {
    NEXT_PUBLIC_DEV_SIGNER: process.env.NEXT_PUBLIC_DEV_SIGNER === "1" ? "1" : "0",
  },
  // The container image (deploy/Dockerfile) builds with NEXT_OUTPUT=standalone: a minimal `server.js` plus
  // only the files the server was traced to load, so the image carries no full node_modules. Every other
  // build keeps the usual `.next` output for `next start`.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
};

export default nextConfig;
