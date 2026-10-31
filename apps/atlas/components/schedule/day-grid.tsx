"use client";

import type { DayGridRow, GridSave } from "@xos/data/schedule-grid";
import { Button, Drawer, parseQuickAdd, SpreadsheetGrid, type GridColumn } from "@xos/ui";
import { zonedInstant } from "@xos/ui/quick-add";
import { useLocale } from "next-intl";
import { useMemo, useState, useTransition } from "react";
import type { ActionError } from "@/components/work/action-result";
import { ActionErrorAlert, useCopy } from "@/components/work/action-ui";
import {
  cellOfWindow,
  normalizeTimeCell,
  readTbcCell,
  readTimeCell,
} from "@/lib/schedule/grid-time";
import { saveDayGridAction } from "./depth-actions";
import type { DayGridSource } from "./days";

type Cell = string | number | null;
type Row = Record<string, Cell>;

/** Two stored or typed instants that name the same moment (the database and the browser spell them differently). */
function sameInstant(a: string | null, b: string | null): boolean {
  return a === null || b === null ? a === b : Date.parse(a) === Date.parse(b);
}

/** Which column a refusal belongs to, so it shows on the cell that caused it. */
function refusalColumn(rule: string | null): string {
  if (rule === "record_title_grammar" || rule === "invalid") return "title";
  if (rule === "grid_kind" || rule === "record_kind_immutable") return "kind";
  return "time";
}

/**
 * The day grid (B4, G-41), loaded on demand: a project day's records as rows of Time, Title, Kind, Owner and TBC.
 * Tab and Shift+Tab move across cells, Enter commits and moves down, and typing in the last row adds a record. Time
 * reads shorthand (8a-10:30a, 830p, 20:30; es 8 a. m., 20 h) on the project's wall clock, an end before the start
 * rolling to the next day, and falls back to quick add's date reading. Save previews the whole grid through
 * app.save_day_grid, which writes nothing; Apply writes every row or none, with refusals in place.
 */
export function DayGrid({
  org,
  source,
  kinds,
  people,
  canWrite,
  onClose,
}: {
  org: string;
  source: DayGridSource;
  kinds: readonly { kind: string; recordClass: string }[];
  people: readonly { id: string; name: string | null }[];
  canWrite: boolean;
  onClose: () => void;
}) {
  const t = useCopy("schedule");
  const locale = useLocale();
  const zone = source.project.timeZone;
  const [pending, start] = useTransition();
  const [error, setError] = useState<ActionError | null>(null);
  const [preview, setPreview] = useState<GridSave | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [said, setSaid] = useState("");
  const loaded = useMemo<Row[]>(
    () =>
      source.records.map((r) => ({
        id: r.id,
        time: cellOfWindow(r, zone),
        title: r.title,
        kind: r.kind,
        owner: r.ownerName,
        tbc: r.startTbc ? "TBC" : null,
      })),
    [source.records, zone],
  );
  const [rows, setRows] = useState<Row[]>(loaded);

  const columns: GridColumn[] = [
    {
      key: "time",
      label: t("grid.columns.time"),
      type: "time",
      editable: canWrite,
      width: 160,
      parse: (text) => normalizeTimeCell(text, locale),
    },
    { key: "title", label: t("grid.columns.title"), editable: canWrite, width: 320 },
    { key: "kind", label: t("grid.columns.kind"), editable: canWrite, width: 140 },
    { key: "owner", label: t("grid.columns.owner"), editable: canWrite, width: 180 },
    { key: "tbc", label: t("grid.columns.tbc"), editable: canWrite, width: 72 },
  ];

  // Quick add's date reading, for a Time cell that is not shorthand: the grid's day at noon, on the project's clock.
  const quickAdd = (text: string) =>
    parseQuickAdd(text, {
      referenceDate: new Date(zonedInstant(source.day, "12:00", zone)),
      timeZone: zone,
      locale,
    });

  /** The rows to send and the cells that do not read, keyed "row:col". */
  const build = (): {
    payload: DayGridRow[];
    indexes: number[];
    invalid: Record<string, string>;
  } => {
    const payload: DayGridRow[] = [];
    const indexes: number[] = [];
    const invalid: Record<string, string> = {};
    rows.forEach((row, i) => {
      const id = typeof row["id"] === "string" ? row["id"] : undefined;
      const original = id ? source.records.find((r) => r.id === id) : undefined;
      const title = String(row["title"] ?? "").trim();
      const empty = !id && title === "" && !row["time"] && !row["kind"];
      if (empty) return;
      const when = readTimeCell(String(row["time"] ?? ""), source.day, zone, locale, quickAdd);
      if (!when) invalid[`${i}:time`] = t("grid.badTime");
      const kindText = String(row["kind"] ?? "")
        .trim()
        .toLowerCase();
      const kind = kinds.find((k) => k.kind.toLowerCase() === kindText)?.kind;
      if (!id && !kind) invalid[`${i}:kind`] = t("grid.badKind");
      const ownerText = String(row["owner"] ?? "")
        .trim()
        .replace(/^@/, "")
        .toLowerCase();
      const owner =
        ownerText === ""
          ? null
          : (people.find((p) => (p.name ?? "").toLowerCase() === ownerText) ??
            people.find((p) => (p.name ?? "").toLowerCase().startsWith(ownerText)));
      if (ownerText !== "" && !owner) invalid[`${i}:owner`] = t("grid.badOwner");
      if (title === "") invalid[`${i}:title`] = t("grid.badTitle");
      if (!when) return;
      const next: DayGridRow = {
        ...(id ? { id } : { recordKind: kind ?? "" }),
        title,
        startsAt: when.startsAt,
        endsAt: when.endsAt,
        dueAt: when.dueAt,
        startTbc: readTbcCell(row["tbc"] ?? null),
        ownerPartyId: owner ? owner.id : null,
        ...(original
          ? {
              expect: {
                title: original.title,
                starts_at: original.startsAt,
                ends_at: original.endsAt,
                due_at: original.dueAt,
                start_tbc: original.startTbc,
                owner_party_id: original.ownerId,
              },
            }
          : {}),
      };
      // An edited row is sent only when something in it changed.
      if (
        original &&
        original.title === next.title &&
        sameInstant(original.startsAt, next.startsAt) &&
        sameInstant(original.endsAt, next.endsAt) &&
        sameInstant(original.dueAt, next.dueAt) &&
        original.startTbc === next.startTbc &&
        original.ownerId === next.ownerPartyId
      ) {
        return;
      }
      payload.push(next);
      indexes.push(i);
    });
    return { payload, indexes, invalid };
  };

  const send = (commit: boolean) => {
    const { payload, indexes, invalid } = build();
    setError(null);
    if (Object.keys(invalid).length > 0) {
      setErrors(invalid);
      setPreview(null);
      setSaid(t("grid.fix", { count: Object.keys(invalid).length }));
      return;
    }
    if (payload.length === 0) {
      setErrors({});
      setSaid(t("grid.nothing"));
      return;
    }
    start(async () => {
      const result = await saveDayGridAction(org, {
        projectId: source.project.id,
        day: source.day,
        rows: payload,
        commit,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const placed: Record<string, string> = {};
      for (const r of result.data.rows) {
        const index = indexes[r.index - 1];
        if (r.action === "refused" && index !== undefined)
          placed[`${index}:${refusalColumn(r.rule)}`] = r.message ?? r.rule ?? "";
      }
      setErrors(placed);
      const summary = t("grid.preview", {
        created: result.data.created,
        changed: result.data.changed,
        refused: result.data.refused,
      });
      setSaid(summary);
      if (commit && result.data.refused === 0) {
        onClose();
        return;
      }
      setPreview(result.data);
    });
  };

  return (
    <Drawer
      title={t("grid.title", { project: source.project.key, date: source.day })}
      open
      onOpenChange={(v) => (v ? undefined : onClose())}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("grid.close")}
          </Button>
          {canWrite ? (
            preview && preview.refused === 0 ? (
              <Button variant="primary" loading={pending} onClick={() => send(true)}>
                {t("grid.apply")}
              </Button>
            ) : (
              <Button variant="primary" loading={pending} onClick={() => send(false)}>
                {t("grid.save")}
              </Button>
            )
          ) : null}
        </>
      }
    >
      <p className="m-0 text-text-13 text-text-secondary">
        {t("grid.help", { zone: zone.replaceAll("_", " ") })}
      </p>
      <ActionErrorAlert error={error} />
      <SpreadsheetGrid
        label={t("grid.label", { date: source.day })}
        columns={columns}
        rows={rows}
        appendRow={canWrite}
        errors={errors}
        onChange={(next) => {
          setRows(next);
          setPreview(null);
        }}
      />
      {preview ? (
        <p role="status" className="m-0 text-text-13">
          {t("grid.preview", {
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
