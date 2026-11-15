"use client";

import { RefreshCw } from "lucide-react";

import { ViewError } from "@/components/states/ViewStates";
import { Button } from "@/components/ui/Button";

/** Catches a view that throws while rendering; the shell, wallet and kill switch stay usable. */
export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ViewError
      title="Something went wrong"
      view="This view"
      detail={error.digest ? `Error ${error.digest}` : undefined}
      action={
        <Button variant="secondary" icon={<RefreshCw aria-hidden />} onClick={reset}>
          Try again
        </Button>
      }
    />
  );
}
