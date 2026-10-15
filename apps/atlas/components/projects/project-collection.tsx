"use client";

import {
  Board,
  Button,
  Calendar,
  Card,
  Checkbox,
  DataTable,
  Drawer,
  EmptyState,
  Gallery,
  Input,
  PageHeader,
  PhaseChip,
  PropertyList,
  RecordList,
  RecordRow,
  SegmentedControl,
  StateChip,
  TemplateCollection,
  Timeline,
} from "@xos/ui";
import { PROJECT_STATES, type ProjectSummary } from "@xos/data/projects";
import type { PhaseCode, RecordState } from "@xos/ui";
import type { Route } from "next";
import { useFormatter, useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { phaseCode, stateIcon } from "@/lib/projects/format";
import { CreateProjectDialog, type ProjectFormOptions } from "./create-project";

export type ProjectView = "table" | "list" | "board" | "gallery" | "timeline" | "calendar";

export interface PhaseInfo {
  readonly code: string;
  readonly gate: number;
}

/** Board by project state, or by phase (the gate board of Projects > By phase). */
export type BoardMode = "state" | "phase";

/**
 * The Projects collection (Collection template, Section 11.6): the views the sitemap allows for the
 * page, a search over key and name, the archived filter, a side peek and the New project dialog.
 * Every view keeps the same search and filter state, and the view lives in the query string
 * (Section 4.5.3), so a link reopens the same view.
 */
export function ProjectCollection({
  org,
  title,
  projects,
  phases,
  views,
  view,
  board = "state",
  includeArchived,
  month,
  today,
  create,
}: {
  org: string;
  title: string;
  projects: readonly ProjectSummary[];
  phases: readonly PhaseInfo[];
  views: readonly ProjectView[];
  view: ProjectView;
  board?: BoardMode;
  includeArchived: boolean;
  month: string;
  today: string;
  create: { readonly options: ProjectFormOptions; readonly open: boolean } | null;
}) {
  const t = useTranslations("projects");
  const format = useFormatter();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [query, setQuery] = useState("");
  const [peekKey, setPeekKey] = useState<string | null>(null);

  const gateOf = (code: string) => phases.find((p) => p.code === code)?.gate ?? 0;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === ""
      ? projects
      : projects.filter((p) => p.key.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
  }, [projects, query]);

  const setParam = (name: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null) next.delete(name);
    else next.set(name, value);
    const qs = next.toString();
    router.replace((qs ? `${pathname}?${qs}` : pathname) as Route);
  };
  const projectHref = (key: string, tab = "overview") => `/${org}/p/${key}/${tab}` as Route;
  const date = (iso: string | null) =>
    iso === null ? null : format.dateTime(new Date(`${iso}T00:00:00`), { dateStyle: "medium" });
  const dates = (p: ProjectSummary) => {
    const s = date(p.startsOn);
    const e = date(p.endsOn);
    if (s && e) return t("values.dateRange", { start: s, end: e });
    if (s) return t("values.from", { start: s });
    if (e) return t("values.until", { end: e });
    return t("values.noDates");
  };
  const stateLabel = (p: ProjectSummary) => t(`states.${p.projectState}`);
  const phaseName = (code: string) => t(`phases.${phaseCode(code)}`);
  const peek = projects.find((p) => p.key === peekKey) ?? null;

  const header = (
    <PageHeader
      title={title}
      count={shown.length}
      views={
        views.length > 1 ? (
          <SegmentedControl
            label={t("views.label")}
            value={view}
            options={views.map((v) => ({ value: v, label: t(`views.${v}`) }))}
            onChange={(v) => setParam("view", v)}
          />
        ) : undefined
      }
      actions={
        create ? (
          <CreateProjectDialog
            key={String(create.open)}
            org={org}
            options={create.options}
            defaultOpen={create.open}
          />
        ) : undefined
      }
    />
  );

  const filters = (
    <>
      <Input
        id="projects-search"
        type="search"
        label={t("list.search")}
        placeholder={t("list.searchPlaceholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <Checkbox
        label={t("list.showArchived")}
        checked={includeArchived}
        onChange={(e) => setParam("archived", e.target.checked ? "1" : null)}
      />
    </>
  );

  let body: React.ReactNode;
  if (projects.length === 0) {
    body = create ? (
      <EmptyState
        icon="FolderPlus"
        sentence={t("list.empty")}
        actionLabel={t("list.newProject")}
        onAction={() => setParam("create", "1")}
      />
    ) : (
      <EmptyState
        icon="Folder"
        sentence={t("list.emptyReadOnly")}
        actionLabel={t("list.emptyReadOnlyAction")}
        onAction={() => router.push(`/${org}/my-work` as Route)}
      />
    );
  } else if (shown.length === 0) {
    body = (
      <EmptyState
        icon="Search"
        sentence={t("list.noMatch", { query })}
        actionLabel={t("list.clearSearch")}
        onAction={() => setQuery("")}
      />
    );
  } else if (view === "table") {
    body = (
      <DataTable
        caption={t("list.caption")}
        columns={[
          { key: "key", label: t("fields.key"), type: "code", width: 88 },
          { key: "name", label: t("fields.name"), wrap: true },
          { key: "state", label: t("fields.state"), type: "state", width: 128 },
          { key: "phase", label: t("fields.phase"), width: 160 },
          { key: "jurisdiction", label: t("fields.jurisdiction"), type: "code", width: 180 },
          { key: "venue", label: t("fields.venue"), width: 180 },
          { key: "dates", label: t("fields.dates"), width: 220 },
        ]}
        pinStart={["key"]}
        rows={shown.map((p) => ({
          id: p.key,
          key: p.key,
          name: p.name,
          state: { state: stateIcon(p.projectState), label: stateLabel(p) },
          phase: t("gates.gate", { gate: gateOf(p.phaseCode) }) + ` · ${phaseName(p.phaseCode)}`,
          jurisdiction: p.jurisdictionId ?? t("values.unresolved"),
          venue: p.venueName ?? t("values.none"),
          dates: dates(p),
        }))}
        onRowActivate={(row) => setPeekKey(String(row["key"]))}
      />
    );
  } else if (view === "list") {
    body = (
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
  } else if (view === "board") {
    const columns =
      board === "phase"
        ? phases.map((ph) => ({
            state: "active" as RecordState,
            label: t("gates.gate", { gate: ph.gate }) + ` · ${phaseName(ph.code)}`,
            cards: shown
              .filter((p) => p.phaseCode === ph.code)
              .map((p) => ({ key: p.key, title: p.name, meta: `${p.key} · ${stateLabel(p)}` })),
          }))
        : PROJECT_STATES.map((s) => ({
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
    body = (
      <section aria-label={board === "phase" ? t("list.phaseBoardLabel") : t("list.boardLabel")}>
        <Board readOnly columns={columns} onOpen={(key) => setPeekKey(key)} />
      </section>
    );
  } else if (view === "gallery") {
    body = (
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
  } else if (view === "timeline") {
    body = (
      <PortfolioTimeline
        projects={shown}
        label={t("list.timelineLabel")}
        today={today}
        format={(d) => format.dateTime(d, { weekday: "narrow", timeZone: "UTC" })}
        onAddDates={(key) => router.push(projectHref(key, "settings"))}
      />
    );
  } else {
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
    body = (
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

  const undated = projects.filter((p) => !p.startsOn && !p.endsOn).length;

  return (
    <TemplateCollection
      header={header}
      filters={filters}
      peek={
        peek ? (
          <Drawer
            open
            onOpenChange={(open) => (open ? undefined : setPeekKey(null))}
            title={t("peek.title", { key: peek.key, name: peek.name })}
            footer={
              <>
                <Button onClick={() => router.push(projectHref(peek.key, "gates"))}>
                  {t("peek.gates")}
                </Button>
                <Button variant="primary" onClick={() => router.push(projectHref(peek.key))}>
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
                { label: t("fields.timeZone"), value: peek.timeZone },
                { label: t("fields.dates"), value: dates(peek) },
              ]}
            />
          </Drawer>
        ) : undefined
      }
    >
      {body}
      {(view === "timeline" || view === "calendar") && undated > 0 ? (
        <p className="mt-8 text-text-13 text-text-secondary">
          {t("list.undated", { count: undated })} {t("list.addDates")}
        </p>
      ) : null}
    </TemplateCollection>
  );
}

/** `2026-11-01` moved by whole months, as the first of that month. */
function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 10);
}

const DAY = 86_400_000;

/** Projects on a day grid from the earliest start to the latest end (Timeline view). */
function PortfolioTimeline({
  projects,
  label,
  today,
  format,
  onAddDates,
}: {
  projects: readonly ProjectSummary[];
  label: string;
  today: string;
  format: (d: Date) => string;
  onAddDates: (key: string) => void;
}) {
  const t = useTranslations("projects");
  const dated = projects.filter((p) => p.startsOn || p.endsOn);
  const first0 = projects[0];
  if (dated.length === 0) {
    return first0 ? (
      <EmptyState
        icon="CalendarRange"
        sentence={t("list.addDates")}
        actionLabel={t("list.open")}
        onAction={() => onAddDates(first0.key)}
      />
    ) : null;
  }
  const time = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  const starts = dated.map((p) => time((p.startsOn ?? p.endsOn) as string));
  const ends = dated.map((p) => time((p.endsOn ?? p.startsOn) as string));
  const first = Math.min(...starts);
  const last = Math.min(Math.max(...ends), first + 365 * DAY);
  const count = Math.round((last - first) / DAY) + 1;
  const days = Array.from({ length: count }, (_, i) => {
    const d = new Date(first + i * DAY);
    const dow = d.getUTCDay();
    return { dow: format(d), date: d.getUTCDate(), weekend: dow === 0 || dow === 6 };
  });
  const index = (ms: number) => Math.max(0, Math.min(count - 1, Math.round((ms - first) / DAY)));
  const todayIndex = Math.round((time(today) - first) / DAY);
  return (
    <div className="overflow-x-auto">
      <Timeline
        label={label}
        days={days}
        dayWidth={count > 120 ? 8 : count > 45 ? 16 : 32}
        {...(todayIndex >= 0 && todayIndex < count ? { today: todayIndex } : {})}
        rows={dated.map((p, i) => ({
          key: p.key,
          title: p.name,
          state: stateIcon(p.projectState),
          start: index(starts[i] ?? first),
          end: index(ends[i] ?? first),
        }))}
      />
    </div>
  );
}
