import { getTranslations } from "next-intl/server";
import { BrandEditor } from "@/components/settings/forms";
import { SectionHeader } from "@/components/settings/section-header";
import { requireNode } from "@/components/shell/sitemap-page";
import { InlineAlert } from "@/components/ui";
import { defaultAccent } from "@/lib/brand/contrast";

/**
 * White Label (Section 12, Section 4.5.6 item 12): the brand accent with the live contrast gate from
 * @xos/tokens and the logo slots. Saving needs an org brand table (not in migrations 0200 to 0207),
 * so the page states that the brand is checked but not kept.
 */
export default async function WhiteLabelSettingsPage({
  params,
}: PageProps<"/[org]/settings/white-label">) {
  await requireNode("settings.white-label", await params);
  const t = await getTranslations("shell.settings.whiteLabel");
  return (
    <>
      <SectionHeader node="settings.white-label" />
      <InlineAlert tone="warning">{t("notStored")}</InlineAlert>
      <BrandEditor initialAccent={defaultAccent()} />
      <section aria-labelledby="logos-heading" className="flex flex-col gap-8">
        <h2 id="logos-heading" className="m-0 text-heading-16 font-semibold">
          {t("logos")}
        </h2>
        <dl className="m-0 grid grid-cols-1 gap-12 sm:grid-cols-2">
          {(["logoLight", "logoDark"] as const).map((slot) => (
            <div
              key={slot}
              className="flex flex-col gap-4 rounded-card border border-border-subtle p-12"
            >
              <dt className="text-label-13 font-medium">{t(slot)}</dt>
              <dd className="m-0 text-text-12 text-text-secondary">{t("logoHelp")}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}
