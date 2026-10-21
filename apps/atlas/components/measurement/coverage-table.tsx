import type { EarnedMediaItem } from "@xos/data/measurements";
import type { ReactNode } from "react";
import { SimpleTable } from "@/components/finance/figures";
import { figureText, mediumLabel, toneLabel, type MeasurementT } from "./format";

/**
 * Earned media coverage (gate 8, A98): each piece with its day, linked headline, outlet, medium, reach (Unmeasured
 * when the source reports none) and tone (Unrated until someone rates it). Server-rendered; the gate 8 panel passes
 * its withdraw control per row, the report passes none.
 */
export function CoverageTable({
  t,
  locale,
  date,
  items,
  withdraw,
}: {
  t: MeasurementT;
  locale: string;
  date: (iso: string | null) => string;
  items: readonly EarnedMediaItem[];
  withdraw: ((item: EarnedMediaItem) => ReactNode) | null;
}) {
  return (
    <SimpleTable
      caption={t("coverage.title")}
      head={[
        t("fields.publishedOn"),
        t("fields.headline"),
        t("fields.outlet"),
        t("fields.medium"),
        t("fields.reach"),
        t("fields.tone"),
        ...(withdraw ? [t("actions")] : []),
      ]}
      numeric={[4]}
      rows={items.map((item) => [
        date(item.publishedOn),
        item.url ? (
          <a
            key="h"
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-text underline"
          >
            {item.title}
          </a>
        ) : (
          item.title
        ),
        item.outlet,
        mediumLabel(t, item.medium),
        figureText(t, locale, item.reach, "count"),
        toneLabel(t, item.tone),
        ...(withdraw ? [withdraw(item)] : []),
      ])}
    />
  );
}
