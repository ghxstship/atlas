"use client";

import { useFormatter, useNow, useTranslations } from "next-intl";
import { doorsText } from "@/lib/home/today";

/**
 * The doors tile of Home > Today (B6, G-249): how long until the next doors open, or how long ago
 * they did, ticking every 30 seconds, with the event, its project and the doors time in the project's
 * zone. Only Today imports it.
 */
export function DoorsCountdown({
  doorsAt,
  event,
  project,
  venue,
  timeZone,
  href,
}: {
  doorsAt: string;
  event: string;
  project: string;
  venue: string | null;
  timeZone: string | null;
  href: string | null;
}) {
  const t = useTranslations("home.today.tiles.doors");
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const text = doorsText(doorsAt, now);
  const time = format.dateTime(new Date(doorsAt), {
    ...(timeZone ? { timeZone } : {}),
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-heading-20 font-semibold tabular-nums">
        {text.key === "home.today.tiles.doors.none"
          ? t("none")
          : t(text.key === "home.today.tiles.doors.in" ? "in" : "opened", {
              hours: text.hours,
              minutes: text.minutes,
            })}
      </p>
      <p className="m-0 text-text-13">
        {href ? (
          <a
            href={href}
            className="font-medium text-text-primary underline-offset-2 hover:underline"
          >
            {event}
          </a>
        ) : (
          <span className="font-medium">{event}</span>
        )}
        <span className="text-text-secondary">
          {" · "}
          {venue ? t("where", { project, venue }) : project}
        </span>
      </p>
      <p className="m-0 text-text-12 text-text-secondary">{t("time", { time })}</p>
    </div>
  );
}
