import { useMemo, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useLocale } from "../lib/context.tsx";
import { formatTimeOfDay } from "../lib/format.ts";
import { Icon } from "../Icon/Icon.tsx";
import { chipClass } from "../Chips/Chips.tsx";
import { Field, controlClass, useFieldId } from "../Field/Field.tsx";
import { type TimePickerProps } from "./Pickers.types.ts";

/**
 * A time of day with the venue time zone always beside it. The contract keeps a native select change
 * event; times read in the locale's format (12-hour with AM and PM in en-US).
 */
export function TimePicker({
  label,
  help,
  value,
  step = 15,
  timeZone,
  zoneLabel,
  onChange,
  id,
  name,
}: TimePickerProps): ReactElement {
  const locale = useLocale();
  const fieldId = useFieldId(id);
  const options = useMemo(() => {
    const out: { value: string; label: string }[] = [];
    for (let mins = 0; mins < 1440; mins += step) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      out.push({
        value: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
        label: formatTimeOfDay(locale, h, m),
      });
    }
    return out;
  }, [locale, step]);
  return (
    <Field id={fieldId} label={label} help={help}>
      <div className="flex items-center gap-6">
        <div className="relative flex-1">
          <select
            id={fieldId}
            name={name}
            defaultValue={value}
            onChange={onChange}
            aria-describedby={`${fieldId}-zone${help ? ` ${fieldId}-help` : ""}`}
            className={cx(controlClass, "appearance-none w-full pe-24")}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute inset-y-0 end-8 flex items-center text-text-tertiary">
            <Icon name="Clock" size={14} />
          </span>
        </div>
        <span id={`${fieldId}-zone`} title={timeZone} className={chipClass}>
          <Icon name="Globe" size={12} />
          {zoneLabel}
        </span>
      </div>
    </Field>
  );
}
