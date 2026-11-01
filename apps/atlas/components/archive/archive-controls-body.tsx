"use client";

import type { ArchivableEntity } from "@xos/data/archive";
import { Button, InlineAlert } from "@xos/ui";
import type { Route } from "next";
import { useFormatter, useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { setArchivedAction, type ArchiveError } from "@/lib/archive/actions";

/**
 * Archive and Unarchive for one row (A124, Section 4.10). An archived row says so and when; the
 * buttons show only to someone who edits the row, and the database checks again
 * (app.archive_row). Archiving from a peek closes it, since the row leaves the list it was opened
 * from; on a record page the page stays and shows the row's new state.
 */
export function ArchiveControlsBody({
  org,
  entity,
  id,
  archivedAt,
  canWrite,
}: {
  org: string;
  entity: ArchivableEntity;
  id: string;
  archivedAt: string | null;
  canWrite: boolean;
}) {
  const t = useTranslations("archive");
  const format = useFormatter();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<ArchiveError | null>(null);
  const archived = archivedAt !== null;
  if (!archived && !canWrite) return null;

  const run = () => {
    setError(null);
    startTransition(async () => {
      const result = await setArchivedAction(org, entity, id, !archived);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (params.has("peek")) {
        const next = new URLSearchParams(params.toString());
        next.delete("peek");
        next.delete("full");
        const qs = next.toString();
        router.replace((qs ? `${pathname}?${qs}` : pathname) as Route, { scroll: false });
      }
    });
  };

  return (
    <section aria-label={t("section")} className="flex flex-col gap-6" data-archive={entity}>
      {archived ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {t("notice", { date: format.dateTime(new Date(archivedAt), { dateStyle: "medium" }) })}
        </p>
      ) : null}
      {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
      {canWrite ? (
        <div>
          <Button
            size="sm"
            variant={archived ? "secondary" : "ghost"}
            icon={archived ? "Undo2" : "Archive"}
            loading={pending}
            onClick={run}
          >
            {archived ? t("action.unarchive") : t("action.archive")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
