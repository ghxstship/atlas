"use client";

import { ErrorState, Skeleton } from "@xos/ui";
import { useEffect } from "react";
import { useCopy } from "./action-ui";

/** The loading state of a Schedule, Work or Show page: skeletons where the header and rows will be. */
export function ModuleLoading({ rows = 8 }: { rows?: number }) {
  const t = useCopy("work");
  return (
    <div aria-busy="true" aria-label={t("pageStates.loading")} className="flex flex-col gap-12">
      <Skeleton width={240} height={28} />
      <Skeleton width="70%" height={40} />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} width="100%" height={36} />
      ))}
    </div>
  );
}

/** The error state of a Schedule, Work or Show page: what failed, a retry and a reference. */
export function ModuleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useCopy("work");
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <ErrorState
      title={t("pageStates.errorTitle")}
      sentence={t("pageStates.errorSentence")}
      actionLabel={t("pageStates.retry")}
      onRetry={reset}
      {...(error.digest ? { reference: error.digest } : {})}
    />
  );
}
