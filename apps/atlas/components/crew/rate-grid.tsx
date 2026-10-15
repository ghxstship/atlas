"use client";

import { Button, InlineAlert, SpreadsheetGrid, type GridColumn } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import type { CrewActionState } from "@/lib/crew/action-state";

type Row = Record<string, string | number | null>;
type Action = (state: CrewActionState, form: FormData) => Promise<CrewActionState>;

/**
 * The rate card grid (Grid editor template, Section 11.6): canon role, classification, pay basis,
 * arrangement and overtime rule are read-only; the rate is editable in place with Excel paste. A
 * blank cell is Unpriced, never zero. Changes save together in one action and refresh the page.
 */
export function RateGrid(props: {
  label: string;
  org: string;
  currency: string;
  columns: GridColumn[];
  rows: Row[];
  editable: boolean;
  action: Action;
}) {
  const t = useTranslations("crew.rates");
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(props.rows);
  const original = new Map(props.rows.map((r) => [String(r["id"]), r["rate"] ?? null]));
  const changes = rows
    .filter((r) => (r["rate"] ?? null) !== original.get(String(r["id"])))
    .map((r) => ({ id: String(r["id"]), rate: typeof r["rate"] === "number" ? r["rate"] : null }));
  const [state, action, pending] = useActionState(async (prev: CrewActionState, form: FormData) => {
    const next = await props.action(prev, form);
    if (next.ok) router.refresh();
    return next;
  }, {});
  return (
    <div className="flex flex-col gap-8">
      <SpreadsheetGrid
        label={props.label}
        columns={props.columns.map((c) =>
          c.key === "rate" ? { ...c, editable: props.editable, currency: props.currency } : c,
        )}
        rows={rows}
        onChange={(next) => setRows(next)}
      />
      {props.editable ? (
        <form action={action} className="flex flex-wrap items-center gap-8">
          <input type="hidden" name="org" value={props.org} />
          <input type="hidden" name="currencyCode" value={props.currency} />
          <input type="hidden" name="changes" value={JSON.stringify(changes)} />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={pending}
            disabled={changes.length === 0}
          >
            {t("saveRates", { count: changes.length })}
          </Button>
          {changes.length > 0 ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setRows(props.rows)}>
              {t("discard")}
            </Button>
          ) : null}
          {state.error ? (
            <InlineAlert tone="danger" title={t("notSaved")}>
              {state.error}
            </InlineAlert>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
