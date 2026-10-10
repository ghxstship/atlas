import { useMemo, type CSSProperties, type ReactElement } from "react";
import qrcode from "qrcode-generator";
import nameMap from "@xos/tokens/name-map.json" with { type: "json" };
import type {
  BrandSlotProps as ReferenceBrandSlotProps,
  CredentialBadgeProps as ReferenceCredentialBadgeProps,
  PresenceIndicatorProps as ReferencePresenceIndicatorProps,
  QRCodeProps as ReferenceQRCodeProps,
  WhiteLabelPreviewProps as ReferenceWhiteLabelPreviewProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useFormat, useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button, IconButton } from "../Button/Button.tsx";
import { Avatar } from "../Avatar/Avatar.tsx";
import { BrandMark } from "../BrandMark/BrandMark.tsx";
import { chipClass } from "../Chips/Chips.tsx";

export type PresenceIndicatorProps = ReferencePresenceIndicatorProps;
export type QRCodeProps = ReferenceQRCodeProps;
export type CredentialBadgeProps = ReferenceCredentialBadgeProps & {
  onWallet?: () => void;
  onBrightness?: () => void;
};
export type BrandSlotProps = ReferenceBrandSlotProps;
export type WhiteLabelPreviewProps = ReferenceWhiteLabelPreviewProps;

/** Who is viewing or editing a record live; the count and names are announced together. */
export function PresenceIndicator({
  names,
  verb = "viewing",
}: PresenceIndicatorProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  const summary = t(verb === "editing" ? "presence.editing" : "presence.viewing", {
    n: names.length,
  });
  return (
    <span
      role="img"
      aria-label={t(verb === "editing" ? "presence.namesEditing" : "presence.namesViewing", {
        names: fmt.list(names),
      })}
      className="inline-flex items-center gap-8 text-text-12"
    >
      <span aria-hidden="true" className="inline-flex [&>*+*]:ms-(--ui-avatar-overlap)">
        {names.slice(0, 3).map((name) => (
          <span key={name} className="relative inline-flex">
            <Avatar name={name} />
            <span className="absolute -end-(--stroke-width-hairline) -bottom-(--stroke-width-hairline) size-(--space-8) rounded-full bg-success ring-(length:--stroke-width-focus) ring-bg-canvas" />
          </span>
        ))}
      </span>
      <span aria-hidden="true" className="text-text-secondary">
        {summary}
      </span>
    </span>
  );
}

interface QRModules {
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}

/** The dark modules of a QR code (error correction M) as one SVG path, with a 4-module quiet zone. */
export function qrPath(value: string): { size: number; path: string } {
  const code = qrcode(0, "M");
  code.addData(value);
  code.make();
  const modules = code as unknown as QRModules;
  const n = modules.getModuleCount();
  const cells: string[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (modules.isDark(r, c)) cells.push(`M${c + 4} ${r + 4}h1v1h-1z`);
  }
  return { size: n + 8, path: cells.join("") };
}

/** A scannable code as SVG, always dark on a light quiet zone so scanners read it in every theme. */
export function QRCode({ value, label, size = 160 }: QRCodeProps): ReactElement {
  const { size: modules, path } = useMemo(() => qrPath(value), [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${modules} ${modules}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="block rounded-control"
    >
      <rect width={modules} height={modules} className="fill-paper" />
      <path d={path} className="fill-paper-ink" />
    </svg>
  );
}

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

const SPEC = nameMap as Record<string, string>;

/** The CSS variable a white-label token override sets: the spec name with dots as hyphens (`accent-default` is `--color-accent-default`). */
export function tokenVariable(key: string): string {
  const spec = SPEC[key];
  return `--${(spec ?? key).replace(/\./g, "-")}`;
}

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
