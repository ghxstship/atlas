import type { ReactElement } from "react";
import { Chip } from "./Chips.shared.tsx";
import { type URIDChipProps } from "./Chips.types.ts";
import { codeClass } from "./codeClass.tsx";

/** Catalog element name with its URID in a mono chip. */
export function URIDChip({ name, urid }: URIDChipProps): ReactElement {
  return (
    <Chip>
      <span>{name}</span>
      <span className={codeClass}>{urid}</span>
    </Chip>
  );
}
