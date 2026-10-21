import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { CookieBanner } from "@/components/privacy/cookie-banner";
import { XOSProvider } from "@/components/xos-provider";
import { localeDirection } from "@/i18n/negotiate";
import { clientMessages, negotiatedLocale, uiMessages } from "@/i18n/request";
import { THEME_COOKIE, themeFromCookie } from "@/lib/theme";
import { PREFERENCES_COOKIE, decodePreferences, documentAttributes } from "@xos/ui/preferences";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell.atlas");
  return {
    title: { default: t("name"), template: `%s · ${t("name")}` },
    description: t("tagline"),
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The negotiated locale (a pseudo-locale in development) picks the language, direction and messages; next-intl's
  // locale, which XOSProvider formats with, is its formatting locale (i18n/request.ts, A53-001).
  const [locale, formatting, cookieStore] = await Promise.all([
    negotiatedLocale(),
    getLocale(),
    cookies(),
  ]);
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
            <CookieBanner />
            {children}
          </XOSProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
