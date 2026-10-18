import { useState, type ReactElement } from "react";
import { Popover as RPopover } from "radix-ui";
import { useLocale, useT } from "../lib/context.tsx";
import { formatDate } from "../lib/format.ts";
import { Icon } from "../Icon/Icon.tsx";
import { Field, describedBy, useFieldId } from "../Field/Field.tsx";
import { CalendarPanel, todayIso, triggerClass } from "./Pickers.shared.tsx";
import { type DatePickerProps } from "./Pickers.types.ts";

/** One date from a month grid in a popover dialog; dates display as Oct 30, 2026. */
export function DatePicker({
  label,
  help,
  value,
  month,
  today,
  placeholder: hint,
  defaultOpen,
  onChange,
  id,
}: DatePickerProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  const fieldId = useFieldId(id);
  const [current, setCurrent] = useState(value);
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const initial = current ?? month ?? today ?? todayIso();
  return (
    <Field id={fieldId} label={label} help={help}>
      <RPopover.Root open={open} onOpenChange={setOpen}>
        <RPopover.Trigger asChild>
          <button
            id={fieldId}
            type="button"
            aria-haspopup="dialog"
            aria-labelledby={label ? `${fieldId}-label ${fieldId}` : undefined}
            className={triggerClass}
            aria-describedby={describedBy(fieldId, help, undefined)}
          >
            <Icon name="Calendar" size={14} />
            <span className={current ? undefined : "text-text-tertiary"}>
              {current ? formatDate(locale, current) : (hint ?? t("date.pick"))}
            </span>
          </button>
        </RPopover.Trigger>
        <CalendarPanel
          label={t("date.choose")}
          initial={initial}
          mark={(iso) => (iso === current ? "selected" : iso === today ? "today" : null)}
          onPick={(iso) => {
            setCurrent(iso);
            onChange?.(iso);
            setOpen(false);
          }}
        />
      </RPopover.Root>
    </Field>
  );
}
