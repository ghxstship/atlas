import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { Icon } from "../Icon/Icon.tsx";
import { ComparisonScroll } from "./ComparisonScroll.tsx";
import { marketingCopy } from "./marketing-copy.ts";
import { type ComparisonTableProps, type ComparisonValue } from "./Marketing.types.ts";

const CELL: Record<ComparisonValue, { icon: string; key: string }> = {
  yes: { icon: "CircleCheck", key: "mk.cmp.yes" },
  partial: { icon: "CircleDot", key: "mk.cmp.partial" },
  no: { icon: "CircleMinus", key: "mk.cmp.no" },
  unpublished: { icon: "CircleDashed", key: "mk.cmp.unpublished" },
};

/**
 * A like-for-like comparison in a real table. Every cell carries a word beside its icon, the
 * caption states when the cells were last verified, and a cell may link to its source. Explicit
 * roles keep the table a table when it stacks into cards below bp-md.
 */
export function ComparisonTable({
  caption,
  verified,
  featureLabel,
  columns,
  rows,
  footnote,
  locale,
  messages,
}: ComparisonTableProps): ReactElement {
  const { t } = marketingCopy({ locale, messages });
  return (
    <div className="xos-mkt-cmp">
      <ComparisonScroll label={caption}>
        <table className="xos-mkt-cmp-table" role="table">
          <caption>
            <span>{caption}</span>
            {verified ? (
              <span className="xos-mkt-cmp-verified">
                {t("mk.cmp.verified", { date: verified })}
              </span>
            ) : null}
          </caption>
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader">
                {featureLabel ?? t("mk.cmp.feature")}
              </th>
              {columns.map((column) => (
                <th
                  key={column.name}
                  scope="col"
                  role="columnheader"
                  className={column.highlight ? "xos-mkt-cmp-own" : undefined}
                >
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {rows.map((row) => (
              <tr key={row.feature} role="row">
                <th scope="row" role="rowheader">
                  {row.feature}
                </th>
                {row.cells.map((cell, index) => {
                  const column = columns[index];
                  const mark = CELL[cell.value] ?? CELL.unpublished;
                  return (
                    <td
                      key={column?.name ?? index}
                      role="cell"
                      data-label={column?.name}
                      className={column?.highlight ? "xos-mkt-cmp-own" : undefined}
                    >
                      <span
                        className={cx(
                          "xos-mkt-cmp-cell",
                          cell.value === "yes" && "xos-mkt-cmp-yes",
                          cell.value === "partial" && "xos-mkt-cmp-partial",
                          cell.value === "no" && "xos-mkt-cmp-no",
                          cell.value === "unpublished" && "xos-mkt-cmp-unpublished",
                        )}
                      >
                        <Icon name={mark.icon} size={14} />
                        <span>{cell.text ?? t(mark.key)}</span>
                      </span>
                      {cell.source ? (
                        <a className="xos-mkt-cmp-src" href={cell.source.href}>
                          {cell.source.label}
                        </a>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </ComparisonScroll>
      {footnote ? <p className="xos-mkt-note">{footnote}</p> : null}
    </div>
  );
}
