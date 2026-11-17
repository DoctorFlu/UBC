"use client";

import { WebAuthnError, browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

import type { PolicyRules } from "@mandate/shared";

import type { OwnerCall } from "./calls";

/**
 * What a passkey confirms (#95): one owner action, bound by the server to this member, this workspace and,
 * for a contract call, this mandate's contract. The server builds the challenge from it, so an answer for
 * one action never confirms another.
 */
export type ConfirmedAction =
  | { kind: "owner-call"; mandateId: string; call: OwnerCall }
  | { kind: "owner-request"; mandateId: string; request: { action: string; payload: unknown } }
  | { kind: "create-mandate"; name: string; rules: PolicyRules | null }
  | { kind: "create-token"; agentId: string; name: string };

export interface StepUpAnswer {
  id: string;
  response: AuthenticationResponseJSON;
}

/** A refusal to show as it is, in one plain sentence. `cancelled` when the person closed the prompt. */
export class PasskeyFailure extends Error {
  override readonly name = "PasskeyFailure";
  constructor(
    message: string,
    readonly cancelled = false,
  ) {
    super(message);
  }
}

export const STEP_UP_PATH = "/api/console/step-up";

async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch {
    // Not JSON.
  }
  return `The console answered ${response.status.toString()}.`;
}

function cancelledPrompt(error: unknown): boolean {
  const names = new Set<string>();
  if (error instanceof WebAuthnError) {
    names.add(error.code);
    if (error.cause instanceof Error) names.add(error.cause.name);
  } else if (error instanceof Error) {
    names.add(error.name);
  }
  return ["ERROR_CEREMONY_ABORTED", "NotAllowedError", "AbortError"].some((name) => names.has(name));
}

/**
 * One passkey prompt for one action: asks the console for a challenge bound to `action`, asks the device,
 * and returns the answer to send with the action itself. Nothing has changed when it throws.
 */
export async function confirmWithPasskey(action: ConfirmedAction): Promise<StepUpAnswer> {
  if (!browserSupportsWebAuthn()) {
    throw new PasskeyFailure(
      "This browser can't use passkeys, so nothing was changed. Open the console in a current browser.",
    );
  }
  let started: Response;
  try {
    started = await fetch(STEP_UP_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
  } catch {
    throw new PasskeyFailure(
      "Can't reach the console, so nothing was changed. Check your connection and try again.",
    );
  }
  if (!started.ok) throw new PasskeyFailure(await errorText(started));
  const { id, options } = (await started.json()) as {
    id: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  };
  try {
    return { id, response: await startAuthentication({ optionsJSON: options }) };
  } catch (error) {
    if (cancelledPrompt(error)) {
      throw new PasskeyFailure("You closed the passkey prompt, so nothing was changed.", true);
    }
    throw new PasskeyFailure("Your passkey could not confirm this, so nothing was changed. Try again.");
  }
}

/** The console's answer to a write, as a plain sentence when it refused. */
export async function refusal(response: Response): Promise<string> {
  return errorText(response);
}
