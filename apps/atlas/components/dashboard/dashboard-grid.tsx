"use client";

import { Button, TemplateDashboard, type DashboardSpans, type DashboardTile } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Region } from "@/components/shell/region";
import type { DashboardId } from "@/lib/dashboard/layout";
import {
  resetDashboardLayoutAction,
  saveDashboardLayoutAction,
} from "@/lib/dashboard/layout-actions";

/** How long a run of resizes settles before the layout saves. */
const SAVE_AFTER_MS = 600;

/**
 * Home and the partner console on the Dashboard template (Section 11.6, A129): tiles on the
 * 12-column grid at the person's saved spans. Resizing a tile, by drag or by keyboard, saves every
 * span as their own setting once the changes settle; Reset layout appears once the layout differs from
 * the default and brings the default spans back. Every tile is its own Region (ADR 0118): one that
 * fails shows Retry in its place and the other tiles stay.
 */
export function DashboardGrid({
  dashboard,
  header,
  controls,
  tiles,
  saved,
  label,
}: {
  dashboard: DashboardId;
  header: ReactNode;
  controls?: ReactNode;
  tiles: readonly DashboardTile[];
  /** The spans the person saved, from me.dashboard_layout.<dashboard>. */
  saved: DashboardSpans;
  /** Names the grid, such as "Home tiles". */
  label: string;
}) {
  const t = useTranslations("home.layout");
  const [spans, setSpans] = useState<DashboardSpans>(saved);
  // A reset remounts the template so the spans it changed in place go back too.
  const [version, setVersion] = useState(0);
  const [failed, setFailed] = useState(false);
  const regions = useMemo(
    () => tiles.map((tile) => ({ ...tile, content: <Region>{tile.content}</Region> })),
    [tiles],
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const save = (next: DashboardSpans) => {
    setSpans(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void saveDashboardLayoutAction(dashboard, next).then((r) => setFailed(!r.ok));
    }, SAVE_AFTER_MS);
  };

  const reset = () => {
    if (timer.current) clearTimeout(timer.current);
    setSpans({});
    setVersion((v) => v + 1);
    void resetDashboardLayoutAction(dashboard).then((r) => setFailed(!r.ok));
  };

  const customized = tiles.some(
    (tile) => spans[tile.id] !== undefined && spans[tile.id] !== tile.span,
  );

  return (
    <TemplateDashboard
      key={version}
      header={header}
      controls={
        controls || customized || failed ? (
          <>
            {controls}
            {customized ? (
              <Button variant="ghost" size="sm" icon="Undo2" onClick={reset}>
                {t("reset")}
              </Button>
            ) : null}
            {failed ? (
              <span role="alert" className="text-text-12 text-danger-text">
                {t("saveFailed")}
              </span>
            ) : null}
          </>
        ) : undefined
      }
      tiles={regions}
      spans={spans}
      label={label}
      resize={{
        label: (tile) => t("resize", { tile }),
        describe: (tile, span) => t("span", { tile, span }),
        onChange: save,
      }}
    />
  );
}
