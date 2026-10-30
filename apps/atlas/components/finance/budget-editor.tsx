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
  extendedMinor,
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
import { parsePastedLines } from "@/lib/finance/paste";
import { BudgetPresence } from "./budget-presence";
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
 */

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
  readonly lines: readonly BudgetLine[];
  readonly urids: readonly UridOption[];
  readonly accounts: readonly GlAccount[];
  readonly costCenters: readonly CostCenterOption[];
  readonly grades: readonly Grade[];
  readonly canWrite: boolean;
}

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
  };
}

async function submit<T extends Record<string, string>>(
  action: (s: ActionState, f: FormData) => Promise<ActionState>,
  values: T,
): Promise<ActionState> {
  const form = new FormData();
  for (const [k, v] of Object.entries(values)) form.set(k, v);
  return action({}, form);
}

/**
 * Lines from a new page render merged into the editor's lines by id: rows added or removed elsewhere
 * come and go, and a line takes the page's version unless it is held (its cell is open or its save is
 * in flight) or the page's version is older than the one held, which a refresh that started before
 * this tab's own save can carry.
 */
function mergeLines(
  current: readonly BudgetLine[],
  incoming: readonly BudgetLine[],
  held: ReadonlySet<string>,
): BudgetLine[] {
  const mine = new Map(current.map((l) => [l.id, l]));
  return incoming.map((line) => {
    const known = mine.get(line.id);
    if (!known) return line;
    if (held.has(line.id) || line.updatedAt < known.updatedAt) return known;
    return line;
  });
}

export function BudgetEditor(props: Props) {
  const t = useFinanceT();
  const router = useRouter();
  const [lines, setLines] = useState<BudgetLine[]>(() => [...props.lines]);
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
  const [sheet, setSheet] = useState<"add" | "catalog" | "paste" | "delete" | "draw" | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [, start] = useTransition();
  // Saves in flight per line, chained so a second edit saves against the version the first returns.
  const inflight = useRef(new Map<string, Promise<string | null>>());
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
    setLines((current) => mergeLines(current, props.lines, held));
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

  // One array per change of the lines, so the grid merges rows only when they change.
  const rows: GridRow[] = useMemo(
    () =>
      lines.map((l) => ({
        id: l.id,
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
      })),
    [lines, centerCode, props.exponent, t],
  );
  const withheld = lines.some((l) => l.committedWithheld);
  const otherCurrencyLines = lines.flatMap((l, i) =>
    l.otherCurrencyPoLineCount > 0 ? [i + 1] : [],
  );
  const editingLine = editingId ? lines.findIndex((l) => l.id === editingId) + 1 || null : null;

  const columns: GridColumn[] = [
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
  ];

  /**
   * Saves a line against the version it was read at. The typed values show at once; a refusal puts
   * the line back, a conflict opens the dialog, and a line deleted elsewhere is dropped. A second
   * edit of a line whose save is still in flight waits for it and saves against its new version.
   */
  const save = async (previous: BudgetLine, input: BudgetLineInput, expected: string) => {
    const id = previous.id;
    setLines((current) =>
      current.map((l) =>
        l.id === id
          ? { ...l, ...input, extendedMinor: extendedMinor(input.quantity, input.unitPriceMinor) }
          : l,
      ),
    );
    markSaving(id, true);
    const before = inflight.current.get(id);
    const run = (async (): Promise<string | null> => {
      const version = before ? ((await before) ?? expected) : expected;
      const result = await submit(updateBudgetLineAction, {
        org: props.org,
        id,
        expectedUpdatedAt: version,
        line: JSON.stringify(input),
      });
      if (result.conflict) {
        setConflict({ mine: input, theirs: result.conflict, previous });
        return null;
      }
      if (result.error?.kind === "not-found") {
        // Named by the grid row it showed on, as the presence and currency captions name lines.
        setRemovedLine(lines.findIndex((l) => l.id === id) + 1 || previous.lineNumber);
        setLines((current) => current.filter((l) => l.id !== id));
        setStatus({});
        return null;
      }
      setStatus(result);
      if (result.line) {
        const saved = result.line;
        setLines((current) =>
          current.map((l) => (l.id === saved.id ? mergeSavedLine(l, saved) : l)),
        );
        start(() => router.refresh());
        return saved.updatedAt;
      }
      setLines((current) => current.map((l) => (l.id === id ? previous : l)));
      return null;
    })();
    inflight.current.set(id, run);
    await run;
    if (inflight.current.get(id) === run) {
      inflight.current.delete(id);
      markSaving(id, false);
    }
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
      const changed =
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
      const input: BudgetLineInput = {
        ...inputOf(line),
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
    if (key !== null || closed === null || inflight.current.has(closed)) return;
    setLines((current) => {
      const theirs = props.lines.find((l) => l.id === closed);
      const mine = current.find((l) => l.id === closed);
      if (!theirs || !mine || theirs.updatedAt < mine.updatedAt) return current;
      return current.map((l) => (l.id === closed ? theirs : l));
    });
  };

  const gridError = status.fieldErrors?.["grid"];

  return (
    <div className="flex flex-col gap-12">
      {props.canWrite ? (
        <div role="toolbar" aria-label={t("budgets.toolbar")} className="flex flex-wrap gap-8">
          <Button icon="Plus" onClick={() => setSheet("add")}>
            {t("budgets.addLine")}
          </Button>
          <Button icon="Package" onClick={() => setSheet("catalog")}>
            {t("budgets.addFromCatalog")}
          </Button>
          <Button icon="ClipboardPaste" onClick={() => setSheet("paste")}>
            {t("budgets.pasteRows")}
          </Button>
          <Button icon="Trash2" onClick={() => setSheet("delete")} disabled={lines.length === 0}>
            {t("budgets.deleteLines")}
          </Button>
          {lines.some((l) => l.lineType === "Contingency") ? (
            <Button icon="ArrowRightLeft" onClick={() => setSheet("draw")}>
              {t("budgets.drawContingency")}
            </Button>
          ) : null}
        </div>
      ) : null}
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
        />
      )}
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
            setSheet(null);
            setUndo({ ids, message: t("budgets.deleted", { count: ids.length }), restore: true });
          }}
        />
      ) : null}
      {sheet === "draw" ? (
        <DrawDialog {...props} lines={lines} onClose={() => setSheet(null)} />
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
