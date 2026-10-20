import type { Route } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Button, InlineAlert } from "@/components/ui";
import { saveCookieChoice } from "@/lib/privacy/actions";
import { consentState } from "@/lib/privacy/consent";

/** Every cookie Atlas sets, by category (legal/cookie-policy.md section 3 asks for them by name). */
const COOKIES = [
  { name: "xos-auth", category: "necessary", purpose: "session" },
  { name: "xos-consent", category: "necessary", purpose: "consent" },
  { name: "xos-view-as", category: "necessary", purpose: "viewAs" },
  { name: "xos-locale", category: "preferences", purpose: "locale" },
  { name: "xos-theme", category: "preferences", purpose: "theme" },
  { name: "xos-workspace", category: "preferences", purpose: "workspace" },
  { name: "xos-last-org", category: "preferences", purpose: "lastOrg" },
] as const;

/**
 * Cookie settings (Section 14.3, legal/cookie-policy.md section 5): the visitor's current choice, the
 * categories with the cookies in each, and the same choice as the banner. A browser that sends Global
 * Privacy Control is told the signal counts as a refusal. Public: no session needed.
 */
export async function CookieSettings() {
  const [state, t] = await Promise.all([consentState(), getTranslations("compliance.cookies")]);
  const choice = state.consent;
  return (
    <main id="content" className="mx-auto flex max-w-layout-reading flex-col gap-16 p-24">
      <h1 className="m-0 text-heading-24 font-semibold">{t("settingsTitle")}</h1>
      <p className="m-0 text-text-14 text-text-secondary">{t("settingsLead")}</p>
      {state.gpc ? <InlineAlert tone="info">{t("gpc")}</InlineAlert> : null}
      <p className="m-0 text-text-14" role="status">
        {choice === null
          ? t("current.none")
          : t("current.choice", {
              preferences: t(choice.preferences ? "current.on" : "current.off"),
              performance: t(choice.performance ? "current.on" : "current.off"),
            })}
      </p>
      <form action={saveCookieChoice} className="flex flex-col gap-12">
        <input type="hidden" name="choice" value="save" />
        <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
          <legend className="mb-4 text-label-14 font-medium">{t("categories")}</legend>
          <label className="flex items-start gap-8 text-text-14">
            <input type="checkbox" checked disabled className="mt-2" />
            <span>{t("necessary")}</span>
          </label>
          <label className="flex items-start gap-8 text-text-14">
            <input
              type="checkbox"
              name="preferences"
              className="mt-2"
              defaultChecked={choice?.preferences ?? false}
              disabled={state.gpc}
            />
            <span>{t("preferences")}</span>
          </label>
          <label className="flex items-start gap-8 text-text-14">
            <input
              type="checkbox"
              name="performance"
              className="mt-2"
              defaultChecked={choice?.performance ?? false}
              disabled={state.gpc}
            />
            <span>{t("performance")}</span>
          </label>
        </fieldset>
        <div className="flex flex-wrap gap-8">
          <Button type="submit" variant="primary">
            {t("save")}
          </Button>
        </div>
      </form>
      <form action={saveCookieChoice} className="flex flex-wrap gap-8">
        <Button type="submit" name="choice" value="all" variant="secondary" disabled={state.gpc}>
          {t("acceptAll")}
        </Button>
        <Button type="submit" name="choice" value="none" variant="secondary">
          {t("rejectAll")}
        </Button>
      </form>
      <table className="w-full border-collapse text-left text-text-13">
        <caption className="mb-8 text-left text-label-14 font-medium">{t("table.caption")}</caption>
        <thead>
          <tr className="border-b border-border-subtle">
            <th scope="col" className="py-4 pe-8">
              {t("table.name")}
            </th>
            <th scope="col" className="py-4 pe-8">
              {t("table.category")}
            </th>
            <th scope="col" className="py-4">
              {t("table.purpose")}
            </th>
          </tr>
        </thead>
        <tbody>
          {COOKIES.map((c) => (
            <tr key={c.name} className="border-b border-border-subtle">
              <th scope="row" className="py-4 pe-8 font-mono font-normal">
                {c.name}
              </th>
              <td className="py-4 pe-8">{t(`table.categories.${c.category}`)}</td>
              <td className="py-4">{t(`table.purposes.${c.purpose}`)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="m-0 text-text-13 text-text-secondary">
        <Link className="text-accent-text underline" href={"/legal/cookie-policy" as Route}>
          {t("policy")}
        </Link>
      </p>
    </main>
  );
}
