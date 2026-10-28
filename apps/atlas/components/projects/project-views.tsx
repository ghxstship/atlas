"use client";

import { Button, Card, PhaseChip, StateChip } from "@xos/ui";
import type { ProjectSummary } from "@xos/data/projects";
import type { PhaseCode, RecordState } from "@xos/ui";
import type { Route } from "next";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { phaseCode, PROJECT_STATE_ORDER, stateIcon } from "@/lib/projects/format";
import {
  Board,
  Calendar,
  Drawer,
  Gallery,
  PropertyList,
  RecordList,
  RecordRow,
} from "@/components/lazy-ui";
import { useProjectLabels, type PhaseInfo } from "./project-labels";

/** The portfolio timeline loads when the Timeline view is shown (A24-009). */
const PortfolioTimeline = dynamic(() =>
  import("./portfolio-timeline").then((m) => m.PortfolioTimeline),
);

/**
 * The Projects collection's views other than the default table (list, board, gallery, timeline,
 * calendar) and its peek. They load when first shown, not with the page (A24-009), so the table's
 * selection and row menus fit the route budget.
 */
export function ProjectAltView({
  view,
  shown,
  phases,
  board,
  month,
  today,
  onOpen,
  onMonth,
  onAddDates,
}: {
  view: "list" | "board" | "gallery" | "timeline" | "calendar";
  shown: readonly ProjectSummary[];
  phases: readonly PhaseInfo[];
  board: "state" | "phase";
  month: string;
  today: string;
  onOpen: (key: string | null) => void;
  onMonth: (month: string) => void;
  onAddDates: (key: string) => void;
}) {
  const t = useTranslations("projects");
  const format = useFormatter();
  const { gateOf, phaseName, stateLabel, dates } = useProjectLabels(phases);
  if (view === "list") {
    return (
      <RecordList label={t("list.caption")}>
        {shown.map((p) => (
          <RecordRow
            key={p.id}
            state={stateIcon(p.projectState)}
            stateLabel={stateLabel(p)}
            recordKey={p.key}
            title={p.name}
            chips={
              <PhaseChip
                gate={gateOf(p.phaseCode)}
                code={phaseCode(p.phaseCode)}
                name={phaseName(p.phaseCode)}
              />
            }
            next={dates(p)}
            actionLabel={t("list.open")}
            onAction={() => onOpen(p.key)}
            onOpen={() => onOpen(p.key)}
          />
        ))}
      </RecordList>
    );
  }
  if (view === "board") {
    const columns =
      board === "phase"
        ? phases.map((ph) => ({
            state: "active" as RecordState,
            label: t("gates.gate", { gate: ph.gate }) + ` · ${phaseName(ph.code)}`,
            cards: shown
              .filter((p) => p.phaseCode === ph.code)
              .map((p) => ({ key: p.key, title: p.name, meta: `${p.key} · ${stateLabel(p)}` })),
          }))
        : PROJECT_STATE_ORDER.map((s) => ({
            state: stateIcon(s),
            label: t(`states.${s}`),
            cards: shown
              .filter((p) => p.projectState === s)
              .map((p) => ({
                key: p.key,
                title: p.name,
                meta: `${p.key} · ${phaseName(p.phaseCode)}`,
              })),
          }));
    return (
      <section aria-label={board === "phase" ? t("list.phaseBoardLabel") : t("list.boardLabel")}>
        <Board readOnly columns={columns} onOpen={onOpen} />
      </section>
    );
  }
  if (view === "gallery") {
    return (
      <Gallery label={t("list.galleryLabel")}>
        {shown.map((p) => (
          <Card
            key={p.id}
            interactive
            title={`${p.key} ${p.name}`}
            meta={<StateChip state={stateIcon(p.projectState)} label={stateLabel(p)} />}
            footer={
              <Button size="sm" variant="ghost" onClick={() => onOpen(p.key)}>
                {t("list.open")}
              </Button>
            }
          >
            <div className="flex flex-col gap-6 text-text-13 text-text-secondary">
              <PhaseChip
                gate={gateOf(p.phaseCode)}
                code={phaseCode(p.phaseCode)}
                name={phaseName(p.phaseCode)}
              />
              <span>{p.venueName ?? p.jurisdictionId ?? t("values.unresolved")}</span>
              <span>{dates(p)}</span>
            </div>
          </Card>
        ))}
      </Gallery>
    );
  }
  if (view === "timeline") {
    return (
      <PortfolioTimeline
        projects={shown}
        label={t("list.timelineLabel")}
        today={today}
        format={(d) => format.dateTime(d, { weekday: "narrow", timeZone: "UTC" })}
        onAddDates={onAddDates}
      />
    );
  }
  // The calendar, by start and end day.
  const byLabel = new Map<string, string>();
  const events = shown.flatMap((p) => {
    const out: { date: string; label: string; state: RecordState }[] = [];
    const add = (iso: string | null, label: string) => {
      if (iso?.startsWith(month.slice(0, 7))) {
        byLabel.set(label, p.key);
        out.push({ date: iso, label, state: stateIcon(p.projectState) });
      }
    };
    add(p.startsOn, t("list.starts", { key: p.key }));
    add(p.endsOn, t("list.ends", { key: p.key }));
    return out;
  });
  return (
    <div className="flex flex-col gap-8">
      <div className="flex gap-8">
        <Button onClick={() => onMonth(shiftMonth(month, -1))}>{t("list.previousMonth")}</Button>
        <Button onClick={() => onMonth(shiftMonth(month, 1))}>{t("list.nextMonth")}</Button>
      </div>
      <Calendar
        month={month}
        today={today}
        events={events}
        onEventSelect={(e) => onOpen(byLabel.get(e.label) ?? null)}
      />
    </div>
  );
}

/** A project's peek: its state, phase and properties, with Gates and Open project. */
export function ProjectPeek({
  org,
  project,
  phases,
  onClose,
}: {
  org: string;
  project: ProjectSummary;
  phases: readonly PhaseInfo[];
  onClose: () => void;
}) {
  const t = useTranslations("projects");
  const router = useRouter();
  const { gateOf, phaseName, stateLabel, dates } = useProjectLabels(phases);
  return (
    <Drawer
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t("peek.title", { key: project.key, name: project.name })}
      footer={
        <>
          <Button onClick={() => router.push(`/${org}/p/${project.key}/gates` as Route)}>
            {t("peek.gates")}
          </Button>
          <Button
            variant="primary"
            onClick={() => router.push(`/${org}/p/${project.key}/overview` as Route)}
          >
            {t("peek.openProject")}
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap gap-6">
        <StateChip state={stateIcon(project.projectState)} label={stateLabel(project)} />
        <PhaseChip
          gate={gateOf(project.phaseCode)}
          code={phaseCode(project.phaseCode) as PhaseCode}
          name={phaseName(project.phaseCode)}
        />
      </div>
      <PropertyList
        items={[
          { label: t("fields.production"), value: t(`states.${project.productionState}`) },
          {
            label: t("fields.jurisdiction"),
            value: project.jurisdictionId ?? t("values.unresolved"),
          },
          { label: t("fields.venue"), value: project.venueName ?? t("values.none") },
          { label: t("fields.region"), value: project.regionCode ?? t("values.none") },
          { label: t("fields.currency"), value: project.currency },
          { label: t("fields.timeZone"), value: project.timeZone },
          { label: t("fields.dates"), value: dates(project) },
        ]}
      />
    </Drawer>
  );
}

/** `2026-11-01` moved by whole months, as the first of that month. */
function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 10);
}
