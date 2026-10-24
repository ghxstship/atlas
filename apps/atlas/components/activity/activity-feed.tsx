"use client";

import type { ActivityEntry, RestoreTarget } from "@xos/data/activity";
import { Button, EmptyState, SegmentedControl } from "@xos/ui";
import type { Route } from "next";
import { useFormatter, useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { CollectionViews } from "@/components/views/collection-views";
// The table is an alternative to the feed (A24-009).
import { DataTable } from "@/components/lazy-ui";
import { ActivityLine, ActivityTarget } from "./activity-line";
import { collapseRepeats, useDescribe } from "./describe";
import { RestoreButton } from "./restore-button";

export type ActivityView = "feed" | "list" | "table";

/**
 * The activity feed (Feed view, Section 11.15) of an org or one project, with list and table
 * alternatives, a filter that keeps across views, and keyset paging through `before`. An entry for a
 * row moved to Trash offers Restore while the row is still restorable (Section 11.7).
 */
export function ActivityFeed({
  label,
  entries,
  views,
  view,
  next,
  paged,
  empty,
  restorable = {},
}: {
  label: string;
  entries: readonly ActivityEntry[];
  views: readonly ActivityView[];
  view: ActivityView;
  next: string | null;
  paged: boolean;
  empty: { readonly sentence: string; readonly action: string; readonly href: string };
  /** The rows entries can restore, keyed by entry id (restorableEntries). */
  restorable?: Readonly<Record<string, RestoreTarget>>;
}) {
  const t = useTranslations("activity.feed");
  const format = useFormatter();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const describe = useDescribe();
  const viewLabel = useTranslations("projects.views");
  const [filter, setFilter] = useState<"all" | "projects" | "records">("all");
  const [restored, setRestored] = useState<string | null>(null);
  const org = pathname.split("/")[1] ?? "";
  const restore = (e: ActivityEntry, target: string) => {
    const found = restorable[e.id];
    return found ? (
      <RestoreButton
        org={org}
        target={found}
        label={target}
        onRestored={(name) => setRestored(t("restored", { target: name }))}
      />
    ) : null;
  };

  const go = (changes: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    const s = q.toString();
    router.push((s ? `${pathname}?${s}` : pathname) as Route);
  };

  if (entries.length === 0 && !paged) {
    return (
      <EmptyState
        icon="Activity"
        sentence={empty.sentence}
        actionLabel={empty.action}
        onAction={() => router.push(empty.href as Route)}
      />
    );
  }

  const shown = entries.filter((e) =>
    filter === "all"
      ? true
      : filter === "records"
        ? e.subjectTable === "records"
        : e.subjectTable !== "records" && e.project !== null,
  );
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });

  return (
    <section aria-label={label} className="flex flex-col gap-12">
      {/* Always mounted, so a restore is announced although its entry stops offering Restore. */}
      <p role="status" className={restored ? "m-0 text-text-13 text-success-text" : "sr-only"}>
        {restored}
      </p>
      <div className="flex flex-wrap items-end gap-12">
        {views.length > 1 ? (
          <CollectionViews
            label={t("title")}
            value={view}
            options={views.map((v) => ({
              value: v,
              label: viewLabel(v),
            }))}
            onChange={(v) => go({ view: v })}
          />
        ) : null}
        <SegmentedControl
          label={t("filter")}
          value={filter}
          options={[
            { value: "all", label: t("all") },
            { value: "projects", label: t("projectsOnly") },
            { value: "records", label: t("recordsOnly") },
          ]}
          onChange={(v) => setFilter(v as typeof filter)}
        />
      </div>
      {shown.length === 0 ? (
        <EmptyState
          icon="Filter"
          sentence={t("noMatch")}
          actionLabel={t("showAll")}
          onAction={() => setFilter("all")}
        />
      ) : view === "table" ? (
        <DataTable
          caption={label}
          columns={[
            { key: "when", label: t("table.when"), width: 180 },
            { key: "who", label: t("table.who"), width: 160 },
            { key: "what", label: t("table.what"), wrap: true },
            { key: "project", label: t("table.project"), type: "code", width: 96 },
          ]}
          rows={shown.map((e) => {
            const d = describe(e);
            return {
              id: e.id,
              when: when(e.at),
              who: d.actor,
              what: [d.action, d.target, d.comment].filter(Boolean).join(" "),
              project: e.project?.key ?? "",
            };
          })}
        />
      ) : view === "list" ? (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {collapseRepeats(shown, describe).map(({ entry: e, description: d, count }) => (
            <li key={e.id} className="flex flex-wrap items-baseline gap-8 py-8 text-text-13">
              <time
                dateTime={e.at}
                className="w-(--ui-props-label) shrink-0 text-text-secondary tabular-nums"
              >
                {when(e.at)}
              </time>
              <span className="font-medium text-text-primary">{d.actor}</span>
              <span className="text-text-secondary">{d.action}</span>
              <span className="text-text-primary">
                <ActivityTarget parts={d.targetParts} />
              </span>
              {count > 1 ? (
                <span className="text-text-secondary">{t("times", { count })}</span>
              ) : null}
              <span className="ms-auto">{restore(e, d.target)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-4 p-0">
          {collapseRepeats(shown, describe).map(({ entry: e, description: d, count }) => (
            <li key={e.id} className="flex items-start gap-8">
              <ActivityLine description={d} time={when(e.at)} count={count} />
              {restore(e, d.target)}
            </li>
          ))}
        </ol>
      )}
      <div className="flex gap-8">
        {paged ? (
          <Button variant="ghost" onClick={() => go({ before: null })}>
            {t("newest")}
          </Button>
        ) : null}
        {next ? (
          <Button variant="secondary" onClick={() => go({ before: next })}>
            {t("older")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
