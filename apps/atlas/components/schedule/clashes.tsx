"use client";

import {
  CLASH_RULES,
  type Clash,
  type ClashThresholds,
  type TravelRequestClash,
} from "@xos/data/schedule-clashes";
import type { ProjectRef } from "@xos/data/work";
import {
  Button,
  DataTable,
  EmptyState,
  Input,
  Link,
  PageHeader,
  RecordList,
  RecordRow,
  Select,
  Tag,
  TemplateCollection,
} from "@xos/ui";
import type { Route } from "next";
import { useFormatter } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { CollectionViews } from "@/components/views/collection-views";
import type { ActionError } from "@/components/work/action-result";
import { ActionErrorAlert, useCopy } from "@/components/work/action-ui";
import { withQuery } from "@/components/work/format";
import { clashHref, clashSentence, linkLabelKey, ruleNameKey } from "@/lib/schedule/clash-copy";
import { checkTravelRequestsAction } from "./depth-actions";

/**
 * Schedule > Clashes (B4, G-46, G-47) as a list or a table, filtered by project, period, rule and severity. Each row
 * says what clashes in a sentence composed here in the locale, its severity as a word with its tone, and links to
 * where it is fixed; nothing is fixed automatically. The travel request check is a panel of its own: it runs only
 * when asked, writes each compared person's access log, and its answer is never kept, listed here or exported.
 */
export function ClashesCollection({
  org,
  title,
  views,
  view,
  from,
  to,
  projectKey,
  rule,
  severity,
  projects,
  clashes,
  thresholds,
  canCheckTravel,
}: {
  org: string;
  title: string;
  views: readonly string[];
  view: string;
  from: string;
  to: string;
  projectKey: string;
  rule: string | null;
  severity: "Clash" | "Warning" | null;
  projects: readonly ProjectRef[];
  clashes: readonly Clash[];
  thresholds: ClashThresholds;
  canCheckTravel: boolean;
}) {
  const t = useCopy("schedule");
  const w = useCopy("work");
  const format = useFormatter();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (changes: Record<string, string | null>) =>
    router.replace(withQuery(pathname, params, changes) as Route, { scroll: false });
  const zoneOf = (c: Clash) =>
    projects.find((p) => p.id === c.candidate.projectId)?.timeZone ?? "UTC";
  const keyOf = (id: string | null) => projects.find((p) => p.id === id)?.key ?? "";
  const sentence = (c: Clash) =>
    clashSentence(
      c,
      t,
      (at) =>
        at
          ? format.dateTime(new Date(at), {
              hour: "numeric",
              minute: "2-digit",
              timeZone: zoneOf(c),
            })
          : "",
      (at) =>
        at
          ? format.dateTime(new Date(at), { month: "short", day: "numeric", timeZone: zoneOf(c) })
          : "",
    );
  const severityText = (c: Clash) =>
    t(c.severity === "Clash" ? "clashes.severity.clash" : "clashes.severity.warning");
  const day = (d: string) =>
    format.dateTime(new Date(`${d}T12:00:00Z`), {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  const projectsOf = (c: Clash) =>
    [
      ...new Set(
        [keyOf(c.candidate.projectId), keyOf(c.candidate.otherProjectId)].filter((k) => k !== ""),
      ),
    ].join(", ");
  const links = (c: Clash) => (
    <span className="inline-flex flex-wrap gap-8">
      {c.links.map((l) => (
        <Link key={`${l.kind}-${l.id}`} href={clashHref(org, l)}>
          {t(linkLabelKey(l))}
        </Link>
      ))}
    </span>
  );

  const header = (
    <PageHeader
      title={title}
      count={clashes.length}
      views={
        <div className="flex flex-wrap items-end gap-8">
          {views.length > 1 ? (
            <CollectionViews
              label={t("clashes.label")}
              value={view}
              options={views.map((v) => ({ value: v, label: w(`views.${v}`) }))}
              onChange={(v) => go({ view: v })}
            />
          ) : null}
        </div>
      }
    />
  );
  const filters = (
    <>
      {projects.length > 1 ? (
        <Select
          id="clash-project"
          label={t("clashes.project")}
          value={projectKey}
          options={[
            { value: "", label: t("clashes.allProjects") },
            ...projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
          ]}
          onChange={(e) => go({ project: e.target.value || null })}
        />
      ) : null}
      <Input
        id="clash-from"
        type="date"
        label={t("clashes.from")}
        value={from}
        width={160}
        onChange={(e) => go({ from: e.target.value || null })}
      />
      <Input
        id="clash-to"
        type="date"
        label={t("clashes.to")}
        help={t("clashes.periodHelp")}
        value={to}
        width={160}
        onChange={(e) => go({ to: e.target.value || null })}
      />
      <Select
        id="clash-rule"
        label={t("clashes.rule")}
        value={rule ?? ""}
        options={[
          { value: "", label: t("clashes.allRules") },
          ...CLASH_RULES.map((r) => ({ value: r, label: t(ruleNameKey(r)) })),
        ]}
        onChange={(e) => go({ rule: e.target.value || null })}
      />
      <Select
        id="clash-severity"
        label={t("clashes.severityFilter")}
        value={severity ?? ""}
        options={[
          { value: "", label: t("clashes.allSeverities") },
          { value: "Clash", label: t("clashes.severity.clash") },
          { value: "Warning", label: t("clashes.severity.warning") },
        ]}
        onChange={(e) => go({ severity: e.target.value || null })}
      />
    </>
  );

  let body: ReactNode;
  if (clashes.length === 0) {
    body = (
      <EmptyState
        icon="CircleCheck"
        sentence={t("clashes.empty")}
        actionLabel={t("clashes.toTimeline")}
        onAction={() => router.push(`/${org}/schedule/timeline` as Route)}
      />
    );
  } else if (view === "table") {
    body = (
      <DataTable
        caption={t("clashes.label")}
        columns={[
          { key: "severity", label: t("clashes.columns.severity") },
          { key: "day", label: t("clashes.columns.day") },
          { key: "projects", label: t("clashes.columns.projects"), type: "code" },
          { key: "rule", label: t("clashes.columns.rule") },
          { key: "what", label: t("clashes.columns.what"), wrap: true },
        ]}
        rows={clashes.map((c, i) => ({
          id: String(i),
          severity: severityText(c),
          day: day(c.candidate.day),
          projects: projectsOf(c),
          rule: t(ruleNameKey(c.rule)),
          what: sentence(c),
        }))}
        onRowActivate={(row) => {
          const c = clashes[Number(row["id"])];
          const first = c?.links[0];
          if (first) router.push(clashHref(org, first) as Route);
        }}
      />
    );
  } else {
    body = (
      <RecordList label={t("clashes.label")}>
        {clashes.map((c, i) => (
          <RecordRow
            key={`${c.rule}-${c.candidate.subjectId}-${c.candidate.otherId ?? ""}-${i}`}
            state={c.severity === "Clash" ? "blocked" : "in-review"}
            stateLabel={severityText(c)}
            recordKey={projectsOf(c)}
            title={sentence(c)}
            chips={
              <>
                <Tag tone={c.severity === "Clash" ? "danger" : "warning"}>{severityText(c)}</Tag>
                {c.params.tbc ? <Tag>{t("clashes.tbc")}</Tag> : null}
                {c.params.draft ? <Tag>{t("clashes.draft")}</Tag> : null}
                {links(c)}
              </>
            }
            next={`${day(c.candidate.day)} · ${t(ruleNameKey(c.rule))}`}
            actionLabel={t(linkLabelKey(c.links[0] ?? { kind: "shift", table: "shifts", id: "" }))}
            onAction={() => {
              const first = c.links[0];
              if (first) router.push(clashHref(org, first) as Route);
            }}
          />
        ))}
      </RecordList>
    );
  }

  return (
    <TemplateCollection header={header} filters={filters} peek={null}>
      <p className="m-0 text-text-13 text-text-secondary">
        {t("clashes.help", {
          changeover: thresholds.changeoverMinutes,
          buffer: thresholds.travelBufferMinutes,
        })}
      </p>
      {body}
      {canCheckTravel ? (
        <TravelRequestCheck org={org} projects={projects} projectKey={projectKey} />
      ) : null}
    </TemplateCollection>
  );
}

/**
 * The travel request check (R5's requested dates against calls, G-47). It runs only when pressed, because the
 * database writes each compared person's access log; the answer lives in this panel's state and nowhere else.
 */
function TravelRequestCheck({
  org,
  projects,
  projectKey,
}: {
  org: string;
  projects: readonly ProjectRef[];
  projectKey: string;
}) {
  const t = useCopy("schedule");
  const format = useFormatter();
  const [projectId, setProjectId] = useState(
    projects.find((p) => p.key === projectKey)?.id ?? projects[0]?.id ?? "",
  );
  const [rows, setRows] = useState<TravelRequestClash[] | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, start] = useTransition();
  const day = (d: string) =>
    format.dateTime(new Date(`${d}T12:00:00Z`), {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return (
    <section
      aria-labelledby="travel-check"
      className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
    >
      <h2 id="travel-check" className="m-0 text-heading-16 font-semibold">
        {t("clashes.travel.title")}
      </h2>
      <p className="m-0 text-text-13 text-text-secondary">{t("clashes.travel.logged")}</p>
      <div className="flex flex-wrap items-end gap-8">
        {projects.length > 1 ? (
          <Select
            id="travel-project"
            label={t("clashes.project")}
            value={projectId}
            options={projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
            onChange={(e) => {
              setProjectId(e.target.value);
              setRows(null);
            }}
          />
        ) : null}
        <Button
          icon="Plane"
          loading={pending}
          disabled={projectId === ""}
          onClick={() =>
            start(async () => {
              const result = await checkTravelRequestsAction(org, projectId);
              if (!result.ok) {
                setError(result.error);
                setRows(null);
                return;
              }
              setError(null);
              setRows(result.data);
            })
          }
        >
          {t("clashes.travel.check")}
        </Button>
      </div>
      <ActionErrorAlert error={error} />
      {rows ? (
        rows.length === 0 ? (
          <p role="status" className="m-0 text-text-13">
            {t("clashes.travel.none")}
          </p>
        ) : (
          <ul role="status" className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
            {rows.map((r) => (
              <li key={`${r.rosterEntryId}-${r.rule}`}>
                {t(
                  r.rule === "requested_arrival_after_call"
                    ? "clashes.travel.arrivalAfterCall"
                    : "clashes.travel.departureBeforeCall",
                  {
                    person: r.personName ?? t("clashes.someone"),
                    requested: day(r.requestedOn),
                    call: day(r.callDay),
                  },
                )}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
