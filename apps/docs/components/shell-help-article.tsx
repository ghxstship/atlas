/**
 * A Gateway or Compass help article in the help center, as the app's help panel shows it. The
 * routes /<locale>/help/gateway/<slug> and /<locale>/help/compass/<slug> render it; Atlas articles
 * keep /<locale>/help/<slug>.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactElement } from "react";
import { Markdown, Outline } from "@/components/markdown.tsx";
import { Breadcrumbs, TemplateDocument } from "@/components/ui.tsx";
import { helpArticles, type HelpShell } from "@/lib/content.ts";
import { LOCALES, isLocale, translator } from "@/lib/i18n.ts";

export type AppShell = Exclude<HelpShell, "atlas">;

export interface ShellArticleParams {
  readonly locale: string;
  readonly slug: string;
}

/** Every locale and article of a shell, for generateStaticParams. */
export function shellHelpParams(shell: AppShell): ShellArticleParams[] {
  return LOCALES.flatMap((locale) =>
    helpArticles(locale, shell).map((a) => ({ locale, slug: a.slug })),
  );
}

function find(shell: AppShell, locale: string, slug: string) {
  return isLocale(locale) ? helpArticles(locale, shell).find((a) => a.slug === slug) : undefined;
}

export function shellHelpMetadata(shell: AppShell, { locale, slug }: ShellArticleParams): Metadata {
  const article = find(shell, locale, slug);
  return article ? { title: article.title, description: article.summary } : {};
}

export function ShellHelpArticle({
  shell,
  locale,
  slug,
}: ShellArticleParams & { readonly shell: AppShell }): ReactElement {
  const article = find(shell, locale, slug);
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
