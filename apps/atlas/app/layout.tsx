import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { XOSProvider } from "@/components/xos-provider";
import { localeDirection, type AtlasLocale } from "@/i18n/negotiate";
import { clientMessages, uiMessages } from "@/i18n/request";
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
  const [locale, cookieStore] = await Promise.all([getLocale(), cookies()]);
  const theme = themeFromCookie(cookieStore.get(THEME_COOKIE)?.value);
  // The person's display preferences (A65-001), kept in a cookie the shell syncs from their settings.
  const preferences = decodePreferences(cookieStore.get(PREFERENCES_COOKIE)?.value);
  const overrides = uiMessages(locale as AtlasLocale);
  return (
    <html
      lang={locale}
      dir={localeDirection(locale)}
      data-theme={theme}
      {...documentAttributes(preferences)}
    >
      <body>
        <NextIntlClientProvider messages={clientMessages(locale as AtlasLocale)}>
          <XOSProvider
            locale={locale}
            preferences={preferences}
            {...(overrides ? { messages: overrides } : {})}
          >
            {children}
          </XOSProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
