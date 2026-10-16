"use client";

import {
  aggregatesFor,
  CHART_TYPES,
  FILTER_OPERATORS,
  previewCsv,
  REPORT_SOURCES,
  type Aggregate,
  type ChartType,
  type FilterOperator,
  type PreviewCell,
  type ReportDefinition,
  type ReportPreview,
} from "@xos/data/report-builder";
import { Button, Chart, Checkbox, IconButton, InlineAlert, Input, Select, StatTile } from "@xos/ui";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import { useId, useState, useTransition } from "react";
import {
  deleteDefinitionAction,
  previewAction,
  queueRunAction,
  saveDefinitionAction,
} from "@/app/[org]/reports/builder/actions";
import type { WorkflowActionState } from "@/lib/workflow/state";
import { Feedback, useWorkflowT } from "./kit";

interface Draft {
  id: string | null;
  name: string;
  sourceCode: string;
  chart: ChartType;
  groupBy: string | null;
  shared: boolean;
  fields: { field: string; aggregate: Aggregate }[];
  filters: { field: string; operator: FilterOperator; value: string | null }[];
}

function fromDefinition(d: ReportDefinition | null): Draft {
  if (d) {
    return {
      id: d.id,
      name: d.name,
      sourceCode: d.sourceCode,
      chart: d.chart,
      groupBy: d.groupBy,
      shared: d.shared,
      fields: d.fields.map((f) => ({ ...f })),
      filters: d.filters.map((f) => ({ ...f })),
    };
  }
  const source = REPORT_SOURCES[0];
  return {
    id: null,
    name: "",
    sourceCode: source?.code ?? "records",
    chart: "Table",
    groupBy: null,
    shared: false,
    fields: source?.fields[0] ? [{ field: source.fields[0].key, aggregate: "None" }] : [],
    filters: [],
  };
}

/**
 * The report builder (Section 4.6.4): source, fields with NULL-aware aggregates, filters, one
 * grouping and a chart, previewed live as the viewer. Money totals stay blank while an input is
 * unpriced, with the unpriced count beside them. Saved reports can be queued as a run.
 */
export function ReportBuilder({
  org,
  initial,
  editable,
  canExport,
  exponents,
}: {
  org: string;
  initial: ReportDefinition | null;
  editable: boolean;
  canExport: boolean;
  exponents: Readonly<Record<string, number>>;
}) {
  const t = useWorkflowT();
  const locale = useLocale();
  const router = useRouter();
  const id = useId();
  const [draft, setDraft] = useState<Draft>(() => fromDefinition(initial));
  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const [state, setState] = useState<WorkflowActionState>({});
  const [format, setFormat] = useState("CSV");
  const [pending, start] = useTransition();
  const source = REPORT_SOURCES.find((s) => s.code === draft.sourceCode) ?? REPORT_SOURCES[0];
  const sourceFields = source?.fields ?? [];
  const fieldLabel = (key: string) => t(`builder.fields.${draft.sourceCode}.${key}`);
  const typeOf = (key: string) => sourceFields.find((f) => f.key === key)?.type ?? "text";
  const input = () => ({ ...draft, customObjectTypeId: null });
  const update = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setPreview(null);
  };

  const money = (minor: number | null, currency: string) => {
    if (minor === null) return t("common.unpriced");
    const exponent = exponents[currency] ?? 2;
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(minor / 10 ** exponent);
  };
  const cellText = (c: PreviewCell) => {
    if (c.kind === "value") {
      if (c.value === null) return t("builder.preview.blank");
      return typeof c.value === "number"
        ? new Intl.NumberFormat(locale).format(c.value)
        : String(c.value);
    }
    const total = money(c.totalMinor, c.currency);
    return c.unpricedCount > 0
      ? t("builder.preview.unpriced", { total, count: c.unpricedCount })
      : total;
  };
  const columnLabel = (field: string, aggregate: Aggregate) =>
    aggregate === "None"
      ? fieldLabel(field)
      : t("builder.columnAggregate", {
          aggregate: t(`builder.aggregates.${aggregate}`),
          field: fieldLabel(field),
        });

  const runPreview = () =>
    start(async () => {
      setState({});
      const result = await previewAction(org, input());
      if (result.ok) setPreview(result.preview);
      else setState(result.state);
    });
  const save = () =>
    start(async () => {
      const result = await saveDefinitionAction(org, input());
      setState(result);
      if (result.ok && result.id && draft.id === null) {
        router.replace(`/${org}/reports/builder?report=${result.id}` as Route);
      }
    });
  const remove = () =>
    start(async () => {
      if (!draft.id) return;
      const result = await deleteDefinitionAction(org, draft.id);
      setState(result);
      if (result.ok) router.replace(`/${org}/reports/builder` as Route);
    });
  const queue = () =>
    start(async () => {
      if (!draft.id) return;
      setState(await queueRunAction(org, draft.id, format));
    });
  const download = () => {
    if (!preview) return;
    const csv = previewCsv(
      preview,
      preview.columns.map((c) => columnLabel(c.field, c.aggregate)),
      draft.groupBy ? fieldLabel(draft.groupBy) : null,
    );
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(draft.name || t("builder.untitled")).replace(/[^A-Za-z0-9 _-]/g, "").trim() || "report"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const firstNumeric =
    preview?.columns.findIndex(
      (c) => c.aggregate !== "None" || c.type === "number" || c.type === "money",
    ) ?? -1;
  const chartType = draft.chart === "Line" || draft.chart === "Area" ? "line" : "bar";
  const numericOf = (c: PreviewCell | undefined): number | null =>
    c === undefined
      ? null
      : c.kind === "money"
        ? c.totalMinor === null
          ? null
          : c.totalMinor / 10 ** (exponents[c.currency] ?? 2)
        : typeof c.value === "number"
          ? c.value
          : null;
  const moneyColumn =
    preview && firstNumeric >= 0 ? preview.columns[firstNumeric]?.type === "money" : false;
  const firstCurrency = preview?.rows.find((r) => r.cells[firstNumeric]?.kind === "money")?.cells[
    firstNumeric
  ];

  return (
    <div className="grid grid-cols-[minmax(0,22rem)_minmax(0,1fr)] gap-24 max-lg:grid-cols-1">
      <form
        aria-label={t("builder.formLabel")}
        className="flex min-w-0 flex-col gap-16"
        onSubmit={(e) => {
          e.preventDefault();
          runPreview();
        }}
      >
        <Input
          label={t("builder.name")}
          value={draft.name}
          maxLength={200}
          width="100%"
          disabled={!editable}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        />
        <Select
          label={t("builder.source")}
          help={t("builder.sourceHelp")}
          value={draft.sourceCode}
          disabled={!editable || draft.id !== null}
          options={REPORT_SOURCES.map((s) => ({
            value: s.code,
            label: t(`builder.sources.${s.code}`),
          }))}
          onChange={(e) => {
            const next = REPORT_SOURCES.find((s) => s.code === e.target.value);
            update({
              sourceCode: e.target.value,
              groupBy: null,
              filters: [],
              fields: next?.fields[0] ? [{ field: next.fields[0].key, aggregate: "None" }] : [],
            });
          }}
        />
        <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
          <legend className="mb-4 text-text-13 font-semibold">{t("builder.fieldsTitle")}</legend>
          {draft.fields.map((f, i) => (
            <div key={`${f.field}-${i}`} className="flex flex-wrap items-end gap-6">
              <Select
                label={t("builder.field", { n: i + 1 })}
                value={f.field}
                disabled={!editable}
                options={sourceFields.map((s) => ({ value: s.key, label: fieldLabel(s.key) }))}
                onChange={(e) =>
                  update({
                    fields: draft.fields.map((x, j) =>
                      j === i
                        ? {
                            field: e.target.value,
                            aggregate: aggregatesFor(typeOf(e.target.value)).includes(x.aggregate)
                              ? x.aggregate
                              : "None",
                          }
                        : x,
                    ),
                  })
                }
              />
              <Select
                label={t("builder.aggregate")}
                value={f.aggregate}
                disabled={!editable}
                options={aggregatesFor(typeOf(f.field)).map((a) => ({
                  value: a,
                  label: t(`builder.aggregates.${a}`),
                }))}
                onChange={(e) =>
                  update({
                    fields: draft.fields.map((x, j) =>
                      j === i ? { ...x, aggregate: e.target.value as Aggregate } : x,
                    ),
                  })
                }
              />
              {editable ? (
                <IconButton
                  icon="X"
                  label={t("builder.removeField", { field: fieldLabel(f.field) })}
                  onClick={() => update({ fields: draft.fields.filter((_, j) => j !== i) })}
                />
              ) : null}
            </div>
          ))}
          {editable && draft.fields.length < 20 && sourceFields[0] ? (
            <Button
              size="sm"
              onClick={() =>
                update({
                  fields: [
                    ...draft.fields,
                    { field: sourceFields[0]?.key ?? "", aggregate: "None" },
                  ],
                })
              }
            >
              {t("builder.addField")}
            </Button>
          ) : null}
        </fieldset>
        <Select
          label={t("builder.groupBy")}
          help={t("builder.groupByHelp")}
          value={draft.groupBy ?? ""}
          disabled={!editable}
          options={[
            { value: "", label: t("builder.noGrouping") },
            ...sourceFields
              .filter((s) => s.type === "text" || s.type === "date")
              .map((s) => ({ value: s.key, label: fieldLabel(s.key) })),
          ]}
          onChange={(e) => update({ groupBy: e.target.value === "" ? null : e.target.value })}
        />
        <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
          <legend className="mb-4 text-text-13 font-semibold">{t("builder.filtersTitle")}</legend>
          {draft.filters.length === 0 ? (
            <p className="m-0 text-text-12 text-text-secondary">{t("builder.noFilters")}</p>
          ) : null}
          {draft.filters.map((f, i) => (
            <div key={`${f.field}-${i}`} className="flex flex-wrap items-end gap-6">
              <Select
                label={t("builder.filterField", { n: i + 1 })}
                value={f.field}
                disabled={!editable}
                options={sourceFields.map((s) => ({ value: s.key, label: fieldLabel(s.key) }))}
                onChange={(e) =>
                  update({
                    filters: draft.filters.map((x, j) =>
                      j === i ? { ...x, field: e.target.value } : x,
                    ),
                  })
                }
              />
              <Select
                label={t("builder.operator")}
                value={f.operator}
                disabled={!editable}
                options={FILTER_OPERATORS.map((o) => ({
                  value: o,
                  label: t(`builder.operators.${o}`),
                }))}
                onChange={(e) =>
                  update({
                    filters: draft.filters.map((x, j) =>
                      j === i
                        ? {
                            ...x,
                            operator: e.target.value as FilterOperator,
                            value: e.target.value === "is_null" ? null : (x.value ?? ""),
                          }
                        : x,
                    ),
                  })
                }
              />
              {f.operator !== "is_null" ? (
                <Input
                  label={t("builder.value")}
                  {...(f.operator === "in" ? { help: t("builder.valueListHelp") } : {})}
                  value={f.value ?? ""}
                  maxLength={1000}
                  disabled={!editable}
                  onChange={(e) =>
                    update({
                      filters: draft.filters.map((x, j) =>
                        j === i ? { ...x, value: e.target.value } : x,
                      ),
                    })
                  }
                />
              ) : null}
              {editable ? (
                <IconButton
                  icon="X"
                  label={t("builder.removeFilter", { n: i + 1 })}
                  onClick={() => update({ filters: draft.filters.filter((_, j) => j !== i) })}
                />
              ) : null}
            </div>
          ))}
          {editable && draft.filters.length < 20 && sourceFields[0] ? (
            <Button
              size="sm"
              onClick={() =>
                update({
                  filters: [
                    ...draft.filters,
                    { field: sourceFields[0]?.key ?? "", operator: "eq", value: "" },
                  ],
                })
              }
            >
              {t("builder.addFilter")}
            </Button>
          ) : null}
        </fieldset>
        <Select
          label={t("builder.chart")}
          value={draft.chart}
          disabled={!editable}
          options={CHART_TYPES.map((c) => ({ value: c, label: t(`builder.charts.${c}`) }))}
          onChange={(e) => update({ chart: e.target.value as ChartType })}
        />
        <Checkbox
          label={t("builder.shared")}
          checked={draft.shared}
          disabled={!editable}
          onChange={(e) => setDraft((d) => ({ ...d, shared: e.target.checked }))}
        />
        <div className="flex flex-wrap gap-8">
          <Button type="submit" variant="primary" loading={pending}>
            {t("builder.preview.run")}
          </Button>
          {editable ? (
            <Button
              onClick={save}
              loading={pending}
              disabled={draft.name.trim() === "" || draft.fields.length === 0}
            >
              {draft.id ? t("builder.saveChanges") : t("builder.save")}
            </Button>
          ) : null}
          {editable && draft.id ? (
            <Button variant="danger" onClick={remove} loading={pending}>
              {t("builder.delete")}
            </Button>
          ) : null}
        </div>
        {draft.id && canExport ? (
          <div className="flex flex-wrap items-end gap-8">
            <Select
              label={t("builder.runFormat")}
              value={format}
              options={["CSV", "XLSX", "PDF"].map((f) => ({ value: f, label: f }))}
              onChange={(e) => setFormat(e.target.value)}
            />
            <Button onClick={queue} loading={pending}>
              {t("builder.queueRun")}
            </Button>
          </div>
        ) : null}
        <div aria-live="polite">
          <Feedback state={state} success={t("builder.saved")} />
        </div>
      </form>

      <section aria-labelledby={`${id}-preview`} className="flex min-w-0 flex-col gap-12">
        <div className="flex flex-wrap items-center justify-between gap-8">
          <h2 id={`${id}-preview`} className="m-0 text-heading-16 font-semibold">
            {t("builder.preview.title")}
          </h2>
          {preview && preview.rows.length > 0 && canExport ? (
            <Button size="sm" onClick={download}>
              {t("builder.preview.download")}
            </Button>
          ) : null}
        </div>
        {preview === null ? (
          <InlineAlert tone="info">{t("builder.preview.prompt")}</InlineAlert>
        ) : preview.rows.length === 0 ? (
          <InlineAlert tone="info">{t("builder.preview.empty")}</InlineAlert>
        ) : (
          <>
            <p className="m-0 text-text-12 text-text-secondary">
              {preview.truncated
                ? t("builder.preview.truncated", { rows: preview.sourceRows })
                : t("builder.preview.rows", { rows: preview.sourceRows })}
            </p>
            {draft.chart === "Number" && firstNumeric >= 0 ? (
              <StatTile
                label={columnLabel(
                  preview.columns[firstNumeric]?.field ?? "",
                  preview.columns[firstNumeric]?.aggregate ?? "None",
                )}
                value={numericOf(preview.rows[0]?.cells[firstNumeric])}
                format={moneyColumn ? "money" : "number"}
                {...(preview.rows.length > 1 ? { caption: t("builder.preview.firstGroup") } : {})}
              />
            ) : null}
            {draft.chart !== "Table" &&
            draft.chart !== "Number" &&
            firstNumeric >= 0 &&
            draft.groupBy ? (
              <>
                <Chart
                  type={chartType}
                  title={draft.name || t("builder.untitled")}
                  categoryLabel={fieldLabel(draft.groupBy)}
                  categories={preview.rows.map((r) => r.group ?? t("builder.preview.blank"))}
                  series={[
                    {
                      name: columnLabel(
                        preview.columns[firstNumeric]?.field ?? "",
                        preview.columns[firstNumeric]?.aggregate ?? "None",
                      ),
                      values: preview.rows.map((r) => numericOf(r.cells[firstNumeric])),
                    },
                  ]}
                  format={moneyColumn ? "money" : "number"}
                  {...(firstCurrency?.kind === "money" && firstCurrency.currency
                    ? { currency: firstCurrency.currency }
                    : {})}
                />
                {draft.chart === "Pie" || draft.chart === "Area" ? (
                  <p className="m-0 text-text-12 text-text-secondary">
                    {t(`builder.preview.chartNote.${draft.chart}`)}
                  </p>
                ) : null}
              </>
            ) : null}
            {draft.chart !== "Table" && draft.chart !== "Number" && !draft.groupBy ? (
              <p className="m-0 text-text-12 text-text-secondary">
                {t("builder.preview.chartNeedsGroup")}
              </p>
            ) : null}
            <div
              role="region"
              aria-label={t("builder.preview.caption")}
              tabIndex={0}
              className="overflow-x-auto rounded-card border border-border-subtle"
            >
              <table className="w-full border-collapse text-text-13">
                <caption className="sr-only">{t("builder.preview.caption")}</caption>
                <thead>
                  <tr className="border-b border-border-subtle text-left text-text-12 text-text-secondary">
                    {draft.groupBy ? (
                      <th scope="col" className="px-12 py-8 font-medium">
                        {fieldLabel(draft.groupBy)}
                      </th>
                    ) : null}
                    {preview.columns.map((c, i) => (
                      <th key={`${c.field}-${i}`} scope="col" className="px-12 py-8 font-medium">
                        {columnLabel(c.field, c.aggregate)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 500).map((r, i) => (
                    <tr key={i} className="border-b border-border-subtle last:border-b-0">
                      {draft.groupBy ? (
                        <th scope="row" className="px-12 py-8 text-left font-medium">
                          {r.group ?? t("builder.preview.blank")}
                        </th>
                      ) : null}
                      {r.cells.map((c, j) => (
                        <td
                          key={j}
                          className={`px-12 py-8 ${c.kind === "money" ? "text-right tabular-nums" : ""}`}
                        >
                          {cellText(c)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.rows.length > 500 ? (
              <p className="m-0 text-text-12 text-text-secondary">
                {t("builder.preview.moreRows", { rows: preview.rows.length })}
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
