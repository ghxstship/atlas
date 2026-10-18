import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { chipClass } from "../Chips/Chips.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";
import { RESULT, ResultIcon, tableClass, tdClass, thClass } from "./XOS.shared.tsx";
import { type ReconciliationTableProps, type Result } from "./XOS.types.ts";

/** Requirements against venue capability as Met, Gap or Unknown, with counts. */
export function ReconciliationTable({ label, rows }: ReconciliationTableProps): ReactElement {
  const t = useT();
  const counts: Record<"Met" | "Gap" | "Unknown", number> = { Met: 0, Gap: 0, Unknown: 0 };
  for (const r of rows) counts[r.result] += 1;
  const lower = (r: "Met" | "Gap" | "Unknown") => r.toLowerCase() as Result;
  return (
    <div className="flex flex-col gap-12">
      <div className="flex flex-wrap items-center gap-8">
        {(Object.keys(counts) as ("Met" | "Gap" | "Unknown")[]).map((k) => (
          <span key={k} className={chipClass}>
            <ResultIcon result={lower(k)} t={t} labeled={false} />
            {t(RESULT[lower(k)].key)}
            <span className="tabular-nums text-text-secondary">{counts[k]}</span>
          </span>
        ))}
      </div>
      <ScrollRegion label={label ?? t("scroll.region")}>
        <table className={tableClass}>
          <thead>
            <tr>
              <th scope="col" className={thClass}>
                {t("recon.requirement")}
              </th>
              <th scope="col" className={thClass}>
                {t("recon.capability")}
              </th>
              <th scope="col" className={thClass}>
                {t("recon.result")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.requirement}-${i}`} className="hover:bg-bg-hover">
                <td className={tdClass}>{r.requirement}</td>
                <td className={cx(tdClass, !r.capability && "text-text-secondary")}>
                  {r.capability ?? t("recon.notDeclared")}
                </td>
                <td className={tdClass}>
                  <span className="inline-flex items-center gap-6">
                    <ResultIcon result={lower(r.result)} t={t} labeled={false} />
                    {t(RESULT[lower(r.result)].key)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </div>
  );
}
