import { useState, type ReactElement } from "react";
import type { BudgetLine, GLAccount } from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useFormat, useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Money } from "../Forms/Forms.tsx";
import { SegmentedControl } from "../Navigation/Navigation.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";
import { type BudgetGridProps, type Grade } from "./Grids.types.ts";
import { glForCode } from "./glForCode.tsx";

function blank(v: number | null | undefined): v is null | undefined {
  return v === null || v === undefined;
}

/**
 * Budget lines grouped by GL account in numeric order, with a grade toggle. Posting and amounts are
 * derived, never stored; any unpriced line makes its subtotal and the total Unpriced.
 */
export function BudgetGrid({
  accounts,
  accountType = "Expense",
  lines,
  grades,
  grade: initial = "base",
  scopeLabel,
  label,
  onGradeChange,
}: BudgetGridProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  const [grade, setGrade] = useState<Grade>(initial);
  const amount = (l: BudgetLine): number | null => {
    const rate = l[grade];
    if (blank(rate)) return null;
    if (l.qty === undefined) return rate;
    return blank(l.qty) ? null : l.qty * rate;
  };
  const sum = (ls: BudgetLine[]): number | null => {
    let total = 0;
    for (const l of ls) {
      const a = amount(l);
      if (a === null) return null;
      total += a;
    }
    return ls.length ? total : null;
  };
  const groups = new Map<string, { account: GLAccount | null; lines: BudgetLine[] }>();
  for (const l of lines) {
    const account = glForCode(l.urid, accounts, accountType);
    const key = account?.code ?? "~";
    const group = groups.get(key) ?? { account, lines: [] };
    group.lines.push(l);
    groups.set(key, group);
  }
  const ordered = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, g]) => g);
  const hasQty = lines.some((l) => l.qty !== undefined);
  const heads = [
    t("budget.gl"),
    t("budget.costCenter"),
    t("budget.urid"),
    t("budget.line"),
    ...(hasQty ? [t("budget.qty"), t("budget.rate")] : []),
    t("budget.amount"),
  ];
  const lead = heads.length - 1;
  const th = cx(
    "h-control-lg px-12 font-medium text-text-12 text-text-secondary bg-bg-surface border-b border-border-subtle",
  );
  const td = cx("h-row-default px-12 border-b border-border-subtle whitespace-nowrap");
  return (
    <div className="flex flex-col gap-12">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <SegmentedControl
          label={t("budget.grade")}
          value={grade}
          options={grades}
          onChange={(g) => {
            setGrade(g as Grade);
            onGradeChange?.(g);
          }}
        />
        {scopeLabel ? <span className="text-text-secondary">{scopeLabel}</span> : null}
      </div>
      <ScrollRegion label={label ?? t("scroll.region")}>
        <table className="w-full border-collapse text-text-13">
          <thead>
            <tr>
              {heads.map((h, i) => (
                <th key={h} scope="col" className={cx(th, i >= 4 ? "text-end" : "text-start")}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          {ordered.map((g) => (
            <tbody key={g.account?.code ?? "unmapped"}>
              <tr className="bg-bg-surface">
                <th scope="rowgroup" colSpan={lead} className={cx(td, "text-start font-regular")}>
                  {g.account ? (
                    <span className="font-mono text-text-12">{g.account.code}</span>
                  ) : (
                    <span className="text-warning">
                      <Icon name="TriangleAlert" size={14} />
                    </span>
                  )}{" "}
                  <strong className="font-semibold">
                    {g.account?.name ?? t("budget.unmapped")}
                  </strong>
                </th>
                <td className={cx(td, "text-end font-semibold")}>
                  <Money amount={sum(g.lines)} />
                </td>
              </tr>
              {g.lines.map((l, i) => (
                <tr key={`${l.urid}-${i}`} className="hover:bg-bg-hover">
                  <td className={td} />
                  <td className={cx(td, "font-mono text-text-12 text-text-secondary")}>{l.cc}</td>
                  <td className={td}>
                    <span className="font-mono text-text-12">{l.urid}</span>
                  </td>
                  <td className={cx(td, "whitespace-normal")}>
                    {l.name}
                    {l.type ? <span className="text-text-secondary"> · {l.type}</span> : null}
                  </td>
                  {hasQty ? (
                    <td className={cx(td, "text-end tabular-nums")}>
                      {blank(l.qty) ? "" : fmt.number(l.qty)}
                      {l.unit ? <span className="text-text-secondary"> {l.unit}</span> : null}
                    </td>
                  ) : null}
                  {hasQty ? (
                    <td className={cx(td, "text-end")}>
                      <Money amount={l[grade]} />
                    </td>
                  ) : null}
                  <td className={cx(td, "text-end")}>
                    <Money amount={amount(l)} />
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
          <tfoot>
            <tr>
              <th
                scope="row"
                colSpan={lead}
                className={cx(td, "text-start font-semibold bg-bg-surface")}
              >
                {t("table.total")}
              </th>
              <td className={cx(td, "text-end font-semibold bg-bg-surface")}>
                <Money amount={sum(lines)} />
              </td>
            </tr>
          </tfoot>
        </table>
      </ScrollRegion>
    </div>
  );
}
