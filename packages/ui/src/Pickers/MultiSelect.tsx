import { useState, type ReactElement } from "react";
import { Popover as RPopover } from "radix-ui";
import type { Option } from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { chipClass } from "../Chips/Chips.tsx";
import { controlClass, fieldClass, helpClass, labelClass, useFieldId } from "../Field/Field.tsx";
import { Listbox, listKeys, useList } from "./Pickers.shared.tsx";
import { type MultiSelectProps } from "./Pickers.types.ts";

/** Picks several values; picks show as removable chips and Backspace removes the last. */
export function MultiSelect({
  label,
  help,
  value,
  placeholder: hint,
  options,
  defaultOpen,
  onChange,
  id,
}: MultiSelectProps): ReactElement {
  const t = useT();
  const fieldId = useFieldId(id);
  const s = useList(options, defaultOpen);
  const [picked, setPicked] = useState(value ?? []);
  const set = (next: string[]) => {
    setPicked(next);
    onChange?.(next);
  };
  const toggle = (o: Option) =>
    set(picked.includes(o.value) ? picked.filter((v) => v !== o.value) : [...picked, o.value]);
  const chosen = options.filter((o) => picked.includes(o.value));
  return (
    <div className={fieldClass}>
      {label ? (
        <label className={labelClass} htmlFor={fieldId}>
          {label}
        </label>
      ) : null}
      <RPopover.Root open={s.open} onOpenChange={s.setOpen}>
        <RPopover.Anchor asChild>
          <div
            data-combobox={fieldId}
            className={cx(
              controlClass,
              "relative flex flex-wrap items-center gap-4 h-auto min-h-control-md py-2 ps-4 pe-24",
            )}
          >
            {chosen.map((o) => (
              <span key={o.value} className={cx(chipClass, "h-(--ui-tag)")}>
                {o.label}
                <button
                  type="button"
                  aria-label={t("chip.remove", { label: o.label })}
                  onClick={() => toggle(o)}
                  className="xos-hit inline-grid place-items-center ms-2 p-0 border-0 bg-transparent text-text-tertiary hover:text-text-primary rounded-mark cursor-pointer"
                >
                  <Icon name="X" size={12} />
                </button>
              </span>
            ))}
            <input
              id={fieldId}
              role="combobox"
              aria-expanded={s.open}
              aria-controls={s.open ? `${fieldId}-list` : undefined}
              aria-autocomplete="list"
              aria-activedescendant={
                s.open && s.list.length ? `${fieldId}-opt-${s.active}` : undefined
              }
              aria-describedby={help ? `${fieldId}-help` : undefined}
              autoComplete="off"
              value={s.query}
              placeholder={chosen.length ? "" : hint}
              onFocus={() => s.setOpen(true)}
              onBlur={() => {
                if (!defaultOpen) s.setOpen(false);
              }}
              onChange={(e) => {
                s.setQuery(e.target.value);
                s.setOpen(true);
                s.setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Backspace" && !s.query && chosen.length) {
                  const last = chosen[chosen.length - 1];
                  if (last) toggle(last);
                  return;
                }
                listKeys(e, s, toggle);
              }}
              className="flex-1 min-w-(--space-64) border-0 bg-transparent outline-none text-text-primary text-text-13 placeholder:text-text-tertiary pointer-coarse:min-h-target-coarse"
            />
            <span className="pointer-events-none absolute inset-y-0 end-8 flex items-center text-text-tertiary">
              <Icon name="ChevronsUpDown" size={14} />
            </span>
          </div>
        </RPopover.Anchor>
        <Listbox
          id={fieldId}
          state={s}
          isSelected={(o) => picked.includes(o.value)}
          pick={toggle}
          multiselectable
          noMatch={t("list.noMatch")}
        />
      </RPopover.Root>
      {help ? (
        <div className={helpClass} id={`${fieldId}-help`}>
          {help}
        </div>
      ) : null}
    </div>
  );
}
