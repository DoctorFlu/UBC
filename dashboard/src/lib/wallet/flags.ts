/**
 * The dev signer is on only when the build was made with NEXT_PUBLIC_DEV_SIGNER=1. Next.js
 * inlines the value at build time, so a build without the flag compiles this to `false`, never
 * creates the connector, and (see dev-signer.ts) carries no key.
 */
export const DEV_SIGNER_ENABLED = process.env.NEXT_PUBLIC_DEV_SIGNER === "1";

/** The dev signer connector id; kept here so checking for it never pulls in the signer module. */
export const DEV_SIGNER_ID = "devSigner";
