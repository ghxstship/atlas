import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { BoundaryCopyProvider } from "@/components/error-copy.tsx";
import { DocsSidebar, type NavGroup } from "@/components/nav.tsx";
import { AppShell, ThemeSwitch, XOSProvider } from "@/components/ui.tsx";
import { GUIDE_SECTIONS, guides } from "@/lib/content.ts";
import type { Locale } from "@/lib/i18n.ts";
import { LOCALES, isLocale, translator, uiMessages } from "@/lib/i18n.ts";
import { THEME_SCRIPT } from "@/lib/theme.ts";
import "../globals.css";

export const dynamicParams = false;

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = translator(locale);
  return {
    title: { default: t("name"), template: `%s · ${t("name")}` },
    description: t("tagline"),
  };
}

function navigation(locale: Locale): NavGroup[] {
  const t = translator(locale);
  const all = guides(locale);
  return [
    {
      items: [
        { label: t("nav.home"), href: `/${locale}` },
        { label: t("nav.reference"), href: `/${locale}/reference` },
        { label: t("nav.dictionary"), href: `/${locale}/data-dictionary` },
        { label: t("nav.help"), href: `/${locale}/help` },
      ],
    },
    ...GUIDE_SECTIONS.map((section) => ({
      label: t(`guides.sections.${section}`),
      items: all
        .filter((g) => g.section === section)
        .map((g) => ({ label: g.title, href: `/${locale}/guides/${g.slug}` })),
    })),
  ];
}

/** The docs document: dark by default, the saved or system theme applied before paint, one shell for every page. */
export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = translator(locale);
  const other = LOCALES.filter((l) => l !== locale);
  const ui = uiMessages(locale);
  return (
    <html lang={locale} dir="ltr" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:absolute focus:start-8 focus:top-8 focus:z-dialog focus:px-12 focus:py-8 focus:rounded-control focus:bg-bg-raised focus:text-text-primary"
        >
          {t("skip")}
        </a>
        <XOSProvider locale={locale} {...(ui ? { messages: ui } : {})}>
          <AppShell
            brand={
              <a
                href={`/${locale}`}
                className="font-semibold text-text-14 text-text-primary no-underline"
              >
                {t("name")}
              </a>
            }
            sidebar={<DocsSidebar label={t("nav.label")} groups={navigation(locale)} />}
            header={
              <div className="flex flex-1 flex-wrap items-center justify-end gap-12">
                <nav aria-label={t("language.label")} className="flex gap-8 text-text-13">
                  {other.map((l) => (
                    <a
                      key={l}
                      href={`/${l}`}
                      lang={l}
                      hrefLang={l}
                      className="text-text-secondary hover:text-text-primary"
                    >
                      {t(`language.${l}`)}
                    </a>
                  ))}
                </nav>
                <ThemeSwitch
                  label={t("theme.label")}
                  labels={{
                    system: t("theme.system"),
                    light: t("theme.light"),
                    dark: t("theme.dark"),
                  }}
                />
              </div>
            }
          >
            <div id="content" tabIndex={-1} className="flex flex-col gap-24 w-full outline-none">
              <BoundaryCopyProvider
                copy={{
                  home: `/${locale}`,
                  error: {
                    title: t("error.title"),
                    sentence: t("error.sentence"),
                    action: t("error.action"),
                  },
                  notFound: {
                    title: t("notFound.title"),
                    sentence: t("notFound.sentence"),
                    action: t("notFound.action"),
                  },
                }}
              >
                {children}
              </BoundaryCopyProvider>
            </div>
          </AppShell>
        </XOSProvider>
      </body>
    </html>
  );
}
