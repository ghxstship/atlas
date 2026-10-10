"use client";

import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Button } from "@/components/shell/primitives";
import { SystemMessage } from "@/components/shell/system-message";

/** Error boundary with a retry (Section 11.7, loading): the System template for a failed region. */
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
    <SystemMessage
      icon={TriangleAlert}
      title={t("title")}
      body={t("body")}
      action={
        <Button variant="primary" onClick={reset}>
          {t("action")}
        </Button>
      }
    />
  );
}
