import { ConsentBannerStatic } from "@xos/ui/consent/static";
import { getTranslations } from "next-intl/server";
import { saveCookieChoice } from "@/lib/privacy/actions";
import { consentState } from "@/lib/privacy/consent";
import { routerLink } from "./consent-link";

/**
 * The cookie banner (Section 14.3 ePrivacy, legal/cookie-policy.md, finding A65-014): the shared
 * banner of @xos/ui in its script-free form, with Atlas's copy and its server action. Shown until
 * the visitor chooses, and never to a browser that sends Global Privacy Control, which counts as a
 * refusal the proxy has already recorded; the Cookie settings page tells that visitor why. Plain
 * forms bound to a server action, so the banner works before hydration, and a server component with
 * no client module of its own, so the root layout adds no script to any route for it (ADR 0027).
 * The links are next/link.
 */
export async function ConsentBanner() {
  const state = await consentState();
  if (state.consent !== null || state.gpc) return null;
  const t = await getTranslations("compliance.cookies");
  return (
    <ConsentBannerStatic
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
      action={saveCookieChoice}
      renderLink={routerLink}
    />
  );
}
