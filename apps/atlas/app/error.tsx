"use client";

import { reportClientError } from "@xos/infra/observability/browser";
import { useTranslations } from "next-intl";
import { lazy, Suspense, useEffect } from "react";

/*
 * Every route loads this boundary's script with the root layout, though it renders only when a route
 * above the org layout throws: the org and record routes have boundaries of their own. ErrorState
 * and the Button it draws load when it renders. Kept in this chunk they cost each route about
 * 2.5 KB, once the 4.16 cookie banner became script-free and the root layout stopped sharing
 * Button with it (r/NWS-1 went over its ceiling in nightly run 43690467981).
 */
const ErrorState = lazy(() => import("@/components/shell/root-error-state"));

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
    reportClientError(error);
  }, [error]);
  return (
    <Suspense fallback={null}>
      <ErrorState
        title={t("title")}
        sentence={t("body")}
        actionLabel={t("action")}
        onRetry={reset}
        {...(error.digest ? { reference: error.digest } : {})}
      />
    </Suspense>
  );
}
