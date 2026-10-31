"use client";

import { Button, SegmentedControl, Textarea, Toast, ToastRegion } from "@xos/ui";
import type {
  StatusHeatmapCell,
  StatusHeatmapCol,
  StatusHeatmapLegendItem,
  StatusHeatmapRow,
} from "@xos/ui";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { BulkActionBar } from "@/components/lazy-ui/bulk-action-bar";
import { Dialog } from "@/components/lazy-ui/dialog";
import { StatusHeatmap } from "@/components/lazy-ui/status-heatmap";
import {
  revokeTrackSignoffAction,
  sendAdvanceReminderAction,
  signOffTrackAction,
  type ProgressOutcome,
} from "./progress-actions";
import { useCopy } from "./use-copy";
import { useQueryHref } from "./views";

/**
 * Client pieces of Advancing > Progress (R11): the pane switcher, the heatmaps (StatusHeatmap loads through
 * lazy-ui, so a page that never shows a pane never carries it), the bulk reminder on chosen recipients of one
 * packet, and the sign-off and revoke dialogs of the Tracks pane. Every write goes through progress-actions.
 */

export interface HeatmapData {
  readonly label: string;
  readonly corner: string;
  readonly rows: readonly StatusHeatmapRow[];
  readonly cols: readonly StatusHeatmapCol[];
  readonly cells: Readonly<Record<string, StatusHeatmapCell>>;
  readonly legend: readonly StatusHeatmapLegendItem[];
}

/** Switches the panes with `?pane=`, keeping the section and the packet filter. */
export function ProgressPaneTabs({
  label,
  current,
  options,
}: {
  label: string;
  current: string;
  options: { value: string; label: string }[];
}) {
  const router = useRouter();
  const href = useQueryHref();
  return (
    <SegmentedControl
      label={label}
      value={current}
      options={options}
      onChange={(next) => router.replace(href({ pane: next }))}
    />
  );
}

/** A heatmap whose cells open where their href points: the Crew and Allocations panes. */
export function LinkedHeatmap({ data }: { data: HeatmapData }) {
  const router = useRouter();
  return (
    <StatusHeatmap
      {...data}
      onCellSelect={(_row, _col, cell) => {
        if (cell.href) router.push(cell.href as Route);
      }}
    />
  );
}

function outcomeMessage(
  t: (key: string, values?: Record<string, string | number>) => string,
  errors: (key: string) => string,
  outcome: ProgressOutcome,
): string {
  return outcome.ok
    ? t("remind.done", { sent: outcome.sent ?? 0, skipped: outcome.skipped ?? 0 })
    : errors(outcome.error);
}

/**
 * The Packets pane: recipients by sections of one packet. A reader who may send picks recipient rows and reminds
 * them now; the toast says how many were reminded and how many were already reminded in the last day.
 */
export function PacketsHeatmap({
  org,
  packetId,
  canRemind,
  data,
}: {
  org: string;
  packetId: string;
  canRemind: boolean;
  data: HeatmapData;
}) {
  const t = useCopy("advancing.progress");
  const errors = useCopy("advancing.errors");
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const remind = () =>
    startTransition(async () => {
      const outcome = await sendAdvanceReminderAction(org, packetId, selected);
      setNotice(outcomeMessage(t, errors, outcome));
      if (outcome.ok) setSelected([]);
    });
  return (
    <div className="flex flex-col gap-12">
      <StatusHeatmap
        {...data}
        {...(canRemind ? { selection: { selected, onChange: setSelected } } : {})}
        onCellSelect={(_row, _col, cell) => {
          if (cell.href) router.push(cell.href as Route);
        }}
      />
      {canRemind && selected.length > 0 ? (
        <BulkActionBar
          count={selected.length}
          actions={[
            {
              label: t("remind.action"),
              icon: "Bell",
              ...(pending ? {} : { onSelect: remind }),
            },
          ]}
          onClear={() => setSelected([])}
        />
      ) : null}
      <ToastRegion label={t("remind.action")}>
        {notice ? <Toast message={notice} /> : null}
      </ToastRegion>
    </div>
  );
}

/** What a Tracks cell signs off or revokes. */
export interface TrackCellAction {
  readonly recipientId: string;
  readonly recipientLabel: string;
  readonly track: string;
  readonly trackLabel: string;
  readonly signoffId: string | null;
  /** Ready cells sign off; Signed Off and Reopened cells revoke. */
  readonly offer: "signOff" | "revoke" | null;
}

/**
 * The Tracks pane: recipients by tracks of one packet. A reviewer signs off a Ready cell and revokes a Signed Off or
 * Reopened one with a reason; other cells only say where the track stands.
 */
export function TracksHeatmap({
  org,
  canReview,
  data,
  actions,
}: {
  org: string;
  canReview: boolean;
  data: HeatmapData;
  actions: Readonly<Record<string, TrackCellAction>>;
}) {
  const t = useCopy("advancing.tracks");
  const common = useCopy("advancing.common");
  const errors = useCopy("advancing.errors");
  const router = useRouter();
  const [open, setOpen] = useState<TrackCellAction | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const reasonId = useId();
  const close = () => {
    setOpen(null);
    setReason("");
    setError(null);
  };
  const confirm = () => {
    if (!open) return;
    const target = open;
    startTransition(async () => {
      const outcome =
        target.offer === "revoke" && target.signoffId
          ? await revokeTrackSignoffAction(org, target.signoffId, reason)
          : await signOffTrackAction(org, target.recipientId, target.track);
      if (!outcome.ok) {
        setError(errors(outcome.error));
        return;
      }
      const values = { track: target.trackLabel, recipient: target.recipientLabel };
      setNotice(target.offer === "revoke" ? t("revoke.done", values) : t("signOff.done", values));
      close();
      router.refresh();
    });
  };
  const values = open ? { track: open.trackLabel, recipient: open.recipientLabel } : null;
  return (
    <div className="flex flex-col gap-12">
      <StatusHeatmap
        {...data}
        onCellSelect={(row, col) => {
          const action = actions[`${row}:${col}`];
          if (canReview && action?.offer) setOpen(action);
        }}
      />
      {open && values ? (
        <Dialog
          open
          onOpenChange={(next) => (next ? undefined : close())}
          title={open.offer === "revoke" ? t("revoke.title", values) : t("signOff.title", values)}
          actions={
            <>
              <Button variant="secondary" type="button" onClick={close}>
                {common("cancel")}
              </Button>
              <Button
                variant={open.offer === "revoke" ? "danger" : "primary"}
                type="button"
                loading={pending}
                onClick={confirm}
              >
                {open.offer === "revoke" ? t("revoke.confirm") : t("signOff.confirm")}
              </Button>
            </>
          }
        >
          {open.offer === "revoke" ? (
            <Textarea
              id={reasonId}
              label={t("revoke.reason")}
              help={t("revoke.reasonHelp")}
              maxLength={500}
              width="100%"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              error={error ?? ""}
            />
          ) : (
            <div className="flex flex-col gap-8">
              <p className="m-0">{t("signOff.body")}</p>
              {error ? <p className="m-0 text-text-13 text-danger-text">{error}</p> : null}
            </div>
          )}
        </Dialog>
      ) : null}
      <ToastRegion label={t("label")}>{notice ? <Toast message={notice} /> : null}</ToastRegion>
    </div>
  );
}
