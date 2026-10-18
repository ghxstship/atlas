import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { codeClass } from "../Chips/Chips.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";
import { tableClass, tdClass, thClass } from "./XOS.shared.tsx";
import { type RadioChannelTableProps } from "./XOS.types.ts";

/** The radio plan, always sorted by zone then channel; notes wrap so it reads on a phone. */
export function RadioChannelTable({ caption, channels }: RadioChannelTableProps): ReactElement {
  const t = useT();
  const sorted = [...channels].sort((a, b) => a.zone - b.zone || a.channel - b.channel);
  return (
    <ScrollRegion label={caption ?? t("scroll.region")}>
      <table className={tableClass}>
        {caption ? <caption className="pb-8 text-start font-semibold">{caption}</caption> : null}
        <thead>
          <tr>
            {["radio.zone", "radio.channel", "radio.assignment", "radio.notes"].map((k) => (
              <th key={k} scope="col" className={thClass}>
                {t(k)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => (
            <tr key={`${c.zone}.${c.channel}`}>
              <td className={cx(tdClass, "tabular-nums")}>{c.zone}</td>
              <td className={tdClass}>
                <span className={codeClass}>{c.channel}</span>
              </td>
              <td className={tdClass}>
                <strong className="font-semibold">{c.assignment}</strong>
              </td>
              <td
                className={cx(
                  tdClass,
                  "whitespace-normal py-8 min-w-(--ui-skeleton-inline) text-text-secondary",
                )}
              >
                {c.notes}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
