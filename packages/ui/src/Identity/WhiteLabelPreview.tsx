import { type CSSProperties, type ReactElement } from "react";
import { BrandMark } from "../BrandMark/BrandMark.tsx";
import { type WhiteLabelPreviewProps } from "./Identity.types.ts";
import { tokenVariable } from "./tokenVariable.tsx";

/** The same screen under each tenant brand, to prove theming is token-only. */
export function WhiteLabelPreview({ sample, brands }: WhiteLabelPreviewProps): ReactElement {
  return (
    <div className="grid grid-cols-2 max-sm:grid-cols-1 gap-16">
      {brands.map((brand) => {
        const style: Record<string, string> = {};
        for (const [key, value] of Object.entries(brand.tokens)) style[tokenVariable(key)] = value;
        return (
          <section
            key={brand.name}
            aria-label={brand.name}
            data-theme={brand.theme}
            style={style as CSSProperties}
            className="overflow-hidden rounded-card border border-border-subtle bg-bg-canvas text-text-primary"
          >
            <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 px-12 py-8 bg-bg-surface border-b border-border-subtle text-text-12">
              <BrandMark name={brand.name} size="sm" />
              <span title={brand.domain} className="min-w-0 truncate text-text-secondary">
                {brand.domain}
              </span>
            </div>
            <div className="flex flex-col gap-12 p-16">{sample}</div>
          </section>
        );
      })}
    </div>
  );
}
