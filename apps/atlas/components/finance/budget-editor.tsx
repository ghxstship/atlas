"use client";

import type {
  BudgetLine,
  BudgetLineInput,
  BudgetLineType,
  CatalogElement,
  GlAccount,
  Grade,
  UridOption,
  XyzTag,
} from "@xos/data/finance";
import {
  accountForUrid,
  BUDGET_LINE_TYPES,
  clientUnitPrice,
  mergeSavedLine,
  xyzFor,
} from "@xos/data/finance";
import {
  Button,
  Combobox,
  Dialog,
  Drawer,
  Input,
  Select,
  SpreadsheetGrid,
  Textarea,
  ToastRegion,
  UndoToast,
  type GridColumn,
} from "@xos/ui";
import dynamic from "next/dynamic";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  addBudgetLinesAction,
  deleteBudgetLinesAction,
  drawContingencyAction,
  searchCatalogAction,
  updateBudgetLineAction,
  type ActionState,
} from "@/app/[org]/finance/actions";
import { useLiveRefresh } from "@/components/live/live-refresh";
import type { PresenceMe } from "@/components/presence/presence";
import {
  catchUpLine,
  lineSaveOutcome,
  LineSaves,
  linesAfterSave,
  mergeLines,
  savedVersion,
  typedLine,
} from "@/lib/finance/live-lines";
import { useCustomFieldColumns } from "@/components/custom-fields/list";
import { parsePastedLines } from "@/lib/finance/paste";
import { BudgetPresence } from "./budget-presence";
// Drawer and dialog bodies load when opened; the toolbar's buttons stay in this chunk.
import { BudgetVersionsDrawer, LineTransactionsDrawer, QuoteLinesDialog } from "./lazy";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useFinanceT } from "./kit-use-finance-t";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
/**
 * The budget grid editor (Section 11.6 Grid editor, Section 11.11 Finance): spreadsheet-speed editing
 * of a budget's lines with NULL-aware totals. Each cell edit saves its line against the version it
 * was read at; when someone else saved first, a conflict dialog shows both values and the person
 * chooses (Section 11.7, journey 33). Lines are added one at a time, from catalog elements at a
 * chosen grade with the grade's price or Unpriced (journey 3), or pasted from a spreadsheet as one
 * batch that Undo removes (journey 34).
 *
 * The grid is live (Section 11.7, gap G-216): a line someone else saves, adds or removes appears
 * without a reload, and Committed follows purchase orders as they are approved, sent, closed or
 * canceled. Lines merge by id. The line with an open cell, and a line whose save is in flight, keep
 * what this person typed and the version they started from, so a later save is still checked against
 * it and nothing is overwritten unseen. Who else has the budget open, and the line each is editing,
 * shows above the grid.
 *
 * The org's filterable custom fields on budget lines (tags, 2872) show as read-only columns, and
 * Line fields edits one line's custom fields.
 */

// The Line fields drawer's editor loads when the drawer opens, inside this already-lazy chunk.
const CustomFieldsSection = dynamic(() =>
  import("@/components/custom-fields/custom-fields-section").then((m) => m.CustomFieldsSection),
);

export interface CostCenterOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

type Cell = string | number | null;
type GridRow = Record<string, Cell>;

interface Props {
  readonly org: string;
  readonly budgetId: string;
  /** The budget's project, whose purchase orders fill Committed. */
  readonly projectId: string;
  /** The viewer, for presence on the budget; null in the moment before their person exists. */
  readonly me: PresenceMe | null;
  readonly currency: string;
  readonly exponent: number;
  /** The lines shown: the whole budget, or those the grid's custom field conditions keep. */
  readonly lines: readonly BudgetLine[];
  /** Every line of the budget, so filtering never hides a contingency source or target; defaults to `lines`. */
  readonly allLines?: readonly BudgetLine[];
  /** The org has custom fields on budget lines, so Line fields is offered (with finance.budget.write). */
  readonly lineFields?: boolean;
  readonly urids: readonly UridOption[];
  readonly accounts: readonly GlAccount[];
  readonly costCenters: readonly CostCenterOption[];
  readonly grades: readonly Grade[];
  readonly canWrite: boolean;
  /** Which columns the grid shows (?columns=), server-rendered links beside the toolbar. */
  readonly columnSet?: BudgetColumnSet;
  /** The budget's default markup in basis points, shown in a line's blank Markup cell. */
  readonly defaultMarkupBp?: number | null;
  /** The sections Transactions may show; a section left out reads as withheld, never partial. */
  readonly transactionAccess?: {
    readonly expenses: boolean;
    readonly labor: boolean;
    readonly purchaseOrders: boolean;
    readonly invoices: boolean;
  };
  /** The import wizard for this budget (Import lines), or null when hidden. */
  readonly importHref?: string | null;
}

export type BudgetColumnSet = "cost" | "client" | "forecast";

const toMajor = (minor: number | null, exponent: number) =>
  minor === null ? null : minor / 10 ** exponent;
const toMinor = (major: Cell, exponent: number): number | null =>
  major === null || major === "" ? null : Math.round(Number(major) * 10 ** exponent);

function inputOf(line: BudgetLine): BudgetLineInput {
  return {
    description: line.description,
    lineType: line.lineType,
    urid: line.urid,
    costCenterId: line.costCenterId,
    gradeCode: line.gradeCode,
    elementId: line.elementId,
    quantity: line.quantity,
    unitBasis: line.unitBasis,
    unitPriceMinor: line.unitPriceMinor,
    xyz: line.xyz,
    xyzBasis: line.xyzBasis,
    markupBp: line.markupBp,
    clientUnitPriceMinor: line.clientUnitPriceMinor,
    excludedFromQuote: line.excludedFromQuote,
    etcMinor: line.etcMinor,
  };
}

/** A percent typed in the grid as basis points; blank is null, never zero. */
const toBp = (percent: Cell): number | null =>
  percent === null || percent === "" ? null : Math.round(Number(percent) * 100);
const validBp = (bp: number | null) => bp === null || (Number.isFinite(bp) && bp >= 0 && bp <= 100000);

async function submit<T extends Record<string, string>>(
  action: (s: ActionState, f: FormData) => Promise<ActionState>,
  values: T,
): Promise<ActionState> {
  const form = new FormData();
  for (const [k, v] of Object.entries(values)) form.set(k, v);
  return action({}, form);
}

export function BudgetEditor(props: Props) {
  const t = useFinanceT();
  const router = useRouter();
  const [lines, setLines] = useState<readonly BudgetLine[]>(props.lines);
  const [gridKey, setGridKey] = useState(0);
  const [status, setStatus] = useState<ActionState>({});
  const [removedLine, setRemovedLine] = useState<number | null>(null);
  const [conflict, setConflict] = useState<{
    mine: BudgetLineInput;
    theirs: BudgetLine;
    previous: BudgetLine;
  } | null>(null);
  const [undo, setUndo] = useState<{ ids: string[]; message: string; restore: boolean } | null>(
    null,
  );
  const [sheet, setSheet] = useState<
    "add" | "catalog" | "paste" | "delete" | "draw" | "fields" | "versions" | "transactions" | "quoteLines" | null
  >(null);
  const [selectedLine, setSelectedLine] = useState<string | null>(null);
  const columnSet = props.columnSet ?? "cost";
  const defaultMarkup = props.defaultMarkupBp ?? null;
  const [editingId, setEditingId] = useState<string | null>(null);
  const custom = useCustomFieldColumns();
  const allLines = props.allLines ?? lines;
  const [, start] = useTransition();
  // Saves in flight per line, chained so a second edit saves against the version the first returns.
  const saves = useRef(new LineSaves());
  // Lines this tab deleted, which leave the page without a line-removed status.
  const [deletedHere, setDeletedHere] = useState<ReadonlySet<string>>(() => new Set());
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(() => new Set());
  const markSaving = (id: string, on: boolean) =>
    setSavingIds((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  // A new page render (a save, a paste, someone else's change, a purchase order approved) merges in.
  const [seenLines, setSeenLines] = useState(props.lines);
  if (props.lines !== seenLines) {
    setSeenLines(props.lines);
    const held = new Set(savingIds);
    if (editingId) held.add(editingId);
    const merged = mergeLines(lines, props.lines, held, deletedHere);
    setLines(merged.lines);
    // A line someone else removed while this person had its cell open: the draft goes with it, and
    // the status says so.
    if (merged.removedRows.length > 0) setRemovedLine(merged.removedRows[0] ?? null);
    if (editingId && !props.lines.some((l) => l.id === editingId)) setEditingId(null);
  }

  useLiveRefresh(
    useMemo(
      () => [
        { table: "budget_lines", filter: `budget_id=eq.${props.budgetId}` },
        { table: "purchase_orders", filter: `project_id=eq.${props.projectId}` },
      ],
      [props.budgetId, props.projectId],
    ),
  );

  const centerCode = useMemo(
    () => new Map(props.costCenters.map((c) => [c.id, c.code])),
    [props.costCenters],
  );
  const centerId = useMemo(
    () => new Map(props.costCenters.map((c) => [c.code, c.id])),
    [props.costCenters],
  );
  const known = useMemo(() => new Set(props.urids.map((u) => u.urid)), [props.urids]);

  // The client price in force, from what this tab holds, so a typed markup shows at once.
  const clientPriceOf = (l: BudgetLine) =>
    l.clientUnitPriceMinor ?? clientUnitPrice(l.unitPriceMinor, l.markupBp ?? defaultMarkup);

  // One array per change of the lines, so the grid merges rows only when they change.
  const rows: GridRow[] = useMemo(
    () =>
      lines.map((l) => ({
        id: l.id,
        markupPercent: l.markupBp === null ? null : l.markupBp / 100,
        clientUnitPrice: toMajor(clientPriceOf(l), props.exponent),
        onQuote: l.excludedFromQuote ? t("common.no") : t("common.yes"),
        remaining: l.forecastWithheld ? null : toMajor(l.remainingCommitmentMinor, props.exponent),
        etc: toMajor(l.etcMinor, props.exponent),
        derivedEtc: l.forecastWithheld ? null : toMajor(l.forecastEtcMinor, props.exponent),
        efc: l.forecastWithheld ? null : toMajor(l.efcMinor, props.exponent),
        varianceAtCompletion: l.forecastWithheld
          ? null
          : toMajor(l.varianceAtCompletionMinor, props.exponent),
        description: l.description,
        urid: l.urid,
        lineType: t(`budgets.lineTypes.${l.lineType}`),
        costCenter: l.costCenterId ? (centerCode.get(l.costCenterId) ?? null) : null,
        quantity: l.quantity,
        unitBasis: l.unitBasis,
        unitPrice: toMajor(l.unitPriceMinor, props.exponent),
        // Blank when withheld or unpriced, so the column total stays blank too (the silence rule).
        committed: l.committedWithheld ? null : toMajor(l.committedMinor, props.exponent),
        actual: toMajor(l.actualMinor, props.exponent),
        ...custom.cells(l.id),
      })),
    // clientPriceOf reads only these lines and the budget's default.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lines, centerCode, props.exponent, t, custom, defaultMarkup],
  );
  const withheld = lines.some((l) => l.committedWithheld);
  const forecastWithheld = lines.some((l) => l.forecastWithheld);
  const unpricedHours = lines.reduce((sum, l) => sum + l.laborUnpricedMinutes, 0) / 60;
  const otherCurrencyLines = lines.flatMap((l, i) =>
    l.otherCurrencyPoLineCount > 0 ? [i + 1] : [],
  );
  const editingLine = editingId ? lines.findIndex((l) => l.id === editingId) + 1 || null : null;

  const descriptionColumn: GridColumn = {
    key: "description",
    label: t("budgets.columns.description"),
    editable: props.canWrite,
    width: 260,
  };
  const moneyColumn = (key: string, label: string, extra: Partial<GridColumn> = {}): GridColumn => ({
    key,
    label,
    type: "money",
    currency: props.currency,
    width: 128,
    ...extra,
  });
  const defaultHint =
    defaultMarkup === null ? null : t("budgets.columns.markupDefault", { percent: defaultMarkup / 100 });
  const clientColumns: GridColumn[] = [
    descriptionColumn,
    { key: "urid", label: t("budgets.columns.urid"), type: "code", width: 120 },
    { key: "lineType", label: t("budgets.columns.lineType"), width: 110 },
    {
      key: "quantity",
      label: t("budgets.columns.quantity"),
      type: "number",
      editable: props.canWrite,
      width: 96,
    },
    moneyColumn("unitPrice", t("budgets.columns.unitPrice"), { editable: props.canWrite }),
    {
      key: "markupPercent",
      label: t("budgets.columns.markup"),
      type: "number",
      editable: props.canWrite,
      width: 96,
      blankHint: () => defaultHint,
    },
    moneyColumn("clientUnitPrice", t("budgets.columns.clientUnitPrice"), {
      editable: props.canWrite,
      width: 144,
    }),
    moneyColumn("clientAmount", t("budgets.columns.clientAmount"), {
      total: true,
      width: 136,
      derive: (r) =>
        r["clientUnitPrice"] === null || r["clientUnitPrice"] === undefined || r["clientUnitPrice"] === ""
          ? null
          : Number(r["quantity"] ?? 0) * Number(r["clientUnitPrice"]),
    }),
    moneyColumn("margin", t("budgets.columns.margin"), {
      total: true,
      derive: (r) =>
        r["clientUnitPrice"] === null ||
        r["clientUnitPrice"] === undefined ||
        r["clientUnitPrice"] === "" ||
        r["unitPrice"] === null ||
        r["unitPrice"] === undefined ||
        r["unitPrice"] === ""
          ? null
          : Number(r["quantity"] ?? 0) * (Number(r["clientUnitPrice"]) - Number(r["unitPrice"])),
    }),
    { key: "onQuote", label: t("budgets.columns.onQuote"), width: 96 },
  ];
  const forecastColumns: GridColumn[] = [
    descriptionColumn,
    { key: "lineType", label: t("budgets.columns.lineType"), width: 110 },
    moneyColumn("actual", t("budgets.columns.actual"), { total: true }),
    moneyColumn("committed", t("budgets.columns.committed"), { total: true }),
    moneyColumn("remaining", t("budgets.columns.remaining"), { total: true, width: 144 }),
    moneyColumn("etc", t("budgets.columns.etc"), {
      editable: props.canWrite,
      width: 144,
      blankHint: (r) => (r["derivedEtc"] === null ? null : String(r["derivedEtc"])),
    }),
    moneyColumn("efc", t("budgets.columns.efc"), { total: true, width: 144 }),
    moneyColumn("varianceAtCompletion", t("budgets.columns.varianceAtCompletion"), {
      total: true,
      width: 160,
    }),
  ];
  const costColumns: GridColumn[] = [
    {
      key: "description",
      label: t("budgets.columns.description"),
      editable: props.canWrite,
      width: 260,
    },
    {
      key: "urid",
      label: t("budgets.columns.urid"),
      type: "code",
      editable: props.canWrite,
      width: 120,
    },
    { key: "lineType", label: t("budgets.columns.lineType"), width: 110 },
    {
      key: "costCenter",
      label: t("budgets.columns.costCenter"),
      type: "code",
      editable: props.canWrite,
      width: 120,
    },
    {
      key: "quantity",
      label: t("budgets.columns.quantity"),
      type: "number",
      editable: props.canWrite,
      width: 96,
    },
    { key: "unitBasis", label: t("budgets.columns.unit"), width: 88 },
    {
      key: "unitPrice",
      label: t("budgets.columns.unitPrice"),
      type: "money",
      currency: props.currency,
      editable: props.canWrite,
      width: 128,
    },
    {
      key: "account",
      label: t("budgets.columns.account"),
      type: "code",
      width: 96,
      derive: (r) => accountForUrid(String(r["urid"] ?? ""), props.accounts)?.code ?? null,
    },
    {
      key: "extended",
      label: t("budgets.columns.extended"),
      type: "money",
      currency: props.currency,
      total: true,
      width: 136,
      derive: (r) =>
        r["unitPrice"] === null || r["unitPrice"] === undefined || r["unitPrice"] === ""
          ? null
          : Number(r["quantity"] ?? 0) * Number(r["unitPrice"]),
    },
    {
      key: "committed",
      label: t("budgets.columns.committed"),
      type: "money",
      currency: props.currency,
      total: true,
      width: 128,
    },
    {
      key: "actual",
      label: t("budgets.columns.actual"),
      type: "money",
      currency: props.currency,
      total: true,
      width: 128,
    },
    // Tags and the other filterable custom fields, read-only here; Line fields edits them.
    ...custom.columns.map((c): GridColumn => ({
      key: c.key,
      label: c.label,
      type: "text",
      editable: false,
      width: 140,
    })),
  ];
  const columns =
    columnSet === "client" ? clientColumns : columnSet === "forecast" ? forecastColumns : costColumns;

  /**
   * Saves a line against the version it was read at. The typed values show at once; a refusal puts
   * the line back, a conflict opens the dialog, and a line deleted elsewhere is dropped. A second
   * edit of a line whose save is still in flight waits for it and saves against its new version.
   */
  const save = async (previous: BudgetLine, input: BudgetLineInput, expected: string) => {
    const id = previous.id;
    // Named by the grid row it showed on, as the presence and currency captions name lines.
    const row = lines.findIndex((l) => l.id === id) + 1 || previous.lineNumber;
    setLines((current) => typedLine(current, id, input));
    markSaving(id, true);
    const last = await saves.current.run(id, expected, async (version) => {
      const result = await submit(updateBudgetLineAction, {
        org: props.org,
        id,
        expectedUpdatedAt: version,
        line: JSON.stringify(input),
      });
      const outcome = lineSaveOutcome(result);
      setLines((current) => linesAfterSave(current, previous, outcome));
      if (outcome.kind === "conflict") {
        setConflict({ mine: input, theirs: outcome.theirs, previous });
      } else if (outcome.kind === "removed") {
        setRemovedLine(row);
        setStatus({});
      } else {
        setStatus(result);
        if (outcome.kind === "saved") start(() => router.refresh());
      }
      return savedVersion(outcome);
    });
    if (last) markSaving(id, false);
  };

  // Grid rows map to lines by id, never by position: rows can move while someone else adds or
  // removes lines. Only a row whose values differ from its line saves.
  const onChange = (next: GridRow[]) => {
    const byId = new Map(lines.map((l) => [l.id, l]));
    for (const row of next) {
      const line = byId.get(String(row["id"] ?? ""));
      if (!line) continue;
      const urid = String(row["urid"] ?? "");
      const code = row["costCenter"] === null ? null : String(row["costCenter"]).toUpperCase();
      const markupBp = toBp(row["markupPercent"] ?? null);
      const typedClient = toMinor(row["clientUnitPrice"] ?? null, props.exponent);
      const etcMinor = toMinor(row["etc"] ?? null, props.exponent);
      // A client price left as the markup gives it stays derived; clearing an override returns to it.
      const inForce = clientPriceOf(line);
      const override =
        typedClient === inForce
          ? line.clientUnitPriceMinor
          : typedClient;
      const changed =
        markupBp !== line.markupBp ||
        override !== line.clientUnitPriceMinor ||
        etcMinor !== line.etcMinor ||
        row["description"] !== line.description ||
        urid !== line.urid ||
        (code ?? null) !==
          (line.costCenterId ? (centerCode.get(line.costCenterId) ?? null) : null) ||
        Number(row["quantity"] ?? 0) !== line.quantity ||
        toMinor(row["unitPrice"] ?? null, props.exponent) !== line.unitPriceMinor;
      if (!changed) continue;
      const problem = (field: string) => {
        setStatus({ error: { kind: "input" }, fieldErrors: { grid: field }, at: Date.now() });
        setGridKey((k) => k + 1);
      };
      if (!row["description"]) return problem("description");
      if (!known.has(urid)) return problem("urid");
      if (code !== null && !centerId.has(code)) return problem("costCenter");
      const xyz = xyzFor(urid, props.urids, line.xyzBasis === "Declared" ? line.xyz : null);
      if (!xyz) return problem("xyz");
      if (!validBp(markupBp)) return problem("markup");
      if (override !== null && !(override >= 0)) return problem("clientPrice");
      if (etcMinor !== null && !(etcMinor >= 0)) return problem("etc");
      const input: BudgetLineInput = {
        ...inputOf(line),
        markupBp,
        clientUnitPriceMinor: override,
        etcMinor,
        description: String(row["description"]),
        urid,
        costCenterId: code === null ? null : (centerId.get(code) ?? null),
        quantity: Math.max(0, Number(row["quantity"] ?? 0)),
        unitPriceMinor: toMinor(row["unitPrice"] ?? null, props.exponent),
        ...xyz,
      };
      setRemovedLine(null);
      void save(line, input, line.updatedAt);
    }
  };

  // When a cell closes without a save, its line catches up with the page.
  const onEditingChange = (key: string | null) => {
    const closed = editingId;
    setEditingId(key);
    if (key !== null || closed === null || saves.current.has(closed)) return;
    setLines((current) => catchUpLine(current, props.lines, closed));
  };

  const gridError = status.fieldErrors?.["grid"];

  return (
    <div className="flex flex-col gap-12">
      <div role="toolbar" aria-label={t("budgets.toolbar")} className="flex flex-wrap gap-8">
        {props.canWrite ? (
          <>
            <Button icon="Plus" onClick={() => setSheet("add")}>
              {t("budgets.addLine")}
            </Button>
            <Button icon="Package" onClick={() => setSheet("catalog")}>
              {t("budgets.addFromCatalog")}
            </Button>
            <Button icon="ClipboardPaste" onClick={() => setSheet("paste")}>
              {t("budgets.pasteRows")}
            </Button>
            {props.importHref ? (
              <Link
                href={props.importHref as Route}
                className="inline-flex h-control-md items-center rounded-control border border-border-subtle px-12 text-text-13 text-text-primary hover:bg-bg-hover"
              >
                {t("budgets.importLines")}
              </Link>
            ) : null}
            <Button icon="Trash2" onClick={() => setSheet("delete")} disabled={lines.length === 0}>
              {t("budgets.deleteLines")}
            </Button>
            {allLines.some((l) => l.lineType === "Contingency") ? (
              <Button icon="ArrowRightLeft" onClick={() => setSheet("draw")}>
                {t("budgets.drawContingency")}
              </Button>
            ) : null}
            {props.lineFields ? (
              <Button
                icon="SlidersHorizontal"
                onClick={() => setSheet("fields")}
                disabled={allLines.length === 0}
              >
                {t("budgets.lineFields")}
              </Button>
            ) : null}
            <Button
              icon="ListChecks"
              onClick={() => setSheet("quoteLines")}
              disabled={allLines.length === 0}
            >
              {t("budgets.quoteLines")}
            </Button>
          </>
        ) : null}
        <Button icon="History" onClick={() => setSheet("versions")}>
          {t("budgets.versions.open")}
        </Button>
        <Button
          icon="Receipt"
          onClick={() => setSheet("transactions")}
          disabled={selectedLine === null}
        >
          {t("budgets.transactions.open")}
        </Button>
      </div>
      {props.me ? (
        <BudgetPresence budgetId={props.budgetId} me={props.me} editingLine={editingLine} />
      ) : null}
      {gridError ? (
        <p role="alert" className="m-0 text-text-13 text-danger-text">
          {t(`budgets.gridErrors.${gridError}`)}
        </p>
      ) : (
        <ActionFeedback state={status} />
      )}
      {removedLine !== null ? (
        <p role="status" className="m-0 text-text-13 text-text-secondary">
          {t("budgets.lineRemoved", { line: removedLine })}
        </p>
      ) : null}
      {lines.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("budgets.noLines")}</p>
      ) : (
        <SpreadsheetGrid
          key={`${props.budgetId}-${gridKey}`}
          label={t("budgets.gridLabel")}
          columns={columns}
          rows={rows}
          totalsLabel={t("common.total")}
          rowKey="id"
          onChange={onChange}
          onEditingChange={onEditingChange}
          onSelectionChange={setSelectedLine}
        />
      )}
      {unpricedHours > 0 ? (
        <p role="status" className="m-0 text-text-12 text-warning-text">
          {t("budgets.unpricedHours", { hours: Math.round(unpricedHours * 100) / 100 })}
        </p>
      ) : null}
      {columnSet === "forecast" && forecastWithheld ? (
        <p className="m-0 text-text-12 text-text-secondary">{t("budgets.committedWithheld")}</p>
      ) : null}
      {lines.length > 0 && withheld ? (
        <p className="m-0 text-text-12 text-text-secondary">{t("budgets.committedWithheld")}</p>
      ) : null}
      {lines.length > 0 && !withheld && otherCurrencyLines.length > 0 ? (
        <p className="m-0 text-text-12 text-text-secondary">
          {t("budgets.committedOtherCurrency", {
            count: otherCurrencyLines.length,
            lines: otherCurrencyLines.join(", "),
          })}
        </p>
      ) : null}
      {conflict ? (
        <ConflictDialog
          conflict={conflict}
          currency={props.currency}
          exponent={props.exponent}
          onKeepMine={() => {
            const { mine, theirs, previous } = conflict;
            setConflict(null);
            void save(mergeSavedLine(previous, theirs), mine, theirs.updatedAt);
          }}
          onTakeTheirs={() => {
            const theirs = conflict.theirs;
            setLines((current) =>
              current.map((l) => (l.id === theirs.id ? mergeSavedLine(l, theirs) : l)),
            );
            setConflict(null);
          }}
        />
      ) : null}
      {sheet === "add" ? <AddLineDialog {...props} onClose={() => setSheet(null)} /> : null}
      {sheet === "catalog" ? <CatalogDialog {...props} onClose={() => setSheet(null)} /> : null}
      {sheet === "paste" ? (
        <PasteDialog
          {...props}
          onClose={() => setSheet(null)}
          onPasted={(ids) => {
            setSheet(null);
            setUndo({ ids, message: t("budgets.pasted", { count: ids.length }), restore: false });
          }}
        />
      ) : null}
      {sheet === "delete" ? (
        <DeleteLinesDialog
          {...props}
          lines={lines}
          onClose={() => setSheet(null)}
          onDeleted={(ids) => {
            setDeletedHere((current) => new Set([...current, ...ids]));
            setSheet(null);
            setUndo({ ids, message: t("budgets.deleted", { count: ids.length }), restore: true });
          }}
        />
      ) : null}
      {sheet === "draw" ? (
        <DrawDialog {...props} lines={allLines} onClose={() => setSheet(null)} />
      ) : null}
      {sheet === "fields" ? (
        <LineFieldsDialog lines={allLines} onClose={() => setSheet(null)} />
      ) : null}
      {sheet === "versions" ? (
        <BudgetVersionsDrawer
          org={props.org}
          budgetId={props.budgetId}
          canWrite={props.canWrite}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === "transactions" && selectedLine ? (
        <LineTransactionsDrawer
          org={props.org}
          lineId={selectedLine}
          currency={props.currency}
          exponent={props.exponent}
          access={
            props.transactionAccess ?? {
              expenses: false,
              labor: false,
              purchaseOrders: false,
              invoices: false,
            }
          }
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === "quoteLines" ? (
        <QuoteLinesDialog org={props.org} lines={allLines} onClose={() => setSheet(null)} />
      ) : null}
      <ToastRegion label={t("common.notifications")}>
        {undo ? (
          <UndoToast
            key={undo.ids.join(",")}
            message={undo.message}
            onUndo={() => {
              const target = undo;
              setUndo(null);
              void submit(deleteBudgetLinesAction, {
                org: props.org,
                ids: target.ids.join(","),
                ...(target.restore ? { restore: "1" } : {}),
              }).then((r) => {
                setStatus(r);
                start(() => router.refresh());
              });
            }}
            onExpire={() => setUndo(null)}
          />
        ) : null}
      </ToastRegion>
    </div>
  );
}

function ConflictDialog({
  conflict,
  currency,
  exponent,
  onKeepMine,
  onTakeTheirs,
}: {
  conflict: { mine: BudgetLineInput; theirs: BudgetLine };
  currency: string;
  exponent: number;
  onKeepMine: () => void;
  onTakeTheirs: () => void;
}) {
  const t = useFinanceT();
  const money = (minor: number | null) =>
    minor === null
      ? t("common.unpriced")
      : new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
          minor / 10 ** exponent,
        );
  const percent = (bp: number | null) => (bp === null ? t("common.none") : `${bp / 100}%`);
  const fields: { label: string; mine: string; theirs: string }[] = [
    {
      label: t("budgets.columns.description"),
      mine: conflict.mine.description,
      theirs: conflict.theirs.description,
    },
    { label: t("budgets.columns.urid"), mine: conflict.mine.urid, theirs: conflict.theirs.urid },
    {
      label: t("budgets.columns.quantity"),
      mine: String(conflict.mine.quantity),
      theirs: String(conflict.theirs.quantity),
    },
    {
      label: t("budgets.columns.unitPrice"),
      mine: money(conflict.mine.unitPriceMinor),
      theirs: money(conflict.theirs.unitPriceMinor),
    },
    {
      label: t("budgets.columns.markup"),
      mine: percent(conflict.mine.markupBp ?? null),
      theirs: percent(conflict.theirs.markupBp),
    },
    {
      label: t("budgets.columns.clientUnitPrice"),
      mine: money(conflict.mine.clientUnitPriceMinor ?? null),
      theirs: money(conflict.theirs.clientUnitPriceMinor),
    },
    {
      label: t("budgets.columns.etc"),
      mine: money(conflict.mine.etcMinor ?? null),
      theirs: money(conflict.theirs.etcMinor),
    },
  ].filter((f) => f.mine !== f.theirs);
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? null : onTakeTheirs())}
      title={t("budgets.conflict.title")}
      description={t("budgets.conflict.sentence")}
      actions={
        <>
          <Button onClick={onTakeTheirs}>{t("budgets.conflict.theirs")}</Button>
          <Button variant="primary" onClick={onKeepMine}>
            {t("budgets.conflict.mine")}
          </Button>
        </>
      }
    >
      <table className="w-full border-collapse text-text-13">
        <caption className="sr-only">{t("budgets.conflict.title")}</caption>
        <thead>
          <tr>
            <th scope="col" className="py-4 text-start font-medium text-text-secondary">
              {t("budgets.conflict.field")}
            </th>
            <th scope="col" className="py-4 text-start font-medium text-text-secondary">
              {t("budgets.conflict.mineColumn")}
            </th>
            <th scope="col" className="py-4 text-start font-medium text-text-secondary">
              {t("budgets.conflict.theirsColumn")}
            </th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.label} className="border-t border-border-subtle">
              <th scope="row" className="py-6 text-start font-medium">
                {f.label}
              </th>
              <td className="py-6">{f.mine}</td>
              <td className="py-6">{f.theirs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

function useAddLines(org: string, budgetId: string, onDone: (ids: string[]) => void) {
  const router = useRouter();
  const [state, setState] = useState<ActionState>({});
  const [pending, start] = useTransition();
  const add = (lines: BudgetLineInput[]) =>
    start(async () => {
      const result = await submit(addBudgetLinesAction, {
        org,
        budgetId,
        lines: JSON.stringify(lines),
      });
      setState(result);
      if (result.ok) {
        router.refresh();
        onDone([...(result.ids ?? [])]);
      }
    });
  return { state, pending, add };
}

function AddLineDialog(props: Props & { onClose: () => void }) {
  const t = useFinanceT();
  const { state, pending, add } = useAddLines(props.org, props.budgetId, () => props.onClose());
  const [urid, setUrid] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const option = props.urids.find((u) => u.urid === urid);
  return (
    <Drawer
      open
      onClose={props.onClose}
      title={t("budgets.addLine")}
      footer={
        <>
          <Button onClick={props.onClose}>{t("common.cancel")}</Button>
          <Button type="submit" form="add-line" variant="primary" loading={pending}>
            {t("budgets.addLine")}
          </Button>
        </>
      }
    >
      <form
        id="add-line"
        className="flex flex-col gap-12"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const description = String(f.get("description") ?? "").trim();
          if (description === "") return setProblem("description");
          if (!option) return setProblem("urid");
          const declared = (String(f.get("xyz") ?? "") || null) as XyzTag | null;
          const xyz = xyzFor(urid, props.urids, declared);
          if (!xyz) return setProblem("xyz");
          const priceText = String(f.get("unitPrice") ?? "").trim();
          const price = priceText === "" ? null : Number(priceText.replace(/,/g, ""));
          if (price !== null && (!Number.isFinite(price) || price < 0))
            return setProblem("unitPrice");
          const quantity = Number(f.get("quantity") || 1);
          if (!Number.isFinite(quantity) || quantity < 0) return setProblem("quantity");
          setProblem(null);
          add([
            {
              description,
              lineType: String(f.get("lineType")) as BudgetLineType,
              urid,
              costCenterId: String(f.get("costCenterId") ?? "") || null,
              gradeCode: null,
              elementId: null,
              quantity,
              unitBasis: null,
              unitPriceMinor: price === null ? null : Math.round(price * 10 ** props.exponent),
              ...xyz,
            },
          ]);
        }}
      >
        <Input
          id="add-line-description"
          name="description"
          required
          width="100%"
          label={t("budgets.columns.description")}
          error={problem === "description" ? t("errors.fields.description") : ""}
        />
        <Combobox
          id="add-line-urid"
          label={t("budgets.columns.urid")}
          help={problem === "urid" ? t("errors.fields.urid") : t("budgets.uridHelp")}
          options={props.urids.map((u) => ({ value: u.urid, label: `${u.name} · ${u.urid}` }))}
          onChange={setUrid}
        />
        <div className="flex flex-wrap gap-12">
          <Select
            id="add-line-type"
            name="lineType"
            label={t("budgets.columns.lineType")}
            value="Cost"
            options={BUDGET_LINE_TYPES.map((v) => ({
              value: v,
              label: t(`budgets.lineTypes.${v}`),
            }))}
          />
          <Select
            id="add-line-xyz"
            name="xyz"
            label={t("budgets.columns.xyz")}
            help={
              option?.xyz
                ? t("budgets.xyzFromCategory", { tag: option.xyz })
                : t("budgets.xyzDeclare")
            }
            error={problem === "xyz" ? t("errors.fields.xyz") : ""}
            value=""
            options={[
              { value: "", label: t("budgets.xyzCategory") },
              { value: "X", label: t("budgets.xyz.X") },
              { value: "Y", label: t("budgets.xyz.Y") },
              { value: "Z", label: t("budgets.xyz.Z") },
            ]}
          />
        </div>
        <div className="flex flex-wrap gap-12">
          <Select
            id="add-line-cc"
            name="costCenterId"
            label={t("budgets.columns.costCenter")}
            value=""
            options={[
              { value: "", label: t("common.none") },
              ...props.costCenters.map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` })),
            ]}
          />
          <Input
            id="add-line-qty"
            name="quantity"
            inputMode="decimal"
            defaultValue="1"
            label={t("budgets.columns.quantity")}
            error={problem === "quantity" ? t("errors.fields.quantity") : ""}
          />
          <Input
            id="add-line-price"
            name="unitPrice"
            inputMode="decimal"
            label={t("budgets.columns.unitPrice")}
            help={t("common.blankIsUnpriced")}
            error={problem === "unitPrice" ? t("errors.fields.unitPrice") : ""}
          />
        </div>
        <ActionFeedback state={state} />
      </form>
    </Drawer>
  );
}

function CatalogDialog(props: Props & { onClose: () => void }) {
  const t = useFinanceT();
  const [search, run, searching] = useActionState(searchCatalogAction, {});
  const { state, pending, add } = useAddLines(props.org, props.budgetId, () => props.onClose());
  const [grade, setGrade] = useState(props.grades[0]?.code ?? "base");
  const [picked, setPicked] = useState<Record<string, number>>({});
  const elements: readonly CatalogElement[] = search.elements ?? [];
  const priceOf = (e: CatalogElement) =>
    e.currency === props.currency ? (e.prices[grade] ?? null) : null;
  const chosen = elements.filter((e) => (picked[e.elementId] ?? 0) > 0);
  return (
    <Drawer
      open
      onClose={props.onClose}
      title={t("budgets.addFromCatalog")}
      footer={
        <>
          <Button onClick={props.onClose}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={chosen.length === 0}
            onClick={() =>
              add(
                chosen.flatMap((e) => {
                  const xyz = xyzFor(e.urid, props.urids, e.xyz);
                  return xyz
                    ? [
                        {
                          description: e.name,
                          lineType: "Cost" as const,
                          urid: e.urid,
                          costCenterId: null,
                          gradeCode: grade,
                          elementId: e.elementId,
                          quantity: picked[e.elementId] ?? 1,
                          unitBasis: null,
                          unitPriceMinor: priceOf(e),
                          ...xyz,
                        },
                      ]
                    : [];
                }),
              )
            }
          >
            {t("budgets.addPicked", { count: chosen.length })}
          </Button>
        </>
      }
    >
      <p className="m-0 text-text-13 text-text-secondary">{t("budgets.catalogSentence")}</p>
      <div className="flex flex-col gap-12">
        <form
          action={run}
          onSubmit={keepInputOnSubmit(run)}
          className="flex flex-wrap items-end gap-8"
        >
          <input type="hidden" name="org" value={props.org} />
          <Input
            id="catalog-search"
            name="search"
            type="search"
            label={t("budgets.catalogSearch")}
          />
          <Button type="submit" loading={searching}>
            {t("common.search")}
          </Button>
          <Select
            id="catalog-grade"
            label={t("budgets.grade")}
            value={grade}
            options={props.grades.map((g) => ({ value: g.code, label: g.label }))}
            onChange={(e) => setGrade(e.target.value)}
          />
        </form>
        {search.error ? <ActionFeedback state={{ error: search.error }} /> : null}
        {search.elements && elements.length === 0 ? (
          <p className="m-0 text-text-13">{t("budgets.catalogEmpty")}</p>
        ) : null}
        {elements.length > 0 ? (
          <ul className="m-0 flex max-h-(--ui-list-max) list-none flex-col divide-y divide-border-subtle overflow-y-auto p-0">
            {elements.map((e) => {
              const price = priceOf(e);
              return (
                <li key={e.elementId} className="flex items-center justify-between gap-12 py-8">
                  <span className="flex min-w-0 flex-col">
                    <span className="text-text-13 text-text-primary">{e.name}</span>
                    <span className="font-mono text-text-11 text-text-secondary">
                      {e.elementId} · {e.urid}
                    </span>
                  </span>
                  <span className="text-text-13 tabular-nums text-text-secondary">
                    {price === null
                      ? t("common.unpriced")
                      : new Intl.NumberFormat(undefined, {
                          style: "currency",
                          currency: props.currency,
                        }).format(price / 10 ** props.exponent)}
                  </span>
                  <Input
                    id={`catalog-qty-${e.elementId}`}
                    width={96}
                    inputMode="decimal"
                    label={t("budgets.columns.quantity")}
                    value={String(picked[e.elementId] ?? "")}
                    onChange={(ev) =>
                      setPicked((p) => ({
                        ...p,
                        [e.elementId]: Math.max(0, Number(ev.target.value) || 0),
                      }))
                    }
                  />
                </li>
              );
            })}
          </ul>
        ) : null}
        <ActionFeedback state={state} />
      </div>
    </Drawer>
  );
}

function PasteDialog(props: Props & { onClose: () => void; onPasted: (ids: string[]) => void }) {
  const t = useFinanceT();
  const [text, setText] = useState("");
  const { state, pending, add } = useAddLines(props.org, props.budgetId, props.onPasted);
  const parsed = useMemo(
    () =>
      text.trim() === ""
        ? null
        : parsePastedLines(text, {
            exponent: props.exponent,
            urids: props.urids,
            costCenters: props.costCenters,
          }),
    [text, props.exponent, props.urids, props.costCenters],
  );
  return (
    <Drawer
      open
      onClose={props.onClose}
      title={t("budgets.pasteRows")}
      footer={
        <>
          <Button onClick={props.onClose}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!parsed || parsed.lines.length === 0 || parsed.problems.length > 0}
            onClick={() => parsed && add(parsed.lines)}
          >
            {t("budgets.addPasted", { count: parsed?.lines.length ?? 0 })}
          </Button>
        </>
      }
    >
      <p className="m-0 text-text-13 text-text-secondary">{t("budgets.pasteSentence")}</p>
      <div className="flex flex-col gap-12">
        <Textarea
          id="paste-rows"
          label={t("budgets.pasteLabel")}
          help={t("budgets.pasteHelp")}
          rows={8}
          width="100%"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {parsed ? (
          <p role="status" className="m-0 text-text-13">
            {t("budgets.pastePreview", {
              count: parsed.lines.length,
              unpriced: parsed.unpricedCount,
              problems: parsed.problems.length,
            })}
          </p>
        ) : null}
        {parsed && parsed.problems.length > 0 ? (
          <ul className="m-0 flex flex-col gap-2 ps-16 text-text-12 text-danger-text">
            {parsed.problems.slice(0, 10).map((p) => (
              <li key={`${p.row}-${p.field}`}>
                {t("budgets.pasteProblem", {
                  row: p.row,
                  field: t(`budgets.pasteFields.${p.field}`),
                })}
              </li>
            ))}
          </ul>
        ) : null}
        <ActionFeedback state={state} />
      </div>
    </Drawer>
  );
}

function DeleteLinesDialog(
  props: Props & {
    lines: readonly BudgetLine[];
    onClose: () => void;
    onDeleted: (ids: string[]) => void;
  },
) {
  const t = useFinanceT();
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [state, setState] = useState<ActionState>({});
  const [pending, start] = useTransition();
  return (
    <Drawer
      open
      onClose={props.onClose}
      title={t("budgets.deleteLines")}
      footer={
        <>
          <Button onClick={props.onClose}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            loading={pending}
            disabled={selected.length === 0}
            onClick={() =>
              start(async () => {
                const result = await submit(deleteBudgetLinesAction, {
                  org: props.org,
                  ids: selected.join(","),
                });
                setState(result);
                if (result.ok) {
                  router.refresh();
                  props.onDeleted(selected);
                }
              })
            }
          >
            {t("budgets.deleteCount", { count: selected.length })}
          </Button>
        </>
      }
    >
      <p className="m-0 text-text-13 text-text-secondary">{t("budgets.deleteSentence")}</p>
      <fieldset className="m-0 flex max-h-(--ui-list-max) flex-col gap-6 overflow-y-auto border-0 p-0">
        <legend className="sr-only">{t("budgets.deleteLines")}</legend>
        {props.lines.map((l) => (
          <label key={l.id} className="flex items-center gap-8 text-text-13 text-text-primary">
            <input
              type="checkbox"
              checked={selected.includes(l.id)}
              onChange={(e) =>
                setSelected((s) => (e.target.checked ? [...s, l.id] : s.filter((x) => x !== l.id)))
              }
            />
            <span className="tabular-nums text-text-secondary">{l.lineNumber}</span>
            {l.description}
          </label>
        ))}
      </fieldset>
      <ActionFeedback state={state} />
    </Drawer>
  );
}

/** Line fields: pick a line, then edit its custom fields (saveCustomFieldsAction, as the 0540 and 2110 rules allow). */
function LineFieldsDialog({
  lines,
  onClose,
}: {
  lines: readonly BudgetLine[];
  onClose: () => void;
}) {
  const t = useFinanceT();
  const [lineId, setLineId] = useState(lines[0]?.id ?? "");
  return (
    <Drawer
      open
      onClose={onClose}
      title={t("budgets.lineFields")}
      footer={<Button onClick={onClose}>{t("common.close")}</Button>}
    >
      <p className="m-0 text-text-13 text-text-secondary">{t("budgets.lineFieldsSentence")}</p>
      <Select
        id="line-fields-line"
        name="lineId"
        label={t("budgets.lineFieldsLine")}
        value={lineId}
        onChange={(e) => setLineId(e.target.value)}
        options={lines.map((l) => ({ value: l.id, label: `${l.lineNumber} · ${l.description}` }))}
      />
      {lineId ? <CustomFieldsSection key={lineId} table="app.budget_lines" id={lineId} /> : null}
    </Drawer>
  );
}

function DrawDialog(props: Props & { lines: readonly BudgetLine[]; onClose: () => void }) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(drawContingencyAction, {});
  const contingency = props.lines.filter((l) => l.lineType === "Contingency");
  const targets = props.lines.filter((l) => l.lineType !== "Contingency");
  const { onClose } = props;
  useEffect(() => {
    if (state.ok) onClose();
  }, [state.ok, state.at, onClose]);
  return (
    <Drawer
      open
      onClose={props.onClose}
      title={t("budgets.drawContingency")}
      footer={
        <>
          <Button onClick={props.onClose}>{t("common.cancel")}</Button>
          <Button type="submit" form="draw-contingency" variant="primary" loading={pending}>
            {t("budgets.drawContingency")}
          </Button>
        </>
      }
    >
      <p className="m-0 text-text-13 text-text-secondary">{t("budgets.drawSentence")}</p>
      <form
        id="draw-contingency"
        action={action}
        onSubmit={keepInputOnSubmit(action)}
        className="flex flex-col gap-12"
      >
        <input type="hidden" name="org" value={props.org} />
        <input type="hidden" name="currency" value={props.currency} />
        <Select
          id="draw-from"
          name="fromLineId"
          label={t("budgets.drawFrom")}
          value={contingency[0]?.id ?? ""}
          options={contingency.map((l) => ({
            value: l.id,
            label: `${l.lineNumber} · ${l.description}`,
          }))}
        />
        <Select
          id="draw-to"
          name="toLineId"
          label={t("budgets.drawTo")}
          value={targets[0]?.id ?? ""}
          options={targets.map((l) => ({
            value: l.id,
            label: `${l.lineNumber} · ${l.description}`,
          }))}
          error={fieldError(t, state, "toLineId")}
        />
        <Input
          id="draw-amount"
          name="amount"
          inputMode="decimal"
          required
          label={t("common.amount")}
          error={fieldError(t, state, "amount")}
        />
        <Textarea
          id="draw-reason"
          name="reason"
          required
          width="100%"
          label={t("common.reason")}
          error={fieldError(t, state, "reason")}
        />
        <ActionFeedback state={state} />
      </form>
    </Drawer>
  );
}
