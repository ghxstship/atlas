import { type CSSProperties, type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { type BrandSlotProps } from "./Identity.types.ts";

/**
 * Marks where a tenant uploads a brand file, drawn in proportion (at most 160 by 148) with its
 * delivery size and formats.
 */
export function BrandSlot({ label, width, height, formats }: BrandSlotProps): ReactElement {
  const t = useT();
  const scale = Math.min(1, 160 / width, 148 / height);
  const frame: CSSProperties = {
    inlineSize: `calc(var(--space-4) * ${Math.round(width * scale) / 4})`,
    blockSize: `calc(var(--space-4) * ${Math.round(height * scale) / 4})`,
  };
  return (
    <figure className="flex flex-col gap-6 m-0">
      <div
        aria-hidden="true"
        style={frame}
        className="flex flex-col items-center justify-center gap-4 min-w-(--space-64) min-h-(--space-48) box-border rounded-card border border-dashed border-border-strong text-text-tertiary text-text-11"
      >
        <Icon name="Image" size={20} />
        <span className="tabular-nums">{t("brand.size", { width, height })}</span>
      </div>
      <figcaption className="flex flex-col text-text-12 text-text-secondary">
        <strong className="font-medium text-text-primary">{label}</strong>
        <span className="tabular-nums">{t("brand.size", { width, height })}</span>
        <span>{formats}</span>
      </figcaption>
    </figure>
  );
}
