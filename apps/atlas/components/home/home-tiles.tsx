"use client";

import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { HomeTilesData } from "@/lib/home/data";
import { ActivityLine } from "@/components/activity/activity-line";
import { collapseRepeats, useDescribe } from "@/components/activity/describe";

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

/**
 * The Home dashboard tiles A07 adds under the checklist, each one tile of the Dashboard template
 * (Section 11.6, A129). Alert texts and relative activity times arrive formatted by the server:
 * building Intl date and relative-time formatters during hydration was the largest part of Home's
 * main-thread work on a slow CPU (gate 10, Total Blocking Time).
 */
export function ReadinessTile({
  org,
  readiness,
  href,
}: {
  org: string;
  readiness: HomeTilesData["readiness"];
  href: string;
}) {
  const t = useTranslations("home.dashboard");
  const r = useTranslations("home.readiness");
  const p = useTranslations("projects");
  return (
    <Tile id="home-readiness" title={t("readinessTitle")} href={href}>
      {readiness.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("noReadiness")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {readiness.map((x) => (
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
  );
}

/** The alerts tile; each alert's text arrives formatted, by id. */
export function AlertsTile({
  alerts,
  text,
  href,
}: {
  alerts: HomeTilesData["alerts"];
  text: Readonly<Record<string, string>>;
  href: string;
}) {
  const t = useTranslations("home.dashboard");
  return (
    <Tile id="home-alerts" title={t("alertsTitle")} href={href}>
      {alerts.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("noAlerts")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-8 p-0 text-text-13">
          {alerts.map((a) => (
            <li key={a.id}>{text[a.id]}</li>
          ))}
        </ul>
      )}
    </Tile>
  );
}

/** Recent activity; each entry's relative time arrives formatted, by id. */
export function ActivityTile({
  activity,
  times,
  href,
}: {
  activity: HomeTilesData["activity"];
  times: Readonly<Record<string, string>>;
  href: string | null;
}) {
  const t = useTranslations("home.dashboard");
  const describe = useDescribe();
  return (
    <Tile id="home-activity" title={t("recentTitle")} href={href}>
      {activity.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("noActivity")}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-4 p-0">
          {collapseRepeats(activity, describe).map(({ entry: e, description, count }) => (
            <li key={e.id}>
              <ActivityLine description={description} count={count} time={times[e.id] ?? ""} />
            </li>
          ))}
        </ol>
      )}
    </Tile>
  );
}
