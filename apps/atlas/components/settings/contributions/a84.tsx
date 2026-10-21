import { listMyCalendarFeeds } from "@xos/data/calendar-feeds";
import { listProjectOptions } from "@xos/data/procurement";
import { getFormatter } from "next-intl/server";
import {
  AddCalendarFeedForm,
  CalendarFeedActions,
} from "@/components/settings/calendar-feed-forms";
import { InlineAlert } from "@/components/ui";
import { getTranslate } from "@/lib/shell/translate";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A84's settings panel (RRR-129, finding A65-018, Section 4.6.5): Personal settings, Calendar
 * Feeds lists the member's live feeds in this org (their own schedule or a project's), with the
 * last four characters of each link, and adds, re-links and revokes them. Every role holds
 * me.calendar_feeds.write at own reach, so the controls always show; the 1410 RPCs decide. It reads
 * with the viewer's client, so row level security shows only the viewer's own feeds.
 */

const P = "platform.calendarFeeds";

async function CalendarFeedsPanel({ ctx }: SettingsPanelProps) {
  const [t, format, feeds, projects] = await Promise.all([
    getTranslate(),
    getFormatter(),
    listMyCalendarFeeds(ctx.viewer.db, ctx.org.id),
    listProjectOptions(ctx.viewer.db, ctx.org.id),
  ]);
  if (!feeds.ok || !projects.ok) {
    return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  }
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium" });
  return (
    <section aria-labelledby="calendar-feeds" className="flex max-w-layout-form flex-col gap-12">
      <header className="flex flex-col gap-4">
        <h2 id="calendar-feeds" className="m-0 text-heading-16 font-semibold">
          {t(`${P}.title`)}
        </h2>
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.description`)}</p>
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.secret`)}</p>
      </header>
      {feeds.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.none`)}</p>
      ) : (
        <ul
          aria-label={t(`${P}.listLabel`)}
          className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
        >
          {feeds.data.map((feed) => {
            const name =
              feed.projectId === null
                ? t(`${P}.mine`)
                : t(`${P}.projectFeed`, { project: feed.projectName ?? feed.projectKey ?? "" });
            return (
              <li key={feed.id} className="flex flex-wrap items-start justify-between gap-12 py-12">
                <div className="flex min-w-0 flex-col gap-4">
                  <span className="text-label-13 font-medium">{name}</span>
                  <span className="text-text-12 text-text-secondary">
                    {[
                      t(`${P}.hint`, { hint: feed.tokenHint }),
                      feed.rotatedAt
                        ? t(`${P}.rotated`, { date: when(feed.rotatedAt) })
                        : t(`${P}.created`, { date: when(feed.createdAt) }),
                      feed.lastAccessedAt
                        ? t(`${P}.lastFetched`, { date: when(feed.lastAccessedAt) })
                        : t(`${P}.neverFetched`),
                    ].join(" · ")}
                  </span>
                </div>
                <CalendarFeedActions org={ctx.org.slug} id={feed.id} name={name} />
              </li>
            );
          })}
        </ul>
      )}
      <AddCalendarFeedForm
        org={ctx.org.slug}
        projects={projects.data.map((p) => ({
          value: p.id,
          label: t(`${P}.projectFeed`, { project: `${p.key} ${p.name}` }),
        }))}
      />
    </section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "me.calendar-feeds", order: 10, Panel: CalendarFeedsPanel },
];
