"use client";

import {
  articlesForNode,
  helpLocale,
  isSpecificTo,
  searchArticles,
  type ArticleSummary,
  type HelpBodies,
} from "@xos/help";
import { findRoute } from "@xos/ia";
import { displayKeys, platformOf, SHORTCUT_REGISTRY } from "@xos/schemas/shortcuts";
import { Button, Drawer, InlineAlert, Input, Keys, Skeleton } from "@xos/ui";
import { useLocale, useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { HELP_CONTENT } from "@/help/content.generated";
import { sitemap } from "@/ia/sitemap.generated";
import { ContactSupport } from "./contact-support";
import { HelpArticle } from "./help-article";

type Translate = (key: string, values?: Record<string, string | number>) => string;

type View =
  | { readonly kind: "home" }
  | { readonly kind: "article"; readonly slug: string }
  | { readonly kind: "contact" };

/**
 * The shortcuts Gateway answers everywhere (search, help, closing what is open), from the shortcut
 * registry (packages/schemas/shortcuts.yaml), written for the person's platform.
 */
function gatewayShortcuts(): {
  readonly id: string;
  readonly label: string;
  readonly keys: string;
}[] {
  const platform = typeof navigator === "undefined" ? "other" : platformOf(navigator);
  return SHORTCUT_REGISTRY.shells.gateway.shortcuts.flatMap((s) => {
    const keys = platform === "mac" && s.mac !== null ? s.mac : s.keys;
    return keys === null ? [] : [{ id: s.id, label: s.label, keys: displayKeys(keys, platform) }];
  });
}

/**
 * The Gateway help panel (Section 11.16), loaded the first time Help opens: the articles for the
 * page the person is on (mapped by sitemap node), search across every Gateway article, the shortcut
 * sheet, What's New and Contact Support. Article bodies load when the panel first opens. Gateway
 * has no assistant for external parties, so the panel offers none.
 */
export function HelpPanel({
  open,
  onOpenChange,
  docsUrl,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The docs site origin (RRR-119); null hides the help center links. */
  readonly docsUrl: string | null;
}) {
  const t = useTranslations("help") as unknown as Translate;
  const tRoot = useTranslations() as unknown as Translate;
  const lang = helpLocale(useLocale());
  const pathname = usePathname();
  const match = useMemo(() => findRoute(sitemap, pathname), [pathname]);
  const nodeId = match?.id ?? null;
  const engagementKey = match?.params["engagementKey"] ?? null;
  const articles = HELP_CONTENT.articles[lang];
  const [view, setView] = useState<View>({ kind: "home" });
  const [query, setQuery] = useState("");
  const [bodies, setBodies] = useState<HelpBodies | null>(null);
  const [bodiesFailed, setBodiesFailed] = useState(false);

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

  // Closing returns the panel to its start, so the next Help opens on this page's articles.
  const change = (next: boolean) => {
    if (!next) {
      setView({ kind: "home" });
      setQuery("");
    }
    onOpenChange(next);
  };
  const close = () => change(false);

  const pageArticles = articlesForNode(articles, nodeId);
  const specific = pageArticles.filter((a) => nodeId !== null && isSpecificTo(a, nodeId));
  const general = pageArticles.filter((a) => !specific.includes(a));
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

  const section = (title: string, children: ReactNode) => (
    <section aria-label={title} className="flex flex-col gap-8">
      <h3 className="m-0 text-text-12 font-medium text-text-secondary">{title}</h3>
      {children}
    </section>
  );

  return (
    <Drawer title={t("title")} open={open} onOpenChange={change}>
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
                <HelpArticle
                  blocks={bodies[lang][article.slug] ?? []}
                  onArticle={(slug) => setView({ kind: "article", slug })}
                  onNavigate={close}
                />
              ) : bodiesFailed ? (
                <InlineAlert tone="danger">{t("bodyFailed")}</InlineAlert>
              ) : (
                <Skeleton />
              )}
              {docsUrl ? (
                <a
                  className="self-start text-text-12 font-medium text-accent-text underline"
                  href={`${docsUrl}/${lang}/help/gateway/${article.slug}`}
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
        <ContactSupport
          engagementKey={engagementKey}
          pathname={pathname}
          onBack={() => setView({ kind: "home" })}
          onNavigate={close}
        />
      ) : (
        <div className="flex flex-col gap-16">
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
              {section(t("gateway.general"), articleList(general))}
            </>
          )}
          {section(
            t("shortcuts.title"),
            <dl className="m-0 flex flex-col gap-4">
              {gatewayShortcuts().map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-8">
                  <dt>{tRoot(s.label)}</dt>
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
                  <span className="font-medium">{t(`gateway.whatsNew.${entry.key}.title`)}</span>
                  <span className="text-text-12 text-text-secondary">
                    {t(`gateway.whatsNew.${entry.key}.body`)}
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
          {docsUrl ? (
            <a
              className="self-start text-accent-text underline"
              href={`${docsUrl}/${lang}/help`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("docs.helpCenter")}
            </a>
          ) : null}
          <Button icon="LifeBuoy" onClick={() => setView({ kind: "contact" })}>
            {t("contact.open")}
          </Button>
        </div>
      )}
    </Drawer>
  );
}
