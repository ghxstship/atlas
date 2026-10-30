"use client";

import {
  applyItemAt,
  type ApplyItem,
  type DayItem,
  type DayTemplate,
} from "@xos/data/day-templates";
import type { ProjectRef } from "@xos/data/work";
import { Button, Checkbox, Drawer, Input, Select, Tag } from "@xos/ui";
import { undoStack, type UndoResult } from "@xos/ui/undo";
import { useFormatter } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { ActionError } from "@/components/work/action-result";
import { ActionErrorAlert, useAction, useCopy } from "@/components/work/action-ui";
import {
  applyDayTemplateAction,
  createDayTemplateFromDayAction,
  listDayItemsAction,
  undoDayTemplateApplicationAction,
} from "./depth-actions";
import type { RunRef } from "./days";

type Line =
  | { readonly kind: "existing"; readonly item: DayItem; readonly at: string | null }
  | { readonly kind: "proposed"; readonly item: ApplyItem; readonly at: string | null };

/**
 * Applying a day template (B4, G-42), loaded when opened: a dry run through app.apply_day_template that lays the
 * day's existing records and cues beside the template's proposed items, by time. Proposed items are ghosted and tagged
 * New; an item already on the day is tagged and unticked; overlaps are counted; every item has a checkbox. Apply
 * creates exactly the ticked items at the previewed times, and the Undo toast moves them to Trash.
 */
export function DayTemplateApply({
  org,
  project,
  day,
  templates,
  runs,
  onClose,
}: {
  org: string;
  project: ProjectRef;
  day: string;
  templates: readonly DayTemplate[];
  runs: readonly RunRef[];
  onClose: () => void;
}) {
  const t = useCopy("schedule");
  const format = useFormatter();
  const router = useRouter();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [runId, setRunId] = useState(runs.length === 1 ? (runs[0]?.id ?? "") : "");
  const [items, setItems] = useState<ApplyItem[] | null>(null);
  const [existing, setExisting] = useState<DayItem[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<ActionError | null>(null);
  const [said, setSaid] = useState("");
  const [pending, start] = useTransition();
  const needsRun = runs.length > 1 && runId === "";

  useEffect(() => {
    if (!templateId || needsRun) return;
    let live = true;
    start(async () => {
      const [preview, onDay] = await Promise.all([
        applyDayTemplateAction(org, {
          templateId,
          projectId: project.id,
          day,
          runOfShowId: runId || null,
          skipItemIds: [],
          includeDuplicates: false,
          commit: false,
        }),
        listDayItemsAction(org, { projectId: project.id, day, timeZone: project.timeZone }),
      ]);
      if (!live) return;
      if (!preview.ok) {
        setError(preview.error);
        setItems(null);
        return;
      }
      setError(null);
      setItems(preview.data);
      setExisting(onDay.ok ? onDay.data : []);
      setTicked(new Set(preview.data.filter((i) => i.action === "create").map((i) => i.itemId)));
    });
    return () => {
      live = false;
    };
  }, [org, templateId, runId, needsRun, project.id, project.timeZone, day]);

  const time = (at: string | null) =>
    at
      ? format.dateTime(new Date(at), {
          hour: "numeric",
          minute: "2-digit",
          timeZone: project.timeZone,
        })
      : t("dayTemplates.noTime");
  const lines: Line[] = [
    ...existing.map((item) => ({ kind: "existing" as const, item, at: item.at })),
    ...(items ?? []).map((item) => ({ kind: "proposed" as const, item, at: applyItemAt(item) })),
  ].sort((a, b) => Date.parse(a.at ?? "9999-12-31") - Date.parse(b.at ?? "9999-12-31"));
  const choosable = (i: ApplyItem) =>
    i.action === "create" || i.action === "skip_duplicate" || i.action === "skip_chosen";
  const count = items?.filter((i) => ticked.has(i.itemId)).length ?? 0;
  const overlaps = items?.filter((i) => ticked.has(i.itemId) && i.overlaps > 0).length ?? 0;

  const apply = () => {
    if (!items) return;
    const duplicatesTicked = items.some(
      (i) => i.action === "skip_duplicate" && ticked.has(i.itemId),
    );
    const skip = items.filter((i) => choosable(i) && !ticked.has(i.itemId)).map((i) => i.itemId);
    start(async () => {
      const result = await applyDayTemplateAction(org, {
        templateId,
        projectId: project.id,
        day,
        runOfShowId: runId || null,
        skipItemIds: skip,
        includeDuplicates: duplicatesTicked,
        commit: true,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const created = result.data.filter((i) => i.action === "create" && i.createdId);
      const label = t("dayTemplates.applied", { count: created.length });
      setSaid(label);
      undoStack.push({
        label,
        undo: async (): Promise<UndoResult> => {
          const undone = await undoDayTemplateApplicationAction(
            org,
            created.map((i) => ({ kind: i.kind, createdId: i.createdId })),
          );
          if (!undone.ok) return { ok: false, message: t("dayTemplates.undoFailed") };
          router.refresh();
          return { ok: true };
        },
      });
      onClose();
    });
  };

  return (
    <Drawer
      title={t("dayTemplates.applyTitle", { project: project.key, date: day })}
      open
      onOpenChange={(v) => (v ? undefined : onClose())}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("dayTemplates.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!items || count === 0}
            onClick={apply}
          >
            {t("dayTemplates.applyButton", { count })}
          </Button>
        </>
      }
    >
      <p className="m-0 text-text-13 text-text-secondary">{t("dayTemplates.applyHelp")}</p>
      <div className="flex flex-wrap gap-12">
        <Select
          id="apply-template"
          label={t("dayTemplates.template")}
          value={templateId}
          options={templates.map((tpl) => ({ value: tpl.id, label: tpl.name }))}
          onChange={(e) => setTemplateId(e.target.value)}
        />
        {runs.length > 1 ? (
          <Select
            id="apply-run"
            label={t("dayTemplates.run")}
            help={t("dayTemplates.runHelp")}
            value={runId}
            placeholder={t("dayTemplates.chooseRun")}
            options={runs.map((r) => ({ value: r.id, label: r.name }))}
            onChange={(e) => setRunId(e.target.value)}
          />
        ) : null}
      </div>
      <ActionErrorAlert error={error} />
      {items ? (
        <>
          <p role="status" className="m-0 text-text-13">
            {t("dayTemplates.summary", { count, overlaps })}
          </p>
          <ol
            className="m-0 flex list-none flex-col p-0"
            aria-label={t("dayTemplates.dayLabel", { date: day })}
          >
            {lines.map((line) =>
              line.kind === "existing" ? (
                <li
                  key={`e-${line.item.id}`}
                  className="flex items-center gap-8 border-b border-border-subtle py-6 text-text-13"
                >
                  <span className="w-(--space-80) flex-none tabular-nums text-text-secondary">
                    {time(line.at)}
                  </span>
                  <span className="truncate">{line.item.label}</span>
                  <Tag>
                    {line.item.kind === "Cue"
                      ? t("dayTemplates.existingCue")
                      : t("dayTemplates.existingRecord")}
                  </Tag>
                </li>
              ) : (
                <li
                  key={`p-${line.item.itemId}`}
                  className="flex items-center gap-8 border-b border-dashed border-border-subtle py-6 text-text-13 opacity-80"
                >
                  <span className="w-(--space-80) flex-none tabular-nums text-text-secondary">
                    {time(line.at)}
                  </span>
                  <Checkbox
                    id={`apply-${line.item.itemId}`}
                    label={line.item.name}
                    checked={ticked.has(line.item.itemId)}
                    disabled={!choosable(line.item)}
                    onChange={(e) =>
                      setTicked((set) => {
                        const next = new Set(set);
                        if (e.target.checked) next.add(line.item.itemId);
                        else next.delete(line.item.itemId);
                        return next;
                      })
                    }
                  />
                  <Tag tone="accent">{t("dayTemplates.new")}</Tag>
                  {line.item.action === "skip_duplicate" ? (
                    <Tag>{t("dayTemplates.duplicate")}</Tag>
                  ) : null}
                  {line.item.action === "skip_no_running_order" ? (
                    <Tag>{t("dayTemplates.noRun")}</Tag>
                  ) : null}
                  {line.item.overlaps > 0 ? (
                    <Tag tone="warning">
                      {t("dayTemplates.overlaps", { count: line.item.overlaps })}
                    </Tag>
                  ) : null}
                </li>
              ),
            )}
          </ol>
        </>
      ) : needsRun ? (
        <p className="m-0 text-text-13">{t("dayTemplates.runHelp")}</p>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {said}
      </p>
    </Drawer>
  );
}

/** Saving a project day as a day template (B4, G-42), with times kept relative to local midnight. */
export function DayTemplateSave({
  org,
  project,
  day,
  runs,
  onClose,
}: {
  org: string;
  project: ProjectRef;
  day: string;
  runs: readonly RunRef[];
  onClose: () => void;
}) {
  const t = useCopy("schedule");
  const { pending, error, run } = useAction();
  const [name, setName] = useState("");
  const [runId, setRunId] = useState(runs.length === 1 ? (runs[0]?.id ?? "") : "");
  const [said, setSaid] = useState("");
  return (
    <Drawer
      title={t("dayTemplates.saveTitle", { project: project.key, date: day })}
      open
      onOpenChange={(v) => (v ? undefined : onClose())}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("dayTemplates.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={name.trim() === "" || (runs.length > 1 && runId === "")}
            onClick={() =>
              run(
                () =>
                  createDayTemplateFromDayAction(org, {
                    projectId: project.id,
                    day,
                    name,
                    runOfShowId: runId || null,
                  }),
                () => {
                  setSaid(t("dayTemplates.savedDay", { name: name.trim() }));
                  onClose();
                },
              )
            }
          >
            {t("dayTemplates.saveButton")}
          </Button>
        </>
      }
    >
      <p className="m-0 text-text-13 text-text-secondary">{t("dayTemplates.saveHelp")}</p>
      <ActionErrorAlert error={error} />
      <Input
        id="day-template-name"
        label={t("dayTemplates.name")}
        placeholder={t("dayTemplates.nameExample")}
        width="100%"
        maxLength={200}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      {runs.length > 1 ? (
        <Select
          id="save-run"
          label={t("dayTemplates.run")}
          value={runId}
          placeholder={t("dayTemplates.chooseRun")}
          options={runs.map((r) => ({ value: r.id, label: r.name }))}
          onChange={(e) => setRunId(e.target.value)}
        />
      ) : null}
      <p aria-live="polite" className="sr-only">
        {said}
      </p>
    </Drawer>
  );
}
