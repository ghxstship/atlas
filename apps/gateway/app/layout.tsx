import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { cookies, headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import appIcon from "@xos/ui/brand/app-icon.svg";
import favicon from "@xos/ui/brand/favicon.svg";
import { themeColors } from "@xos/ui/pwa";
import { PwaRuntime } from "@/components/pwa/pwa-runtime";
import { CookieBanner } from "@/components/privacy/cookie-banner";
import { ThemeFollower, XOSProvider } from "@/components/ui";
import { localeDirection } from "@/i18n/negotiate";
import { clientMessages, negotiatedLocale, uiMessages } from "@/i18n/request";
import { brandStyle } from "@/lib/brand/brand";
import { productAnalyticsConsent } from "@/lib/privacy/product-analytics";
import { getRequestFacts } from "@/lib/shell/context";
import { THEME_COOKIE, preferenceFromCookie, renderedTheme } from "@/lib/theme";
import { PREFERENCES_COOKIE, decodePreferences, documentAttributes } from "@xos/ui/preferences";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const [t, facts] = await Promise.all([getTranslations("shell.gateway"), getRequestFacts()]);
  const name = facts.brand.kind === "org" ? facts.brand.org.name : t("name");
  return {
    title: { default: name, template: `%s · ${name}` },
    description: t("tagline"),
    // The installable app (A96, ADR 0052): an org's app icon on its custom domain, else the platform brand's marks.
    icons: {
      icon: favicon.src,
      apple:
        facts.brand.kind === "org" && facts.brand.org.appIconPath ? "/brand/app-icon" : appIcon.src,
    },
    appleWebApp: { capable: true, title: name },
  };
}

/** The browser's toolbar takes the canvas color of the color scheme, from the tokens. */
export const viewport: Viewport = { themeColor: themeColors() };

/**
 * The Gateway document: System theme by default (Section 11.6), the locale negotiated per request,
 * and the org brand accent on a custom Gateway domain (Section 4.4.7).
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  // The negotiated locale (a pseudo-locale in development) picks the language, direction and messages; next-intl's
  // locale, which XOSProvider formats with, is its formatting locale (i18n/request.ts, A53-001).
  const [locale, formatting, cookieStore, headerStore, facts, analytics] = await Promise.all([
    negotiatedLocale(),
    getLocale(),
    cookies(),
    headers(),
    getRequestFacts(),
    productAnalyticsConsent(),
  ]);
  const preference = preferenceFromCookie(cookieStore.get(THEME_COOKIE)?.value);
  const theme = renderedTheme(preference, headerStore.get("sec-ch-prefers-color-scheme"));
  const overrides = uiMessages(locale);
  // The person's display preferences (A65-001), kept in a cookie the shell syncs from their settings.
  const display = decodePreferences(cookieStore.get(PREFERENCES_COOKIE)?.value);
  return (
    <html
      lang={locale}
      dir={localeDirection(locale)}
      data-theme={theme}
      data-theme-preference={preference}
      style={brandStyle(facts.brand)}
      {...documentAttributes(display)}
    >
      <body>
        <NextIntlClientProvider messages={clientMessages(locale)}>
          <XOSProvider
            locale={formatting}
            preferences={display}
            {...(overrides ? { messages: overrides } : {})}
          >
            {preference === "system" ? <ThemeFollower /> : null}
            <CookieBanner />
            {children}
            <PwaRuntime analytics={analytics} />
          </XOSProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
