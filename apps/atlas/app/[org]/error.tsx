"use client";

import { reportClientError } from "@xos/infra/observability/browser";
import { TemplateSystem } from "@xos/ui";
import type { Route } from "next";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, type MouseEvent } from "react";

/**
 * A page in an org that throws (A23-017). The boundary sits inside the org layout, so the sidebar,
 * header and skip link stay, and the error fills only the page region, which the shell's main
 * landmark already holds: a level 1 heading, Try again, and Go to Home as the way out.
 *
 * Go to Home navigates client side the way the shell's sidebar does, an anchor whose plain click
 * goes through the router, so this boundary, which loads on every org page, does not carry
 * next/link (ADR 0027).
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
  const router = useRouter();
  const home = `/${org}/home` as Route;
  useEffect(() => {
    console.error(error);
    reportClientError(error);
  }, [error]);
  const goHome = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    event.preventDefault();
    router.push(home);
  };
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
      <a href={home} onClick={goHome} className="text-text-14 text-accent-text underline">
        {t("home")}
      </a>
    </div>
  );
}
