"use client";

import type { CueGridRow, CueGridSource, GridSave } from "@xos/data/schedule-grid";
import { Button, Drawer, SpreadsheetGrid, type GridColumn } from "@xos/ui";
import { parseDuration } from "@xos/ui/quick-add";
import { useLocale } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import type { ActionError } from "@/components/work/action-result";
import { ActionErrorAlert, useCopy } from "@/components/work/action-ui";
import { loadCueGridAction, saveCueGridAction } from "@/components/schedule/depth-actions";
import {
  cellOfWindow,
  normalizeTimeCell,
  readDurationCell,
  readTbcCell,
  readTimeCell,
} from "@/lib/schedule/grid-time";

type Row = Record<string, string | number | null>;

/**
 * The cue grid (B4, G-41), loaded on demand from a running order: its cues as rows of Time, Duration, Label, Segment
 * and TBC, in running order. Called cues, and every cue at or before the last called one, are listed above the grid
 * and stay as they are; the grid edits, reorders by Move up and Move down, and appends the rest, with a trailing row
 * that becomes a new cue. Save previews through app.save_cue_grid, which writes nothing; Apply writes every row or
 * none, renumbering the run densely.
 */
export function CueGrid({
  org,
  runId,
  day,
  timeZone,
  onClose,
}: {
  org: string;
  runId: string;
  day: string;
  timeZone: string;
  onClose: () => void;
}) {
  const t = useCopy("show");
  const locale = useLocale();
  const [source, setSource] = useState<CueGridSource[] | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [version, setVersion] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<GridSave | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [said, setSaid] = useState("");
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    void loadCueGridAction(org, runId).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Only the cues after the last called one are the grid's rows; the rest are listed above it as they are.
      const last = result.data.reduce((at, c, i) => (c.calledAt ? i : at), -1);
      setSource(result.data);
      setRows(
        result.data.slice(last + 1).map((c) => ({
          id: c.id,
          time: cellOfWindow({ startsAt: null, endsAt: null, dueAt: c.plannedAt }, timeZone, day),
          duration: c.durationMinutes,
          label: c.label,
          segment: c.segment,
          tbc: c.startTbc ? "TBC" : null,
        })),
      );
      setVersion((v) => v + 1);
    });
    return () => {
      live = false;
    };
  }, [org, runId, timeZone, day]);

  // Everything at or before the last called cue keeps its place, so only what follows is the grid's to change.
  const lastCalled = source ? source.reduce((at, c, i) => (c.calledAt ? i : at), -1) : -1;
  const fixed = source ? source.slice(0, lastCalled + 1) : [];

  const columns: GridColumn[] = [
    {
      key: "time",
      label: t("cueGrid.columns.time"),
      type: "time",
      editable: true,
      width: 120,
      parse: (text) => normalizeTimeCell(text, locale),
    },
    {
      key: "duration",
      label: t("cueGrid.columns.duration"),
      type: "number",
      editable: true,
      width: 100,
      parse: (text) => (text.trim() === "" ? null : (parseDuration(text) ?? text.trim())),
    },
    { key: "label", label: t("cueGrid.columns.label"), editable: true, width: 280 },
    { key: "segment", label: t("cueGrid.columns.segment"), editable: true, width: 200 },
    { key: "tbc", label: t("cueGrid.columns.tbc"), editable: true, width: 72 },
  ];

  const move = (index: number, by: -1 | 1) => {
    const target = index + by;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    const [row] = next.splice(index, 1);
    if (row) next.splice(target, 0, row);
    setRows(next);
    setVersion((v) => v + 1);
    setPreview(null);
  };

  const send = (commit: boolean) => {
    if (!source) return;
    const invalid: Record<string, string> = {};
    const grid: CueGridRow[] = [];
    rows.forEach((row, i) => {
      const id = typeof row["id"] === "string" ? row["id"] : undefined;
      const label = String(row["label"] ?? "").trim();
      if (!id && label === "" && !row["time"]) return;
      if (label === "") invalid[`${i}:label`] = t("cueGrid.badLabel");
      const when = readTimeCell(String(row["time"] ?? ""), day, timeZone, locale);
      if (!when) invalid[`${i}:time`] = t("cueGrid.badTime");
      const raw = row["duration"];
      const minutes =
        typeof raw === "number"
          ? raw
          : readDurationCell(raw === null || raw === undefined ? null : String(raw));
      if (raw !== null && raw !== undefined && raw !== "" && minutes === null)
        invalid[`${i}:duration`] = t("cueGrid.badDuration");
      const original = id ? source.find((c) => c.id === id) : undefined;
      grid.push({
        ...(id ? { id } : {}),
        label,
        plannedAt: when ? (when.dueAt ?? when.startsAt) : null,
        durationMinutes: minutes,
        segment: String(row["segment"] ?? "").trim() || null,
        startTbc: readTbcCell(row["tbc"] ?? null),
        ...(original
          ? {
              expect: {
                label: original.label,
                planned_at: original.plannedAt,
                duration_minutes: original.durationMinutes,
                segment: original.segment,
                start_tbc: original.startTbc,
              },
            }
          : {}),
      });
    });
    setError(null);
    if (Object.keys(invalid).length > 0) {
      setErrors(invalid);
      setSaid(t("cueGrid.fix", { count: Object.keys(invalid).length }));
      return;
    }
    // Every live cue is listed once: the fixed ones first, as they are, then the grid's.
    const payload: CueGridRow[] = [
      ...fixed.map((c) => ({
        id: c.id,
        label: c.label,
        plannedAt: c.plannedAt,
        durationMinutes: c.durationMinutes,
        segment: c.segment,
        startTbc: c.startTbc,
      })),
      ...grid,
    ];
    start(async () => {
      const result = await saveCueGridAction(org, { runOfShowId: runId, rows: payload, commit });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const placed: Record<string, string> = {};
      for (const r of result.data.rows) {
        const i = r.index - 1 - fixed.length;
        if (r.action === "refused" && i >= 0)
          placed[`${i}:${r.rule === "invalid" ? "duration" : "label"}`] = r.message ?? r.rule ?? "";
      }
      setErrors(placed);
      setSaid(
        t("cueGrid.preview", {
          created: result.data.created,
          changed: result.data.changed,
          refused: result.data.refused,
        }),
      );
      if (commit && result.data.refused === 0) {
        onClose();
        return;
      }
      setPreview(result.data);
    });
  };

  return (
    <Drawer
      title={t("cueGrid.title")}
      open
      onOpenChange={(v) => (v ? undefined : onClose())}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("cueGrid.close")}
          </Button>
          {preview && preview.refused === 0 ? (
            <Button variant="primary" loading={pending} onClick={() => send(true)}>
              {t("cueGrid.apply")}
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={pending}
              disabled={!source}
              onClick={() => send(false)}
            >
              {t("cueGrid.save")}
            </Button>
          )}
        </>
      }
    >
      <p className="m-0 text-text-13 text-text-secondary">
        {t("cueGrid.help", { zone: timeZone.replaceAll("_", " ") })}
      </p>
      <ActionErrorAlert error={error} />
      {fixed.length > 0 ? (
        <section aria-labelledby="cue-grid-called" className="flex flex-col gap-4">
          <h3 id="cue-grid-called" className="m-0 text-label-13 font-semibold">
            {t("cueGrid.called", { count: fixed.length })}
          </h3>
          <ol className="m-0 flex list-none flex-col gap-2 p-0 text-text-13 text-text-secondary">
            {fixed.map((c) => (
              <li key={c.id}>{t("cueGrid.calledCue", { n: c.position, label: c.label })}</li>
            ))}
          </ol>
        </section>
      ) : null}
      {source ? (
        <>
          <SpreadsheetGrid
            key={version}
            label={t("cueGrid.label")}
            columns={columns}
            rows={rows}
            appendRow
            errors={errors}
            onChange={(next) => {
              setRows(next);
              setPreview(null);
            }}
          />
          {rows.length > 1 ? (
            <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-label={t("cueGrid.order")}>
              {rows.map((row, i) => (
                <li
                  key={`${String(row["id"] ?? "new")}-${i}`}
                  className="flex items-center gap-6 text-text-13"
                >
                  <span className="flex-1 truncate">{String(row["label"] ?? "")}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="ArrowUp"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    {t("cueGrid.moveUp")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="ArrowDown"
                    disabled={i === rows.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    {t("cueGrid.moveDown")}
                  </Button>
                </li>
              ))}
            </ol>
          ) : null}
        </>
      ) : (
        <p className="m-0 text-text-13 text-text-secondary">{t("cueGrid.loading")}</p>
      )}
      {preview ? (
        <p role="status" className="m-0 text-text-13">
          {t("cueGrid.preview", {
            created: preview.created,
            changed: preview.changed,
            refused: preview.refused,
          })}
        </p>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {said}
      </p>
    </Drawer>
  );
}
