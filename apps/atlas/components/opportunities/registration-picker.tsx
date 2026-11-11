"use client";

import { MultiSelect } from "@xos/ui";

/** The registrations' picker, loaded when someone chooses to pick (ADR 0027). */
export function RegistrationPicker(props: {
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
