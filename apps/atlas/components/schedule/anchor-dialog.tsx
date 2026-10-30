"use client";

import {
  daysBetweenDates,
  type AnchorItem,
  type AnchorItemKind,
  type AnchorStay,
} from "@xos/data/anchor";
import { Button, Drawer, Input, Link } from "@xos/ui";
import { undoStack, type UndoResult } from "@xos/ui/undo";
import { useFormatter } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ActionError } from "@/components/work/action-result";
import { ActionErrorAlert, useCopy } from "@/components/work/action-ui";
import { moveProjectAnchorAction, setProjectAnchorAction } from "./depth-actions";

const MOVE_GROUPS: readonly AnchorItemKind[] = [
  "Record",
  "Running Order",
  "Cue",
  "Project Day",
  "Day Sheet",
  "Call Sheet",
];
const STAY_REASONS: readonly AnchorStay[] = [
  "pinned",
  "complete",
  "baseline_locked",
  "undated",
  "published",
  "shift",
  "booked",
];
const KIND_SLUGS: Readonly<Record<AnchorItemKind, string>> = {
  Project: "project",
  Record: "record",
  "Running Order": "runningOrder",
  Cue: "cue",
  "Project Day": "projectDay",
  "Day Sheet": "daySheet",
  "Call Sheet": "callSheet",
  Shift: "shift",
  "Dock Slot": "dockSlot",
};

/**
 * Setting or moving a project's anchor (B4, G-44), loaded when opened. Set anchor is a plain update that moves
 * nothing. Move anchor previews through app.move_project_anchor: what moves (records by whole days of the project's
 * wall clock, running orders and their cues, days and unpublished sheets) and what stays and why (pinned, Complete,
 * locked into a baseline, undated, published, and shifts, which never move). Apply writes exactly the preview, and
 * the toast's Move back runs a reverse move of the plan as it then stands.
 */
export function AnchorDialog({
  org,
  project,
  anchorOn,
  mode,
  onClose,
}: {
  org: string;
  project: { id: string; key: string };
  anchorOn: string | null;
  mode: "set" | "move";
  onClose: () => void;
}) {
  const t = useCopy("schedule");
  const format = useFormatter();
  const router = useRouter();
  const [date, setDate] = useState(anchorOn ?? "");
  const [items, setItems] = useState<AnchorItem[] | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [said, setSaid] = useState("");
  const [pending, start] = useTransition();
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && date !== anchorOn;
  const shift = anchorOn && valid ? daysBetweenDates(anchorOn, date) : 0;

  const when = (i: AnchorItem) =>
    i.oldOn
      ? `${format.dateTime(new Date(`${i.oldOn}T12:00:00Z`), { month: "short", day: "numeric", timeZone: "UTC" })}${
          i.moves && i.newOn
            ? ` → ${format.dateTime(new Date(`${i.newOn}T12:00:00Z`), { month: "short", day: "numeric", timeZone: "UTC" })}`
            : ""
        }`
      : i.oldAt
        ? `${format.dateTime(new Date(i.oldAt), { dateStyle: "medium", timeStyle: "short" })}${
            i.moves && i.newAt
              ? ` → ${format.dateTime(new Date(i.newAt), { dateStyle: "medium", timeStyle: "short" })}`
              : ""
          }`
        : t("anchor.undated");

  const preview = () =>
    start(async () => {
      const result = await moveProjectAnchorAction(org, {
        projectId: project.id,
        anchorOn: date,
        commit: false,
        reason: null,
      });
      if (!result.ok) {
        setError(result.error);
        setItems(null);
        return;
      }
      setError(null);
      setItems(result.data);
    });

  const apply = () =>
    start(async () => {
      if (mode === "set") {
        const result = await setProjectAnchorAction(org, { projectId: project.id, anchorOn: date });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setSaid(t("anchor.setDone"));
        onClose();
        return;
      }
      const result = await moveProjectAnchorAction(org, {
        projectId: project.id,
        anchorOn: date,
        commit: true,
        reason: t("anchor.reason", { days: shift }),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const moved = result.data.filter((i) => i.moves && i.kind !== "Project").length;
      const label = t("anchor.moved", { count: moved, days: shift });
      setSaid(label);
      const back = anchorOn;
      if (back) {
        undoStack.push({
          label,
          actionLabel: t("anchor.moveBack"),
          undo: async (): Promise<UndoResult> => {
            const reverse = await moveProjectAnchorAction(org, {
              projectId: project.id,
              anchorOn: back,
              commit: true,
              reason: t("anchor.reasonBack"),
            });
            if (!reverse.ok) return { ok: false, message: t("anchor.moveBackFailed") };
            router.refresh();
            return { ok: true };
          },
        });
      }
      router.refresh();
      onClose();
    });

  const moving = (items ?? []).filter((i) => i.moves && i.kind !== "Project");
  const staying = (items ?? []).filter((i) => !i.moves && i.staysBecause);
  return (
    <Drawer
      title={
        mode === "set"
          ? t("anchor.setTitle", { project: project.key })
          : t("anchor.moveTitle", { project: project.key })
      }
      open
      onOpenChange={(v) => (v ? undefined : onClose())}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("anchor.cancel")}
          </Button>
          {mode === "set" ? (
            <Button variant="primary" loading={pending} disabled={!valid} onClick={apply}>
              {t("anchor.setButton")}
            </Button>
          ) : items ? (
            <Button variant="primary" loading={pending} onClick={apply}>
              {t("anchor.apply", { count: moving.length })}
            </Button>
          ) : (
            <Button variant="primary" loading={pending} disabled={!valid} onClick={preview}>
              {t("anchor.preview")}
            </Button>
          )}
        </>
      }
    >
      <p className="m-0 text-text-13 text-text-secondary">
        {mode === "set" ? t("anchor.setHelp") : t("anchor.moveHelp")}
      </p>
      <Input
        id="anchor-date"
        type="date"
        label={t("anchor.date")}
        value={date}
        onChange={(e) => {
          setDate(e.target.value);
          setItems(null);
        }}
      />
      {mode === "move" && valid ? (
        <p className="m-0 text-text-13">
          {t(shift < 0 ? "anchor.earlier" : "anchor.later", { n: Math.abs(shift) })}
        </p>
      ) : null}
      <ActionErrorAlert error={error} />
      {items ? (
        <>
          <p role="status" className="m-0 text-text-13">
            {t("anchor.summary", { moves: moving.length, stays: staying.length })}
          </p>
          <section aria-labelledby="anchor-moves" className="flex flex-col gap-6">
            <h3 id="anchor-moves" className="m-0 text-label-13 font-semibold">
              {t("anchor.moves")}
            </h3>
            {MOVE_GROUPS.map((kind) => {
              const list = moving.filter((i) => i.kind === kind);
              return list.length === 0 ? null : (
                <div key={kind} className="flex flex-col gap-2">
                  <h4 className="m-0 text-text-12 font-medium text-text-secondary">
                    {t(`anchor.kinds.${KIND_SLUGS[kind]}`, { count: list.length })}
                  </h4>
                  <ul className="m-0 flex list-none flex-col gap-2 p-0 text-text-13">
                    {list.map((i) => (
                      <li key={i.id}>
                        {i.label} <span className="text-text-secondary">{when(i)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </section>
          <section aria-labelledby="anchor-stays" className="flex flex-col gap-6">
            <h3 id="anchor-stays" className="m-0 text-label-13 font-semibold">
              {t("anchor.stays")}
            </h3>
            {STAY_REASONS.map((reason) => {
              const list = staying.filter((i) => i.staysBecause === reason);
              return list.length === 0 ? null : (
                <div key={reason} className="flex flex-col gap-2">
                  <h4 className="m-0 text-text-12 font-medium text-text-secondary">
                    {t(`anchor.reasons.${reason}`, { count: list.length })}
                  </h4>
                  <ul className="m-0 flex list-none flex-col gap-2 p-0 text-text-13">
                    {list.map((i) => (
                      <li key={i.id}>
                        {i.label} <span className="text-text-secondary">{when(i)}</span>
                      </li>
                    ))}
                  </ul>
                  {reason === "shift" ? (
                    <Link href={`/${org}/p/${project.key}/crew`}>{t("anchor.toShifts")}</Link>
                  ) : null}
                </div>
              );
            })}
            <p className="m-0 text-text-12 text-text-secondary">{t("anchor.neverMove")}</p>
          </section>
        </>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {said}
      </p>
    </Drawer>
  );
}
