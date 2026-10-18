import { useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Field, controlClass, describedBy, useFieldId } from "../Field/Field.tsx";
import { type CurrencyInputProps } from "./Forms.types.ts";

/** A NULL-aware amount field: blank is unpriced and never coerced to 0. */
export function CurrencyInput({
  label,
  value,
  currency = "USD",
  help,
  unpricedLabel,
  id,
  onChange,
}: CurrencyInputProps): ReactElement {
  const t = useT();
  const fieldId = useFieldId(id);
  const [blank, setBlank] = useState(value === null || value === undefined);
  const helpText = help ?? (blank ? t("money.blankHelp") : undefined);
  return (
    <Field id={fieldId} label={label} help={helpText}>
      <div className="flex items-center gap-6">
        <input
          id={fieldId}
          className={cx(controlClass, "flex-1 min-w-0 text-end tabular-nums")}
          inputMode="decimal"
          placeholder={unpricedLabel ?? t("money.unpriced")}
          defaultValue={value === null || value === undefined ? "" : String(value)}
          aria-describedby={describedBy(fieldId, helpText, undefined)}
          onChange={(e) => {
            setBlank(e.target.value.trim() === "");
            onChange?.(e);
          }}
        />
        <span className="text-text-12 text-text-tertiary">{currency}</span>
      </div>
    </Field>
  );
}
