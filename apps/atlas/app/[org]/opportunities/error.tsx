"use client";

import { ErrorState } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

/** The Opportunities region error boundary with a retry (Section 11.7); the shell and other regions keep working. */
export default function OpportunitiesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("opportunities.error");
  useEffect(() => {
    console.error(error);
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
