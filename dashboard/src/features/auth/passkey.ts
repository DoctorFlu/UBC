"use client";

import {
  WebAuthnError,
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

import { promptNeedsFocus } from "@/lib/owner/passkey";

/** A failure to show as it is: one plain sentence. */
export class AuthFailure extends Error {
  override readonly name = "AuthFailure";
}

interface ApiError {
  error?: { message?: string };
}

async function post<T>(url: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthFailure("Can't reach the console. Check your connection and try again.");
  }
  const payload = (await response.json().catch(() => ({}))) as T & ApiError;
  if (!response.ok) {
    throw new AuthFailure(payload.error?.message ?? "Something went wrong. Try again.");
  }
  return payload;
}

/** The browser's own passkey errors, as a sentence a person can act on. */
function passkeyFailure(error: unknown): AuthFailure {
  const names = new Set<string>();
  if (error instanceof WebAuthnError) {
    names.add(error.code);
    if (error.cause instanceof Error) names.add(error.cause.name);
  } else if (error instanceof Error) {
    names.add(error.name);
  }
  if (promptNeedsFocus(error)) {
    return new AuthFailure(
      "The passkey prompt needs this tab in front. Click anywhere on this page, then try again.",
    );
  }
  if (["ERROR_CEREMONY_ABORTED", "NotAllowedError", "AbortError"].some((name) => names.has(name))) {
    return new AuthFailure("The passkey prompt closed before it finished. Try again.");
  }
  if (["ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED", "InvalidStateError"].some((name) => names.has(name))) {
    return new AuthFailure("This device already holds a passkey for you here. Sign in with it instead.");
  }
  return new AuthFailure("The passkey could not be used. Try again, or use another device.");
}

function requireWebAuthn(): void {
  if (!browserSupportsWebAuthn()) {
    throw new AuthFailure("This browser can't use passkeys. Open the console in a current browser.");
  }
}

export interface Registered {
  status: "signed-in" | "passkey-added";
  /** Shown once, after sign-up, claim and recovery. */
  recoveryCode?: string;
}

/** Starts a registration at `url`, asks the device for a new passkey, and finishes it. */
export async function registerPasskey(url: string, body: unknown): Promise<Registered> {
  requireWebAuthn();
  const { options } = await post<{ options: PublicKeyCredentialCreationOptionsJSON }>(url, body);
  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (error) {
    throw passkeyFailure(error);
  }
  return post<Registered>("/api/auth/register", { response });
}

/** Signs in with any passkey this device holds for the console. */
export async function signInWithPasskey(): Promise<void> {
  requireWebAuthn();
  const { options } = await post<{ options: PublicKeyCredentialRequestOptionsJSON }>("/api/auth/sign-in", {});
  let response;
  try {
    response = await startAuthentication({ optionsJSON: options });
  } catch (error) {
    throw passkeyFailure(error);
  }
  await post("/api/auth/sign-in/verify", { response });
}
