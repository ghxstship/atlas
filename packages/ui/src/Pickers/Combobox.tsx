import { useState, type ReactElement } from "react";
import { Popover as RPopover } from "radix-ui";
import type { Option } from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Field, controlClass, describedBy, useFieldId } from "../Field/Field.tsx";
import { Listbox, listKeys, useList } from "./Pickers.shared.tsx";
import { type ComboboxProps } from "./Pickers.types.ts";

/**
 * Searches a long list as the person types (fuzzy ranking from cmdk, positioned on Radix Popover).
 * Arrow keys move, Enter picks, Escape closes.
 */
export function Combobox({
  label,
  help,
  value,
  placeholder: hint,
  noMatch,
  options,
  defaultOpen,
  onChange,
  id,
}: ComboboxProps): ReactElement {
  const t = useT();
  const fieldId = useFieldId(id);
  const s = useList(options, defaultOpen);
  const [current, setCurrent] = useState(value);
  const chosen = options.find((o) => o.value === current);
  const pick = (o: Option) => {
    setCurrent(o.value);
    s.setQuery("");
    s.setOpen(false);
    onChange?.(o.value);
  };
  return (
    <Field id={fieldId} label={label} help={help}>
      <RPopover.Root
        open={s.open && (s.list.length > 0 || s.query !== "")}
        onOpenChange={s.setOpen}
      >
        <RPopover.Anchor asChild>
          <div className="relative" data-combobox={fieldId}>
            <input
              id={fieldId}
              role="combobox"
              aria-expanded={s.open}
              aria-controls={s.open ? `${fieldId}-list` : undefined}
              aria-autocomplete="list"
              aria-activedescendant={
                s.open && s.list.length ? `${fieldId}-opt-${s.active}` : undefined
              }
              aria-describedby={describedBy(fieldId, help, undefined)}
              autoComplete="off"
              value={s.query}
              placeholder={chosen?.label ?? hint}
              onFocus={() => s.setOpen(true)}
              onBlur={() => {
                if (!defaultOpen) s.setOpen(false);
              }}
              onChange={(e) => {
                s.setQuery(e.target.value);
                s.setOpen(true);
                s.setActive(0);
              }}
              onKeyDown={(e) => listKeys(e, s, pick)}
              className={cx(
                controlClass,
                "w-full pe-24",
                chosen && "placeholder:text-text-primary",
              )}
            />
            <span className="pointer-events-none absolute inset-y-0 end-8 flex items-center text-text-tertiary">
              <Icon name="ChevronsUpDown" size={14} />
            </span>
          </div>
        </RPopover.Anchor>
        <Listbox
          id={fieldId}
          state={s}
          isSelected={(o) => o.value === current}
          pick={pick}
          noMatch={noMatch ?? t("list.noMatch")}
        />
      </RPopover.Root>
    </Field>
  );
}
