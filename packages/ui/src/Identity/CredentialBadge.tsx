import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Button, IconButton } from "../Button/Button.tsx";
import { Avatar } from "../Avatar/Avatar.tsx";
import { BrandMark } from "../BrandMark/BrandMark.tsx";
import { chipClass } from "../Chips/Chips.tsx";
import { type CredentialBadgeProps } from "./Identity.types.ts";
import { QRCode } from "./QRCode.tsx";

const CATEGORY: Record<CredentialBadgeProps["categoryColor"], string> = {
  1: cx("border-t-viz-cat-1"),
  2: cx("border-t-viz-cat-2"),
  3: cx("border-t-viz-cat-3"),
  4: cx("border-t-viz-cat-4"),
  5: cx("border-t-viz-cat-5"),
  6: cx("border-t-viz-cat-6"),
  7: cx("border-t-viz-cat-7"),
};

/** The badge shown at access points: category band with its label, holder, offline QR code, zones and validity. */
export function CredentialBadge({
  org,
  name,
  role,
  category,
  categoryColor,
  credentialKey,
  payload,
  zones,
  validFrom,
  validTo,
  onWallet,
  onBrightness,
}: CredentialBadgeProps): ReactElement {
  const t = useT();
  return (
    <article
      aria-label={t("badge.label", { name })}
      className="flex flex-col w-(--layout-property-column) max-w-full box-border overflow-hidden rounded-dialog border border-border-subtle bg-bg-raised"
    >
      <div
        className={cx(
          "px-16 py-6 border-t-stroke-stripe bg-bg-surface text-text-primary font-semibold text-text-13 tracking-wider uppercase",
          CATEGORY[categoryColor],
        )}
      >
        {category}
      </div>
      <div className="flex flex-col gap-12 p-16">
        <div className="flex items-center justify-between gap-8">
          <BrandMark name={org} size="sm" />
          <span className="font-mono text-text-12 text-text-secondary">{credentialKey}</span>
        </div>
        <div className="flex items-center gap-12">
          <Avatar name={name} size="lg" />
          <div className="flex flex-col">
            <strong className="text-heading-20 font-semibold">{name}</strong>
            <span className="text-text-secondary">{role}</span>
          </div>
        </div>
        <div className="flex justify-center p-8 rounded-card bg-paper">
          <QRCode value={payload} label={t("badge.qr", { key: credentialKey })} size={168} />
        </div>
        <div className="flex flex-col gap-4">
          <span className="text-text-12 font-medium text-text-secondary">{t("badge.zones")}</span>
          <ul className="flex flex-wrap gap-4 m-0 p-0 list-none">
            {zones.map((z) => (
              <li key={z} className={chipClass}>
                {z}
              </li>
            ))}
          </ul>
        </div>
        <span className="text-text-secondary tabular-nums">
          {t("badge.valid", { from: validFrom, to: validTo })}
        </span>
        <div className="flex items-center gap-8">
          <Button icon="Wallet" className="flex-1" onClick={onWallet}>
            {t("badge.wallet")}
          </Button>
          <IconButton
            icon="SunMedium"
            label={t("badge.brightness")}
            variant="secondary"
            onClick={onBrightness}
          />
        </div>
      </div>
    </article>
  );
}
