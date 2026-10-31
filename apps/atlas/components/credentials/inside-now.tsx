"use client";

import { Button } from "@xos/ui";
import type { InsideZone } from "@xos/data/credentials";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { loadInsideNow } from "@/lib/credentials/actions";

/** How often the section reads the counts again while it is not paused (WCAG 2.2.2 lets the viewer pause it). */
const REFRESH_MS = 30_000;

/**
 * The scan log's Inside now section (B8, gap G-145, app.zone_counts_live): each zone of the project with the people
 * scanned into it now, by code and name, its total, and a disclosure with the split by category and by team. It
 * reads the counts again every 30 seconds, shows when it last did, and can be paused. Loaded with next/dynamic from
 * the scan log page, so no other page carries its code.
 */
export function InsideNow({
  org,
  projectKey,
  initial,
  timeZone,
}: {
  org: string;
  projectKey: string;
  initial: { readonly zones: readonly InsideZone[]; readonly at: string };
  timeZone: string;
}) {
  const t = useTranslations("credentials.insideNow");
  const format = useFormatter();
  const [data, setData] = useState(initial);
  const [paused, setPaused] = useState(false);

  const refresh = useCallback(async () => {
    const next = await loadInsideNow(org, projectKey);
    if (next) setData(next);
  }, [org, projectKey]);

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [paused, refresh]);

  const time = format.dateTime(new Date(data.at), { timeStyle: "medium", timeZone });
  return (
    <section aria-labelledby="inside-now" className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <h2 id="inside-now" className="m-0 text-text-14 font-semibold">
          {t("title")}
        </h2>
        <div className="flex flex-wrap items-center gap-8">
          <p className="m-0 text-text-12 text-text-secondary" aria-live="polite">
            {t("updated", { time })}
          </p>
          <Button
            variant="secondary"
            size="sm"
            aria-pressed={paused}
            onClick={() => {
              setPaused((p) => !p);
              if (paused) void refresh();
            }}
          >
            {paused ? t("resume") : t("pause")}
          </Button>
        </div>
      </div>
      <p className="m-0 text-text-13 text-text-secondary">{t("what")}</p>
      {data.zones.length === 0 ? (
        <p className="m-0 text-text-13">{t("empty")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {data.zones.map((zone) => (
            <li key={zone.zoneId} className="py-6">
              <details>
                <summary className="flex min-h-target-coarse cursor-pointer flex-wrap items-center justify-between gap-8 text-text-13">
                  <span className="font-semibold">
                    <span className="font-mono">{zone.code}</span> · {zone.name}
                  </span>
                  <span>{t("total", { count: zone.total })}</span>
                </summary>
                <div className="grid gap-12 pt-8 sm:grid-cols-2">
                  <Breakdown title={t("byCategory")} parts={zone.byCategory} none={t("noTeam")} />
                  <Breakdown title={t("byTeam")} parts={zone.byTeam} none={t("noTeam")} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Breakdown({
  title,
  parts,
  none,
}: {
  title: string;
  parts: InsideZone["byCategory"];
  none: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="m-0 text-text-12 font-semibold text-text-secondary">{title}</h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0 text-text-13">
        {parts.map((p) => (
          <li key={p.id ?? "none"} className="flex justify-between gap-8">
            <span>{p.label ?? none}</span>
            <span className="tabular-nums">{p.inside}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
