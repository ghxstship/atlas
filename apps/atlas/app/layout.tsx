import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { XOSProvider } from "@/components/ui";
import { localeDirection, type AtlasLocale } from "@/i18n/negotiate";
import { clientMessages, uiMessages } from "@/i18n/request";
import { THEME_COOKIE, themeFromCookie } from "@/lib/theme";
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
  const overrides = uiMessages(locale as AtlasLocale);
  return (
    <html lang={locale} dir={localeDirection(locale)} data-theme={theme}>
      <body>
        <NextIntlClientProvider messages={clientMessages(locale as AtlasLocale)}>
          <XOSProvider locale={locale} {...(overrides ? { messages: overrides } : {})}>
            {children}
          </XOSProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
