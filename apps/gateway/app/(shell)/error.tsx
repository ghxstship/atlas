"use client";

import { TemplateSystem } from "@xos/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

/**
 * A signed-in Gateway page that throws (A23-017). The boundary sits inside the shell layout, so the
 * top bar, tab bar and skip link stay and only the page region shows the error: a level 1 heading,
 * Try again, and Go to Home as the way out.
 */
export default function ShellPageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("gateway.system.pageError");
  useEffect(() => {
    console.error(error);
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
      <Link href="/home" className="text-text-14 text-accent-text underline">
        {t("home")}
      </Link>
    </div>
  );
}
