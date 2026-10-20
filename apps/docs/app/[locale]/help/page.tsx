import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Breadcrumbs, Card, Link } from "@/components/ui.tsx";
import {
  HELP_SHELLS,
  helpArticles,
  helpPath,
  searchPages,
  whatsNew,
  type HelpArticle,
  type HelpShell,
} from "@/lib/content.ts";
import { isLocale, translator } from "@/lib/i18n.ts";
import { textOf } from "@/lib/markdown.ts";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string | string[] }>;
};

const KINDS = ["guide", "workflow", "page", "glossary"] as const;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return isLocale(locale) ? { title: translator(locale)("help.title") } : {};
}

/**
 * The help center: the same articles as the help panels of Atlas, Gateway and Compass, with search
 * across all three and Atlas's What's New.
 */
export default async function HelpIndex({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = translator(locale);
  const th = translator(locale, "help");
  const raw = (await searchParams).q;
  const query = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  const byShell = HELP_SHELLS.map((shell) => ({ shell, articles: helpArticles(locale, shell) }));
  const results = query
    ? byShell.flatMap(({ shell, articles }) =>
        searchPages(articles, query, (a) => textOf(a.body)).map((article) => ({ shell, article })),
      )
    : [];
  const articleLink = (shell: HelpShell, a: HelpArticle) => (
    <Link href={helpPath(locale, shell, a.slug)}>{a.title}</Link>
  );
  const list = (shell: HelpShell, articles: readonly HelpArticle[]) => (
    <ul className="m-0 p-0 list-none flex flex-col gap-8">
      {articles.map((a) => (
        <li key={a.slug} className="flex flex-col gap-2">
          {articleLink(shell, a)}
          <span className="text-text-13 text-text-secondary">{a.summary}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <>
      <header className="flex flex-col gap-8 pb-16 border-b border-border-subtle">
        <Breadcrumbs
          items={[{ label: t("nav.home"), href: `/${locale}` }, { label: t("help.title") }]}
        />
        <h1 className="m-0 text-heading-24 font-semibold">{t("help.title")}</h1>
        <p className="m-0 text-text-14 text-text-secondary">{t("help.sentence")}</p>
        <form
          role="search"
          action={`/${locale}/help`}
          method="get"
          className="flex flex-wrap items-end gap-8"
        >
          <label className="flex flex-col gap-4 text-text-12 text-text-secondary">
            {t("help.searchLabel")}
            <input
              type="search"
              name="q"
              defaultValue={query}
              className="h-control-md w-(--layout-property-column) max-w-full px-8 rounded-control border border-border-control bg-bg-surface text-text-13 text-text-primary"
            />
          </label>
          <button
            type="submit"
            className="h-control-md px-12 rounded-control border border-border-control bg-bg-raised text-text-13 text-text-primary cursor-pointer hover:bg-bg-hover"
          >
            {t("help.searchButton")}
          </button>
        </form>
      </header>
      {query ? (
        <section aria-live="polite" className="flex flex-col gap-8">
          <h2 className="m-0 text-heading-16 font-semibold">
            {results.length > 0
              ? t("help.results", { count: results.length, query })
              : t("help.noResults", { query })}
          </h2>
          <ul className="m-0 p-0 list-none flex flex-col gap-8">
            {results.map(({ shell, article }) => (
              <li key={`${shell}-${article.slug}`} className="flex flex-col gap-2">
                {articleLink(shell, article)}
                <span className="text-text-13 text-text-secondary">
                  {t(`help.shells.${shell}.title`)} · {article.summary}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] max-lg:grid-cols-1 gap-24">
        <div className="flex flex-col gap-32">
          {byShell.map(({ shell, articles }) => (
            <section
              key={shell}
              aria-labelledby={`shell-${shell}`}
              className="flex flex-col gap-16"
            >
              <header className="flex flex-col gap-4">
                <h2 id={`shell-${shell}`} className="m-0 text-heading-20 font-semibold">
                  {t(`help.shells.${shell}.title`)}
                </h2>
                <p className="m-0 text-text-13 text-text-secondary">
                  {t(`help.shells.${shell}.sentence`)}
                </p>
              </header>
              {KINDS.map((kind) => {
                const group = articles.filter((a) => a.kind === kind);
                if (group.length === 0) return null;
                return (
                  <section
                    key={kind}
                    aria-labelledby={`kind-${shell}-${kind}`}
                    className="flex flex-col gap-8"
                  >
                    <h3 id={`kind-${shell}-${kind}`} className="m-0 text-heading-16 font-semibold">
                      {th(`kinds.${kind}`)}
                    </h3>
                    {list(shell, group)}
                  </section>
                );
              })}
            </section>
          ))}
        </div>
        <aside aria-labelledby="whats-new">
          <Card>
            <h2 id="whats-new" className="m-0 mb-8 text-heading-16 font-semibold">
              {t("help.whatsNew")}
            </h2>
            <ul className="m-0 p-0 list-none flex flex-col gap-12">
              {whatsNew().map((entry) => (
                <li key={entry.key} className="flex flex-col gap-2 text-text-13">
                  <time dateTime={entry.date} className="text-text-12 text-text-tertiary">
                    {new Intl.DateTimeFormat(locale, {
                      dateStyle: "medium",
                      timeZone: "UTC",
                    }).format(new Date(`${entry.date}T00:00:00Z`))}
                  </time>
                  <strong>{th(`whatsNew.${entry.key}.title`)}</strong>
                  <span className="text-text-secondary">{th(`whatsNew.${entry.key}.body`)}</span>
                  {entry.article ? (
                    <Link href={helpPath(locale, "atlas", entry.article)}>{t("help.related")}</Link>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </>
  );
}
