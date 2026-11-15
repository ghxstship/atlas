import { type ReactElement } from "react";
import { BrandMark } from "../BrandMark/BrandMark.tsx";
import { BrandSlotFrame } from "../Identity/BrandSlotFrame.tsx";
import { marketingCopy } from "./marketing-copy.ts";
import { type LogoSlotWallProps } from "./Marketing.types.ts";

const SLOT = { width: 160, height: 40 } as const;

/**
 * Customer marks. With no logos and no slots it renders nothing, so a page ships without it until
 * a customer consents in writing.
 */
export function LogoSlotWall({
  label,
  title,
  logos = [],
  slots = 0,
  disclosure,
  locale,
  messages,
}: LogoSlotWallProps): ReactElement | null {
  const { t } = marketingCopy({ locale, messages });
  if (logos.length === 0 && slots <= 0) return null;
  return (
    <div className="xos-mkt-logos">
      {title ? <p className="xos-mkt-label">{title}</p> : null}
      <ul aria-label={label}>
        {logos.map((logo) => (
          <li key={logo.name}>
            <BrandMark
              name={logo.name}
              size="lg"
              {...(logo.logoLight === undefined ? {} : { logoLight: logo.logoLight })}
              {...(logo.logoDark === undefined ? {} : { logoDark: logo.logoDark })}
            />
          </li>
        ))}
        {Array.from({ length: slots }, (_, index) => (
          <li key={`slot-${index}`}>
            <BrandSlotFrame
              label={t("mk.logo.slot", { n: index + 1 })}
              width={SLOT.width}
              height={SLOT.height}
              formats="SVG"
              sizeLabel={t("brand.size", SLOT)}
            />
          </li>
        ))}
      </ul>
      {disclosure ? <p className="xos-mkt-note">{disclosure}</p> : null}
    </div>
  );
}
