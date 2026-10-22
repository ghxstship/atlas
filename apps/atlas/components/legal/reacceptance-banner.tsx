import { listPendingReacceptances } from "@xos/data/legal-reacceptance";
import type { Route } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Banner } from "@/components/platform/client/banner";
import { LEGAL_DOCUMENTS } from "@/lib/legal.generated";
import type { OrgContext } from "@/lib/shell/context";

/** A long date in the viewer's language: a YYYY-MM-DD effective date, or the day (UTC) of a timestamp. */
export function legalDate(locale: string, value: string): string {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(date);
}

export function documentTitle(slug: string): string {
  return LEGAL_DOCUMENTS.find((d) => d.slug === slug)?.title ?? slug;
}

/**
 * The re-acceptance prompt above every org page (Section 14.4, finding A65-014; migration 1383):
 * shown to whoever may accept legal terms for the org (org.legal.accept) once the platform team has
 * announced a material change, until the org accepts the new version in Settings, Legal. It cannot
 * be dismissed. Nobody else is asked, and nothing is read for them.
 */
export async function ReacceptanceBanner({ ctx }: { ctx: OrgContext }) {
  if (!ctx.capabilities.has("org.legal.accept") || ctx.preview) return null;
  const pending = await listPendingReacceptances(ctx.viewer.db, ctx.org.id);
  if (!pending.ok || pending.data.length === 0) return null;
  const [t, locale] = await Promise.all([getTranslations("compliance.reacceptance"), getLocale()]);
  const required = pending.data.some((p) => p.required);
  return (
    <div className="mb-16">
      <Banner tone={required ? "danger" : "warning"} icon="FileText">
        <span data-testid="reacceptance-banner" className="flex flex-col gap-4">
          {pending.data.map((p) => (
            <span key={`${p.documentSlug}@${p.documentVersion}`}>
              {t(p.required ? "banner.required" : "banner.upcoming", {
                title: documentTitle(p.documentSlug),
                date: legalDate(locale, p.effectiveOn),
                org: ctx.org.name,
              })}
            </span>
          ))}
          <Link
            className="font-medium text-accent-text underline"
            href={`/${ctx.org.slug}/settings/legal` as Route}
          >
            {t("banner.review")}
          </Link>
        </span>
      </Banner>
    </div>
  );
}
