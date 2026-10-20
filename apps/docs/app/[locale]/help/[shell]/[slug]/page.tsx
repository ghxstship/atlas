import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Markdown, Outline } from "@/components/markdown.tsx";
import { Breadcrumbs, TemplateDocument } from "@/components/ui.tsx";
import { helpArticles, type HelpShell } from "@/lib/content.ts";
import { LOCALES, isLocale, translator } from "@/lib/i18n.ts";

export const dynamicParams = false;

/** The shells whose articles live under /<locale>/help/<shell>; Atlas keeps /<locale>/help. */
const SHELLS: readonly Exclude<HelpShell, "atlas">[] = ["gateway", "compass"];

export function generateStaticParams() {
  return LOCALES.flatMap((locale) =>
    SHELLS.flatMap((shell) =>
      helpArticles(locale, shell).map((a) => ({ locale, shell, slug: a.slug })),
    ),
  );
}

type Params = { params: Promise<{ locale: string; shell: string; slug: string }> };

function find(locale: string, shell: string, slug: string) {
  if (!isLocale(locale) || !(SHELLS as readonly string[]).includes(shell)) return undefined;
  return helpArticles(locale, shell as HelpShell).find((a) => a.slug === slug);
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale, shell, slug } = await params;
  const article = find(locale, shell, slug);
  return article ? { title: article.title, description: article.summary } : {};
}

/** A Gateway or Compass help article, as the app's help panel shows it. */
export default async function ShellHelpArticlePage({ params }: Params) {
  const { locale, shell, slug } = await params;
  const article = find(locale, shell, slug);
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
            { label: t(`help.shells.${shell}.title`), href: `/${locale}/help#shell-${shell}` },
            { label: article.title },
          ]}
        />
        <p className="m-0 text-text-12 text-text-tertiary">
          {t(`help.shells.${shell}.title`)} · {th(`kinds.${article.kind}`)}
        </p>
        <h1 className="m-0 text-heading-24 font-semibold">{article.title}</h1>
        <p className="m-0 text-text-16 text-text-secondary">{article.summary}</p>
      </header>
      <Markdown
        body={article.body}
        locale={locale}
        codeLabel={t("reference.samples")}
        helpBase={`/${locale}/help/${shell}`}
      />
    </TemplateDocument>
  );
}
