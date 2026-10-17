"use client";

import { reportClientError } from "@xos/infra/observability/browser";
import { ErrorState } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

/** The Finance region's error boundary: says what failed and retries in place (Section 11.7). */
export default function FinanceError({ error, reset }: { error: Error; reset: () => void }) {
  const t = useTranslations("finance.common");
  useEffect(() => {
    reportClientError(error);
  }, [error]);
  return (
    <ErrorState
      title={t("errorTitle")}
      sentence={t("errorSentence")}
      actionLabel={t("retry")}
      onRetry={reset}
    />
  );
}
