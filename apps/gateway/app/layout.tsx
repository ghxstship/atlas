import { isLocale } from "@xos/i18n";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies, headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { ThemeFollower, XOSProvider } from "@/components/ui";
import { localeDirection } from "@/i18n/negotiate";
import { messagesFor } from "@/i18n/request";
import { brandStyle } from "@/lib/brand/brand";
import { getRequestFacts } from "@/lib/shell/context";
import { THEME_COOKIE, preferenceFromCookie, renderedTheme } from "@/lib/theme";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const [t, facts] = await Promise.all([getTranslations("shell.gateway"), getRequestFacts()]);
  const name = facts.brand.kind === "org" ? facts.brand.org.name : t("name");
  return {
    title: { default: name, template: `%s · ${name}` },
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
  const overrides = uiOverrides(locale);
  return (
    <html
      lang={locale}
      dir={localeDirection(locale)}
      data-theme={theme}
      data-theme-preference={preference}
      style={brandStyle(facts.brand)}
    >
      <body>
        <NextIntlClientProvider>
          <XOSProvider locale={locale} {...(overrides ? { messages: overrides } : {})}>
            {preference === "system" ? <ThemeFollower /> : null}
            {children}
          </XOSProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
