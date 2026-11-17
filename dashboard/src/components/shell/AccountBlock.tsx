"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { AccountView } from "@/lib/accounts/types";

import styles from "./Shell.module.css";

/** Who is signed in, to which workspace, and the way out. */
export function AccountBlock({ account }: { account: AccountView }) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  async function signOut() {
    setLeaving(true);
    try {
      await fetch("/api/auth/sign-out", { method: "POST" });
    } finally {
      router.replace("/sign-in");
    }
  }
  return (
    <div className={styles.account}>
      <div className={styles.accountWho}>
        <span className={styles.accountName}>{account.member.name}</span>
        <span className={styles.accountWorkspace}>{account.workspace.name}</span>
      </div>
      <button
        type="button"
        className={styles.footLink}
        onClick={() => void signOut()}
        disabled={leaving}
        aria-busy={leaving || undefined}
      >
        <LogOut aria-hidden strokeWidth={1.5} />
        Sign out
      </button>
    </div>
  );
}
