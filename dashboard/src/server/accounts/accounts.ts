import "server-only";

import { randomBytes } from "node:crypto";

import {
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { z } from "zod";

import type { AccountsConfig } from "../config";
import type { Database } from "../db";
import { type MasterKey, loadMasterKey } from "./keys";
import { type RateLimits, defaultRateLimits } from "./rate-limit";
import { hashSecret, newHumanCode, newOpaqueId, normalizeHumanCode } from "./secrets";
import { AccountStore, type Mandate, type Member, type Session, type Workspace } from "./store";

/**
 * Accounts: passkey ceremonies, sessions, and which workspace and mandate a session may see
 * (docs/accounts.md). Passkeys are verified by SimpleWebAuthn; this class decides what a verified passkey
 * is allowed to do.
 */

const RP_NAME = "Mandate";
/** How long a browser has to answer a passkey prompt. */
export const CEREMONY_TTL_MS = 5 * 60 * 1000;
/** How long a claim code and an invite code stay valid. */
export const CLAIM_CODE_TTL_MS = 24 * 60 * 60 * 1000;
export const INVITE_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Marks an AccountError across copies of this module (`AccountError.is`). */
const ACCOUNT_ERROR = Symbol.for("mandate.account-error");

/** A failure a person can act on: a stable code, an HTTP status and one plain sentence. */
export class AccountError extends Error {
  override readonly name = "AccountError";
  readonly [ACCOUNT_ERROR] = true;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }

  /**
   * True for an AccountError from any copy of this module. Next.js may load server modules more than
   * once (console.ts), and the shared console service throws the class of the copy that built it, so
   * `instanceof` would miss it in a route that loaded another copy and answer 500 for a refusal.
   */
  static is(error: unknown): error is AccountError {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as Record<symbol, unknown>)[ACCOUNT_ERROR] === true
    );
  }
}

/** What a registration is for. Stored server side with its challenge, never trusted from the browser. */
const purposeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("sign-up"), name: z.string(), inviteHash: z.string().nullable() }),
  z.strictObject({ kind: z.literal("claim"), name: z.string(), claimHash: z.string() }),
  z.strictObject({ kind: z.literal("recover"), memberId: z.string(), recoveryHash: z.string() }),
  z.strictObject({ kind: z.literal("add"), memberId: z.string() }),
]);
type Purpose = z.infer<typeof purposeSchema>;

const registrationPayload = z.strictObject({ purpose: purposeSchema, webauthnUserId: z.string() });

/** A member's display name: 1 to 60 printable characters. */
export const memberNameSchema = z
  .string()
  .trim()
  .min(1, "Enter your name.")
  .max(60, "Use at most 60 characters.")
  .refine(isPlainText, "Use letters, digits and punctuation only.");

/** No control characters and no angle brackets: a name is shown in pages, logs and passkey prompts. */
export function isPlainText(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || character === "<" || character === ">") return false;
  }
  return true;
}

/** Who a live session belongs to. */
export interface Access {
  session: Session;
  member: Member;
  workspace: Workspace;
}

/** What a finished registration did. */
export type RegistrationOutcome =
  { kind: "signed-in"; member: Member; recoveryCode: string } | { kind: "passkey-added"; member: Member };

export class Accounts {
  readonly store: AccountStore;
  readonly master: MasterKey;
  readonly limits: RateLimits;

  constructor(
    readonly config: AccountsConfig,
    db: Database,
    options: { dataDir: string; log: (message: string) => void; now?: () => Date; limits?: RateLimits },
  ) {
    this.store = new AccountStore(db, options.now);
    this.limits = options.limits ?? defaultRateLimits();
    this.master = loadMasterKey(
      {
        mode: config.mode,
        file: config.masterKeyFile,
        value: config.masterKey?.reveal() ?? null,
        dataDir: options.dataDir,
      },
      options.log,
    );
  }

  // ---------------------------------------------------------------- codes

  /** A new claim code for the first workspace, valid for a day. Only its hash is stored. */
  issueClaimCode(): { code: string; workspace: Workspace } {
    return issueClaimCode(this.store);
  }

  /** A new single-use invite code for creating a workspace, valid for a week. Only its hash is stored. */
  issueInviteCode(): string {
    return issueInviteCode(this.store);
  }

  /** The hash of a typed code, or an error that says nothing about whether such a code exists. */
  private codeHash(typed: string, what: string): string {
    const code = normalizeHumanCode(typed);
    if (code === null) throw new AccountError(422, "invalid_code", `That is not a valid ${what}.`);
    return hashSecret(code);
  }

  // ---------------------------------------------------------------- registration

  /**
   * Starts a passkey registration. Each purpose is checked here, before the browser asks for a passkey,
   * and again when the answer comes back, since a code can be used up in between.
   */
  async startRegistration(
    request:
      | { kind: "sign-up"; name: string; inviteCode: string | null }
      | { kind: "claim"; name: string; claimCode: string }
      | { kind: "recover"; recoveryCode: string }
      | { kind: "add"; member: Member },
  ): Promise<{ ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
    let purpose: Purpose;
    let member: Member | null = null;
    let userName: string;
    switch (request.kind) {
      case "sign-up": {
        const name = memberNameSchema.parse(request.name);
        let inviteHash: string | null = null;
        if (this.config.signup === "invite") {
          if (request.inviteCode === null || request.inviteCode.trim() === "") {
            throw new AccountError(422, "invite_required", "Creating a workspace here needs an invite code.");
          }
          inviteHash = this.codeHash(request.inviteCode, "invite code");
          if (!this.store.accessCode("invite", inviteHash)) {
            throw new AccountError(
              403,
              "invalid_code",
              "That invite code is not valid, or it was already used.",
            );
          }
        }
        purpose = { kind: "sign-up", name, inviteHash };
        userName = name;
        break;
      }
      case "claim": {
        const name = memberNameSchema.parse(request.name);
        const claimHash = this.codeHash(request.claimCode, "claim code");
        if (!this.store.accessCode("claim", claimHash)) {
          throw new AccountError(
            403,
            "invalid_code",
            "That claim code is not valid, or it was already used.",
          );
        }
        purpose = { kind: "claim", name, claimHash };
        userName = name;
        break;
      }
      case "recover": {
        const recoveryHash = this.codeHash(request.recoveryCode, "recovery code");
        member = this.store.recoveryCodeMember(recoveryHash);
        if (!member) throw new AccountError(403, "invalid_code", "That recovery code is not valid.");
        purpose = { kind: "recover", memberId: member.id, recoveryHash };
        userName = member.name;
        break;
      }
      case "add":
        member = request.member;
        purpose = { kind: "add", memberId: member.id };
        userName = member.name;
        break;
    }
    const webauthnUserId = member?.webauthnUserId ?? randomBytes(32).toString("base64url");
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: this.config.rpId,
      userName,
      userDisplayName: userName,
      userID: new Uint8Array(Buffer.from(webauthnUserId, "base64url")),
      attestationType: "none",
      excludeCredentials: member
        ? this.store.passkeysOf(member.id).map((passkey) => ({
            id: passkey.credentialId,
            transports: passkey.transports,
          }))
        : [],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      timeout: CEREMONY_TTL_MS,
    });
    const ceremonyId = newOpaqueId();
    const payload: z.infer<typeof registrationPayload> = { purpose, webauthnUserId };
    this.store.putCeremony(hashSecret(ceremonyId), "register", options.challenge, payload, CEREMONY_TTL_MS);
    return { ceremonyId, options };
  }

  /** Verifies the browser's new passkey and does what the ceremony was started for. */
  async finishRegistration(
    ceremonyId: string | null,
    response: RegistrationResponseJSON,
    signedIn: Member | null,
  ): Promise<RegistrationOutcome> {
    const ceremony = ceremonyId ? this.store.takeCeremony(hashSecret(ceremonyId), "register") : null;
    if (!ceremony) throw expired();
    const { purpose, webauthnUserId } = registrationPayload.parse(ceremony.payload);
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        requireUserVerification: true,
      });
    } catch {
      throw new AccountError(400, "passkey_rejected", "The passkey could not be verified. Try again.");
    }
    if (!verified.verified) {
      throw new AccountError(400, "passkey_rejected", "The passkey could not be verified. Try again.");
    }
    const info = verified.registrationInfo;
    if (this.store.passkey(info.credential.id)) {
      throw new AccountError(409, "passkey_exists", "This passkey is already registered.");
    }
    const passkey = {
      credentialId: info.credential.id,
      publicKey: info.credential.publicKey,
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    };
    switch (purpose.kind) {
      case "sign-up": {
        const created = this.store.signUp({
          memberName: purpose.name,
          webauthnUserId,
          passkey,
          inviteHash: purpose.inviteHash,
          master: this.master,
        });
        if (!created) {
          throw new AccountError(
            403,
            "invalid_code",
            "That invite code was used meanwhile. Ask for a new one.",
          );
        }
        return {
          kind: "signed-in",
          member: created.member,
          recoveryCode: this.newRecoveryCode(created.member),
        };
      }
      case "claim": {
        const claimed = this.store.claim({
          claimHash: purpose.claimHash,
          memberName: purpose.name,
          webauthnUserId,
          passkey,
        });
        if (!claimed) {
          throw new AccountError(
            403,
            "invalid_code",
            "That claim code was used meanwhile, or the workspace is claimed.",
          );
        }
        return {
          kind: "signed-in",
          member: claimed.member,
          recoveryCode: this.newRecoveryCode(claimed.member),
        };
      }
      case "recover": {
        const member = this.store.useRecoveryCode(purpose.recoveryHash);
        if (member?.id !== purpose.memberId) {
          throw new AccountError(403, "invalid_code", "That recovery code was used meanwhile.");
        }
        this.store.addPasskey(member.id, passkey);
        return { kind: "signed-in", member, recoveryCode: this.newRecoveryCode(member) };
      }
      case "add": {
        // Only the member who started it may finish it, in the session that started it.
        if (signedIn?.id !== purpose.memberId) throw expired();
        this.store.addPasskey(signedIn.id, passkey);
        return { kind: "passkey-added", member: signedIn };
      }
    }
  }

  private newRecoveryCode(member: Member): string {
    const code = newHumanCode();
    this.store.setRecoveryCode(member.id, normalizeHumanCode(code) ?? code);
    return code;
  }

  // ---------------------------------------------------------------- sign-in

  /** Starts a sign-in with any passkey of this site: discoverable credentials, no user name. */
  async startAuthentication(): Promise<{
    ceremonyId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }> {
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpId,
      userVerification: "required",
      timeout: CEREMONY_TTL_MS,
    });
    const ceremonyId = newOpaqueId();
    this.store.putCeremony(hashSecret(ceremonyId), "authenticate", options.challenge, {}, CEREMONY_TTL_MS);
    return { ceremonyId, options };
  }

  /** The member whose passkey answered the challenge. Every failure reads the same, so nothing leaks. */
  async finishAuthentication(
    ceremonyId: string | null,
    response: AuthenticationResponseJSON,
  ): Promise<Member> {
    const ceremony = ceremonyId ? this.store.takeCeremony(hashSecret(ceremonyId), "authenticate") : null;
    if (!ceremony) throw expired();
    const rejected = new AccountError(
      401,
      "passkey_rejected",
      "That passkey is not registered here, or it could not be verified.",
    );
    const passkey = this.store.passkey(response.id);
    if (!passkey) throw rejected;
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: passkey.counter,
          transports: passkey.transports,
        },
        requireUserVerification: true,
      });
    } catch {
      throw rejected;
    }
    if (!verified.verified) throw rejected;
    this.store.usePasskey(passkey.credentialId, verified.authenticationInfo.newCounter);
    const member = this.store.member(passkey.memberId);
    if (!member) throw rejected;
    return member;
  }

  // ---------------------------------------------------------------- sessions

  /** A new session for the member. The id goes in the cookie; the store keeps only its hash. */
  openSession(member: Member): string {
    const id = newOpaqueId();
    this.store.createSession(member, hashSecret(id));
    return id;
  }

  /** The member, workspace and session behind a session id, or null when it is not a live session. */
  access(sessionId: string | null): Access | null {
    if (!sessionId || sessionId.length > 128) return null;
    const session = this.store.session(hashSecret(sessionId));
    if (!session) return null;
    const member = this.store.member(session.memberId);
    const workspace = this.store.workspace(session.workspaceId);
    if (!member || !workspace || member.workspaceId !== workspace.id) return null;
    return { session, member, workspace };
  }

  closeSession(sessionId: string | null): void {
    if (sessionId && sessionId.length <= 128) this.store.deleteSession(hashSecret(sessionId));
    for (const listener of [...this.#sessionEnded]) listener();
  }

  readonly #sessionEnded = new Set<() => void>();

  /**
   * Calls `listener` whenever a session is closed here (a sign-out), so what a session holds open, such as
   * an event stream, can check whether it is still live. Returns the unsubscribe.
   */
  onSessionClosed(listener: () => void): () => void {
    this.#sessionEnded.add(listener);
    return () => {
      this.#sessionEnded.delete(listener);
    };
  }

  /**
   * The mandate a request acts on: the one named (it must belong to the session's workspace), or the
   * workspace's first. Null when the name is not one of the workspace's mandates, which reads the same as
   * one that does not exist.
   */
  mandateFor(access: Access, requested: string | null): Mandate | null {
    const mandates = this.store.mandates(access.workspace.id);
    if (requested === null || requested === "") return mandates[0] ?? null;
    return mandates.find((mandate) => mandate.id === requested) ?? null;
  }
}

/**
 * A new claim code for the first workspace, valid for a day; only its hash is stored. The operator's
 * command calls this on the server, so the code never crosses the network until the operator shares it.
 */
export function issueClaimCode(store: AccountStore): { code: string; workspace: Workspace } {
  const workspace = store.firstWorkspace();
  if (workspace.claimedAt !== null) {
    throw new AccountError(409, "already_claimed", "The first workspace is already claimed.");
  }
  const code = newHumanCode();
  store.createAccessCode("claim", normalizeHumanCode(code) ?? code, CLAIM_CODE_TTL_MS, workspace.id);
  return { code, workspace };
}

/** A new single-use invite code for creating a workspace, valid for a week; only its hash is stored. */
export function issueInviteCode(store: AccountStore): string {
  const code = newHumanCode();
  store.createAccessCode("invite", normalizeHumanCode(code) ?? code, INVITE_CODE_TTL_MS, null);
  return code;
}

function expired(): AccountError {
  return new AccountError(400, "ceremony_expired", "That passkey prompt expired. Start again.");
}
