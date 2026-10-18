import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Avatar } from "../Avatar/Avatar.tsx";
import { StateIcon } from "../StateIcon/StateIcon.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";
import { type ResourceScheduleProps } from "./Charts.types.ts";

/** People against days with their shifts; double bookings are flagged in place. A native table. */
export function ResourceSchedule({ label, days, people }: ResourceScheduleProps): ReactElement {
  const t = useT();
  return (
    <ScrollRegion label={label}>
      <table className="w-full border-collapse text-text-13">
        <caption className="pb-8 text-start font-semibold">{label}</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="h-control-lg px-12 text-start font-medium text-text-12 text-text-secondary bg-bg-surface border-b border-border-subtle"
            >
              {t("resource.person")}
            </th>
            {days.map((d) => (
              <th
                key={d.key}
                scope="col"
                className={cx(
                  "h-control-lg px-12 text-start font-medium text-text-12 border-b border-border-subtle",
                  d.weekend ? "bg-bg-surface" : "bg-bg-surface",
                )}
              >
                <span className="text-text-secondary">{d.dow}</span>{" "}
                <span className="tabular-nums">{d.date}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <tr key={p.name}>
              <th
                scope="row"
                className="px-12 py-6 text-start font-regular border-b border-border-subtle"
              >
                <span className="flex items-center gap-8 whitespace-nowrap">
                  <Avatar name={p.name} />
                  <span className="flex flex-col">
                    <span>{p.name}</span>
                    <span className="text-text-secondary">{p.role}</span>
                  </span>
                </span>
              </th>
              {days.map((d) => {
                const shifts = (p.shifts ?? []).filter((s) => s.day === d.key);
                const clash = shifts.length > 1;
                return (
                  <td
                    key={d.key}
                    className={cx(
                      "min-w-(--space-64) px-12 py-6 align-top border-b border-border-subtle",
                      d.weekend && "bg-bg-surface",
                      clash && "ring-(length:--stroke-width-focus) ring-inset ring-danger",
                    )}
                  >
                    {shifts.map((s, i) => (
                      <span
                        key={i}
                        className="flex items-center gap-4 mb-2 px-6 py-2 rounded-chip bg-bg-hover text-text-12"
                      >
                        <StateIcon state={s.state} size={12} />
                        <span className="tabular-nums">{s.time}</span>
                      </span>
                    ))}
                    {clash ? (
                      <span className="flex items-center gap-4 text-text-11 font-medium text-danger-text">
                        <Icon name="TriangleAlert" size={12} />
                        {t("resource.doubleBooked")}
                      </span>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
