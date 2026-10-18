import type { ReactElement } from "react";
import { StateIcon } from "../StateIcon/StateIcon.tsx";
import { Chip } from "./Chips.shared.tsx";
import { type StateChipProps } from "./Chips.types.ts";

/** Record state as icon plus label; clickable chips open the state menu. `compact` keeps the label for assistive technology only. */
export function StateChip({
  state,
  label,
  compact = false,
  onClick,
}: StateChipProps): ReactElement {
  return (
    <Chip onClick={onClick}>
      <StateIcon state={state} />
      <span className={compact ? "sr-only" : undefined}>{label}</span>
    </Chip>
  );
}
