import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { ButtonLink } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorState, Skeleton, SkeletonText } from "@/components/ui/States";

import styles from "./ViewStates.module.css";

/** Generic loading frame: the header and two blocks, at their real sizes. */
export function ViewSkeleton({
  title,
  fallback = false,
  children,
}: {
  title: string;
  /** True for the route's loading fallback, shown before the page has arrived. */
  fallback?: boolean;
  children?: ReactNode;
}) {
  return (
    <div aria-busy="true">
      <PageHeader
        title={title}
        description={<Skeleton width="22rem" height="1rem" />}
        reportsHydration={!fallback}
      />
      <span className="visually-hidden" role="status">
        Loading {title}
      </span>
      {children ?? (
        <div className={styles.grid}>
          <div className={styles.block}>
            <SkeletonText lines={4} />
          </div>
          <div className={styles.block}>
            <SkeletonText lines={3} />
          </div>
        </div>
      )}
    </div>
  );
}

/** The view-level error, shared by the route error boundary and the `?state=error` preview. */
export function ViewError({
  title,
  view,
  detail,
  action,
}: {
  title: string;
  view: string;
  detail?: string | undefined;
  action?: ReactNode;
}) {
  return (
    <div>
      <PageHeader title={title} />
      <ErrorState
        title={`${view} did not load`}
        detail={detail}
        action={
          action ?? (
            <ButtonLink href="?" variant="secondary" icon={<RefreshCw aria-hidden />}>
              Try again
            </ButtonLink>
          )
        }
      >
        The console could not read this view&apos;s data. Check that the event store is running and reachable,
        then try again. Everything onchain is unaffected.
      </ErrorState>
    </div>
  );
}
