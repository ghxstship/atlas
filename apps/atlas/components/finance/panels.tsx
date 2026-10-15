"use client";

import { EmptyState, ErrorState, RefusalNotice, Skeleton } from "@xos/ui";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useFinanceT } from "./kit";

/**
 * Page states for Finance and Reports (Section 19.6): empty with one next action, loading
 * skeletons, error with retry, and a refusal naming why the viewer cannot see a page's data.
 */

export function EmptyPanel({
  sentence,
  actionLabel,
  href,
  icon = "Inbox",
}: {
  sentence: string;
  actionLabel: string;
  href: string;
  icon?: string;
}) {
  const router = useRouter();
  return (
    <EmptyState
      icon={icon}
      sentence={sentence}
      actionLabel={actionLabel}
      onAction={() => router.push(href as Route)}
    />
  );
}

export function ErrorPanel({ sentence }: { sentence: string }) {
  const t = useFinanceT();
  const router = useRouter();
  return (
    <ErrorState
      title={t("common.errorTitle")}
      sentence={sentence}
      actionLabel={t("common.retry")}
      onRetry={() => router.refresh()}
    />
  );
}

/** Shown when the viewer lacks the capability a page reads with; the rule is named, never guessed. */
export function RefusalPanel({ capability, href }: { capability: string; href: string }) {
  const t = useFinanceT();
  const router = useRouter();
  return (
    <RefusalNotice
      outcome="REFUSE"
      title={t("common.refusedTitle")}
      reason={t("common.missingCapability", { capability })}
      actionLabel={t("common.backHome")}
      onAction={() => router.push(href as Route)}
    />
  );
}

export function LoadingPanel({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-8">
      <Skeleton height={28} width="40%" />
      <Skeleton height={36} />
      <Skeleton height={36} />
      <Skeleton height={36} />
      <Skeleton height={36} />
    </div>
  );
}
