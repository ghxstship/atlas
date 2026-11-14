import { type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { BrandSlotFrame } from "./BrandSlotFrame.tsx";
import { type BrandSlotProps } from "./Identity.types.ts";

/**
 * Marks where a tenant uploads a brand file, drawn in proportion (at most 160 by 148) with its
 * delivery size and formats.
 */
export function BrandSlot({ width, height, ...slot }: BrandSlotProps): ReactElement {
  const t = useT();
  return (
    <BrandSlotFrame
      {...slot}
      width={width}
      height={height}
      sizeLabel={t("brand.size", { width, height })}
    />
  );
}
