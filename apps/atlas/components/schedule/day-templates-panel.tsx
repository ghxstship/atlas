"use client";

import type { DayTemplate, DayTemplateItem } from "@xos/data/day-templates";
import { minuteClock } from "@xos/data/day-templates";
import { Button, IconButton, Input, Link, Select } from "@xos/ui";
import { undoStack } from "@xos/ui/undo";
import type { Route } from "next";
import { useState } from "react";
import { ActionErrorAlert, useAction, useCopy } from "@/components/work/action-ui";
import {
  deleteDayTemplateAction,
  deleteDayTemplateItemAction,
  restoreDayTemplateAction,
  saveDayTemplateItemAction,
} from "./depth-actions";
import { parseTimeShorthand, parseDuration } from "@xos/ui/quick-add";

/**
 * The day templates of Projects > Templates (B4, G-42): the list, the chosen template's items in start order, adding
 * an item (a record with its kind, or a cue with its segment, at a time of the day) and removing items or the template
 * to Trash, with Undo.
 */
export function DayTemplatesPanel({
  org,
  templates,
  loadFailed,
  current,
  items,
  canEdit,
}: {
  org: string;
  templates: readonly DayTemplate[];
  loadFailed: boolean;
  current: DayTemplate | null;
  items: readonly DayTemplateItem[];
  canEdit: boolean;
}) {
  const t = useCopy("schedule");
  const { pending, error, run } = useAction();
  const [kind, setKind] = useState<"Record" | "Cue">("Record");
  const [name, setName] = useState("");
  const [recordKind, setRecordKind] = useState("Task");
  const [time, setTime] = useState("");
  const [length, setLength] = useState("");
  const [segment, setSegment] = useState("");
  const clock = (minute: number) => {
    const c = minuteClock(minute);
    return c.dayOffset === 0
      ? c.time
      : t(c.dayOffset > 0 ? "dayTemplates.nextDay" : "dayTemplates.dayBefore", { time: c.time });
  };
  const at = parseTimeShorthand(time);
  const startMinute = at ? Number(at.start.slice(0, 2)) * 60 + Number(at.start.slice(3, 5)) : null;
  const minutes = length.trim() === "" ? null : parseDuration(length);
  const valid =
    name.trim() !== "" && startMinute !== null && (length.trim() === "" || minutes !== null);

  return (
    <section
      id="day-templates"
      aria-labelledby="day-templates-title"
      className="flex flex-col gap-12"
    >
      <h2 id="day-templates-title" className="m-0 text-heading-16 font-semibold">
        {t("dayTemplates.title")}
      </h2>
      <p className="m-0 max-w-layout-reading text-text-13 text-text-secondary">
        {t("dayTemplates.sentence")}
      </p>
      {loadFailed ? (
        <p className="m-0 text-text-13 text-danger-text">{t("dayTemplates.loadFailed")}</p>
      ) : null}
      {templates.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("dayTemplates.empty")}</p>
      ) : (
        <ul
          className="m-0 flex list-none flex-col gap-8 p-0"
          aria-label={t("dayTemplates.listLabel")}
        >
          {templates.map((tpl) => (
            <li key={tpl.id}>
              <Link
                href={`/${org}/projects/templates?dayTemplate=${tpl.id}#day-templates` as Route}
                aria-current={tpl.id === current?.id ? "true" : undefined}
              >
                {tpl.name}
              </Link>{" "}
              <span className="text-text-12 text-text-secondary">
                {t("dayTemplates.itemCount", { count: tpl.itemCount })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {current ? (
        <article
          aria-labelledby="day-template-name"
          className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
        >
          <header className="flex flex-wrap items-center justify-between gap-8">
            <h3 id="day-template-name" className="m-0 text-text-15 font-semibold">
              {current.name}
            </h3>
            {canEdit ? (
              <Button
                size="sm"
                variant="ghost"
                icon="Trash2"
                loading={pending}
                onClick={() =>
                  run(
                    () => deleteDayTemplateAction(org, current.id),
                    () =>
                      undoStack.push({
                        label: t("dayTemplates.deleted", { name: current.name }),
                        undo: async () => {
                          const restored = await restoreDayTemplateAction(org, current.id);
                          return restored.ok
                            ? { ok: true }
                            : { ok: false, message: t("dayTemplates.undoFailed") };
                        },
                      }),
                  )
                }
              >
                {t("dayTemplates.delete")}
              </Button>
            ) : null}
          </header>
          <ActionErrorAlert error={error} />
          {items.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("dayTemplates.noItems")}</p>
          ) : (
            <ol
              className="m-0 flex list-none flex-col gap-4 p-0 text-text-13"
              aria-label={t("dayTemplates.items")}
            >
              {items.map((i) => (
                <li key={i.id} className="flex items-center gap-8">
                  <span className="w-(--space-96) flex-none tabular-nums text-text-secondary">
                    {clock(i.startMinute)}
                  </span>
                  <span className="flex-1">
                    {i.name}{" "}
                    <span className="text-text-12 text-text-secondary">
                      {i.kind === "Record"
                        ? t("dayTemplates.recordItem", { kind: i.recordKind ?? "" })
                        : t("dayTemplates.cueItem", {
                            segment: i.segment ?? t("dayTemplates.noSegment"),
                          })}
                      {i.durationMinutes !== null
                        ? ` · ${t("dayTemplates.minutes", { n: i.durationMinutes })}`
                        : ""}
                    </span>
                  </span>
                  {canEdit ? (
                    <IconButton
                      icon="Trash2"
                      variant="ghost"
                      label={t("dayTemplates.removeItem", { name: i.name })}
                      onClick={() => run(() => deleteDayTemplateItemAction(org, i.id))}
                    />
                  ) : null}
                </li>
              ))}
            </ol>
          )}
          {canEdit ? (
            <form
              className="flex flex-wrap items-end gap-8"
              onSubmit={(e) => {
                e.preventDefault();
                if (!valid || startMinute === null) return;
                run(
                  () =>
                    saveDayTemplateItemAction(org, {
                      templateId: current.id,
                      kind,
                      sortOrder: Math.min(500, items.length + 1),
                      name: name.trim(),
                      recordKind: kind === "Record" ? recordKind : null,
                      xyz: kind === "Record" ? "Y" : null,
                      startMinute,
                      durationMinutes: minutes,
                      segment: kind === "Cue" ? segment.trim() || null : null,
                      startTbc: false,
                    }),
                  () => {
                    setName("");
                    setTime("");
                    setLength("");
                    setSegment("");
                  },
                );
              }}
            >
              <Select
                id="day-item-kind"
                label={t("dayTemplates.itemKind")}
                value={kind}
                options={[
                  { value: "Record", label: t("dayTemplates.kinds.record") },
                  { value: "Cue", label: t("dayTemplates.kinds.cue") },
                ]}
                onChange={(e) => setKind(e.target.value === "Cue" ? "Cue" : "Record")}
              />
              <Input
                id="day-item-name"
                label={t("dayTemplates.itemName")}
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
              />
              {kind === "Record" ? (
                <Input
                  id="day-item-record-kind"
                  label={t("dayTemplates.recordKind")}
                  width={140}
                  value={recordKind}
                  onChange={(e) => setRecordKind(e.target.value)}
                />
              ) : (
                <Input
                  id="day-item-segment"
                  label={t("dayTemplates.segment")}
                  width={180}
                  value={segment}
                  maxLength={200}
                  onChange={(e) => setSegment(e.target.value)}
                />
              )}
              <Input
                id="day-item-time"
                label={t("dayTemplates.time")}
                help={t("dayTemplates.timeHelp")}
                width={120}
                value={time}
                {...(time !== "" && startMinute === null
                  ? { error: t("dayTemplates.badTime") }
                  : {})}
                onChange={(e) => setTime(e.target.value)}
              />
              <Input
                id="day-item-length"
                label={t("dayTemplates.length")}
                help={t("dayTemplates.lengthHelp")}
                width={120}
                value={length}
                {...(length !== "" && minutes === null
                  ? { error: t("dayTemplates.badLength") }
                  : {})}
                onChange={(e) => setLength(e.target.value)}
              />
              <Button type="submit" variant="primary" loading={pending} disabled={!valid}>
                {t("dayTemplates.addItem")}
              </Button>
            </form>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}
