import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Markdown, Outline } from "@/components/markdown.tsx";
import { Breadcrumbs, TemplateDocument } from "@/components/ui.tsx";
import { helpArticles } from "@/lib/content.ts";
import { LOCALES, isLocale, translator } from "@/lib/i18n.ts";

export const dynamicParams = false;

export function generateStaticParams() {
  return LOCALES.flatMap((locale) => helpArticles(locale).map((a) => ({ locale, slug: a.slug })));
}

type Params = { params: Promise<{ locale: string; slug: string }> };

function find(locale: string, slug: string) {
  return isLocale(locale) ? helpArticles(locale).find((a) => a.slug === slug) : undefined;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale, slug } = await params;
  const article = find(locale, slug);
  return article ? { title: article.title, description: article.summary } : {};
}

export default async function HelpArticlePage({ params }: Params) {
  const { locale, slug } = await params;
  const article = find(locale, slug);
  if (!article || !isLocale(locale)) notFound();
  const t = translator(locale);
  const th = translator(locale, "help");
  return (
    <TemplateDocument outline={<Outline body={article.body} label={t("guides.outline")} />}>
      <header className="flex flex-col gap-8">
        <Breadcrumbs
          items={[
            { label: t("nav.home"), href: `/${locale}` },
            { label: t("help.title"), href: `/${locale}/help` },
            { label: article.title },
          ]}
        />
        <p className="m-0 text-text-12 text-text-tertiary">{th(`kinds.${article.kind}`)}</p>
        <h1 className="m-0 text-heading-24 font-semibold">{article.title}</h1>
        <p className="m-0 text-text-16 text-text-secondary">{article.summary}</p>
      </header>
      <Markdown body={article.body} locale={locale} codeLabel={t("reference.samples")} />
    </TemplateDocument>
  );
}
