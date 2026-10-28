"use client";

import type { Actual, Dependency } from "@xos/data/schedule";
import type { ProjectRef, RecordSummary } from "@xos/data/work";
import { Button, Drawer, IconButton, Input, Select } from "@xos/ui";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useRecordKeyHovers } from "@/components/hover/use-hover-cards";
import { ActionErrorAlert, useAction, useCopy } from "@/components/work/action-ui";
import { fromLocalInput, toLocalInput, withQuery } from "@/components/work/format";
import {
  addDependencyAction,
  captureBaselineAction,
  removeDependencyAction,
  setActualAction,
} from "./actions";

const TYPES = ["Finish to Start", "Start to Start", "Finish to Finish", "Start to Finish"] as const;

/**
 * A record's predecessors and successors, with a form to add a predecessor of the same project. Each
 * related record's key previews it after 400 ms (Section 11.7).
 */
export function DependencyEditor({
  org,
  record,
  dependencies,
  candidates,
  canEdit,
}: {
  org: string;
  record: RecordSummary;
  dependencies: readonly Dependency[];
  /** Other records of the record's project, by id. */
  candidates: readonly RecordSummary[];
  canEdit: boolean;
}) {
  const t = useCopy("schedule");
  const { pending, error, run } = useAction();
  const [predecessor, setPredecessor] = useState("");
  const [type, setType] = useState<string>(TYPES[0]);
  const [lag, setLag] = useState("0");
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const name = (id: string) => {
    const r = byId.get(id);
    return r ? `${r.key} ${r.title}` : t("dependencies.hidden");
  };
  const hover = useRecordKeyHovers(org);
  const before = dependencies.filter((d) => d.successorId === record.id);
  const after = dependencies.filter((d) => d.predecessorId === record.id);
  const row = (d: Dependency, other: string) => (
    <li key={d.id} className="flex items-center justify-between gap-8 text-text-13">
      <span>
        <span
          {...(byId.has(other) ? { "data-item": byId.get(other)?.key, "data-column": "key" } : {})}
        >
          {name(other)}
        </span>{" "}
        <span className="text-text-secondary">· {t(`dependencies.types.${d.type}`)}</span>
      </span>
      {canEdit ? (
        <IconButton
          icon="X"
          label={t("dependencies.remove", { name: name(other) })}
          onClick={() => run(() => removeDependencyAction(org, d.id))}
        />
      ) : null}
    </li>
  );
  return (
    <section
      aria-labelledby={`deps-${record.id}`}
      className="flex flex-col gap-8"
      {...hover.hoverProps}
    >
      <h3 id={`deps-${record.id}`} className="m-0 text-label-13 font-semibold">
        {t("dependencies.title")}
      </h3>
      <ActionErrorAlert error={error} />
      <div className="grid grid-cols-2 gap-12 max-sm:grid-cols-1">
        <div className="flex flex-col gap-4">
          <h4 className="m-0 text-text-12 font-medium text-text-secondary">
            {t("dependencies.before")}
          </h4>
          {before.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("dependencies.noneBefore")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-4 p-0">
              {before.map((d) => row(d, d.predecessorId))}
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-4">
          <h4 className="m-0 text-text-12 font-medium text-text-secondary">
            {t("dependencies.after")}
          </h4>
          {after.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("dependencies.noneAfter")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-4 p-0">
              {after.map((d) => row(d, d.successorId))}
            </ul>
          )}
        </div>
      </div>
      {canEdit && candidates.length > 0 ? (
        <form
          className="flex flex-wrap items-end gap-8"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () =>
                addDependencyAction(org, {
                  predecessorId: predecessor,
                  successorId: record.id,
                  type,
                  lagMinutes: Math.round(Number(lag) * 60) || 0,
                }),
              () => setPredecessor(""),
            );
          }}
        >
          <Select
            key={`pred-${dependencies.length}`}
            id={`dep-pred-${record.id}`}
            label={t("dependencies.predecessor")}
            value=""
            placeholder={t("dependencies.choose")}
            options={candidates.map((c) => ({ value: c.id, label: `${c.key} ${c.title}` }))}
            onChange={(e) => setPredecessor(e.target.value)}
          />
          <Select
            id={`dep-type-${record.id}`}
            label={t("dependencies.type")}
            value={type}
            options={TYPES.map((x) => ({ value: x, label: t(`dependencies.types.${x}`) }))}
            onChange={(e) => setType(e.target.value)}
          />
          <Input
            id={`dep-lag-${record.id}`}
            type="number"
            step="0.5"
            width={96}
            label={t("dependencies.lag")}
            value={lag}
            onChange={(e) => setLag(e.target.value)}
          />
          <Button type="submit" disabled={predecessor === ""} loading={pending}>
            {t("dependencies.add")}
          </Button>
        </form>
      ) : null}
      {hover.card}
    </section>
  );
}

/** When the record actually started and finished. */
export function ActualsForm({
  org,
  record,
  actual,
  canEdit,
}: {
  org: string;
  record: RecordSummary;
  actual: Actual | null;
  canEdit: boolean;
}) {
  const t = useCopy("schedule");
  const tz = record.timeZone ?? record.projectTimeZone;
  const { pending, error, run } = useAction();
  const [started, setStarted] = useState(toLocalInput(actual?.startedAt ?? null, tz));
  const [finished, setFinished] = useState(toLocalInput(actual?.finishedAt ?? null, tz));
  return (
    <form
      aria-label={t("actuals.title")}
      className="flex flex-col gap-8"
      onSubmit={(e) => {
        e.preventDefault();
        run(() =>
          setActualAction(org, {
            recordId: record.id,
            startedAt: fromLocalInput(started, tz),
            finishedAt: fromLocalInput(finished, tz),
          }),
        );
      }}
    >
      <h3 className="m-0 text-label-13 font-semibold">{t("actuals.title")}</h3>
      <ActionErrorAlert error={error} />
      <div className="flex flex-wrap items-end gap-8">
        <Input
          id={`actual-start-${record.id}`}
          type="datetime-local"
          label={t("actuals.started")}
          value={started}
          disabled={!canEdit}
          onChange={(e) => setStarted(e.target.value)}
        />
        <Input
          id={`actual-end-${record.id}`}
          type="datetime-local"
          label={t("actuals.finished")}
          value={finished}
          disabled={!canEdit}
          onChange={(e) => setFinished(e.target.value)}
        />
        {canEdit ? (
          <Button type="submit" loading={pending}>
            {t("actuals.save")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** Captures a baseline of one project: every dated record's planned window, locked at once. */
export function CaptureBaselineDialog({
  org,
  projects,
  defaultProjectId,
  open,
}: {
  org: string;
  projects: readonly ProjectRef[];
  defaultProjectId: string | null;
  open: boolean;
}) {
  const t = useCopy("schedule");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { pending, error, run } = useAction();
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState(defaultProjectId ?? projects[0]?.id ?? "");
  const setOpen = (value: boolean) =>
    router.replace(withQuery(pathname, params, { create: value ? "1" : null }) as Route, {
      scroll: false,
    });
  return (
    <>
      <Button variant="primary" icon="Camera" onClick={() => setOpen(true)}>
        {t("baselines.capture")}
      </Button>
      {open ? (
        <Drawer
          title={t("baselines.captureTitle")}
          open
          onOpenChange={(v) => (v ? undefined : setOpen(false))}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t("baselines.cancel")}
              </Button>
              <Button
                variant="primary"
                loading={pending}
                disabled={name.trim() === "" || projectId === ""}
                onClick={() =>
                  run(
                    () => captureBaselineAction(org, { projectId, name }),
                    (data) =>
                      router.replace(
                        withQuery(pathname, params, { create: null, peek: data.id }) as Route,
                        { scroll: false },
                      ),
                  )
                }
              >
                {t("baselines.captureButton")}
              </Button>
            </>
          }
        >
          <p className="m-0 text-text-13 text-text-secondary">{t("baselines.captureHelp")}</p>
          <ActionErrorAlert error={error} />
          {projects.length > 1 ? (
            <Select
              id="baseline-project"
              label={t("baselines.project")}
              value={projectId}
              options={projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
              onChange={(e) => setProjectId(e.target.value)}
            />
          ) : null}
          <Input
            id="baseline-name"
            label={t("baselines.name")}
            placeholder={t("baselines.nameExample")}
            width="100%"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Drawer>
      ) : null}
    </>
  );
}
