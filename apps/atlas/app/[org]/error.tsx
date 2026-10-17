"use client";

import { reportClientError } from "@xos/infra/observability/browser";
import { TemplateSystem } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

/**
 * A page in an org that throws (A23-017). The boundary sits inside the org layout, so the sidebar,
 * header and skip link stay, and the error fills only the page region, which the shell's main
 * landmark already holds: a level 1 heading, Try again, and Go to Home as the way out.
 */
export default function OrgPageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("shell.system.pageError");
  const { org } = useParams<{ org: string }>();
  useEffect(() => {
    console.error(error);
    reportClientError(error);
  }, [error]);
  return (
    <div className="flex flex-col items-center gap-8">
      <TemplateSystem
        icon="CircleAlert"
        title={t("title")}
        sentence={t("body")}
        actionLabel={t("retry")}
        onAction={reset}
        {...(error.digest ? { reference: error.digest } : {})}
      />
      <Link href={`/${org}/home` as Route} className="text-text-14 text-accent-text underline">
        {t("home")}
      </Link>
    </div>
  );
}
