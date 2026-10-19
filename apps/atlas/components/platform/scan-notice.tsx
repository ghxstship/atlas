"use client";

import { useTranslations } from "next-intl";

/**
 * The plain-language line under a file whose virus scan blocked it (owner decision 10, ADR 0033):
 * an infected file was deleted, and a file the scanner could not check stays closed. Renders nothing
 * for a file that is Clean or still being scanned; the status tag already says so.
 */
export function ScanNotice({ status }: { readonly status: string | null | undefined }) {
  const t = useTranslations("platform.uploadScan");
  if (status !== "Infected" && status !== "Scan Failed") return null;
  return (
    <span role="note" className="text-text-12 text-danger-text">
      {status === "Infected" ? t("infected") : t("scanFailed")}
    </span>
  );
}
