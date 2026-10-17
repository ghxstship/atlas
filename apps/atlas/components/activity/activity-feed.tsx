"use client";

import type { ActivityEntry } from "@xos/data/activity";
import { ActivityFeedItem, Button, DataTable, EmptyState, SegmentedControl } from "@xos/ui";
import type { Route } from "next";
import { useFormatter, useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { CollectionViews } from "@/components/views/collection-views";
import { useDescribe } from "./describe";

export type ActivityView = "feed" | "list" | "table";

/**
 * The activity feed (Feed view, Section 11.15) of an org or one project, with list and table
 * alternatives, a filter that keeps across views, and keyset paging through `before`.
 */
export function ActivityFeed({
  label,
  entries,
  views,
  view,
  next,
  paged,
  empty,
}: {
  label: string;
  entries: readonly ActivityEntry[];
  views: readonly ActivityView[];
  view: ActivityView;
  next: string | null;
  paged: boolean;
  empty: { readonly sentence: string; readonly action: string; readonly href: string };
}) {
  const t = useTranslations("activity.feed");
  const format = useFormatter();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const describe = useDescribe();
  const viewLabel = useTranslations("projects.views");
  const [filter, setFilter] = useState<"all" | "projects" | "records">("all");

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
          {shown.map((e) => {
            const d = describe(e);
            return (
              <li key={e.id} className="flex flex-wrap items-baseline gap-8 py-8 text-text-13">
                <time
                  dateTime={e.at}
                  className="w-(--ui-props-label) shrink-0 text-text-secondary tabular-nums"
                >
                  {when(e.at)}
                </time>
                <span className="font-medium text-text-primary">{d.actor}</span>
                <span className="text-text-secondary">{d.action}</span>
                <span className="text-text-primary">{d.target}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-4 p-0">
          {shown.map((e) => {
            const d = describe(e);
            return (
              <li key={e.id}>
                <ActivityFeedItem
                  actor={d.actor}
                  action={d.action}
                  target={d.target}
                  time={when(e.at)}
                  {...(d.comment ? { comment: d.comment } : {})}
                />
              </li>
            );
          })}
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
