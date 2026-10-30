"use client";

import { FilterBuilder } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { useCustomFieldList } from "@/components/custom-fields/list";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import type { CustomFieldListView } from "@/lib/custom-fields/types";
import { conditionParam, conditionsOf, type Condition } from "@/lib/views/conditions";
import {
  choiceLabelKey,
  choiceOf,
  filterTargets,
  type FilterField,
  type FilterTarget,
} from "./filter-model";

/** The condition editor loads the first time someone adds or edits a filter (A24-009). */
const filterEditor = onDemand(() => import("./filter-editor"));

/** Copy lookups take built keys (`filter.ops.is`), so the catalog type is widened. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

type Editing = { readonly index: number | null } | null;

interface Chip {
  readonly field: string;
  readonly op: string;
  readonly value: string;
  readonly index: number;
}

/**
 * The Add filter control of a collection (A117, Section 11.15): the query's conditions as removable chips, Add
 * filter, and Save view while the conditions differ from a saved view. Conditions are query parameters
 * (lib/views/conditions.ts), so a saved view keeps them and a link reopens them; the page applies them, its
 * declared fields on what it shows and custom fields in its loader. Shown when the page declares fields or its
 * table has filterable custom fields.
 */
export function CollectionFilters({
  search,
  fields,
  customFields,
  onNavigate,
  onSave,
}: {
  search: URLSearchParams;
  fields: readonly FilterField[];
  /** The page's filterable custom fields; the surrounding CustomFieldList's when absent. */
  customFields?: CustomFieldListView | null;
  /** Replaces the query string with the given one. */
  onNavigate: (query: string) => void;
  /** Opens the save dialog; absent when the conditions already match a saved view. */
  onSave?: () => void;
}) {
  const t = useTranslations("views") as unknown as Translate;
  const format = useFormatter();
  const surrounding = useCustomFieldList();
  const custom = customFields === undefined ? surrounding : customFields;
  const [editing, setEditing] = useState<Editing>(null);
  const editor = useOnDemand(filterEditor, editing !== null);
  const targets = useMemo(
    () => filterTargets(fields, custom, { yes: t("filter.yes"), no: t("filter.no") }),
    [fields, custom, t],
  );
  const conditions = useMemo(() => conditionsOf(search), [search]);
  if (targets.length === 0) return null;

  const targetOf = (c: Condition): FilterTarget | undefined =>
    targets.find((x) => x.scope === c.scope && x.key === c.key);
  const shownValue = (c: Condition, target: FilterTarget | undefined): string => {
    if (c.operator === "is_null") return "";
    const option = target?.options?.find((o) => o.value === c.value);
    if (option) return option.label;
    if (target?.kind === "date" || target?.kind === "timestamp") {
      const day = new Date(`${c.value}T00:00:00Z`);
      if (!Number.isNaN(day.getTime()))
        return format.dateTime(day, { dateStyle: "medium", timeZone: "UTC" });
    }
    return c.value;
  };
  // Each chip carries its condition's index, so removing one keeps the others whatever their text.
  const chips: Chip[] = conditions.map((c, index) => {
    const target = targetOf(c);
    return {
      field: target?.label ?? c.key,
      op: t(`filter.ops.${choiceLabelKey(target?.kind ?? "text", choiceOf(c))}`),
      value: shownValue(c, target),
      index,
    };
  });

  /** The query with these conditions in place of the current ones; the open peek closes. */
  const withConditions = (next: readonly Condition[]): string => {
    const query = new URLSearchParams(search.toString());
    for (const c of conditions) query.delete(conditionParam(c)[0]);
    for (const c of next) query.set(...conditionParam(c));
    for (const key of ["peek", "full"]) query.delete(key);
    return query.toString();
  };

  return (
    <div className="basis-full">
      <FilterBuilder
        // The chips start from the query; a new query (a saved view, Back) starts them again.
        key={conditions.map((c) => conditionParam(c).join("=")).join("&")}
        filters={chips}
        addLabel={t("filter.add")}
        {...(onSave && conditions.length > 0 ? { saveLabel: t("filter.save") } : {})}
        onAdd={() => setEditing({ index: null })}
        onEdit={(chip) => setEditing({ index: (chip as Chip).index })}
        onChange={(kept) => {
          const keep = new Set(kept.map((k) => (k as Chip).index));
          onNavigate(withConditions(conditions.filter((_, i) => keep.has(i))));
        }}
        onSave={() => onSave?.()}
      />
      {editing && editor ? (
        <editor.FilterEditor
          targets={targets}
          condition={editing.index === null ? null : (conditions[editing.index] ?? null)}
          onClose={() => setEditing(null)}
          onApply={(condition) => {
            const others = conditions.filter((_, i) => i !== editing.index);
            const param = conditionParam(condition)[0];
            onNavigate(
              withConditions([...others.filter((c) => conditionParam(c)[0] !== param), condition]),
            );
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}
