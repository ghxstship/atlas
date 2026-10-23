import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies, headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { ThemeFollower, XOSProvider } from "@/components/ui";
import { clientMessages, negotiatedLocale, uiMessages } from "@/i18n/request";
import { THEME_COOKIE, preferenceFromCookie, renderedTheme } from "@/lib/theme";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("console");
  return {
    title: { default: t("name"), template: `%s · ${t("name")}` },
    description: t("tagline"),
    robots: { index: false, follow: false },
  };
}

/** The console document: System theme by default (Section 11.6) and the negotiated locale. */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, cookieStore, headerStore] = await Promise.all([
    negotiatedLocale(),
    cookies(),
    headers(),
  ]);
  const preference = preferenceFromCookie(cookieStore.get(THEME_COOKIE)?.value);
  const theme = renderedTheme(preference, headerStore.get("sec-ch-prefers-color-scheme"));
  const overrides = uiMessages(locale);
  return (
    <html lang={locale} dir="ltr" data-theme={theme} data-theme-preference={preference}>
      <body>
        <NextIntlClientProvider messages={clientMessages(locale)}>
          <XOSProvider locale={locale} {...(overrides ? { messages: overrides } : {})}>
            {preference === "system" ? <ThemeFollower /> : null}
            {children}
          </XOSProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
