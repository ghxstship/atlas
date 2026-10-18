import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { helpClass, labelClass, useFieldId } from "../Field/Field.tsx";
import { checkLabelClass } from "./Forms.shared.tsx";
import { type RadioProps } from "./Forms.types.ts";

/** A group of native radios in a fieldset; arrow keys move between options as the platform does. */
export function Radio({ label, name, value, options, onChange }: RadioProps): ReactElement {
  const groupName = useFieldId(name);
  return (
    <fieldset className="flex flex-col gap-8 m-0 p-0 border-0">
      <legend className={cx(labelClass, "mb-8")}>{label}</legend>
      {options.map((o) => (
        <label key={o.value} className={cx(checkLabelClass, "items-start")}>
          <input
            type="radio"
            name={groupName}
            value={o.value}
            defaultChecked={value === o.value}
            onChange={onChange}
            className="xos-check-input"
          />
          <span className="flex flex-col">
            <span>{o.label}</span>
            {o.help ? <span className={helpClass}>{o.help}</span> : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
