import type { ReactElement } from "react";
import { RecordKindGlyph } from "../Glyphs/Glyphs.tsx";
import { Chip } from "./Chips.shared.tsx";
import { type RecordKindChipProps } from "./Chips.types.ts";

/** Record kind glyph and name. */
export function RecordKindChip({ kind, label }: RecordKindChipProps): ReactElement {
  return (
    <Chip>
      <RecordKindGlyph kind={kind} size={14} color="var(--color-text-secondary)" />
      <span>{label ?? kind}</span>
    </Chip>
  );
}
