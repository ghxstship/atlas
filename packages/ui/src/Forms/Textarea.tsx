import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { Field, controlClass, describedBy, useFieldId } from "../Field/Field.tsx";
import { type TextareaProps } from "./Forms.types.ts";

/** A multi-line field; grows by rows and resizes vertically. */
export function Textarea({
  label,
  help,
  error,
  id,
  width,
  className,
  rows = 3,
  ...rest
}: TextareaProps): ReactElement {
  const fieldId = useFieldId(id);
  return (
    <Field id={fieldId} label={label} help={help} error={error} width={width}>
      <textarea
        id={fieldId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fieldId, help, error)}
        {...rest}
        className={cx(controlClass, "h-auto py-6 resize-y leading-normal", className)}
      />
    </Field>
  );
}
