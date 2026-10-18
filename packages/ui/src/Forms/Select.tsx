import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { Icon } from "../Icon/Icon.tsx";
import { Field, controlClass, describedBy, useFieldId } from "../Field/Field.tsx";
import { type SelectProps } from "./Forms.types.ts";

/**
 * A native select styled to the system. The contract's onChange is a native select change event,
 * so the control stays a native select, which also gives the platform picker on touch devices.
 */
export function Select({
  label,
  help,
  error,
  value,
  placeholder: hint,
  options,
  disabled,
  onChange,
  id,
  name,
}: SelectProps): ReactElement {
  const fieldId = useFieldId(id);
  return (
    <Field id={fieldId} label={label} help={help} error={error}>
      <div className="relative">
        <select
          id={fieldId}
          name={name}
          className={cx(controlClass, "appearance-none w-full pe-24")}
          defaultValue={value ?? (hint ? "" : undefined)}
          disabled={disabled}
          onChange={onChange}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(fieldId, help, error)}
        >
          {hint ? (
            <option value="" disabled>
              {hint}
            </option>
          ) : null}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute inset-y-0 end-8 flex items-center text-text-tertiary">
          <Icon name="ChevronsUpDown" size={14} />
        </span>
      </div>
    </Field>
  );
}
