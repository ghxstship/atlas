"use client";

import { reportClientError } from "@xos/infra/observability/browser";
import { ErrorState, Skeleton } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

/**
 * The loading and error states of every Credentials and Safety incident page (Section 11.10): a
 * skeleton shaped like the collection while the server renders, and an error that names the next
 * action and offers a retry with the reference the server logged.
 */
export function CollectionLoading() {
  const t = useTranslations("credentials.common");
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-12">
      <span className="sr-only">{t("loading")}</span>
      <Skeleton width={240} height={24} />
      <Skeleton width="100%" height={32} />
      {[0, 1, 2, 3, 4].map((row) => (
        <Skeleton key={row} width="100%" height={40} />
      ))}
    </div>
  );
}

export function CollectionError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("credentials.common");
  useEffect(() => {
    reportClientError(error);
  }, [error]);
  return (
    <ErrorState
      title={t("errorTitle")}
      sentence={t("errorSentence")}
      actionLabel={t("retry")}
      {...(error.digest ? { reference: error.digest } : {})}
      onRetry={reset}
    />
  );
}
