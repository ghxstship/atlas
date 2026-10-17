"use client";

import { Button, Input, Select } from "@xos/ui";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useActionState, useCallback, useState } from "react";
import { restoreAction } from "@/app/[org]/trash/actions";
import { INITIAL_STATE, type WorkflowActionState } from "@/lib/workflow/state";
import { Feedback, usePageStatus, useWorkflowT } from "./kit";

/** Restore one row; the outcome (rows restored, or why not) shows beside the button. */
export function RestoreButton({
  org,
  table,
  id,
  title,
}: {
  org: string;
  table: string;
  id: string;
  title: string;
}) {
  const t = useWorkflowT();
  const pageStatus = usePageStatus();
  // The restored row leaves Trash on revalidation, so success is announced in the page's status
  // region (finding A24-001); refusals stay beside the button, whose row is still there.
  const restoring = useCallback(
    async (previous: WorkflowActionState, form: FormData) => {
      const next = await restoreAction(previous, form);
      if (next.ok && pageStatus) pageStatus(t("trash.restored", { count: Number(next.id ?? 1) }));
      return next;
    },
    [pageStatus, t],
  );
  const [state, action, pending] = useActionState(restoring, INITIAL_STATE);
  return (
    <form action={action} className="flex flex-col items-end gap-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="table" value={table} />
      <input type="hidden" name="id" value={id} />
      <Button
        type="submit"
        size="sm"
        loading={pending}
        aria-label={t("trash.restoreNamed", { title })}
      >
        {t("trash.restore")}
      </Button>
      <div aria-live="polite">
        <Feedback
          state={state}
          {...(pageStatus
            ? {}
            : { success: t("trash.restored", { count: Number(state.id ?? 1) }) })}
        />
      </div>
    </form>
  );
}

/** Filter by kind of row and title; both live in the query string. */
export function TrashFilters({
  tables,
  table,
  q,
}: {
  tables: readonly string[];
  table: string | null;
  q: string | null;
}) {
  const t = useWorkflowT();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [text, setText] = useState(q ?? "");
  const go = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const s = next.toString();
    router.replace((s ? `${pathname}?${s}` : pathname) as Route, { scroll: false });
  };
  return (
    <form
      role="search"
      aria-label={t("trash.filters")}
      className="flex flex-wrap items-end gap-8"
      onSubmit={(e) => {
        e.preventDefault();
        go({ q: text.trim() });
      }}
    >
      <Select
        label={t("trash.kind")}
        value={table ?? ""}
        options={[
          { value: "", label: t("trash.allKinds") },
          ...tables.map((x) => ({ value: x, label: x })),
        ]}
        onChange={(e) => go({ table: e.target.value })}
      />
      <Input
        type="search"
        label={t("trash.search")}
        value={text}
        placeholder={t("trash.searchHint")}
        onChange={(e) => setText(e.target.value)}
      />
      <Button type="submit">{t("trash.apply")}</Button>
    </form>
  );
}
