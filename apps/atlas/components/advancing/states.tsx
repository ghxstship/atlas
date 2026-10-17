"use client";

import { reportClientError } from "@xos/infra/observability/browser";
import { ErrorState, Skeleton } from "@xos/ui";
import { useEffect } from "react";
import { useCopy } from "./use-copy";

/** Loading state of an Advancing page: a labelled skeleton of the header and rows. */
export function AdvancingLoading() {
  const t = useCopy("advancing.common");
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-12">
      <span className="sr-only">{t("loading")}</span>
      <Skeleton width={240} height={28} />
      <Skeleton width="100%" height={40} />
      <Skeleton width="100%" height={40} />
      <Skeleton width="100%" height={40} />
    </div>
  );
}

/** Error state of an Advancing page, with a retry that names the next action. */
export function AdvancingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useCopy("advancing.common.error");
  useEffect(() => {
    console.error(error);
    reportClientError(error);
  }, [error]);
  return (
    <ErrorState
      title={t("title")}
      sentence={t("sentence")}
      actionLabel={t("action")}
      onRetry={reset}
      {...(error.digest ? { reference: error.digest } : {})}
    />
  );
}
