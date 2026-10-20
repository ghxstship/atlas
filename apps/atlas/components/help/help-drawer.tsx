"use client";

import { Button, Drawer, InlineAlert, Input, Keys, Skeleton } from "@xos/ui";
import { useLocale, useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { HELP_CONTENT } from "@/help/content.generated";
import {
  articlesForNode,
  coversNode,
  HELP_LOCALES,
  searchArticles,
  type ArticleSummary,
  type HelpBodies,
  type HelpLocale,
  type Tour,
} from "@/help/model";
import type { HelpPanelState } from "@/lib/help/actions";
import { ArticleBody } from "./article";
import { ContactForm } from "./contact-form";
import { collectDiagnostics } from "./diagnostics";
import type { HelpView as View } from "./help-center";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const SHORTCUTS = [
  { keys: "Mod+K", label: "command" },
  { keys: "?", label: "help" },
  { keys: "Mod+.", label: "focus" },
  { keys: "Esc", label: "close" },
  { keys: "J K", label: "move" },
  { keys: "Enter", label: "open" },
  { keys: "X", label: "select" },
] as const;

const tourCopyKey = (key: string) => `tours.${key.replaceAll(".", "_")}`;

export interface HelpDrawerProps {
  readonly org: string;
  /** The person's tours and tips, or null while loading. */
  readonly state: HelpPanelState | null;
  readonly loadFailed: boolean;
  /** The sitemap node of the current page. */
  readonly nodeId: string | null;
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly view: View;
  readonly setView: (view: View) => void;
  /** The page's tours and the ones the person has seen, for the Tours section. */
  readonly pageTours: readonly Tour[];
  readonly seenTours: ReadonlySet<string>;
  readonly startTour: (tour: Tour) => void;
}

/**
 * The help panel itself (Section 11.16): the articles mapped to this page, search across every
 * article, the shortcut sheet, What's New, guided tours and Contact Support, in a drawer. It loads
 * the first time Help opens (A24-009); the floating tour and tip cards (help-panel.tsx) do not need
 * it, so a page that only offers a tour or a tip never fetches the drawer, the article index or
 * the contact form.
 */
export function HelpDrawer({
  org,
  state,
  loadFailed,
  nodeId,
  open,
  setOpen,
  view,
  setView,
  pageTours,
  seenTours,
  startTour,
}: HelpDrawerProps) {
  const t = useTranslations("help") as unknown as Translate;
  const locale = useLocale();
  const pathname = usePathname();
  const lang: HelpLocale = (HELP_LOCALES as readonly string[]).includes(locale)
    ? (locale as HelpLocale)
    : "en-US";
  const articles = HELP_CONTENT.articles[lang];
  const [query, setQuery] = useState("");
  const [bodies, setBodies] = useState<HelpBodies | null>(null);
  const [bodiesFailed, setBodiesFailed] = useState(false);

  // Article bodies load when the panel first opens, not with the page (A24-009).
  useEffect(() => {
    if (!open || bodies) return;
    let live = true;
    import("@/help/bodies.generated").then(
      (m) => {
        if (live) setBodies(m.HELP_BODIES);
      },
      (error: unknown) => {
        console.error(error);
        if (live) setBodiesFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [open, bodies]);

  const openArticle = (slug: string) => {
    setView({ kind: "article", slug });
    setOpen(true);
  };

  const pageArticles = articlesForNode(articles, nodeId);
  const specific = pageArticles.filter(
    (a) => nodeId !== null && a.nodes.some((p) => p !== "*" && coversNode(p, nodeId)),
  );
  const results = searchArticles(articles, query, (a) => bodies?.[lang][a.slug]);
  const article = view.kind === "article" ? articles.find((a) => a.slug === view.slug) : undefined;

  const articleList = (list: readonly ArticleSummary[]) => (
    <ul className="m-0 flex list-none flex-col gap-8 p-0">
      {list.map((a) => (
        <li key={a.slug}>
          <button
            type="button"
            onClick={() => setView({ kind: "article", slug: a.slug })}
            className="flex w-full cursor-pointer flex-col items-start gap-2 rounded-control border-0 bg-transparent p-4 text-start hover:bg-bg-hover"
          >
            <span className="font-medium text-accent-text">{a.title}</span>
            <span className="text-text-12 text-text-secondary">{a.summary}</span>
          </button>
        </li>
      ))}
    </ul>
  );

  const section = (title: string, children: React.ReactNode) => (
    <section aria-label={title} className="flex flex-col gap-8">
      <h3 className="m-0 text-text-12 font-medium text-text-secondary">{title}</h3>
      {children}
    </section>
  );

  return (
    <Drawer title={t("title")} open={open} onOpenChange={setOpen}>
      {view.kind === "article" ? (
        <article className="flex flex-col gap-12">
          <Button variant="ghost" icon="ArrowLeft" onClick={() => setView({ kind: "home" })}>
            {t("back")}
          </Button>
          {article ? (
            <>
              <h3 className="m-0 text-heading-20 font-semibold">{article.title}</h3>
              <p className="m-0 text-text-secondary">{article.summary}</p>
              {bodies ? (
                <ArticleBody blocks={bodies[lang][article.slug] ?? []} onArticle={openArticle} />
              ) : bodiesFailed ? (
                <InlineAlert tone="danger">{t("bodyFailed")}</InlineAlert>
              ) : (
                <Skeleton />
              )}
              {state?.docsUrl ? (
                <a
                  className="self-start text-text-12 font-medium text-accent-text underline"
                  href={`${state.docsUrl}/${lang}/help/${article.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("docs.article")}
                </a>
              ) : null}
            </>
          ) : (
            <p className="m-0">{t("noArticles")}</p>
          )}
        </article>
      ) : view.kind === "contact" ? (
        <ContactForm
          org={org}
          canContactPlatform={state?.canContactPlatform ?? false}
          platformChannel={state?.platformChannel ?? null}
          diagnostics={view.diagnostics}
          onCancel={() => setView({ kind: "home" })}
        />
      ) : (
        <>
          <Input
            type="search"
            label={t("search")}
            placeholder={t("searchHint")}
            value={query}
            width="100%"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query.trim() !== "" ? (
            section(
              t("searchResults", { query: query.trim() }),
              results.length > 0 ? (
                articleList(results)
              ) : (
                <p className="m-0 text-text-secondary">
                  {t("searchEmpty", { query: query.trim() })}
                </p>
              ),
            )
          ) : (
            <>
              {section(
                t("forThisPage"),
                specific.length > 0 ? (
                  articleList(specific)
                ) : (
                  <p className="m-0 text-text-secondary">{t("noArticles")}</p>
                ),
              )}
              {section(
                t("general"),
                articleList(pageArticles.filter((a) => !specific.includes(a))),
              )}
            </>
          )}
          {loadFailed ? (
            <p role="alert" className="m-0 text-text-12 text-danger-text">
              {t("loadFailed")}
            </p>
          ) : null}
          {section(
            t("tours.title"),
            pageTours.length > 0 ? (
              <div className="flex flex-wrap gap-8">
                {pageTours.map((tour) => (
                  <Button key={tour.key} icon="Play" onClick={() => startTour(tour)}>
                    {t(seenTours.has(tour.key) ? "tours.replay" : "tours.start", {
                      title: t(`${tourCopyKey(tour.key)}.title`),
                    })}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="m-0 text-text-secondary">{t("tours.none")}</p>
            ),
          )}
          {section(
            t("shortcuts.title"),
            <dl className="m-0 flex flex-col gap-4">
              {SHORTCUTS.map((s) => (
                <div key={s.label} className="flex items-center justify-between gap-8">
                  <dt>{t(`shortcuts.${s.label}`)}</dt>
                  <dd className="m-0">
                    <Keys keys={s.keys} />
                  </dd>
                </div>
              ))}
            </dl>,
          )}
          {section(
            t("whatsNew.title"),
            <ul className="m-0 flex list-none flex-col gap-8 p-0">
              {HELP_CONTENT.whatsNew.map((entry) => (
                <li key={entry.key} className="flex flex-col gap-2">
                  <span className="font-medium">{t(`whatsNew.${entry.key}.title`)}</span>
                  <span className="text-text-12 text-text-secondary">
                    {t(`whatsNew.${entry.key}.body`)}
                  </span>
                  {entry.article ? (
                    <button
                      type="button"
                      onClick={() => setView({ kind: "article", slug: entry.article as string })}
                      className="cursor-pointer self-start border-0 bg-transparent p-0 text-text-12 font-medium text-accent-text underline"
                    >
                      {t("tips.learnMore")}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>,
          )}
          {state?.docsUrl ? (
            <a
              className="self-start text-accent-text underline"
              href={`${state.docsUrl}/${lang}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("docs.home")}
            </a>
          ) : null}
          <Button
            icon="LifeBuoy"
            onClick={() =>
              setView({
                kind: "contact",
                diagnostics: collectDiagnostics(pathname, navigator.userAgent),
              })
            }
          >
            {t("contact.open")}
          </Button>
        </>
      )}
    </Drawer>
  );
}
