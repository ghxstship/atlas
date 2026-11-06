"use client";

import { MultiSelect } from "@xos/ui";

/** The workers' picker, loaded when someone chooses to pick (ADR 0027). */
export function WorkerPicker(props: {
  readonly label: string;
  readonly help: string;
  readonly value: string[];
  readonly options: readonly { value: string; label: string }[];
  readonly onChange: (next: string[]) => void;
}) {
  return (
    <MultiSelect
      label={props.label}
      help={props.help}
      value={props.value}
      options={[...props.options]}
      onChange={props.onChange}
    />
  );
}
