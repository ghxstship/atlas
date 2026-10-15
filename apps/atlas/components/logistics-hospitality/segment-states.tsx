"use client";

import { ErrorState, Skeleton } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

/** The loading state of a Logistics or Hospitality page: skeletons where the header and rows go. */
export function OperationsLoading() {
  const t = useTranslations("logistics.common");
  return (
    <div role="status" aria-busy="true" aria-label={t("loading")} className="flex flex-col gap-12">
      <Skeleton width={240} height={28} />
      <Skeleton width="70%" height={40} />
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} width="100%" height={36} />
      ))}
    </div>
  );
}

/** The error state of a Logistics or Hospitality page: what failed, a retry and a reference. */
export function OperationsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("logistics.common.error");
  useEffect(() => {
    console.error(error);
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
