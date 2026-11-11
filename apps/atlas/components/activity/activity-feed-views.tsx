"use client";

import type { ActivityEntry, RestoreTarget } from "@xos/data/activity";
import { useFormatter, useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useState, type ComponentProps } from "react";
import { CollectionViews } from "@/components/views/collection-views";
// The table is an alternative to the feed (A24-009).
import { DataTable } from "@/components/lazy-ui/data-table";
import { ActivityFeed, useActivityGo } from "./activity-feed";
import { ActivityTarget } from "./activity-line";
import { collapseRepeats, useDescribe } from "./describe";
import { RestoreButton } from "./restore-button";

export type ActivityView = "feed" | "list" | "table";

/**
 * The activity feed with its list and table alternatives and the switcher between them. An entry for a row moved to
 * Trash offers Restore while the row is still restorable (Section 11.7).
 */
export function ActivityFeedViews({
  views,
  view,
  restorable = {},
  ...feed
}: Omit<ComponentProps<typeof ActivityFeed>, "switcher" | "alternative" | "notice" | "trailing"> & {
  views: readonly ActivityView[];
  view: ActivityView;
  /** The rows entries can restore, keyed by entry id (restorableEntries). */
  restorable?: Readonly<Record<string, RestoreTarget>>;
}) {
  const t = useTranslations("activity.feed");
  const format = useFormatter();
  const describe = useDescribe();
  const viewLabel = useTranslations("projects.views");
  const go = useActivityGo();
  const org = usePathname().split("/")[1] ?? "";
  const [restored, setRestored] = useState<string | null>(null);
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
          <span className="ms-auto">{restore(e, d.target)}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <ActivityFeed
      {...feed}
      notice={
        // Always mounted, so a restore is announced although its entry stops offering Restore.
        <p role="status" className={restored ? "m-0 text-text-13 text-success-text" : "sr-only"}>
          {restored}
        </p>
      }
      trailing={restore}
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
