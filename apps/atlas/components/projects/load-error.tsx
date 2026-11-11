"use client";

import { ErrorState, PageHeader, TemplateCollection } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

/** The error state of a Projects, Home or Activity page: what failed and a retry. */
export function LoadError({ title, embedded = false }: { title: string; embedded?: boolean }) {
  const t = useTranslations("projects.list");
  const router = useRouter();
  const error = (
    <ErrorState
      title={t("loadErrorTitle")}
      sentence={t("loadError")}
      actionLabel={t("retry")}
      onRetry={() => router.refresh()}
    />
  );
  // A page that failed to load still stands on its template, under its own title (Section 11.6).
  return embedded ? (
    error
  ) : (
    <TemplateCollection header={<PageHeader title={title} />}>{error}</TemplateCollection>
  );
}
