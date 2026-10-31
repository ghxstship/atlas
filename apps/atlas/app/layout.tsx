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
import { XOSProvider } from "@/components/xos-provider";
import { localeDirection } from "@/i18n/negotiate";
import { clientMessages, negotiatedLocale, uiMessages } from "@/i18n/request";
import { PATH_HEADER } from "@/lib/auth/assurance";
import { productAnalyticsConsent } from "@/lib/privacy/product-analytics";
import { THEME_COOKIE, themeFromCookie } from "@/lib/theme";
import { PREFERENCES_COOKIE, decodePreferences, documentAttributes } from "@xos/ui/preferences";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell.atlas");
  return {
    title: { default: t("name"), template: `%s · ${t("name")}` },
    description: t("tagline"),
    // The installable app (A96, ADR 0052): the platform brand's marks; app/manifest.ts links itself.
    icons: { icon: favicon.src, apple: appIcon.src },
    appleWebApp: { capable: true, title: t("name") },
  };
}

/** The browser's toolbar takes the canvas color of the color scheme, from the tokens. */
export const viewport: Viewport = { themeColor: themeColors() };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The negotiated locale (a pseudo-locale in development) picks the language, direction and messages; next-intl's
  // locale, which XOSProvider formats with, is its formatting locale (i18n/request.ts, A53-001).
  const [locale, formatting, cookieStore, analytics, requestHeaders] = await Promise.all([
    negotiatedLocale(),
    getLocale(),
    cookies(),
    productAnalyticsConsent(),
    headers(),
  ]);
  // Public live link pages (P1, ADR 0130) set only the strictly necessary grant cookie and load no product
  // analytics; a display screen also keeps the cookie banner off, so it never covers the timer on a TV.
  const path = requestHeaders.get(PATH_HEADER) ?? "";
  const publicLive = /^\/share\/(view|screen)\//.test(path);
  const screen = path.startsWith("/share/screen/");
  const theme = themeFromCookie(cookieStore.get(THEME_COOKIE)?.value);
  // The person's display preferences (A65-001), kept in a cookie the shell syncs from their settings.
  const preferences = decodePreferences(cookieStore.get(PREFERENCES_COOKIE)?.value);
  const overrides = uiMessages(locale);
  return (
    <html
      lang={locale}
      dir={localeDirection(locale)}
      data-theme={theme}
      {...documentAttributes(preferences)}
    >
      <body>
        <NextIntlClientProvider messages={clientMessages(locale)}>
          <XOSProvider
            locale={formatting}
            preferences={preferences}
            {...(overrides ? { messages: overrides } : {})}
          >
            {screen ? null : <CookieBanner />}
            {children}
            <PwaRuntime analytics={analytics && !publicLive} />
          </XOSProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
