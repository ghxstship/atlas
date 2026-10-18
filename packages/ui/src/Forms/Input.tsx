import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { Field, controlClass, describedBy, useFieldId } from "../Field/Field.tsx";
import { type InputProps } from "./Forms.types.ts";

/** A labeled single-line field with help text or an inline error naming the field, problem and fix. */
export function Input({
  label,
  help,
  error,
  id,
  width,
  className,
  ...rest
}: InputProps): ReactElement {
  const fieldId = useFieldId(id);
  return (
    <Field id={fieldId} label={label} help={help} error={error} width={width}>
      <input
        id={fieldId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fieldId, help, error)}
        {...rest}
        className={cx(controlClass, className)}
      />
    </Field>
  );
}
