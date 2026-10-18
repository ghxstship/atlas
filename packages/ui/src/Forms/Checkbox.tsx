import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { checkLabelClass } from "./Forms.shared.tsx";
import { type CheckboxProps } from "./Forms.types.ts";

/** A native checkbox with its label; the whole label is the target. */
export function Checkbox({ label, className, ...rest }: CheckboxProps): ReactElement {
  return (
    <label className={cx(checkLabelClass, className)}>
      <input type="checkbox" {...rest} className="xos-check-input" />
      {label}
    </label>
  );
}
