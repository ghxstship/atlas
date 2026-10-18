import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { checkLabelClass } from "./Forms.shared.tsx";
import { type SwitchProps } from "./Forms.types.ts";

/** An immediate on or off setting; a checkbox input with the switch role. */
export function Switch({ label, className, ...rest }: SwitchProps): ReactElement {
  return (
    <label className={cx(checkLabelClass, className)}>
      <input type="checkbox" role="switch" {...rest} className="xos-check-input" />
      {label}
    </label>
  );
}
