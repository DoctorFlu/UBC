import { randomBytes } from "node:crypto";

import type { Member, NewPasskey } from "../../src/server/accounts/store";
import { hashSecret, normalizeHumanCode } from "../../src/server/accounts/secrets";
import type { ConsoleService, MandateScope } from "../../src/server/console-service";
import { sessionCookieName } from "../../src/server/http/session";

/**
 * Accounts for server tests, without a browser: members are added through the store with a stand-in
 * passkey, and sessions are opened directly. The WebAuthn ceremonies themselves are tested in
 * src/server/http/auth-api.test.ts (a software passkey) and end to end with a virtual authenticator.
 */

/** A passkey record that no authenticator holds. Enough for everything but a real ceremony. */
export function fakePasskey(): NewPasskey {
  return {
    credentialId: randomBytes(16).toString("base64url"),
    publicKey: new Uint8Array(randomBytes(77)),
    counter: 0,
    transports: ["internal"],
    deviceType: "singleDevice",
    backedUp: false,
  };
}

/** Claims the first workspace (the one holding the server's own mandate) for a new member. */
export function claimFirstWorkspace(service: ConsoleService, name = "Owner"): Member {
  const { code } = service.accounts.issueClaimCode();
  const claimed = service.accounts.store.claim({
    claimHash: codeHash(code),
    memberName: name,
    webauthnUserId: randomBytes(32).toString("base64url"),
    passkey: fakePasskey(),
  });
  if (!claimed) throw new Error("the first workspace could not be claimed");
  return claimed.member;
}

/** A new workspace with its own mandate and agent, as an invited sign-up makes one. */
export function signUpWorkspace(service: ConsoleService, name: string): Member {
  const created = service.accounts.store.signUp({
    memberName: name,
    webauthnUserId: randomBytes(32).toString("base64url"),
    passkey: fakePasskey(),
    inviteHash: null,
    master: service.accounts.master,
  });
  if (!created) throw new Error("the workspace could not be created");
  return created.member;
}

/** The first mandate of the member's workspace: the one sign-up made. */
export function mandateOf(service: ConsoleService, member: Member): string {
  const mandate = service.accounts.store.mandates(member.workspaceId)[0];
  if (!mandate) throw new Error("the workspace has no mandate");
  return mandate.id;
}

/** A session for the member, as the `Cookie` header a browser would send. */
export function sessionHeader(service: ConsoleService, member: Member): string {
  return `${sessionCookieName(service.config.accounts)}=${service.accounts.openSession(member)}`;
}

/** The headers of a request from the console's own pages, signed in as the member. */
export function consoleHeaders(service: ConsoleService, member: Member): Record<string, string> {
  return {
    "content-type": "application/json",
    cookie: sessionHeader(service, member),
    origin: service.config.accounts.origin,
  };
}

/** The mandate that follows the server's contract. */
export function envMandate(service: ConsoleService): MandateScope {
  return service.accounts.store.envMandate();
}

/** The snapshot of the server's own mandate. */
export function envSnapshot(service: ConsoleService) {
  return service.snapshot(envMandate(service));
}

/** The first mandate of the member's workspace, and its agent. */
export function workspaceAgent(service: ConsoleService, member: Member) {
  const [first] = service.accounts.store.agentsOf(member.workspaceId);
  if (!first) throw new Error(`workspace ${member.workspaceId} has no mandate`);
  return first;
}

/** A typed code's hash, normalised the way the console normalises one. */
export function codeHash(code: string): string {
  const normal = normalizeHumanCode(code);
  if (normal === null) throw new Error("not a code");
  return hashSecret(normal);
}
