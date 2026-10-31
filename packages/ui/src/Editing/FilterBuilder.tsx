import { useState, type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { chipClass } from "../Chips/Chips.tsx";
import { type Filter, type FilterBuilderProps } from "./Editing.types.ts";

/**
 * Filters as chips: each opens its editor, removes with its button, and the set saves as a view. Add
 * filter is the target of the shell's Open the filters shortcut (data-shortcut="view.filters",
 * lib/shortcut-targets.ts).
 */
export function FilterBuilder({
  filters,
  addLabel,
  saveLabel,
  onChange,
  onAdd,
  onSave,
  onEdit,
}: FilterBuilderProps): ReactElement {
  const t = useT();
  const [current, setCurrent] = useState(filters);
  const set = (next: Filter[]) => {
    setCurrent(next);
    onChange?.(next);
  };
  return (
    <div role="group" aria-label={t("filter.label")} className="flex flex-wrap items-center gap-6">
      {current.map((f, i) => (
        <span key={`${f.field}-${i}`} className={chipClass}>
          <button
            type="button"
            onClick={() => onEdit?.(f, i)}
            className="xos-hit inline-flex items-center gap-4 p-0 border-0 bg-transparent cursor-pointer text-inherit"
          >
            <span className="text-text-secondary">{f.field}</span>{" "}
            <span className="text-text-secondary">{f.op}</span>{" "}
            <strong className="font-medium">{f.value}</strong>
          </button>
          <button
            type="button"
            aria-label={t("filter.remove", { field: f.field })}
            onClick={() => set(current.filter((_, j) => j !== i))}
            className="xos-hit inline-grid place-items-center ms-2 p-0 border-0 bg-transparent text-text-tertiary hover:text-text-primary rounded-mark cursor-pointer"
          >
            <Icon name="X" size={12} />
          </button>
        </span>
      ))}
      <Button
        size="sm"
        variant="ghost"
        icon="ListFilter"
        onClick={onAdd}
        data-shortcut="view.filters"
      >
        {addLabel ?? t("filter.add")}
      </Button>
      {current.length ? (
        <Button size="sm" variant="ghost" onClick={() => set([])}>
          {t("action.clear")}
        </Button>
      ) : null}
      {saveLabel ? (
        <Button size="sm" icon="Bookmark" onClick={() => onSave?.(current)}>
          {saveLabel}
        </Button>
      ) : null}
    </div>
  );
}
