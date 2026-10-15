"use client";

import { ErrorState } from "@xos/ui";
import { useTranslations } from "next-intl";

/** The Reports region's error boundary: says what failed and retries in place (Section 11.7). */
export default function ReportsError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations("finance.common");
  return (
    <ErrorState
      title={t("errorTitle")}
      sentence={t("errorSentence")}
      actionLabel={t("retry")}
      onRetry={reset}
    />
  );
}
