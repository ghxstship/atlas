"use client";

import dynamic from "next/dynamic";
import type { BudgetLine, BudgetLineInput } from "@xos/data/finance";
import { accountForUrid, clientUnitPrice, mergeSavedLine, xyzFor } from "@xos/data/finance";
import { Button, SpreadsheetGrid, ToastRegion, UndoToast, type GridColumn } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  deleteBudgetLinesAction,
  updateBudgetLineAction,
  type ActionState,
} from "@/app/[org]/finance/actions";
import { useCustomFieldColumns } from "@/components/custom-fields/list";
import { useLiveRefresh } from "@/components/live/live-refresh";
import {
  catchUpLine,
  lineSaveOutcome,
  LineSaves,
  linesAfterSave,
  mergeLines,
  savedVersion,
  typedLine,
} from "@/lib/finance/live-lines";
import { BudgetPresence } from "./budget-presence";
import { MoreActions } from "@/components/shell/more-actions";
import { propertyEdit, softDelete, versionChain } from "@/components/undo/entries";
import { undoStack, type UndoResult } from "@xos/ui/undo";
// Drawer and dialog bodies load when opened; the toolbar's buttons stay in this chunk.
import { BudgetVersionsDrawer, LineTransactionsDrawer, QuoteLinesDialog } from "./lazy";
import {
  submit,
  toMajor,
  toMinor,
  type BudgetEditorProps as Props,
  type Cell,
  type GridRow,
} from "./budget-editor-shared";
import { ActionFeedback } from "./kit-action-feedback";
import { useFinanceT } from "./kit-use-finance-t";

/**
 * The budget grid editor (Section 11.6 Grid editor, Section 11.11 Finance): spreadsheet-speed editing
 * of a budget's lines with NULL-aware totals. Each cell edit saves its line against the version it
 * was read at; when someone else saved first, a conflict dialog shows both values and the person
 * chooses (Section 11.7, journey 33). Lines are added one at a time, from catalog elements at a
 * chosen grade with the grade's price or Unpriced (journey 3), or pasted from a spreadsheet as one
 * batch that Undo removes (journey 34). The org's filterable custom fields on budget lines (tags, 3872) show
 * as read-only columns, and Line fields edits one line's custom fields.
 *
 * The grid is live (Section 11.7, gap G-216): a line someone else saves, adds or removes appears
 * without a reload, and Committed follows purchase orders as they are approved, sent, closed or
 * canceled. Lines merge by id. The line with an open cell, and a line whose save is in flight, keep
 * what this person typed and the version they started from, so a later save is still checked against
 * it and nothing is overwritten unseen. Who else has the budget open, and the line each is editing,
 * shows above the grid.
 *
 * Cell edits, pastes and deletes go on the session's undo stack (Section 11.7): Cmd or Ctrl+Z undoes them through the
 * server, and the toast of a paste or a delete acts on the same entry. A save pushes its entry once it commits.
 */

export type { CostCenterOption } from "./budget-editor-shared";

// Each dialog opens from a press this grid already holds, so it loads then, not with the page (ADR 0027).
const dialog = () => import("./budget-editor-dialogs");
const ConflictDialog = dynamic(() => dialog().then((m) => m.ConflictDialog));
const AddLineDialog = dynamic(() => dialog().then((m) => m.AddLineDialog));
const CatalogDialog = dynamic(() => dialog().then((m) => m.CatalogDialog));
const PasteDialog = dynamic(() => dialog().then((m) => m.PasteDialog));
const DeleteLinesDialog = dynamic(() => dialog().then((m) => m.DeleteLinesDialog));
const LineFieldsDialog = dynamic(() => dialog().then((m) => m.LineFieldsDialog));
const DrawDialog = dynamic(() => dialog().then((m) => m.DrawDialog));

/** Lodging on linked lines (B5) loads with the editor only when there are lines, and reads on request. */
const BudgetLodging = dynamic(() => import("./budget-lodging").then((m) => m.BudgetLodging));
export type { BudgetColumnSet } from "./budget-editor-shared";

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
const validBp = (bp: number | null) =>
  bp === null || (Number.isFinite(bp) && bp >= 0 && bp <= 100000);

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
  // The undo stack entry a paste or delete toast shows.
  const [undo, setUndo] = useState<{ entry: number; message: string } | null>(null);
  // The versions this tab's own saves left. An undo of a cell edit saves against the version its edit left, carried
  // past this tab's later saves of the line and never past anyone else's, so it cannot overwrite their change.
  const [chain] = useState(versionChain);
  useEffect(
    () =>
      undoStack.subscribe((event) => {
        if (event.kind === "undone") {
          setUndo((u) => (u?.entry === event.entry.id ? null : u));
        }
      }),
    [],
  );
  // A refusal reads in the catalog's words (finance.refusals), never the database's sentence.
  const undoResult = (result: ActionState, stale = "common.lineUndo"): UndoResult => {
    if (result.ok) return { ok: true };
    const error = result.error;
    if (result.conflict || !error) return { ok: false, message: t(stale) };
    if (error.kind === "refusal") {
      const key = `refusals.${error.rule}`;
      return {
        ok: false,
        message: t.has(key) ? t(key) : t("refusals.unknown", { rule: error.rule }),
      };
    }
    return { ok: false, message: t(`errors.${error.kind}`) };
  };
  /** Deletes or restores lines for an undo or a redo, refreshing the grid either way. */
  const batch = async (ids: readonly string[], restore: boolean) => {
    const result = await submit(deleteBudgetLinesAction, {
      org: props.org,
      ids: ids.join(","),
      ...(restore ? { restore: "1" } : {}),
    });
    setStatus(result);
    // Lines this tab removed leave the page without a line-removed status; restored ones count again.
    if (result.ok) {
      setDeletedHere((current) => {
        const next = new Set(current);
        for (const id of ids) {
          if (restore) next.delete(id);
          else next.add(id);
        }
        return next;
      });
    }
    start(() => router.refresh());
    return undoResult(result);
  };
  /** A paste (restore false) or a delete (restore true) on the stack, with its toast. */
  const pushBatch = (ids: string[], message: string, restore: boolean) =>
    setUndo({
      entry: undoStack.push(
        softDelete({
          label: message,
          toast: false,
          restore: () => batch(ids, restore),
          remove: () => batch(ids, !restore),
        }),
      ).id,
      message,
    });
  /**
   * Saves a line's values for an undo or a redo of a cell edit, against the version the edit left as this tab's own
   * saves carried it on. A save by someone else in between leaves that version behind, and the server refuses. It waits
   * for a save of the line still in flight, holds the line against a page render as a save does, and shows only what
   * the server answered, so a refusal leaves the grid as it is.
   */
  const resave = async (id: string, input: BudgetLineInput, left: string): Promise<UndoResult> => {
    let answer: UndoResult = { ok: false, message: t("common.editUndo") };
    markSaving(id, true);
    const last = await saves.current.run(id, left, async () => {
      const expected = chain.latest(id, left);
      const result = await submit(updateBudgetLineAction, {
        org: props.org,
        id,
        expectedUpdatedAt: expected,
        line: JSON.stringify(input),
      });
      answer = undoResult(result, "common.editUndo");
      const settled = lineSaveOutcome(result);
      if (settled.kind === "saved") {
        chain.record(id, expected, settled.line.updatedAt);
        setLines((current) =>
          current.map((l) => (l.id === id ? mergeSavedLine(l, settled.line) : l)),
        );
        start(() => router.refresh());
      } else if (settled.kind === "removed") {
        setLines((current) => current.filter((l) => l.id !== id));
      }
      return savedVersion(settled);
    });
    if (last) markSaving(id, false);
    return answer;
  };
  const [sheet, setSheet] = useState<
    | "add"
    | "catalog"
    | "paste"
    | "delete"
    | "draw"
    | "fields"
    | "versions"
    | "transactions"
    | "quoteLines"
    | null
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
        // Not a column: the client totals below leave these lines out (acceptance 6).
        excludedFromQuote: l.excludedFromQuote ? 1 : 0,
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
  const otherCurrencyPostings = lines.reduce((sum, l) => sum + l.laborOtherCurrencyCount, 0);
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
  const moneyColumn = (
    key: string,
    label: string,
    extra: Partial<GridColumn> = {},
  ): GridColumn => ({
    key,
    label,
    type: "money",
    currency: props.currency,
    width: 128,
    ...extra,
  });
  const onQuote = (r: GridRow) => r["excludedFromQuote"] !== 1;
  const defaultHint =
    defaultMarkup === null
      ? null
      : t("budgets.columns.markupDefault", { percent: defaultMarkup / 100 });
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
      totalIncludes: onQuote,
      width: 136,
      derive: (r) =>
        r["clientUnitPrice"] === null ||
        r["clientUnitPrice"] === undefined ||
        r["clientUnitPrice"] === ""
          ? null
          : Number(r["quantity"] ?? 0) * Number(r["clientUnitPrice"]),
    }),
    moneyColumn("margin", t("budgets.columns.margin"), {
      total: true,
      totalIncludes: onQuote,
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
    columnSet === "client"
      ? clientColumns
      : columnSet === "forecast"
        ? forecastColumns
        : costColumns;

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
        if (outcome.kind === "saved") {
          const left = outcome.line.updatedAt;
          chain.record(id, version, left);
          start(() => router.refresh());
          undoStack.push(
            propertyEdit({
              label: t("budgets.edited", { number: previous.lineNumber }),
              toast: false,
              before: { line: JSON.stringify(inputOf(previous)) },
              after: { line: JSON.stringify(input) },
              save: (set) => resave(id, JSON.parse(String(set.line)) as BudgetLineInput, left),
            }),
          );
        }
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
      const override = typedClient === inForce ? line.clientUnitPriceMinor : typedClient;
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
        {/* Four actions and More keep the toolbar within five (gate 27); the rest sit in More. */}
        {props.canWrite ? (
          <>
            <Button icon="Plus" onClick={() => setSheet("add")}>
              {t("budgets.addLine")}
            </Button>
            <Button icon="ClipboardPaste" onClick={() => setSheet("paste")}>
              {t("budgets.pasteRows")}
            </Button>
          </>
        ) : null}
        <Button icon="Clock" onClick={() => setSheet("versions")}>
          {t("budgets.versions.open")}
        </Button>
        <Button
          icon="Receipt"
          onClick={() => setSheet("transactions")}
          disabled={selectedLine === null}
        >
          {t("budgets.transactions.open")}
        </Button>
        {props.canWrite ? (
          <MoreActions
            label={t("budgets.more")}
            items={[
              { label: t("budgets.addFromCatalog"), onSelect: () => setSheet("catalog") },
              props.importHref ? { label: t("budgets.importLines"), href: props.importHref } : null,
              {
                label: t("budgets.deleteLines"),
                onSelect: () => setSheet("delete"),
                disabled: lines.length === 0,
              },
              allLines.some((l) => l.lineType === "Contingency")
                ? { label: t("budgets.drawContingency"), onSelect: () => setSheet("draw") }
                : null,
              props.lineFields
                ? {
                    label: t("budgets.lineFields"),
                    onSelect: () => setSheet("fields"),
                    disabled: allLines.length === 0,
                  }
                : null,
              {
                label: t("budgets.quoteLines"),
                onSelect: () => setSheet("quoteLines"),
                disabled: allLines.length === 0,
              },
            ]}
          />
        ) : null}
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
      {otherCurrencyPostings > 0 ? (
        <p role="status" className="m-0 text-text-12 text-warning-text">
          {t("budgets.laborOtherCurrency", { count: otherCurrencyPostings })}
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
      {lines.length > 0 ? (
        <BudgetLodging
          org={props.org}
          budgetId={props.budgetId}
          lines={lines}
          exponent={props.exponent}
        />
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
            pushBatch(ids, t("budgets.pasted", { count: ids.length }), false);
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
            pushBatch(ids, t("budgets.deleted", { count: ids.length }), true);
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
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === "quoteLines" ? (
        <QuoteLinesDialog org={props.org} lines={allLines} onClose={() => setSheet(null)} />
      ) : null}
      <ToastRegion label={t("common.notifications")}>
        {undo ? (
          <UndoToast
            key={undo.entry}
            message={undo.message}
            onUndo={() => {
              const target = undo;
              setUndo(null);
              void undoStack.undo(target.entry);
            }}
            onExpire={() => setUndo(null)}
          />
        ) : null}
      </ToastRegion>
    </div>
  );
}
