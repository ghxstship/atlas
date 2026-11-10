"use client";

import {
  DAY_TYPES,
  dayTypeSlug,
  isDayType,
  type DayType,
  type ProjectDay,
  type ShowNodeRef,
} from "@xos/data/schedule-days";
import type { ProjectRef } from "@xos/data/work";
import { Button, Drawer, IconButton, Input, Select } from "@xos/ui";
import { undoStack, type UndoResult } from "@xos/ui/undo";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ActionErrorAlert, useAction, useCopy } from "@/components/work/action-ui";
import { restoreProjectDayAction, saveProjectDaysAction } from "./depth-actions";

/** Where a segment happens: at a venue, at one of the project's Show nodes, or at a place named in words. */
type PlaceKind = "venue" | "show" | "location";

interface Draft {
  readonly key: string;
  readonly id?: string;
  readonly sortOrder?: number;
  dayType: DayType;
  label: string;
  place: PlaceKind;
  venueId: string;
  scopeNodeId: string;
  locationText: string;
  timeZone: string;
  teamCode: string;
}

const ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")];

function draftOf(d: ProjectDay): Draft {
  return {
    key: d.id,
    id: d.id,
    sortOrder: d.sortOrder,
    dayType: d.dayType,
    label: d.label ?? "",
    place: d.scopeNodeId ? "show" : d.venueId ? "venue" : "location",
    venueId: d.venueId ?? "",
    scopeNodeId: d.scopeNodeId ?? "",
    locationText: d.locationText ?? "",
    timeZone: d.storedTimeZone ?? "",
    teamCode: d.teamCode ?? "",
  };
}

/**
 * The day editor (B4, G-38), loaded when a day is opened: a date's segments, each with its type, label, place (a
 * venue, a Show node of the project or a place named in words), time zone (only where no venue sets one) and team.
 * "Split day" adds a segment, up to four. Saving writes the segments and moves removed ones to Trash, with Undo.
 * From here the day opens as a grid, is saved as a template or takes one.
 */
export function DayEditor({
  org,
  project,
  projects,
  day,
  segments,
  venues,
  shows,
  teams,
  canWrite,
  canTemplate,
  canSaveTemplate,
  onClose,
  onOpen,
}: {
  org: string;
  project: ProjectRef;
  projects: readonly ProjectRef[];
  day: string;
  segments: readonly ProjectDay[];
  venues: readonly { id: string; name: string; timeZone: string }[];
  shows: readonly ShowNodeRef[];
  teams: readonly { code: string; name: string }[];
  canWrite: boolean;
  canTemplate: boolean;
  canSaveTemplate: boolean;
  onClose: () => void;
  onOpen: (changes: Record<string, string | null>) => void;
}) {
  const t = useCopy("schedule");
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [projectId, setProjectId] = useState(project.id);
  const [date, setDate] = useState(day);
  const [rows, setRows] = useState<Draft[]>(() =>
    segments.length > 0
      ? [...segments].sort((a, b) => a.sortOrder - b.sortOrder).map(draftOf)
      : [blank(0)],
  );
  const [removed, setRemoved] = useState<string[]>([]);
  const [said, setSaid] = useState("");
  const isNew = segments.length === 0;
  const chosen = projects.find((p) => p.id === projectId) ?? project;
  const ref = `${chosen.key}:${date}`;

  function blank(n: number): Draft {
    return {
      key: `new-${n}-${Date.now()}`,
      dayType: "Show",
      label: "",
      place: "location",
      venueId: "",
      scopeNodeId: "",
      locationText: "",
      timeZone: "",
      teamCode: "",
    };
  }
  const update = (key: string, change: Partial<Draft>) =>
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const remove = (r: Draft) => {
    setRows((list) => list.filter((x) => x.key !== r.key));
    if (r.id) setRemoved((ids) => [...ids, r.id as string]);
  };
  const venueZone = (r: Draft) =>
    r.place === "venue"
      ? venues.find((v) => v.id === r.venueId)?.timeZone
      : r.place === "show"
        ? venues.find((v) => v.id === shows.find((s) => s.id === r.scopeNodeId)?.venueId)?.timeZone
        : undefined;
  const typeName = (type: DayType) => t(`days.types.${dayTypeSlug(type)}`);

  const save = () =>
    run(
      () =>
        saveProjectDaysAction(org, {
          projectId,
          dayOn: date,
          removedIds: removed,
          segments: rows.map((r) => ({
            ...(r.id ? { id: r.id, sortOrder: r.sortOrder } : {}),
            dayType: r.dayType,
            label: r.label.trim() || null,
            venueId: r.place === "venue" && r.venueId ? r.venueId : null,
            scopeNodeId: r.place === "show" && r.scopeNodeId ? r.scopeNodeId : null,
            locationText: r.place === "location" ? r.locationText.trim() || null : null,
            timeZone: venueZone(r) ? null : r.timeZone || null,
            teamCode: r.teamCode || null,
          })),
        }),
      () => {
        const label = t("days.saved", { count: rows.length });
        setSaid(label);
        if (removed.length > 0) {
          const ids = [...removed];
          undoStack.push({
            label: t("days.removed", { count: ids.length }),
            undo: async (): Promise<UndoResult> => {
              for (const id of ids) {
                const restored = await restoreProjectDayAction(org, id);
                if (!restored.ok) return { ok: false, message: t("days.undoFailed") };
              }
              router.refresh();
              return { ok: true };
            },
          });
        }
        onClose();
      },
    );

  return (
    <Drawer
      title={isNew ? t("days.addTitle") : t("days.editTitle", { project: chosen.key, date })}
      open
      onOpenChange={(v) => (v ? undefined : onClose())}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("days.cancel")}
          </Button>
          {canWrite ? (
            <Button
              variant="primary"
              loading={pending}
              disabled={rows.length === 0 && removed.length === 0}
              onClick={save}
            >
              {t("days.save")}
            </Button>
          ) : null}
        </>
      }
    >
      <p className="m-0 text-text-13 text-text-secondary">{t("days.editorHelp")}</p>
      <ActionErrorAlert error={error} />
      {isNew && projects.length > 1 ? (
        <Select
          id="day-project"
          label={t("days.project")}
          value={projectId}
          options={projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
          onChange={(e) => setProjectId(e.target.value)}
        />
      ) : null}
      <Input
        id="day-date"
        type="date"
        label={t("days.date")}
        value={date}
        readOnly={!isNew}
        onChange={(e) => setDate(e.target.value)}
      />
      <ol className="m-0 flex list-none flex-col gap-16 p-0" aria-label={t("days.segments")}>
        {rows.map((r, i) => (
          <li
            key={r.key}
            className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
          >
            <div className="flex items-center justify-between gap-8">
              <h3 className="m-0 text-label-13 font-semibold">{t("days.segment", { n: i + 1 })}</h3>
              {canWrite && rows.length > 1 ? (
                <IconButton
                  icon="Trash2"
                  variant="ghost"
                  label={t("days.removeSegment", { n: i + 1 })}
                  onClick={() => remove(r)}
                />
              ) : null}
            </div>
            <div className="flex flex-wrap gap-12">
              <Select
                id={`day-type-${r.key}`}
                label={t("days.type")}
                value={r.dayType}
                disabled={!canWrite}
                options={DAY_TYPES.map((type) => ({ value: type, label: typeName(type) }))}
                onChange={(e) => {
                  if (isDayType(e.target.value)) update(r.key, { dayType: e.target.value });
                }}
              />
              <Input
                id={`day-label-${r.key}`}
                label={t("days.dayLabel")}
                help={t("days.dayLabelHelp", { type: typeName(r.dayType) })}
                value={r.label}
                maxLength={120}
                disabled={!canWrite}
                onChange={(e) => update(r.key, { label: e.target.value })}
              />
            </div>
            <div className="flex flex-wrap gap-12">
              <Select
                id={`day-place-${r.key}`}
                label={t("days.placeKind")}
                value={r.place}
                disabled={!canWrite}
                options={[
                  { value: "location", label: t("days.places.location") },
                  ...(venues.length > 0 ? [{ value: "venue", label: t("days.places.venue") }] : []),
                  ...(shows.length > 0 ? [{ value: "show", label: t("days.places.show") }] : []),
                ]}
                onChange={(e) => update(r.key, { place: e.target.value as PlaceKind })}
              />
              {r.place === "venue" ? (
                <Select
                  id={`day-venue-${r.key}`}
                  label={t("days.venue")}
                  value={r.venueId}
                  placeholder={t("days.chooseVenue")}
                  disabled={!canWrite}
                  options={venues.map((v) => ({ value: v.id, label: v.name }))}
                  onChange={(e) => update(r.key, { venueId: e.target.value })}
                />
              ) : r.place === "show" ? (
                <Select
                  id={`day-show-${r.key}`}
                  label={t("days.show")}
                  value={r.scopeNodeId}
                  placeholder={t("days.chooseShow")}
                  disabled={!canWrite}
                  options={shows.map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))}
                  onChange={(e) => update(r.key, { scopeNodeId: e.target.value })}
                />
              ) : (
                <Input
                  id={`day-location-${r.key}`}
                  label={t("days.location")}
                  placeholder={t("days.locationExample")}
                  value={r.locationText}
                  maxLength={300}
                  disabled={!canWrite}
                  onChange={(e) => update(r.key, { locationText: e.target.value })}
                />
              )}
            </div>
            <div className="flex flex-wrap gap-12">
              {venueZone(r) ? (
                <p className="m-0 text-text-13 text-text-secondary">
                  {t("days.zoneFromVenue", { zone: (venueZone(r) ?? "").replaceAll("_", " ") })}
                </p>
              ) : (
                <Select
                  id={`day-zone-${r.key}`}
                  label={t("days.zone")}
                  help={t("days.zoneHelp", { zone: chosen.timeZone.replaceAll("_", " ") })}
                  value={r.timeZone}
                  disabled={!canWrite}
                  options={[
                    { value: "", label: t("days.projectZone") },
                    ...ZONES.map((z) => ({ value: z, label: z.replaceAll("_", " ") })),
                  ]}
                  onChange={(e) => update(r.key, { timeZone: e.target.value })}
                />
              )}
              <Select
                id={`day-team-${r.key}`}
                label={t("days.team")}
                value={r.teamCode}
                disabled={!canWrite}
                options={[
                  { value: "", label: t("days.everyone") },
                  ...teams.map((team) => ({
                    value: team.code,
                    label: `${team.code} · ${team.name}`,
                  })),
                ]}
                onChange={(e) => update(r.key, { teamCode: e.target.value })}
              />
            </div>
          </li>
        ))}
      </ol>
      {canWrite ? (
        <div>
          <Button
            icon="Split"
            disabled={rows.length >= 4}
            onClick={() => setRows((list) => [...list, blank(list.length)])}
          >
            {t("days.split")}
          </Button>
          {rows.length >= 4 ? (
            <p className="m-0 mt-4 text-text-12 text-text-secondary">{t("days.splitLimit")}</p>
          ) : null}
        </div>
      ) : null}
      {!isNew ? (
        <section
          aria-labelledby="day-tools"
          className="flex flex-col gap-8 border-t border-border-subtle pt-12"
        >
          <h3 id="day-tools" className="m-0 text-label-13 font-semibold">
            {t("days.tools")}
          </h3>
          <div className="flex flex-wrap gap-8">
            <Button icon="Sheet" onClick={() => onOpen({ grid: ref })}>
              {t("grid.open")}
            </Button>
            {canSaveTemplate ? (
              <Button icon="LayoutTemplate" onClick={() => onOpen({ save: ref })}>
                {t("dayTemplates.saveDay")}
              </Button>
            ) : null}
            {canWrite && canTemplate ? (
              <Button icon="ClipboardPaste" onClick={() => onOpen({ apply: ref })}>
                {t("dayTemplates.apply")}
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {said}
      </p>
    </Drawer>
  );
}
