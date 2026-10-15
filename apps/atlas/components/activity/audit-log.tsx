"use client";

import type { AuditEntry } from "@xos/data/activity";
import { Button, DataTable, EmptyState, Tag } from "@xos/ui";
import type { Route } from "next";
import { useFormatter, useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";

/**
 * Activity > Audit log (Section 4.5.5, Owner and Admin): the compliance ledger as a table, newest
 * first, paged by time. Redacted entries say so instead of showing personal data.
 */
export function AuditLog({
  entries,
  next,
  paged,
  membersHref,
}: {
  entries: readonly AuditEntry[];
  next: string | null;
  paged: boolean;
  membersHref: string;
}) {
  const t = useTranslations("activity.audit");
  const format = useFormatter();
  const router = useRouter();
  const pathname = usePathname();
  if (entries.length === 0 && !paged) {
    return (
      <EmptyState
        icon="ScrollText"
        sentence={t("empty")}
        actionLabel={t("emptyAction")}
        onAction={() => router.push(membersHref as Route)}
      />
    );
  }
  return (
    <div className="flex flex-col gap-12">
      <DataTable
        caption={t("caption")}
        columns={[
          { key: "when", label: t("when"), width: 190 },
          { key: "actor", label: t("actor"), width: 180 },
          { key: "action", label: t("action"), type: "code", width: 220 },
          { key: "subject", label: t("subject"), type: "code", width: 200 },
          { key: "changes", label: t("changes"), wrap: true },
        ]}
        rows={entries.map((e) => ({
          id: e.id,
          when: format.dateTime(new Date(e.at), { dateStyle: "medium", timeStyle: "medium" }),
          actor:
            e.actor ??
            (e.actorKind === "Person"
              ? t("redacted")
              : e.actorKind === "Service"
                ? t("service")
                : t("systemActor")),
          action: e.action,
          subject: e.subjectTable.replace(/^app\./, ""),
          changes: e.redacted
            ? t("redacted")
            : Object.keys(e.diff).length > 0
              ? `${t("changedFields", { count: Object.keys(e.diff).length })}: ${Object.keys(e.diff).join(", ")}`
              : "",
        }))}
      />
      <div className="flex gap-8">
        {paged ? (
          <Button variant="ghost" onClick={() => router.push(pathname as Route)}>
            {t("newest")}
          </Button>
        ) : null}
        {next ? (
          <Button
            variant="secondary"
            onClick={() => router.push(`${pathname}?before=${encodeURIComponent(next)}` as Route)}
          >
            {t("older")}
          </Button>
        ) : null}
        {entries.some((e) => e.redacted) ? <Tag tone="neutral">{t("redacted")}</Tag> : null}
      </div>
    </div>
  );
}
