"use client";

import dynamic from "next/dynamic";
import type {
  BudgetLine,
  BudgetLineInput,
  BudgetLineType,
  CatalogElement,
  XyzTag,
} from "@xos/data/finance";
import { BUDGET_LINE_TYPES, xyzFor } from "@xos/data/finance";
import { Button, Combobox, Dialog, Drawer, Input, Select, Textarea } from "@xos/ui";
import { useLocale } from "next-intl";
import { useActionState, useEffect, useMemo, useState, useTransition } from "react";
import {
  addBudgetLinesAction,
  deleteBudgetLinesAction,
  drawContingencyAction,
  searchCatalogAction,
  type ActionState,
} from "@/app/[org]/finance/actions";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import type { SettledSave } from "@/components/live/live-refresh";
import { lineConflictFields, type LineConflictField } from "@/lib/finance/live-lines";
import { parsePastedLines } from "@/lib/finance/paste";
import { submit, type BudgetEditorProps as Props } from "./budget-editor-shared";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useFinanceT } from "./kit-use-finance-t";

/**
 * The budget grid's dialogs (budget-editor.tsx): the conflict choice, adding, pasting and deleting lines, line fields
 * and drawing contingency. Each opens from a press the grid already holds, so they load then, not with the page (ADR
 * 0027).
 */

// The Line fields drawer's editor loads when the drawer opens, inside this already-lazy chunk.
const CustomFieldsSection = dynamic(() =>
  import("@/components/custom-fields/custom-fields-section").then((m) => m.CustomFieldsSection),
);

export function ConflictDialog({
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
  const locale = useLocale();
  const money = (minor: number | null) =>
    minor === null
      ? t("common.unpriced")
      : new Intl.NumberFormat(locale, { style: "currency", currency }).format(
          minor / 10 ** exponent,
        );
  const percent = (bp: number | null) =>
    bp === null
      ? t("common.none")
      : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(
          bp / 10000,
        );
  const quantity = new Intl.NumberFormat(locale);
  const onQuoteLabel = (excluded: boolean) => (excluded ? t("common.no") : t("common.yes"));
  const { mine, theirs } = conflict;
  const row: Record<LineConflictField, { label: string; mine: string; theirs: string }> = {
    description: {
      label: t("budgets.columns.description"),
      mine: mine.description,
      theirs: theirs.description,
    },
    urid: { label: t("budgets.columns.urid"), mine: mine.urid, theirs: theirs.urid },
    quantity: {
      label: t("budgets.columns.quantity"),
      mine: quantity.format(mine.quantity),
      theirs: quantity.format(theirs.quantity),
    },
    unitPrice: {
      label: t("budgets.columns.unitPrice"),
      mine: money(mine.unitPriceMinor),
      theirs: money(theirs.unitPriceMinor),
    },
    markup: {
      label: t("budgets.columns.markup"),
      mine: percent(mine.markupBp ?? null),
      theirs: percent(theirs.markupBp),
    },
    clientPrice: {
      label: t("budgets.columns.clientUnitPrice"),
      mine: money(mine.clientUnitPriceMinor ?? null),
      theirs: money(theirs.clientUnitPriceMinor),
    },
    onQuote: {
      label: t("budgets.columns.onQuote"),
      mine: onQuoteLabel(mine.excludedFromQuote ?? false),
      theirs: onQuoteLabel(theirs.excludedFromQuote),
    },
    etc: {
      label: t("budgets.columns.etc"),
      mine: money(mine.etcMinor ?? null),
      theirs: money(theirs.etcMinor),
    },
  };
  const fields = lineConflictFields(mine, theirs).map((field) => row[field]);
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

/**
 * Adds lines through the editor's settled save: the action's answer carries the page with the new
 * lines, and the dialog closes before that page is on screen, so the editor's transition holds the
 * live refreshes their own rows cause until it is.
 */
function useAddLines(
  settle: SettledSave,
  org: string,
  budgetId: string,
  onDone: (ids: string[]) => void,
) {
  const [state, setState] = useState<ActionState>({});
  const [pending, start] = useTransition();
  const add = (lines: BudgetLineInput[]) =>
    start(async () => {
      const result = await settle(() =>
        submit(addBudgetLinesAction, { org, budgetId, lines: JSON.stringify(lines) }),
      );
      setState(result);
      if (result.ok) onDone([...(result.ids ?? [])]);
    });
  return { state, pending, add };
}

export function AddLineDialog(props: Props & { onClose: () => void; settle: SettledSave }) {
  const t = useFinanceT();
  const { state, pending, add } = useAddLines(props.settle, props.org, props.budgetId, () =>
    props.onClose(),
  );
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

export function CatalogDialog(props: Props & { onClose: () => void; settle: SettledSave }) {
  const t = useFinanceT();
  const [search, run, searching] = useActionState(searchCatalogAction, {});
  const { state, pending, add } = useAddLines(props.settle, props.org, props.budgetId, () =>
    props.onClose(),
  );
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

export function PasteDialog(
  props: Props & { onClose: () => void; onPasted: (ids: string[]) => void; settle: SettledSave },
) {
  const t = useFinanceT();
  const [text, setText] = useState("");
  const { state, pending, add } = useAddLines(
    props.settle,
    props.org,
    props.budgetId,
    props.onPasted,
  );
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

export function DeleteLinesDialog(
  props: Props & {
    lines: readonly BudgetLine[];
    onClose: () => void;
    onDeleted: (ids: string[]) => void;
    settle: SettledSave;
  },
) {
  const t = useFinanceT();
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
                const result = await props.settle(() =>
                  submit(deleteBudgetLinesAction, { org: props.org, ids: selected.join(",") }),
                );
                setState(result);
                if (result.ok) props.onDeleted(selected);
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
export function LineFieldsDialog({
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

export function DrawDialog(props: Props & { lines: readonly BudgetLine[]; onClose: () => void }) {
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
