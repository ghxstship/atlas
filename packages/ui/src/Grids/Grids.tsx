import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { Direction } from "radix-ui";
import type {
  BidSheetProps as ReferenceBidSheetProps,
  BudgetGridProps as ReferenceBudgetGridProps,
  BudgetLine,
  GLAccount,
  GridColumn,
  SpreadsheetGridProps as ReferenceSpreadsheetGridProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useFormat, useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Money } from "../Forms/Forms.tsx";
import { InlineAlert } from "../Feedback/Feedback.tsx";
import { SegmentedControl } from "../Navigation/Navigation.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";

type Cell = string | number | null;
type Row = Record<string, Cell>;

export type SpreadsheetGridProps = ReferenceSpreadsheetGridProps & {
  /** Called with every row after an edit, clear or paste. */
  onChange?: (rows: Row[]) => void;
};
export type BudgetGridProps = ReferenceBudgetGridProps & {
  onGradeChange?: (grade: string) => void;
};
export type BidSheetProps = ReferenceBidSheetProps & {
  onChange?: (lines: ReferenceBidSheetProps["lines"]) => void;
};

function isNumeric(c: GridColumn): boolean {
  return c.type === "money" || c.type === "number" || c.type === "multiplier";
}

function editable(c: GridColumn): boolean {
  return Boolean(c.editable) && !c.derive;
}

/** A typed cell value: blank is null, numbers parse (a trailing x on multipliers is dropped), text stays text. */
export function parseCell(c: GridColumn, text: string): Cell {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!isNumeric(c)) return trimmed;
  const n = Number(trimmed.replace(/x$/i, "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Column total, or null when any line is blank (the silence rule). */
export function columnTotal(rows: Row[], key: string): number | null {
  let sum = 0;
  let any = false;
  for (const r of rows) {
    const v = r[key];
    if (v === null || v === undefined || v === "") return null;
    sum += Number(v);
    any = true;
  }
  return any ? sum : null;
}

/**
 * Spreadsheet-speed editing as an ARIA grid (the accessible model a Glide Data Grid surface keeps):
 * arrows and Tab move, Enter or typing edits, Escape cancels, Delete clears to Unpriced, and a paste
 * from Excel fills the range from the selected cell. Derived columns are read-only.
 */
export function SpreadsheetGrid({
  label,
  columns,
  rows: given,
  totalsLabel,
  onChange,
}: SpreadsheetGridProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  const dir = Direction.useDirection();
  const [rows, setRows] = useState<Row[]>(() => given.map((r) => ({ ...r })));
  const [sel, setSel] = useState<[number, number]>([0, 0]);
  const [editing, setEditing] = useState<{ draft: string } | null>(null);
  const cells = useRef(new Map<string, HTMLTableCellElement>());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) input.current?.focus();
    else cells.current.get(`${sel[0]}:${sel[1]}`)?.focus({ preventScroll: false });
  }, [sel, editing]);

  const commit = (next: Row[]) => {
    setRows(next);
    onChange?.(next);
  };
  const setCell = (r: number, c: number, value: Cell) => {
    const col = columns[c];
    if (!col || !editable(col)) return;
    commit(rows.map((row, i) => (i === r ? { ...row, [col.key]: value } : row)));
  };
  const show = (col: GridColumn, row: Row): ReactNode => {
    const v = col.derive ? col.derive(row) : row[col.key];
    if (col.type === "money")
      return (
        <Money
          amount={typeof v === "number" ? v : null}
          {...(col.currency ? { currency: col.currency } : {})}
        />
      );
    if (v === null || v === undefined || v === "") return null;
    if (col.type === "multiplier" && typeof v === "number") {
      return (
        <span className="tabular-nums">
          {t("fmt.multiplier", {
            n: new Intl.NumberFormat(fmt.locale, {
              minimumFractionDigits: 1,
              maximumFractionDigits: 2,
            }).format(v),
          })}
        </span>
      );
    }
    if (col.type === "code") return <span className="font-mono text-text-12">{String(v)}</span>;
    if (col.type === "number" && typeof v === "number")
      return <span className="tabular-nums">{fmt.number(v)}</span>;
    return String(v);
  };

  const move = (dr: number, dc: number) =>
    setSel(([r, c]) => [
      Math.max(0, Math.min(rows.length - 1, r + dr)),
      Math.max(0, Math.min(columns.length - 1, c + dc)),
    ]);

  const onKeyDown = (e: KeyboardEvent<HTMLTableCellElement>) => {
    if (editing) return;
    const [r, c] = sel;
    const col = columns[c];
    const forward = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    const back = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      [forward]: [0, 1],
      [back]: [0, -1],
    };
    const step = e.key === "Tab" ? ([0, e.shiftKey ? -1 : 1] as [number, number]) : moves[e.key];
    if (
      step &&
      !(e.key === "Tab" && ((e.shiftKey && c === 0) || (!e.shiftKey && c === columns.length - 1)))
    ) {
      e.preventDefault();
      move(step[0], step[1]);
    } else if (e.key === "Home") {
      e.preventDefault();
      setSel(e.ctrlKey || e.metaKey ? [0, 0] : [r, 0]);
    } else if (e.key === "End") {
      e.preventDefault();
      setSel(
        e.ctrlKey || e.metaKey ? [rows.length - 1, columns.length - 1] : [r, columns.length - 1],
      );
    } else if ((e.key === "Enter" || e.key === "F2") && col && editable(col)) {
      e.preventDefault();
      const v = rows[r]?.[col.key];
      setEditing({ draft: v === null || v === undefined ? "" : String(v) });
    } else if ((e.key === "Delete" || e.key === "Backspace") && col && editable(col)) {
      e.preventDefault();
      setCell(r, c, null);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && col && editable(col)) {
      e.preventDefault();
      setEditing({ draft: e.key });
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTableElement>) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text || editing) return;
    e.preventDefault();
    const grid = text
      .replace(/\r/g, "")
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => line.split("\t"));
    const next = rows.map((row) => ({ ...row }));
    grid.forEach((line, dr) => {
      line.forEach((value, dc) => {
        const r = sel[0] + dr;
        const col = columns[sel[1] + dc];
        const row = next[r];
        if (row && col && editable(col)) row[col.key] = parseCell(col, value);
      });
    });
    commit(next);
  };

  const finish = (save: boolean, draft: string) => {
    const col = columns[sel[1]];
    if (save && col) setCell(sel[0], sel[1], parseCell(col, draft));
    setEditing(null);
  };

  const th = cx(
    "h-control-lg px-12 font-medium text-text-12 text-text-secondary bg-bg-surface border-b border-e border-border-subtle",
  );
  const td = cx(
    "relative h-control-lg px-12 border-b border-e border-border-subtle whitespace-nowrap",
  );
  return (
    <div className="flex flex-col gap-6">
      <ScrollRegion label={label}>
        <table
          role="grid"
          aria-label={label}
          aria-rowcount={rows.length + 2}
          onPaste={onPaste}
          className="w-full border-collapse text-text-13"
        >
          <thead>
            <tr aria-rowindex={1}>
              <th scope="col" className={cx(th, "w-(--space-40) text-center")}>
                <span className="sr-only">{t("grid.row")}</span>
              </th>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cx(th, isNumeric(c) ? "text-end" : "text-start")}
                  style={c.width ? { inlineSize: c.width } : undefined}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} aria-rowindex={ri + 2}>
                <td
                  className={cx(
                    td,
                    "text-center text-text-11 text-text-tertiary bg-bg-surface tabular-nums",
                  )}
                >
                  {ri + 1}
                </td>
                {columns.map((c, ci) => {
                  const on = sel[0] === ri && sel[1] === ci;
                  const isEditing = on && editing !== null;
                  return (
                    <td
                      key={c.key}
                      ref={(el) => {
                        if (el) cells.current.set(`${ri}:${ci}`, el);
                        else cells.current.delete(`${ri}:${ci}`);
                      }}
                      role="gridcell"
                      aria-selected={on}
                      aria-readonly={editable(c) ? undefined : true}
                      tabIndex={on ? 0 : -1}
                      title={c.derive ? t("grid.derived") : undefined}
                      onClick={() => setSel([ri, ci])}
                      onDoubleClick={() => {
                        setSel([ri, ci]);
                        if (editable(c)) {
                          const v = row[c.key];
                          setEditing({ draft: v === null || v === undefined ? "" : String(v) });
                        }
                      }}
                      onKeyDown={onKeyDown}
                      className={cx(
                        td,
                        isNumeric(c) && "text-end",
                        !editable(c) && "text-text-secondary",
                        on && "ring-(length:--stroke-width-focus) ring-inset ring-accent",
                        "outline-none forced-colors:border",
                      )}
                    >
                      {isEditing ? (
                        <input
                          ref={input}
                          aria-label={c.label}
                          defaultValue={editing.draft}
                          onBlur={(e) => finish(true, e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") {
                              finish(true, e.currentTarget.value);
                              move(1, 0);
                            } else if (e.key === "Escape") finish(false, "");
                            else if (e.key === "Tab") {
                              e.preventDefault();
                              finish(true, e.currentTarget.value);
                              move(0, e.shiftKey ? -1 : 1);
                            }
                          }}
                          className="w-full border-0 bg-transparent outline-none text-inherit text-text-13 tabular-nums"
                        />
                      ) : (
                        show(c, row)
                      )}
                      {on && !isEditing && editable(c) ? (
                        <span
                          aria-hidden="true"
                          className="absolute -end-(--stroke-width-focus) -bottom-(--stroke-width-focus) z-base size-(--space-6) bg-accent border border-bg-canvas"
                        />
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr aria-rowindex={rows.length + 2}>
              <td className={cx(td, "bg-bg-surface")} />
              {columns.map((c, i) => (
                <td
                  key={c.key}
                  className={cx(td, "font-semibold bg-bg-surface", isNumeric(c) && "text-end")}
                >
                  {c.total ? (
                    <Money
                      amount={columnTotal(
                        rows.map((r) => (c.derive ? { ...r, [c.key]: c.derive(r) ?? null } : r)),
                        c.key,
                      )}
                      {...(c.currency ? { currency: c.currency } : {})}
                    />
                  ) : i === 0 ? (
                    (totalsLabel ?? t("table.total"))
                  ) : null}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </ScrollRegion>
      <p className="m-0 text-text-11 text-text-secondary">{t("grid.hint")}</p>
    </div>
  );
}

/** The account a role code or URID posts to: its class's one account of the requested type, or null. */
export function glForCode(
  code: string,
  accounts: GLAccount[],
  type: GLAccount["type"] = "Expense",
): GLAccount | null {
  const cls = code.split(".")[0];
  return accounts.find((a) => a.classCode === cls && a.type === type) ?? null;
}

type Grade = "base" | "elevated" | "premium";

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

/** A sealed line-item bid: unit prices are the only editable cells; extended amounts and the total are derived and stay Unpriced while any line is blank. */
export function BidSheet({ deadline, lines, onChange }: BidSheetProps): ReactElement {
  const t = useT();
  const columns: GridColumn[] = [
    { key: "line", label: t("bid.line"), type: "code", width: 64 },
    { key: "item", label: t("bid.item") },
    { key: "unit", label: t("bid.unit"), width: 72 },
    { key: "qty", label: t("bid.qty"), type: "number", width: 64 },
    { key: "price", label: t("bid.unitPrice"), type: "money", editable: true },
    {
      key: "ext",
      label: t("bid.extended"),
      type: "money",
      total: true,
      derive: (row) =>
        typeof row["qty"] === "number" && typeof row["price"] === "number"
          ? row["qty"] * row["price"]
          : null,
    },
  ];
  return (
    <div className="flex flex-col gap-12">
      <InlineAlert tone="info" title={t("bid.sealed")}>
        {t("bid.sealedBody", { deadline })}
      </InlineAlert>
      <SpreadsheetGrid
        label={t("bid.lines")}
        columns={columns}
        rows={lines.map((l) => ({
          line: l.line,
          item: l.item,
          unit: l.unit,
          qty: l.qty,
          price: l.price,
          ext: l.ext,
        }))}
        totalsLabel={t("bid.total")}
        onChange={(rows) =>
          onChange?.(
            rows.map((r) => ({
              line: String(r["line"] ?? ""),
              item: String(r["item"] ?? ""),
              unit: String(r["unit"] ?? ""),
              qty: Number(r["qty"] ?? 0),
              price: typeof r["price"] === "number" ? r["price"] : null,
              ext:
                typeof r["qty"] === "number" && typeof r["price"] === "number"
                  ? r["qty"] * r["price"]
                  : null,
            })),
          )
        }
      />
    </div>
  );
}
