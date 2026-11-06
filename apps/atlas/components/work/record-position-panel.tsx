"use client";

import { Button, InlineAlert, Select } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useCallback, useEffect, useState } from "react";
import {
  assignRecordToPositionAction,
  recordPositionsAction,
  unassignRecordFromPositionAction,
  type RecordPositionsResult,
} from "@/app/[org]/crew/coverage-actions";
import { useKeepInput } from "@/components/collection-kit/keep-input";
import type { CrewActionState } from "@/lib/crew/action-state";

const INITIAL: CrewActionState = {};

/** The panel behind "Assign a position", loaded on demand: the record's positions and a picker of its project's others. */
export function RecordPositionPanel(props: { org: string; recordId: string; projectId: string }) {
  const t = useTranslations("crew.positions");
  const router = useRouter();
  const [data, setData] = useState<RecordPositionsResult | null | undefined>(undefined);
  const load = useCallback(() => {
    void recordPositionsAction(props.org, props.recordId, props.projectId).then(setData);
  }, [props.org, props.recordId, props.projectId]);
  useEffect(load, [load]);
  const [state, action, pending] = useActionState(
    async (prev: CrewActionState, form: FormData) => {
      const next = await (form.get("id")
        ? unassignRecordFromPositionAction(prev, form)
        : assignRecordToPositionAction(prev, form));
      if (next.ok) {
        load();
        router.refresh();
      }
      return next;
    },
    INITIAL,
  );
  const keep = useKeepInput(state, action, (done) => Boolean(done.ok));
  if (data === undefined) {
    return (
      <p role="status" className="m-0 text-text-13 text-text-secondary">
        {t("loading")}
      </p>
    );
  }
  if (data === null) return <InlineAlert tone="danger">{t("loadFailed")}</InlineAlert>;
  return (
    <div className="flex w-full flex-col gap-8 rounded-card border border-border-subtle p-12">
      {data.assigned.length > 0 ? (
        <ul aria-label={t("recordPositions")} className="m-0 flex list-none flex-col gap-4 p-0">
          {data.assigned.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-8">
              <span className="text-text-13">{a.title}</span>
              <form action={action} onSubmit={keep.onSubmit}>
                <input type="hidden" name="org" value={props.org} />
                <input type="hidden" name="id" value={a.id} />
                <Button type="submit" size="sm" variant="ghost" loading={pending}>
                  {t("unassignRecord", { title: a.title })}
                </Button>
              </form>
            </li>
          ))}
        </ul>
      ) : null}
      {state.error ? <InlineAlert tone="danger">{state.error}</InlineAlert> : null}
      {data.options.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("noneToAssign")}</p>
      ) : (
        <form action={action} {...keep} className="flex flex-wrap items-end gap-8">
          <input type="hidden" name="org" value={props.org} />
          <input type="hidden" name="recordId" value={props.recordId} />
          <Select
            name="positionId"
            label={t("position")}
            options={[...data.options]}
            {...(state.fieldErrors?.["positionId"] ? { error: state.fieldErrors["positionId"] } : {})}
          />
          <Button type="submit" size="sm" variant="secondary" loading={pending}>
            {t("assignRecordSubmit")}
          </Button>
        </form>
      )}
    </div>
  );
}
