import type { ReactElement } from "react";
import { Icon } from "../Icon/Icon.tsx";
import { Chip } from "./Chips.shared.tsx";
import { type PropertyChipProps } from "./Chips.types.ts";

/** An inline property that edits in place when clickable. */
export function PropertyChip({ label, value, icon, onClick }: PropertyChipProps): ReactElement {
  return (
    <Chip onClick={onClick}>
      {icon ? <Icon name={icon} size={14} color="var(--color-text-secondary)" /> : null}
      {label ? <span className="text-text-secondary">{label}</span> : null}
      <span>{value}</span>
    </Chip>
  );
}
