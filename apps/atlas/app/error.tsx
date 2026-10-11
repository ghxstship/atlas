"use client";

import { ErrorState } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

/** Error boundary with a retry (Section 11.7, loading): @xos/ui ErrorState for a failed region. */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("shell.system.error");
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
