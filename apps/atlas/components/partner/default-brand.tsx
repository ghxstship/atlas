"use client";

import type { DefaultBrand } from "@xos/data/partner";
import { Checkbox, Input, Select } from "@xos/ui";
import { useState } from "react";
import { saveDefaultBrandAction } from "@/app/partner/[partnerSlug]/actions";
import { ActionForm, usePlatformT } from "@/components/platform/kit";

const RADII = ["Compact", "Default", "Rounded"] as const;

/** The partner's default client brand: accent, tint, font, radius, sender details and the override rule. */
export function DefaultBrandForm({
  org,
  brand,
  fonts,
}: {
  org: string;
  brand: DefaultBrand;
  fonts: readonly string[];
}) {
  const t = usePlatformT();
  const [accent, setAccent] = useState(brand.accentHex ?? "");
  const [font, setFont] = useState(brand.fontFamily ?? "");
  const [radius, setRadius] = useState<string>(brand.radiusScale);
  const valid = /^#[0-9A-Fa-f]{6}$/.test(accent);
  return (
    <div className="flex max-w-layout-form flex-col gap-16">
      <p className="m-0 text-text-13 text-text-secondary">{t("partner.brand.intro")}</p>
      <ActionForm
        action={saveDefaultBrandAction}
        hidden={{ org, font, radius }}
        label={t("partner.brand.formLabel")}
        submitLabel={t("partner.brand.save")}
        success={t("partner.brand.saved")}
      >
        <div className="flex flex-wrap items-end gap-12">
          <Input
            id="brand-accent"
            name="accent"
            label={t("partner.brand.accent")}
            help={t("partner.brand.accentHelp")}
            value={accent}
            onChange={(e) => setAccent(e.target.value)}
            pattern="#[0-9A-Fa-f]{6}"
            maxLength={7}
            width={200}
          />
          <span
            role="img"
            aria-label={
              valid
                ? t("partner.brand.swatch", { accent: accent.toUpperCase() })
                : t("partner.brand.noSwatch")
            }
            className="mb-4 inline-block size-32 rounded-control border border-border-subtle bg-accent-default"
            // design-audit-allow: the partner's brand accent is data, not a design value
            style={valid ? { backgroundColor: accent } : undefined}
          />
        </div>
        <Input
          id="brand-tint"
          name="tint"
          label={t("partner.brand.tint")}
          help={t("partner.brand.tintHelp")}
          defaultValue={brand.neutralTintHex ?? ""}
          pattern="#[0-9A-Fa-f]{6}"
          maxLength={7}
          width={200}
        />
        <Select
          label={t("partner.brand.font")}
          value={font}
          options={[
            { value: "", label: t("partner.brand.platformFont") },
            ...fonts.map((f) => ({ value: f, label: f })),
          ]}
          onChange={(e) => setFont(e.target.value)}
        />
        <Select
          label={t("partner.brand.radius")}
          value={radius}
          options={RADII.map((r) => ({ value: r, label: t(`partner.brand.radii.${r}`) }))}
          onChange={(e) => setRadius(e.target.value)}
        />
        <Input
          id="brand-sender"
          name="sender"
          label={t("partner.brand.sender")}
          help={t("partner.brand.senderHelp")}
          defaultValue={brand.emailSenderName ?? ""}
          maxLength={100}
          width="100%"
        />
        <Input
          id="brand-support"
          name="support"
          type="email"
          label={t("partner.brand.support")}
          defaultValue={brand.supportEmail ?? ""}
          width="100%"
        />
        <Checkbox
          id="brand-override"
          name="allowOverride"
          label={t("partner.brand.allowOverride")}
          defaultChecked={brand.allowClientOverride}
        />
      </ActionForm>
    </div>
  );
}
