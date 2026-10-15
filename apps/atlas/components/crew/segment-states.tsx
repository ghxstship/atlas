"use client";

import { ErrorState, Skeleton } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

/**
 * Loading and error states for the People and Crew segments (Section 11.7): a skeleton per region
 * while the page streams, and an error boundary that names what failed and retries in place.
 */
export function CrewLoading() {
  const t = useTranslations("crew.segment");
  return (
    <div role="status" aria-label={t("loading")} className="flex flex-col gap-12">
      <Skeleton width="30%" height={24} />
      <Skeleton width="60%" height={16} />
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} width="100%" height={36} />
      ))}
    </div>
  );
}

export function CrewError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("crew.segment");
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <ErrorState
      title={t("errorTitle")}
      sentence={t("errorBody")}
      actionLabel={t("retry")}
      onRetry={reset}
      {...(error.digest ? { reference: error.digest } : {})}
    />
  );
}
