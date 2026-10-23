import type { XosClient } from "@xos/data/client";
import { listPendingReacceptances } from "@xos/data/legal-reacceptance";
import type { Route } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Button, InlineAlert } from "@/components/ui";
import { gatewayLegalDocument } from "@/lib/auth/legal";
import { acceptPersonalLegalChangeAction } from "@/lib/legal/reacceptance-actions";

/**
 * The re-acceptance prompt at the top of every signed-in Gateway page (Section 14.4, finding A65-014;
 * migration 1383): after the platform team announces a material change to a personal document the
 * person accepted before, such as the Worker Terms, it says what changes and when, links the
 * document and accepts with one button. It stays until they accept.
 */
export async function ReacceptancePrompt({ db }: { db: XosClient }) {
  const pending = await listPendingReacceptances(db, null);
  if (!pending.ok || pending.data.length === 0) return null;
  const [t, locale] = await Promise.all([getTranslations("compliance.reacceptance"), getLocale()]);
  const long = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" });
  return (
    <div className="mb-16 flex flex-col gap-8" data-testid="reacceptance-prompt">
      {pending.data.map((p) => {
        const title = gatewayLegalDocument(p.documentSlug)?.title ?? p.documentSlug;
        return (
          <InlineAlert
            key={`${p.documentSlug}@${p.documentVersion}`}
            tone={p.required ? "danger" : "warning"}
            title={t(p.required ? "personal.required" : "personal.upcoming", {
              title,
              date: long.format(new Date(`${p.effectiveOn}T00:00:00Z`)),
            })}
          >
            <span className="flex flex-col gap-8">
              <span>{p.summary}</span>
              <form
                action={acceptPersonalLegalChangeAction}
                className="flex flex-wrap items-center gap-12"
              >
                <input type="hidden" name="document" value={p.documentSlug} />
                <input type="hidden" name="version" value={p.documentVersion} />
                <Button type="submit" variant="primary">
                  {t("settings.accept", { title, version: p.documentVersion })}
                </Button>
                <Link
                  className="text-text-13 text-accent-text underline"
                  href={`/legal/${p.documentSlug}` as Route}
                >
                  {t("settings.read", { title })}
                </Link>
              </form>
            </span>
          </InlineAlert>
        );
      })}
    </div>
  );
}
