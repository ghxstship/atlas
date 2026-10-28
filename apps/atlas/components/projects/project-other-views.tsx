"use client";

import { Button, Card, PhaseChip, StateChip } from "@xos/ui";
import type { ProjectSummary } from "@xos/data/projects";
import type { PhaseCode, RecordState } from "@xos/ui";
import type { Route } from "next";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { phaseCode, PROJECT_STATE_ORDER, stateIcon } from "@/lib/projects/format";
import { Board } from "@/components/lazy-ui/board";
import { Calendar } from "@/components/lazy-ui/calendar";
import { Drawer } from "@/components/lazy-ui/drawer";
import { Gallery } from "@/components/lazy-ui/gallery";
import { PropertyList } from "@/components/lazy-ui/property-list";
import { RecordList, RecordRow } from "@/components/lazy-ui/record-list";
import { PortfolioTimeline } from "./portfolio-timeline";
import type { BoardMode, PhaseInfo, ProjectView } from "./project-collection";

/** What the Projects collection hands its other views and its peek. */
export interface ProjectViewHelpers {
  readonly org: string;
  readonly phases: readonly PhaseInfo[];
  readonly gateOf: (code: string) => number;
  readonly dates: (p: ProjectSummary) => string;
  readonly stateLabel: (p: ProjectSummary) => string;
  readonly phaseName: (code: string) => string;
  readonly setPeekKey: (key: string | null) => void;
  readonly setParam: (name: string, value: string | null) => void;
}

const projectHref = (org: string, key: string, tab = "overview") =>
  `/${org}/p/${key}/${tab}` as Route;

/**
 * The Projects views other than the default table (list, board, gallery, timeline, calendar). They
 * load when a person switches to one (A24-009), so the table's first load does not carry them.
 */
export function ProjectOtherView({
  view,
  shown,
  board,
  month,
  today,
  h,
}: {
  view: Exclude<ProjectView, "table">;
  shown: readonly ProjectSummary[];
  board: BoardMode;
  month: string;
  today: string;
  h: ProjectViewHelpers;
}) {
  const t = useTranslations("projects");
  const format = useFormatter();
  const router = useRouter();
  const { gateOf, dates, stateLabel, phaseName, setPeekKey, setParam } = h;

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
            onAction={() => setPeekKey(p.key)}
            onOpen={() => setPeekKey(p.key)}
          />
        ))}
      </RecordList>
    );
  }
  if (view === "board") {
    const columns =
      board === "phase"
        ? h.phases.map((ph) => ({
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
        <Board readOnly columns={columns} onOpen={(key) => setPeekKey(key)} />
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
              <Button size="sm" variant="ghost" onClick={() => setPeekKey(p.key)}>
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
        onAddDates={(key) => router.push(projectHref(h.org, key, "settings"))}
      />
    );
  }
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
        <Button onClick={() => setParam("month", shiftMonth(month, -1))}>
          {t("list.previousMonth")}
        </Button>
        <Button onClick={() => setParam("month", shiftMonth(month, 1))}>
          {t("list.nextMonth")}
        </Button>
      </div>
      <Calendar
        month={month}
        today={today}
        events={events}
        onEventSelect={(e) => setPeekKey(byLabel.get(e.label) ?? null)}
      />
    </div>
  );
}

/** The side peek of one project, which loads when a project is opened (A24-009). */
export function ProjectPeek({ peek, h }: { peek: ProjectSummary; h: ProjectViewHelpers }) {
  const t = useTranslations("projects");
  const router = useRouter();
  const { gateOf, dates, stateLabel, phaseName, setPeekKey } = h;
  return (
    <Drawer
      open
      onOpenChange={(open) => (open ? undefined : setPeekKey(null))}
      title={t("peek.title", { key: peek.key, name: peek.name })}
      footer={
        <>
          <Button onClick={() => router.push(projectHref(h.org, peek.key, "gates"))}>
            {t("peek.gates")}
          </Button>
          <Button variant="primary" onClick={() => router.push(projectHref(h.org, peek.key))}>
            {t("peek.openProject")}
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap gap-6">
        <StateChip state={stateIcon(peek.projectState)} label={stateLabel(peek)} />
        <PhaseChip
          gate={gateOf(peek.phaseCode)}
          code={phaseCode(peek.phaseCode) as PhaseCode}
          name={phaseName(peek.phaseCode)}
        />
      </div>
      <PropertyList
        items={[
          { label: t("fields.production"), value: t(`states.${peek.productionState}`) },
          {
            label: t("fields.jurisdiction"),
            value: peek.jurisdictionId ?? t("values.unresolved"),
          },
          { label: t("fields.venue"), value: peek.venueName ?? t("values.none") },
          { label: t("fields.region"), value: peek.regionCode ?? t("values.none") },
          { label: t("fields.currency"), value: peek.currency },
          { label: t("fields.timeZone"), value: peek.timeZone },
          { label: t("fields.dates"), value: dates(peek) },
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
