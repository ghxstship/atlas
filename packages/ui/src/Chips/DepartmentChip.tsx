import type { ReactElement } from "react";
import { DepartmentGlyph } from "../Glyphs/Glyphs.tsx";
import { Chip } from "./Chips.shared.tsx";
import { type DepartmentChipProps } from "./Chips.types.ts";
import { codeClass } from "./codeClass.tsx";

/** Department name with its code in a mono chip. */
export function DepartmentChip({ name, code }: DepartmentChipProps): ReactElement {
  return (
    <Chip>
      <DepartmentGlyph code={code} size={14} color="var(--color-text-secondary)" />
      <span>{name}</span>
      <span className={codeClass}>{code}</span>
    </Chip>
  );
}
