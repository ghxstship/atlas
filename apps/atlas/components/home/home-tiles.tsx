"use client";

import { ActivityFeedItem, StatTile } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import type { HomeTilesData } from "@/lib/home/data";
import { useDescribe } from "@/components/activity/activity-feed";
import { useAlertText } from "./home-views";

function Tile({
  id,
  title,
  href,
  children,
}: {
  id: string;
  title: string;
  href: string | null;
  children: React.ReactNode;
}) {
  const t = useTranslations("home.dashboard");
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-12 rounded-card border border-border-subtle bg-bg-surface p-16"
    >
      <header className="flex items-center justify-between gap-8">
        <h2 id={id} className="m-0 text-heading-16 font-semibold">
          {title}
        </h2>
        {href ? (
          <Link href={href as Route} className="text-text-13 text-accent-text underline">
            {t("seeAll")}
            <span className="sr-only"> {title}</span>
          </Link>
        ) : null}
      </header>
      {children}
    </section>
  );
}

/** The Home dashboard tiles A07 adds under the checklist (Dashboard template, Section 11.6). */
export function HomeTiles({
  org,
  tiles,
  links,
  now,
}: {
  org: string;
  tiles: HomeTilesData;
  /** Server time the tiles were read at, so relative times render the same on server and client. */
  now: string;
  links: { readiness: string; alerts: string; activity: string | null };
}) {
  const t = useTranslations("home.dashboard");
  const r = useTranslations("home.readiness");
  const p = useTranslations("projects");
  const format = useFormatter();
  const describe = useDescribe();
  const alertText = useAlertText();
  return (
    <div className="mt-16 flex flex-col gap-16">
      <div className="grid grid-cols-1 gap-16 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label={t("activeProjects")} value={tiles.active} caption={t("activeCaption")} />
        <StatTile
          label={t("blockedProjects")}
          value={tiles.blocked}
          caption={t("blockedCaption")}
        />
        <StatTile label={t("dueToday")} value={tiles.dueToday} caption={t("dueCaption")} />
        <StatTile label={t("openBlockers")} value={tiles.openBlockers} caption={t("openCaption")} />
      </div>
      <div className="grid grid-cols-1 gap-16 lg:grid-cols-3">
        <Tile id="home-readiness" title={t("readinessTitle")} href={links.readiness}>
          {tiles.readiness.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("noReadiness")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
              {tiles.readiness.map((x) => (
                <li key={x.project.id} className="flex flex-col gap-2 py-8">
                  <Link
                    href={`/${org}/p/${x.project.key}/gates` as Route}
                    className="text-text-14 text-accent-text underline"
                  >
                    {x.project.key} {x.project.name}
                  </Link>
                  <span className="text-text-12 text-text-secondary">
                    {x.closed || !x.phase
                      ? r("closed")
                      : `${p("gates.gate", { gate: x.phase.gate })} · ${r("met", {
                          met: x.blockingMet,
                          total: x.blockingTotal,
                        })}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Tile>
        <Tile id="home-alerts" title={t("alertsTitle")} href={links.alerts}>
          {tiles.alerts.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("noAlerts")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-8 p-0 text-text-13">
              {tiles.alerts.map((a) => (
                <li key={a.id}>{alertText(a)}</li>
              ))}
            </ul>
          )}
        </Tile>
        <Tile id="home-activity" title={t("recentTitle")} href={links.activity}>
          {tiles.activity.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("noActivity")}</p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-4 p-0">
              {tiles.activity.map((e) => {
                const d = describe(e);
                return (
                  <li key={e.id}>
                    <ActivityFeedItem
                      actor={d.actor}
                      action={d.action}
                      target={d.target}
                      time={format.relativeTime(new Date(e.at), new Date(now))}
                    />
                  </li>
                );
              })}
            </ol>
          )}
        </Tile>
      </div>
    </div>
  );
}
