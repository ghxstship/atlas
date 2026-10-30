import { listMembers } from "@xos/data";
import {
  DEFAULT_FEED_SOURCES,
  listMyCalendarFeeds,
  type CalendarFeedSummary,
} from "@xos/data/calendar-feeds";
import { CUE_CALL_KINDS, CUE_CALL_SLUGS } from "@xos/data/cue-calls";
import { departmentsInUse, getDepartmentsInUse } from "@xos/data/org-setup";
import { listProjectOptions } from "@xos/data/procurement";
import { listDepartments } from "@xos/data/projects";
import { listTeams } from "@xos/data/views";
import { getFormatter } from "next-intl/server";
import {
  AddCalendarFeedForm,
  CalendarFeedActions,
  type FeedPickers,
} from "@/components/settings/calendar-feed-forms";
import { InlineAlert } from "@/components/ui";
import { getTranslate } from "@/lib/shell/translate";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A84's settings panel (RRR-129, finding A65-018, Section 4.6.5): Personal settings, Calendar
 * Feeds lists the member's live feeds in this org (their own schedule or a project's), with the
 * last four characters of each link, and adds, re-links and revokes them. Every role holds
 * me.calendar_feeds.write at own reach, so the controls always show; the 1410 RPCs decide. It reads
 * with the viewer's client, so row level security shows only the viewer's own feeds. Each feed shows
 * its name (or the default one) and a one-line summary of what it serves and for whom (B7).
 */

const P = "platform.calendarFeeds";

type Translate = Awaited<ReturnType<typeof getTranslate>>;

/** "Shows shifts and cues · Team: Load-In Crew · Lighting calls": what a feed serves and for whom. */
function filterSummary(t: Translate, feed: CalendarFeedSummary, pickers: FeedPickers): string {
  const sources = (feed.sources ?? DEFAULT_FEED_SOURCES).map((s) =>
    t(`${P}.sources.${s.toLowerCase()}`),
  );
  const labelOf = (list: FeedPickers["people"], value: string) =>
    list.find((o) => o.value === value)?.label ?? value;
  const audience = feed.audience;
  const parts = [t(`${P}.filterSummary`, { sources: sources.join(", ") })];
  if (audience?.kind === "team")
    parts.push(`${t(`${P}.audience.team`)}: ${labelOf(pickers.teams, audience.teamId)}`);
  if (audience?.kind === "department")
    parts.push(
      `${t(`${P}.audience.department`)}: ${labelOf(pickers.departments, audience.departmentCode)}`,
    );
  if (audience?.kind === "people")
    parts.push(
      `${t(`${P}.audience.people`)}: ${audience.personIds.map((p) => labelOf(pickers.people, p)).join(", ")}`,
    );
  if (feed.cueCallKind) parts.push(labelOf(pickers.callKinds, feed.cueCallKind));
  return parts.join(" · ");
}

async function CalendarFeedsPanel({ ctx }: SettingsPanelProps) {
  const [t, format, feeds, projects, members, teams, departments, inUse] = await Promise.all([
    getTranslate(),
    getFormatter(),
    listMyCalendarFeeds(ctx.viewer.db, ctx.org.id),
    listProjectOptions(ctx.viewer.db, ctx.org.id),
    listMembers(ctx.viewer.db, ctx.org.id),
    listTeams(ctx.viewer.db, ctx.org.id),
    listDepartments(ctx.viewer.db),
    getDepartmentsInUse(ctx.viewer.db, ctx.org.id),
  ]);
  if (!feeds.ok || !projects.ok) {
    return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  }
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium" });
  const pickers: FeedPickers = {
    people: (members.ok ? members.data : []).map((m) => ({
      value: m.personId,
      label: m.fullName ?? m.personId,
    })),
    teams: (teams.ok ? teams.data : []).map((team) => ({ value: team.id, label: team.name })),
    departments: (departments.ok
      ? departmentsInUse(departments.data, inUse.ok ? inUse.data.departments : [])
      : []
    ).map((d) => ({ value: d.code, label: `${d.label} · ${d.code}` })),
    callKinds: CUE_CALL_KINDS.map((k) => ({
      value: k,
      label: t(`${P}.showDepartments.${CUE_CALL_SLUGS[k]}`),
    })),
  };
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
              feed.name ??
              (feed.projectId === null
                ? t(`${P}.mine`)
                : t(`${P}.projectFeed`, { project: feed.projectName ?? feed.projectKey ?? "" }));
            return (
              <li key={feed.id} className="flex flex-wrap items-start justify-between gap-12 py-12">
                <div className="flex min-w-0 flex-col gap-4">
                  <span className="text-label-13 font-medium">{name}</span>
                  {feed.name && feed.projectId !== null ? (
                    <span className="text-text-12 text-text-secondary">
                      {t(`${P}.projectFeed`, {
                        project: feed.projectName ?? feed.projectKey ?? "",
                      })}
                    </span>
                  ) : null}
                  <span className="text-text-12 text-text-secondary">
                    {filterSummary(t, feed, pickers)}
                  </span>
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
                <CalendarFeedActions
                  org={ctx.org.slug}
                  id={feed.id}
                  name={name}
                  projectFeed={feed.projectId !== null}
                  values={{
                    name: feed.name,
                    sources: feed.sources,
                    audience: feed.audience,
                    cueCallKind: feed.cueCallKind,
                  }}
                  pickers={pickers}
                />
              </li>
            );
          })}
        </ul>
      )}
      <AddCalendarFeedForm
        org={ctx.org.slug}
        pickers={pickers}
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
