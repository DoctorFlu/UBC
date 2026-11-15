import { ArrowLeft } from "lucide-react";

import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/States";

import styles from "./not-found.module.css";

export default function NotFound() {
  return (
    <main className={styles.page}>
      <EmptyState
        title="Nothing at this address"
        action={
          <ButtonLink href="/" variant="primary" icon={<ArrowLeft aria-hidden />}>
            Back to the overview
          </ButtonLink>
        }
      >
        The page may have moved, or the agent address in the link is not valid.
      </EmptyState>
    </main>
  );
}
