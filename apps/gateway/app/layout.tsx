import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies, headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { ThemeFollower, XOSProvider } from "@/components/ui";
import { localeDirection, type GatewayLocale } from "@/i18n/negotiate";
import { clientMessages, uiMessages } from "@/i18n/request";
import { brandStyle } from "@/lib/brand/brand";
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
  };
}

/**
 * The Gateway document: System theme by default (Section 11.6), the locale negotiated per request,
 * and the org brand accent on a custom Gateway domain (Section 4.4.7).
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, cookieStore, headerStore, facts] = await Promise.all([
    getLocale(),
    cookies(),
    headers(),
    getRequestFacts(),
  ]);
  const preference = preferenceFromCookie(cookieStore.get(THEME_COOKIE)?.value);
  const theme = renderedTheme(preference, headerStore.get("sec-ch-prefers-color-scheme"));
  const overrides = uiMessages(locale as GatewayLocale);
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
        <NextIntlClientProvider messages={clientMessages(locale as GatewayLocale)}>
          <XOSProvider
            locale={locale}
            preferences={display}
            {...(overrides ? { messages: overrides } : {})}
          >
            {preference === "system" ? <ThemeFollower /> : null}
            {children}
          </XOSProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
