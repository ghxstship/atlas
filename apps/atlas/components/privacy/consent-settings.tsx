import { ConsentSettings as Settings } from "@xos/ui/consent";
import { getTranslations } from "next-intl/server";
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
 * Cookie settings (Section 14.3, legal/cookie-policy.md section 5): the shared ConsentSettings of
 * @xos/ui with Atlas's copy, the visitor's current choice, the categories with the cookies in each,
 * and the same choice as the banner. A browser that sends Global Privacy Control is told the signal
 * counts as a refusal. Public: no session needed.
 */
export async function ConsentSettings() {
  const [state, t] = await Promise.all([consentState(), getTranslations("compliance.cookies")]);
  const choice = state.consent;
  return (
    <main id="content">
      <Settings
        title={t("settingsTitle")}
        lead={t("settingsLead")}
        gpc={state.gpc}
        gpcNotice={t("gpc")}
        status={
          choice === null
            ? t("current.none")
            : t("current.choice", {
                preferences: t(choice.preferences ? "current.on" : "current.off"),
                performance: t(choice.performance ? "current.on" : "current.off"),
              })
        }
        categoriesLabel={t("categories")}
        necessary={t("necessary")}
        categories={[
          { name: "preferences", label: t("preferences"), checked: choice?.preferences ?? false },
          { name: "performance", label: t("performance"), checked: choice?.performance ?? false },
        ]}
        saveLabel={t("save")}
        acceptLabel={t("acceptAll")}
        rejectLabel={t("rejectAll")}
        cookies={{
          caption: t("table.caption"),
          nameLabel: t("table.name"),
          categoryLabel: t("table.category"),
          purposeLabel: t("table.purpose"),
          rows: COOKIES.map((c) => ({
            name: c.name,
            category: t(`table.categories.${c.category}`),
            purpose: t(`table.purposes.${c.purpose}`),
          })),
        }}
        policy={{ label: t("policy"), href: "/legal/cookie-policy" }}
        action={saveCookieChoice}
      />
    </main>
  );
}
