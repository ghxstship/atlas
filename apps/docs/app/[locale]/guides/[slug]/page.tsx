import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Markdown, Outline } from "@/components/markdown.tsx";
import { Breadcrumbs, TemplateDocument } from "@/components/ui.tsx";
import { guides } from "@/lib/content.ts";
import { LOCALES, isLocale, translator } from "@/lib/i18n.ts";

export const dynamicParams = false;

export function generateStaticParams() {
  return LOCALES.flatMap((locale) => guides(locale).map((g) => ({ locale, slug: g.slug })));
}

type Params = { params: Promise<{ locale: string; slug: string }> };

function find(locale: string, slug: string) {
  return isLocale(locale) ? guides(locale).find((g) => g.slug === slug) : undefined;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale, slug } = await params;
  const guide = find(locale, slug);
  return guide ? { title: guide.title, description: guide.summary } : {};
}

export default async function GuidePage({ params }: Params) {
  const { locale, slug } = await params;
  const guide = find(locale, slug);
  if (!guide || !isLocale(locale)) notFound();
  const t = translator(locale);
  return (
    <TemplateDocument outline={<Outline body={guide.body} label={t("guides.outline")} />}>
      <header className="flex flex-col gap-8">
        <Breadcrumbs
          items={[
            { label: t("nav.home"), href: `/${locale}` },
            { label: t(`guides.sections.${guide.section}`) },
            { label: guide.title },
          ]}
        />
        <h1 className="m-0 text-heading-24 font-semibold">{guide.title}</h1>
        <p className="m-0 text-text-16 text-text-secondary">{guide.summary}</p>
      </header>
      <Markdown body={guide.body} locale={locale} codeLabel={t("reference.samples")} />
    </TemplateDocument>
  );
}
