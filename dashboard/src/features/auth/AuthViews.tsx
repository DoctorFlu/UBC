"use client";

import { CircleAlert, KeyRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, type ReactNode, useState } from "react";

import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Field, Input } from "@/components/ui/Field";

import { AuthCard } from "./AuthFrame";
import { safeNext } from "@/lib/accounts/next";

import { AuthFailure, type Registered, registerPasskey, signInWithPasskey } from "./passkey";
import styles from "./auth.module.css";

function useAttempt() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function attempt<T>(work: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (failure) {
      setError(failure instanceof AuthFailure ? failure.message : "Something went wrong. Try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, attempt };
}

function Alert({ message }: { message: string | null }) {
  return (
    <div role="alert" aria-live="assertive">
      {message ? (
        <p className={styles.alert}>
          <CircleAlert aria-hidden strokeWidth={2.25} />
          <span>{message}</span>
        </p>
      ) : null}
    </div>
  );
}

function LinkItem({ prompt, href, children }: { prompt: string; href: string; children: ReactNode }) {
  return (
    <li>
      {prompt} <Link href={href}>{children}</Link>
    </li>
  );
}

export function SignInView({ next, canClaim }: { next: string; canClaim: boolean }) {
  const router = useRouter();
  const { busy, error, attempt } = useAttempt();
  async function signIn() {
    const done = await attempt(async () => {
      await signInWithPasskey();
      return true;
    });
    if (done) router.replace(safeNext(next));
  }
  return (
    <AuthCard
      title="Sign in"
      lead="Use the passkey you made for this console. Your device asks for your fingerprint, face or PIN."
      links={
        <>
          <LinkItem prompt="New here?" href="/sign-up">
            Create a workspace
          </LinkItem>
          <LinkItem prompt="Lost your passkey?" href="/recover">
            Use a recovery code
          </LinkItem>
          {canClaim ? (
            <LinkItem prompt="Setting up this console?" href="/claim">
              Claim it
            </LinkItem>
          ) : null}
        </>
      }
    >
      <Alert message={error} />
      <Button
        variant="primary"
        size="lg"
        block
        icon={<KeyRound aria-hidden />}
        loading={busy}
        onClick={() => void signIn()}
      >
        Sign in with a passkey
      </Button>
    </AuthCard>
  );
}

function RecoveryCode({ code, next }: { code: string; next: string }) {
  const router = useRouter();
  return (
    <AuthCard
      title="Save your recovery code"
      lead="If you lose this passkey, this code lets you add a new one. It works once and is not shown again. Keep it in your password manager."
    >
      <div className={styles.code}>
        <span className={styles.codeValue} data-testid="recovery-code">
          {code}
        </span>
        <CopyButton value={code} what="recovery code" />
      </div>
      <Button variant="primary" size="lg" block onClick={() => router.replace(safeNext(next))}>
        I saved it, open the console
      </Button>
    </AuthCard>
  );
}

/** One registration form: fields, one action, then the recovery code. */
function RegisterForm({
  title,
  lead,
  action,
  url,
  body,
  links,
  children,
}: {
  title: string;
  lead: ReactNode;
  action: string;
  url: string;
  body: () => unknown;
  links?: ReactNode;
  children: ReactNode;
}) {
  const { busy, error, attempt } = useAttempt();
  const [done, setDone] = useState<Registered | null>(null);
  if (done?.recoveryCode) return <RecoveryCode code={done.recoveryCode} next="/" />;
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const registered = await attempt(() => registerPasskey(url, body()));
    if (registered) setDone(registered);
  }
  return (
    <AuthCard title={title} lead={lead} links={links}>
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        {children}
        <Alert message={error} />
        <Button type="submit" variant="primary" size="lg" block icon={<KeyRound aria-hidden />} loading={busy}>
          {action}
        </Button>
      </form>
    </AuthCard>
  );
}

const signInLink = (
  <LinkItem prompt="Already have a passkey?" href="/sign-in">
    Sign in
  </LinkItem>
);

export function SignUpView({ inviteRequired }: { inviteRequired: boolean }) {
  const [name, setName] = useState("");
  const [invite, setInvite] = useState("");
  return (
    <RegisterForm
      title="Create a workspace"
      lead="Your workspace holds your mandate and your agent. You sign in with a passkey: no password to remember."
      action="Create a passkey"
      url="/api/auth/sign-up"
      body={() => ({ name, inviteCode: inviteRequired ? invite : null })}
      links={signInLink}
    >
      {inviteRequired ? (
        <Field label="Invite code" hint="From the person who runs this console.">
          <Input name="invite" autoComplete="off" spellCheck={false} value={invite} onValueChange={setInvite} />
        </Field>
      ) : null}
      <Field label="Your name">
        <Input name="name" autoComplete="name" value={name} onValueChange={setName} />
      </Field>
    </RegisterForm>
  );
}

export function ClaimView() {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  return (
    <RegisterForm
      title="Claim this console"
      lead="The first workspace holds the mandate this server already runs. Claim it with the code the operator printed on the server."
      action="Claim with a passkey"
      url="/api/auth/claim"
      body={() => ({ name, claimCode: code })}
      links={signInLink}
    >
      <Field
        label="Claim code"
        hint={
          <>
            Printed by <code>console:admin claim-code</code> on the server. It works once, for a day.
          </>
        }
      >
        <Input name="claim" autoComplete="off" spellCheck={false} value={code} onValueChange={setCode} />
      </Field>
      <Field label="Your name">
        <Input name="name" autoComplete="name" value={name} onValueChange={setName} />
      </Field>
    </RegisterForm>
  );
}

export function RecoverView() {
  const [code, setCode] = useState("");
  return (
    <RegisterForm
      title="Use a recovery code"
      lead="Lost the device with your passkey? Your recovery code adds a passkey on this one. You get a new code after."
      action="Add a passkey"
      url="/api/auth/recover"
      body={() => ({ recoveryCode: code })}
      links={signInLink}
    >
      <Field label="Recovery code">
        <Input name="recovery" autoComplete="off" spellCheck={false} value={code} onValueChange={setCode} />
      </Field>
    </RegisterForm>
  );
}
