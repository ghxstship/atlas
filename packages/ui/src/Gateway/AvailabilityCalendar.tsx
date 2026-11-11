import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useLocale, usePreferences, useT } from "../lib/context.tsx";
import { monthCells, monthTitle, parseIso, toIso, weekdayNames } from "../lib/format.ts";
import { type AvailabilityCalendarProps } from "./Gateway.types.ts";

/** Available and booked days; booked days are struck through as well as colored. */
export function AvailabilityCalendar({
  month,
  available,
  booked,
}: AvailabilityCalendarProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  const { weekStart: firstDay } = usePreferences();
  const { y, m } = parseIso(month);
  const title = monthTitle(locale, y, m);
  return (
    <div className="flex flex-col gap-12 w-(--ui-popover) max-w-full">
      <strong className="font-semibold">{title}</strong>
      <table aria-label={title} className="border-collapse">
        <thead>
          <tr>
            {weekdayNames(locale, firstDay).map((d) => (
              <th
                key={d}
                scope="col"
                className="h-control-sm text-text-11 font-medium text-text-tertiary"
              >
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthCells(locale, y, m, firstDay).map((week, wi) => (
            <tr key={wi}>
              {week.map((d, di) => {
                if (d === null) return <td key={di} />;
                const iso = toIso(y, m, d);
                const isBooked = booked.includes(iso);
                const isAvailable = !isBooked && available.includes(iso);
                return (
                  <td key={di} className="p-0 text-center">
                    <span
                      className={cx(
                        "inline-grid place-items-center w-(--ui-day-inline) h-(--ui-day-block) rounded-control tabular-nums",
                        isBooked && "bg-bg-hover text-text-tertiary line-through",
                        isAvailable && "ring-(length:--ui-hairline-half) ring-inset ring-success",
                      )}
                    >
                      {d}
                      {isBooked || isAvailable ? (
                        <span className="sr-only">
                          {" "}
                          {isBooked ? t("availability.booked") : t("availability.available")}
                        </span>
                      ) : null}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-8 text-text-secondary">
        <span className="inline-flex items-center gap-4">
          <span
            aria-hidden="true"
            className="inline-block size-icon-12 rounded-mark ring-(length:--ui-hairline-half) ring-inset ring-success"
          />
          {t("availability.available")}
        </span>
        <span className="inline-flex items-center gap-4">
          <span aria-hidden="true" className="inline-block size-icon-12 rounded-mark bg-bg-hover" />
          {t("availability.booked")}
        </span>
      </div>
    </div>
  );
}
