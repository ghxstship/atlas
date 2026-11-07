"use client";

import type { ActivityEntry } from "@xos/data/activity";
import { Button, EmptyState, SegmentedControl } from "@xos/ui";
import type { Route } from "next";
import { useFormatter, useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ActivityLine } from "./activity-line";
import { collapseRepeats, useDescribe } from "./describe";

/** Sets or removes query parameters of the current page. */
export function useActivityGo() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (changes: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    const s = q.toString();
    router.push((s ? `${pathname}?${s}` : pathname) as Route);
  };
}

/**
 * The activity feed (Feed view, Section 11.15) of an org or one project, with a filter that keeps
 * across views and keyset paging through `before`. A page offering other views passes them in
 * (activity-feed-views.tsx), so a feed without any, as on Project Overview, carries none of their
 * code (ADR 0027).
 */
export function ActivityFeed({
  label,
  entries,
  next,
  paged,
  empty,
  switcher,
  alternative,
  notice,
  trailing,
}: {
  label: string;
  entries: readonly ActivityEntry[];
  next: string | null;
  paged: boolean;
  empty: { readonly sentence: string; readonly action: string; readonly href: string };
  /** The view switcher, beside the filter. */
  switcher?: ReactNode;
  /** Renders the filtered entries in the chosen view; null keeps the feed. */
  alternative?: (shown: readonly ActivityEntry[]) => ReactNode;
  /** Above the feed, whichever entries are shown (the Activity pages announce a restore here). */
  notice?: ReactNode;
  /** Beside an entry (the Activity pages offer Restore), with what the entry acts on. */
  trailing?: (entry: ActivityEntry, target: string) => ReactNode;
}) {
  const t = useTranslations("activity.feed");
  const format = useFormatter();
  const router = useRouter();
  const describe = useDescribe();
  const go = useActivityGo();
  const [filter, setFilter] = useState<"all" | "projects" | "records">("all");

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
  const shownInView = alternative?.(shown);

  return (
    <section aria-label={label} className="flex flex-col gap-12">
      {notice}
      <div className="flex flex-wrap items-end gap-12">
        {switcher}
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
      ) : shownInView ? (
        shownInView
      ) : (
        <ol className="m-0 flex list-none flex-col gap-4 p-0">
          {collapseRepeats(shown, describe).map(({ entry: e, description: d, count }) => (
            <li key={e.id} className="flex items-start gap-8">
              <ActivityLine description={d} time={when(e.at)} count={count} />
              {trailing?.(e, d.target)}
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
