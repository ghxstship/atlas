import { isLocale } from "@xos/i18n";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { XOSProvider } from "@/components/ui";
import { localeDirection } from "@/i18n/negotiate";
import { messagesFor } from "@/i18n/request";
import { THEME_COOKIE, themeFromCookie } from "@/lib/theme";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell.atlas");
  return {
    title: { default: t("name"), template: `%s · ${t("name")}` },
    description: t("tagline"),
  };
}

/** Flat `ui` messages for @xos/ui when the locale is a pseudo-locale; shipped locales need none. */
function uiOverrides(locale: string): Record<string, string> | undefined {
  if (isLocale(locale)) return undefined;
  const out: Record<string, string> = {};
  const walk = (value: unknown, prefix: string) => {
    if (typeof value === "string") out[prefix] = value;
    else if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value)) walk(v, prefix ? `${prefix}.${k}` : k);
    }
  };
  walk(messagesFor(locale as Parameters<typeof messagesFor>[0]).ui, "");
  return out;
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, cookieStore] = await Promise.all([getLocale(), cookies()]);
  const theme = themeFromCookie(cookieStore.get(THEME_COOKIE)?.value);
  const overrides = uiOverrides(locale);
  return (
    <html lang={locale} dir={localeDirection(locale)} data-theme={theme}>
      <body>
        <NextIntlClientProvider>
          <XOSProvider locale={locale} {...(overrides ? { messages: overrides } : {})}>
            {children}
          </XOSProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
