"use client";

import { reportClientError } from "@xos/infra/observability/browser";
import { ErrorState } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

/** Error boundary with a retry (Section 11.7): @xos/ui ErrorState for a failed region. */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("gateway.system.error");
  useEffect(() => {
    console.error(error);
    reportClientError(error);
  }, [error]);
  return (
    <ErrorState
      title={t("title")}
      sentence={t("body")}
      actionLabel={t("action")}
      onRetry={reset}
      {...(error.digest ? { reference: error.digest } : {})}
    />
  );
}
