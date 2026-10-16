"use client";

import { ErrorState, Skeleton } from "@xos/ui";
import { useEffect } from "react";
import { useAssetsCopy } from "./copy";

/** Loading state of an assets page: the header and rows it is about to fill (Section 11.7). */
export function AssetsLoading() {
  const t = useAssetsCopy();
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-12">
      <span className="sr-only">{t("load.loading")}</span>
      <Skeleton width={240} height={24} />
      <Skeleton width="100%" height={36} />
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} width="100%" height={32} />
      ))}
    </div>
  );
}

/** A failed assets read: what happened, a retry and the reference to quote to support. */
export function AssetsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useAssetsCopy();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <ErrorState
      title={t("load.title")}
      sentence={t("load.sentence")}
      actionLabel={t("load.retry")}
      onRetry={reset}
      {...(error.digest ? { reference: error.digest } : {})}
    />
  );
}
