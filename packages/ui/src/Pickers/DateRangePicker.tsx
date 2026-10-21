import { useState, type ReactElement } from "react";
import { Popover as RPopover } from "radix-ui";
import { useLocale, usePreferences, useT } from "../lib/context.tsx";
import { formatDate } from "../lib/format.ts";
import { Icon } from "../Icon/Icon.tsx";
import { Field, describedBy, useFieldId } from "../Field/Field.tsx";
import { CalendarPanel, todayIso, triggerClass } from "./Pickers.shared.tsx";
import { type DateRangePickerProps } from "./Pickers.types.ts";

/** A start and end date with the length in days; the first pick starts a range, the second ends it. */
export function DateRangePicker({
  label,
  help,
  start,
  end,
  defaultOpen,
  onChange,
  id,
}: DateRangePickerProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  const { dateFormat } = usePreferences();
  const fieldId = useFieldId(id);
  const [range, setRange] = useState<[string | undefined, string | undefined]>([start, end]);
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const [a, b] = range;
  const days = a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1 : null;
  const pick = (iso: string) => {
    const next: [string, string | undefined] =
      !a || b ? [iso, undefined] : iso < a ? [iso, a] : [a, iso];
    setRange(next);
    if (next[1]) {
      onChange?.([next[0], next[1]]);
      setOpen(false);
    }
  };
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
            <Icon name="CalendarRange" size={14} />
            <span className={a ? undefined : "text-text-tertiary"}>
              {a
                ? b
                  ? t("date.rangeValue", {
                      start: formatDate(locale, a, dateFormat),
                      end: formatDate(locale, b, dateFormat),
                    })
                  : formatDate(locale, a, dateFormat)
                : t("date.chooseRange")}
            </span>
            {days !== null ? (
              <span className="ms-auto text-text-secondary tabular-nums">
                {t("date.days", { n: days })}
              </span>
            ) : null}
          </button>
        </RPopover.Trigger>
        <CalendarPanel
          label={t("date.chooseRange")}
          initial={a ?? todayIso()}
          mark={(iso) =>
            iso === a || iso === b ? "edge" : a && b && iso > a && iso < b ? "range" : null
          }
          onPick={pick}
        />
      </RPopover.Root>
    </Field>
  );
}
