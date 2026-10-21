"use client";

import { EmptyState, ErrorState } from "@xos/ui";
import { RefusalNotice } from "@/components/refusal-notice";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useFinanceT } from "./kit-use-finance-t";

/**
 * Page states for Finance and Reports (Section 19.6): empty with one next action, loading
 * skeletons, error with retry, and a refusal naming why the viewer cannot see a page's data.
 */

export function EmptyPanel({
  sentence,
  actionLabel,
  href,
  icon = "Inbox",
  secondary = false,
}: {
  sentence: string;
  actionLabel: string;
  href: string;
  icon?: string;
  /** The page already holds its primary action, so this button is secondary (gate 27). */
  secondary?: boolean;
}) {
  const router = useRouter();
  return (
    <EmptyState
      icon={icon}
      sentence={sentence}
      actionLabel={actionLabel}
      actionVariant={secondary ? "secondary" : "primary"}
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
