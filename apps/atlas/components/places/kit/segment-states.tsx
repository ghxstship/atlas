"use client";

import { reportClientError } from "@xos/infra/observability/browser";
import { ErrorState, Skeleton } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

/**
 * Loading and error states of the Places and Safety route segments (Section 11.7: skeletons per
 * region, an error boundary with a retry). The error names the request digest so support can find it.
 */
export function SegmentLoading() {
  const t = useTranslations("places.kit");
  return (
    <div role="status" aria-label={t("loading")} className="flex flex-col gap-12">
      <Skeleton width="30%" height={28} />
      <Skeleton width="60%" height={20} />
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} width="100%" height={44} />
      ))}
    </div>
  );
}

export function SegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("places.kit.error");
  useEffect(() => {
    console.error(error);
    reportClientError(error);
  }, [error]);
  return (
    <ErrorState
      title={t("title")}
      sentence={t("sentence")}
      actionLabel={t("retry")}
      {...(error.digest ? { reference: error.digest } : {})}
      onRetry={reset}
    />
  );
}
