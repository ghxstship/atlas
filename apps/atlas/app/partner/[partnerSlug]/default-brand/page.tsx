import { getDefaultBrand } from "@xos/data/partner";
import { listBrandFonts } from "@xos/data/settings";
import { DefaultBrandForm } from "@/components/partner/default-brand";
import { ErrorPanel } from "@/components/platform/kit";
import { PartnerFrame } from "@/components/partner/partner-frame";
import { requireNode } from "@/components/shell/sitemap-page";
import { getPlatformT } from "@/lib/platform/format";

/**
 * Default brand (Section 4.6.1, Section 12): the brand every client org inherits, and whether a client
 * may override it. The accent passes the white-label contrast gate before it is saved.
 */
export default async function Page({ params }: PageProps<"/partner/[partnerSlug]/default-brand">) {
  const ctx = await requireNode("partner-console.default-brand", await params);
  const t = await getPlatformT();
  const [brand, fonts] = await Promise.all([
    getDefaultBrand(ctx.viewer.db, ctx.org.id),
    listBrandFonts(ctx.viewer.db),
  ]);
  return (
    <PartnerFrame ctx={ctx} node="partner-console.default-brand">
      {!brand.ok || !fonts.ok ? (
        <ErrorPanel sentence={t("partner.brand.loadError")} />
      ) : (
        <DefaultBrandForm org={ctx.org.slug} brand={brand.data} fonts={fonts.data} />
      )}
    </PartnerFrame>
  );
}
