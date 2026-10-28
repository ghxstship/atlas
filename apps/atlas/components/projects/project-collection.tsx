"use client";

import { Checkbox, DataTable, EmptyState, Input, PageHeader, TemplateCollection } from "@xos/ui";
import type { ProjectSummary } from "@xos/data/projects";
import type { Route } from "next";
import { useFormatter, useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { phaseCode, stateIcon } from "@/lib/projects/format";
import { CreateProjectDialog, type ProjectFormOptions } from "./create-project";
import { collectionPeek } from "@/components/shell/collection-peek";
import { CollectionViews } from "@/components/views/collection-views";
import dynamic from "next/dynamic";
import type { ProjectViewHelpers } from "./project-other-views";
import type { BulkConfig } from "@/components/bulk/types";
import { useBulk } from "@/components/bulk/use-bulk";
// Its menu loads on the first right-click, keeping the page in its route budget.
import { useRowMenuOnDemand } from "@/components/menus/row-menu-on-demand";
import { useCustomFieldColumns } from "@/components/custom-fields/list";
import { isConditionParam } from "@/lib/views/query";

// Views other than the default table, and the peek, load when shown (A24-009).
const ProjectOtherView = dynamic(() =>
  import("./project-other-views").then((m) => m.ProjectOtherView),
);
const ProjectPeek = dynamic(() => import("./project-other-views").then((m) => m.ProjectPeek));

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
 * (Section 4.5.3), so a link reopens the same view. The table selects projects for bulk changes,
 * and each row's menu offers the same changes as the bulk bar (Section 11.7).
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
  sharers = [],
  bulk,
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
  /**
   * Who can share a project with a reader who cannot create one (the org's Owners, Admins and
   * Producers), named in the empty state so it never sends them in a loop (A59-014).
   */
  sharers?: readonly string[];
  /** Bulk edit of the table view's selection, for people who may change projects. */
  bulk?: BulkConfig | null;
}) {
  const t = useTranslations("projects");
  const format = useFormatter();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [query, setQuery] = useState("");
  const [peekKey, setPeekState] = useState<string | null>(params.get("peek"));
  // The org's filterable project fields (A117), from the CustomFieldList the page wraps this in.
  const custom = useCustomFieldColumns();
  const tv = useTranslations("views");
  const clearFilters = () => {
    const next = new URLSearchParams(window.location.search);
    for (const name of [...next.keys()]) if (isConditionParam(name)) next.delete(name);
    router.replace(`${pathname}${next.size > 0 ? `?${next}` : ""}` as Route, { scroll: false });
  };
  /** Opens or closes the peek and keeps it in the URL (`?peek=KEY`) without a server round trip. */
  const setPeekKey = (key: string | null) => {
    setPeekState(key);
    const next = new URLSearchParams(window.location.search);
    if (key === null) next.delete("peek");
    else next.set("peek", key);
    const qs = next.toString();
    window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
  };

  const gateOf = (code: string) => phases.find((p) => p.code === code)?.gate ?? 0;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === ""
      ? projects
      : projects.filter((p) => p.key.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
  }, [projects, query]);

  // The selection keeps only projects the search still shows (Section 11.7).
  const bulkRows = useMemo(() => shown.map((p) => ({ id: p.id, label: p.key })), [shown]);
  const bulkKit = useBulk(view === "table" ? bulk : null, bulkRows);
  const rowMenu = useRowMenuOnDemand();

  const setParam = (name: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null) next.delete(name);
    else next.set(name, value);
    const qs = next.toString();
    router.replace((qs ? `${pathname}?${qs}` : pathname) as Route);
  };
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
  const helpers: ProjectViewHelpers = {
    org,
    phases,
    gateOf,
    dates,
    stateLabel,
    phaseName,
    setPeekKey,
    setParam,
  };

  const header = (
    <PageHeader
      title={title}
      count={shown.length}
      views={
        views.length > 1 ? (
          <CollectionViews
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
        placeholder={t("list.searchHint")}
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
  // Custom field filters apply on the server (A117), so an empty list under them is no match, not no projects.
  const filtering = [...params.keys()].some(isConditionParam);
  if (projects.length === 0 && !filtering) {
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
        sentence={
          sharers.length > 0
            ? t("list.emptyReadOnlyNamed", { names: sharers.join(", ") })
            : t("list.emptyReadOnly")
        }
        actionLabel={t("list.emptyReadOnlyAction")}
        onAction={() => router.push(`/${org}/home` as Route)}
      />
    );
  } else if (shown.length === 0) {
    body = (
      <EmptyState
        icon="Search"
        sentence={query === "" && filtering ? tv("filter.noMatches") : t("list.noMatch", { query })}
        actionLabel={query === "" && filtering ? tv("filter.clear") : t("list.clearSearch")}
        onAction={() => (query === "" && filtering ? clearFilters() : setQuery(""))}
      />
    );
  } else if (view === "table") {
    body = (
      <>
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
            ...custom.columns,
          ]}
          pinStart={["key"]}
          rows={shown.map((p) => ({
            id: p.id,
            key: p.key,
            name: p.name,
            state: { state: stateIcon(p.projectState), label: stateLabel(p) },
            phase: t("gates.gate", { gate: gateOf(p.phaseCode) }) + ` · ${phaseName(p.phaseCode)}`,
            jurisdiction: p.jurisdictionId ?? t("values.unresolved"),
            venue: p.venueName ?? t("values.none"),
            dates: dates(p),
            ...custom.cells(p.id),
          }))}
          onRowActivate={(row) => setPeekKey(String(row["key"]))}
          onRowContextMenu={(_row, index, at, cell) => {
            const p = shown[index];
            if (!p) return;
            rowMenu.open(
              {
                id: p.id,
                label: p.key,
                open: () => setPeekKey(p.key),
                href: `/${org}/p/${p.key}/overview`,
                bulk: bulkKit,
              },
              at,
              cell,
            );
          }}
          {...(bulkKit.selection ? { selection: bulkKit.selection } : {})}
        />
        {bulkKit.bar}
        {rowMenu.menu}
      </>
    );
  } else {
    body = (
      <ProjectOtherView
        view={view}
        shown={shown}
        board={board}
        month={month}
        today={today}
        h={helpers}
      />
    );
  }

  const undated = projects.filter((p) => !p.startsOn && !p.endsOn).length;

  return (
    <TemplateCollection
      header={header}
      filters={filters}
      peek={collectionPeek(peekKey, peek ? <ProjectPeek peek={peek} h={helpers} /> : undefined)}
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
