import type { ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { PhaseGlyph } from "../Glyphs/Glyphs.tsx";
import { Chip } from "./Chips.shared.tsx";
import { type PhaseChipProps } from "./Chips.types.ts";

/** Gate number and phase name (`Gate 3 · Advance`); the code is never shown alone. */
export function PhaseChip({ gate, name, code }: PhaseChipProps): ReactElement {
  const t = useT();
  return (
    <Chip title={code}>
      <PhaseGlyph code={code} size={14} color="var(--color-text-secondary)" />
      <span>{t("phase.gateName", { n: gate, name })}</span>
    </Chip>
  );
}
