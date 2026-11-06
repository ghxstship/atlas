"use client";

import type { ActivityEntry } from "@xos/data/activity";
import { useFormatter, useTranslations } from "next-intl";
import type { ComponentProps } from "react";
import { CollectionViews } from "@/components/views/collection-views";
// The table is an alternative to the feed (A24-009).
import { DataTable } from "@/components/lazy-ui/data-table";
import { ActivityFeed, useActivityGo } from "./activity-feed";
import { ActivityTarget } from "./activity-line";
import { collapseRepeats, useDescribe } from "./describe";

export type ActivityView = "feed" | "list" | "table";

/** The activity feed with its list and table alternatives and the switcher between them. */
export function ActivityFeedViews({
  views,
  view,
  ...feed
}: Omit<ComponentProps<typeof ActivityFeed>, "switcher" | "alternative"> & {
  views: readonly ActivityView[];
  view: ActivityView;
}) {
  const t = useTranslations("activity.feed");
  const format = useFormatter();
  const describe = useDescribe();
  const viewLabel = useTranslations("projects.views");
  const go = useActivityGo();
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });

  const table = (shown: readonly ActivityEntry[]) => (
    <DataTable
      caption={feed.label}
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
  );
  const list = (shown: readonly ActivityEntry[]) => (
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
          {count > 1 ? <span className="text-text-secondary">{t("times", { count })}</span> : null}
        </li>
      ))}
    </ul>
  );

  return (
    <ActivityFeed
      {...feed}
      switcher={
        views.length > 1 ? (
          <CollectionViews
            label={t("title")}
            value={view}
            options={views.map((v) => ({
              value: v,
              label: viewLabel(v),
            }))}
            onChange={(v) => go({ view: v })}
          />
        ) : null
      }
      alternative={(shown) =>
        view === "table" ? table(shown) : view === "list" ? list(shown) : null
      }
    />
  );
}
