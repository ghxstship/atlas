"use client";

import { QuickAdd, type QuickAddResult } from "@xos/ui";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import { useCopy } from "@/components/work/action-ui";
import { withQuery } from "@/components/work/format";
import { quickAddRecordAction } from "@/lib/quick-add/actions";
import { quickAddInput } from "@/lib/quick-add/fields";
import { QuickAddAlert, quickAddResolver, useQuickAddCopy } from "./shared";

export interface RecordQuickAddProps {
  readonly org: string;
  /** The zone date phrases are read in: the org's, or the project's on a project tab. */
  readonly timeZone: string;
  /** The project a project tab is about; null on org-level pages. */
  readonly projectId: string | null;
  /** The kinds the page creates, such as Milestone on Milestones; every kind when null. */
  readonly kinds: readonly string[] | null;
  /** The kind a line without /kind creates. */
  readonly defaultKind: string;
}

/**
 * The inline create row of a record collection (Section 11.7, ADR 0073): one line sets the title,
 * the date, the owner (@), the canon category (#), the kind (/) and the scope (~). Saving opens the
 * new record's peek; a refusal keeps the line so it can be corrected. The record being added shows
 * under the field the moment Enter is pressed, before the server answers (Section 11.10 rule 9).
 */
export function RecordQuickAdd({
  org,
  timeZone,
  projectId,
  kinds,
  defaultKind,
}: RecordQuickAddProps) {
  const t = useCopy("work");
  const copy = useQuickAddCopy();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [error, setError] = useState<{ key: string; detail?: string } | null>(null);
  const [created, setCreated] = useState("");
  const [, start] = useTransition();
  // The title being saved, until the save and the peek it opens have landed.
  const [adding, showAdding] = useOptimistic<string | null, string>(null, (_, title) => title);
  const allowed = kinds ? [...kinds] : null;
  const only = kinds?.length === 1 ? kinds[0] : undefined;

  const submit = (result: QuickAddResult) =>
    new Promise<boolean>((done) =>
      start(async () => {
        setError(null);
        const line = quickAddInput(result);
        showAdding(line.title || t("quickAdd.untitled"));
        const saved = await quickAddRecordAction(org, {
          projectId,
          kinds: allowed,
          defaultKind,
          title: line.title,
          kind: line.kind,
          personId: line.personId,
          tagId: line.tagId,
          scopeNodeId: line.scopeNodeId,
          when: line.when,
        });
        if (!saved.ok) {
          setError(saved.error);
          done(false);
          return;
        }
        setCreated(t("quickAdd.created", { key: saved.data.key }));
        router.replace(withQuery(pathname, params, { peek: saved.data.key }) as Route, {
          scroll: false,
        });
        done(true);
      }),
    );

  return (
    <div className="flex flex-col gap-8 pb-12">
      <QuickAdd
        id="records-quick-add"
        label={only ? t("quickAdd.labelKind", { kind: t(`kinds.${only}`) }) : t("quickAdd.label")}
        placeholder={t("quickAdd.hint")}
        timeZone={timeZone}
        resolve={quickAddResolver(org, { target: "record", where: { projectId }, kinds: allowed })}
        labels={{
          person: t("quickAdd.types.person"),
          tag: t("quickAdd.types.tag"),
          kind: t("quickAdd.types.kind"),
          scope: t("quickAdd.types.scope"),
          date: t("quickAdd.types.date"),
        }}
        copy={copy}
        onSubmit={submit}
      />
      {adding ? (
        <p className="xos-anim-pulse m-0 text-text-13 text-text-secondary">
          {t("quickAdd.adding", { title: adding })}
        </p>
      ) : null}
      <QuickAddAlert error={error} />
      <p role="status" className="sr-only">
        {created}
      </p>
    </div>
  );
}
