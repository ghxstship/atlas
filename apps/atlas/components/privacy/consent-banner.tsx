import { getTranslations } from "next-intl/server";
import { saveCookieChoice } from "@/lib/privacy/actions";
import { consentState } from "@/lib/privacy/consent";
import { RoutedConsentBanner as Banner } from "./consent-client";

/**
 * The cookie banner (Section 14.3 ePrivacy, legal/cookie-policy.md, finding A65-014): the shared
 * ConsentBanner of @xos/ui with Atlas's copy and its server action. Shown until the visitor chooses,
 * and never to a browser that sends Global Privacy Control, which counts as a refusal the proxy has
 * already recorded; the Cookie settings page tells that visitor why. When only the browser reports
 * the signal, the banner says so in Atlas's words and posts the refusal. Plain forms bound to a
 * server action, so the banner works before hydration. The links are next/link, through
 * consent-client.tsx, which imports `@xos/ui/consent`, a client module of its own, so the root
 * layout does not bring the rest of the library to every route (ADR 0027).
 */
export async function ConsentBanner() {
  const state = await consentState();
  if (state.consent !== null || state.gpc) return null;
  const t = await getTranslations("compliance.cookies");
  return (
    <Banner
      title={t("title")}
      body={t("body")}
      policy={{ label: t("policy"), href: "/legal/cookie-policy" }}
      settings={{ label: t("settingsLink"), href: "/legal/cookie-settings" }}
      acceptLabel={t("acceptAll")}
      rejectLabel={t("rejectAll")}
      chooseLabel={t("choose")}
      necessary={t("necessary")}
      categories={[
        { name: "preferences", label: t("preferences") },
        { name: "performance", label: t("performance") },
      ]}
      saveLabel={t("save")}
      gpcLabel={t("gpcBanner")}
      action={saveCookieChoice}
    />
  );
}
