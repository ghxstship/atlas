"use client";

import { ErrorState, PageHeader } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

/** The error state of a Projects, Home or Activity page: what failed and a retry. */
export function LoadError({ title, embedded = false }: { title: string; embedded?: boolean }) {
  const t = useTranslations("projects.list");
  const router = useRouter();
  return (
    <>
      {embedded ? null : <PageHeader title={title} />}
      <ErrorState
        title={t("loadErrorTitle")}
        sentence={t("loadError")}
        actionLabel={t("retry")}
        onRetry={() => router.refresh()}
      />
    </>
  );
}
