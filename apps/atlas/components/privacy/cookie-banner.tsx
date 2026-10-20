import type { Route } from "next";
import Link from "next/link";
import { Button } from "@/components/ui";
import { getTranslations } from "next-intl/server";
import { saveCookieChoice } from "@/lib/privacy/actions";
import { consentState } from "@/lib/privacy/consent";

/**
 * The cookie banner (Section 14.3 ePrivacy, legal/cookie-policy.md, finding A65-014). Shown until the
 * visitor chooses, and never to a browser that sends Global Privacy Control, which counts as a refusal.
 * Accept all and Reject all carry equal weight; Choose opens the categories. A server component of
 * plain forms bound to a server action, so it adds no script to any page and works before hydration.
 */
export async function CookieBanner() {
  const state = await consentState();
  if (state.consent !== null || state.gpc) return null;
  const t = await getTranslations("compliance.cookies");
  return (
    <section
      aria-labelledby="cookie-banner-title"
      className="border-b border-border-subtle bg-bg-surface p-16"
    >
      <div className="mx-auto flex max-w-layout-reading flex-col gap-12">
        <h2 id="cookie-banner-title" className="m-0 text-heading-16 font-semibold">
          {t("title")}
        </h2>
        <p className="m-0 text-text-13 text-text-secondary">
          {t("body")}{" "}
          <Link className="text-accent-text underline" href={"/legal/cookie-policy" as Route}>
            {t("policy")}
          </Link>
          {" · "}
          <Link className="text-accent-text underline" href={"/legal/cookie-settings" as Route}>
            {t("settingsLink")}
          </Link>
        </p>
        <form action={saveCookieChoice} className="flex flex-wrap gap-8">
          <Button type="submit" name="choice" value="all" variant="secondary">
            {t("acceptAll")}
          </Button>
          <Button type="submit" name="choice" value="none" variant="secondary">
            {t("rejectAll")}
          </Button>
        </form>
        <details className="text-text-13">
          <summary className="cursor-pointer text-accent-text underline">{t("choose")}</summary>
          <form action={saveCookieChoice} className="mt-8 flex flex-col gap-8">
            <input type="hidden" name="choice" value="save" />
            <p className="m-0 text-text-12 text-text-secondary">{t("necessary")}</p>
            <label className="flex items-start gap-8">
              <input type="checkbox" name="preferences" className="mt-2" />
              <span>{t("preferences")}</span>
            </label>
            <label className="flex items-start gap-8">
              <input type="checkbox" name="performance" className="mt-2" />
              <span>{t("performance")}</span>
            </label>
            <div>
              <Button type="submit" size="sm" variant="secondary">
                {t("save")}
              </Button>
            </div>
          </form>
        </details>
      </div>
    </section>
  );
}
