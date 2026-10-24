"use client";

import { QuickAdd, type QuickAddResult } from "@xos/ui";
import type { Route } from "next";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { withQuery } from "@/components/work/format";
import { quickAddShiftAction } from "@/lib/quick-add/actions";
import { quickAddInput } from "@/lib/quick-add/fields";
import { QuickAddAlert, quickAddResolver } from "./shared";

export interface ShiftQuickAddProps {
  readonly org: string;
  /** The zone date phrases are read in: the org's, or the project's on a project tab. */
  readonly timeZone: string;
  /** The project a project tab is about; null on org-level pages. */
  readonly projectId: string | null;
}

/**
 * The inline create row of Crew > Shifts and Schedule (Section 11.7, ADR 0073): one line plans a
 * Draft shift with its role (#), person (@, an open shift without one), scope (~) and times. Saving
 * opens the new shift's peek; a refusal keeps the line so it can be corrected.
 */
export function ShiftQuickAdd({ org, timeZone, projectId }: ShiftQuickAddProps) {
  const t = useTranslations("crew.shifts.quickAdd");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [error, setError] = useState<{ key: string; detail?: string } | null>(null);
  const [created, setCreated] = useState("");

  const submit = async (result: QuickAddResult) => {
    setError(null);
    const line = quickAddInput(result);
    const saved = await quickAddShiftAction(org, {
      projectId,
      rest: line.title,
      personId: line.personId,
      tagId: line.tagId,
      scopeNodeId: line.scopeNodeId,
      when: line.when,
    });
    if (!saved.ok) {
      setError(saved.error);
      return false;
    }
    setCreated(t("created"));
    router.replace(withQuery(pathname, params, { peek: saved.data.id, full: null }) as Route, {
      scroll: false,
    });
    return true;
  };

  return (
    <div className="flex flex-col gap-8 pb-12">
      <QuickAdd
        id="shifts-quick-add"
        label={t("label")}
        placeholder={t("hint")}
        timeZone={timeZone}
        resolve={quickAddResolver(org, { target: "shift", where: { projectId } })}
        labels={{
          person: t("types.person"),
          tag: t("types.tag"),
          kind: t("types.kind"),
          scope: t("types.scope"),
          date: t("types.date"),
        }}
        onSubmit={submit}
      />
      <QuickAddAlert error={error} />
      <p role="status" className="sr-only">
        {created}
      </p>
    </div>
  );
}
