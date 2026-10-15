"use client";

import { findRoute } from "@xos/ia";
import { Button, Drawer, IconButton, Input, Keys } from "@xos/ui";
import { useLocale, useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HELP_CONTENT } from "@/help/content.generated";
import {
  articlesForNode,
  coversNode,
  forNode,
  HELP_LOCALES,
  searchArticles,
  type Article,
  type HelpLocale,
  type Tip,
  type Tour,
} from "@/help/model";
import { sitemap } from "@/ia/sitemap.generated";
import {
  dismissTipAction,
  loadHelpStateAction,
  recordTourAction,
  type HelpPanelState,
} from "@/lib/help/actions";
import { ArticleBody } from "./article";
import { ContactForm } from "./contact-form";
import { collectDiagnostics, installErrorCapture, type CollectedDiagnostics } from "./diagnostics";

type Translate = (key: string, values?: Record<string, string | number>) => string;
type View =
  | { readonly kind: "home" }
  | { readonly kind: "article"; readonly slug: string }
  | { readonly kind: "contact"; readonly diagnostics: CollectedDiagnostics };

const SHORTCUTS = [
  { keys: "Mod+K", label: "command" },
  { keys: "?", label: "help" },
  { keys: "Mod+.", label: "focus" },
  { keys: "Esc", label: "close" },
  { keys: "J K", label: "move" },
  { keys: "Enter", label: "open" },
  { keys: "X", label: "select" },
] as const;

const HELP_EVENT = "xos:help";

/** Opens the help panel on an article, or on its home when `slug` is empty. */
export function openHelpArticle(slug: string) {
  window.dispatchEvent(new CustomEvent(HELP_EVENT, { detail: slug }));
}

/** Help articles for the command menu, in the person's locale. */
export function helpCommandItems(locale: string): { slug: string; title: string }[] {
  const lang: HelpLocale = (HELP_LOCALES as readonly string[]).includes(locale)
    ? (locale as HelpLocale)
    : "en-US";
  return [...HELP_CONTENT.articles[lang]]
    .sort((a, b) => a.order - b.order)
    .map((a) => ({ slug: a.slug, title: a.title }));
}

const tourCopyKey = (key: string) => `tours.${key.replaceAll(".", "_")}`;

/**
 * Help in the Atlas shell (Section 11.16). The Help button and the `?` key open the contextual help
 * panel: the articles mapped to this page, search across every article, the shortcut sheet, What's
 * New, guided tours and Contact Support. On a page with a tour the person has never been offered, the
 * tour is offered once; otherwise a contextual tip for a complex feature appears once until
 * dismissed. Tours never start on their own and can be replayed from Help.
 */
export function HelpCenter({ org }: { org: string }) {
  const t = useTranslations("help") as unknown as Translate;
  const locale = useLocale();
  const pathname = usePathname();
  const lang: HelpLocale = (HELP_LOCALES as readonly string[]).includes(locale)
    ? (locale as HelpLocale)
    : "en-US";
  const articles = HELP_CONTENT.articles[lang];
  const nodeId = useMemo(() => findRoute(sitemap, pathname)?.id ?? null, [pathname]);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: "home" });
  const [query, setQuery] = useState("");
  const [state, setState] = useState<HelpPanelState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [running, setRunning] = useState<{ tour: Tour; step: number } | null>(null);
  const [closedOffers, setClosedOffers] = useState<readonly string[]>([]);
  const [hiddenTips, setHiddenTips] = useState<readonly string[]>([]);

  useEffect(() => installErrorCapture(window), []);

  // The command menu opens an article through this event (openHelpArticle).
  useEffect(() => {
    const onOpen = (event: Event) => {
      const slug = (event as CustomEvent<string>).detail;
      setView(slug ? { kind: "article", slug } : { kind: "home" });
      setOpen(true);
    };
    window.addEventListener(HELP_EVENT, onOpen);
    return () => window.removeEventListener(HELP_EVENT, onOpen);
  }, []);

  useEffect(() => {
    let live = true;
    loadHelpStateAction(org).then(
      (result) => {
        if (!live) return;
        if (result.ok) setState(result.data);
        else setLoadFailed(true);
      },
      () => {
        if (live) setLoadFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [org]);

  // The `?` key opens help unless the person is typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null;
      const typing =
        el?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el?.tagName ?? "");
      if (event.key === "?" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setView({ kind: "home" });
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const seenTours = useMemo(() => new Set(state?.tours.map((x) => x.tourKey)), [state]);
  const pageTours = useMemo(() => forNode(HELP_CONTENT.tours, nodeId), [nodeId]);

  // Offer each page's tour the person has never been offered. The offer stays until they start or
  // decline it; recording it as Offered keeps it from returning on a later visit.
  const offered: Tour | null = useMemo(() => {
    if (!state || running) return null;
    return (
      pageTours.find((tour) => !seenTours.has(tour.key) && !closedOffers.includes(tour.key)) ?? null
    );
  }, [state, running, pageTours, seenTours, closedOffers]);

  useEffect(() => {
    if (offered) void recordTourAction(org, offered.key, "Offered");
  }, [offered, org]);

  const tip: Tip | null = useMemo(() => {
    if (!state || offered || running || open) return null;
    return (
      forNode(HELP_CONTENT.tips, nodeId).find(
        (x) => !state.dismissedTips.includes(x.key) && !hiddenTips.includes(x.key),
      ) ?? null
    );
  }, [state, offered, running, open, nodeId, hiddenTips]);

  const startTour = useCallback(
    (tour: Tour) => {
      setClosedOffers((c) => [...c, tour.key]);
      setOpen(false);
      setRunning({ tour, step: 0 });
      void recordTourAction(org, tour.key, "Started", 0);
    },
    [org],
  );

  const openArticle = (slug: string) => {
    setView({ kind: "article", slug });
    setOpen(true);
  };

  const pageArticles = articlesForNode(articles, nodeId);
  const specific = pageArticles.filter(
    (a) => nodeId !== null && a.nodes.some((p) => p !== "*" && coversNode(p, nodeId)),
  );
  const results = searchArticles(articles, query);
  const article = view.kind === "article" ? articles.find((a) => a.slug === view.slug) : undefined;

  const articleList = (list: readonly Article[]) => (
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
    <>
      <IconButton
        icon="CircleHelp"
        label={t("button")}
        shortcut="?"
        data-help-trigger=""
        onClick={() => {
          setView({ kind: "home" });
          setOpen(true);
        }}
      />
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
                <ArticleBody blocks={article.body} onArticle={openArticle} />
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
      {offered ? (
        <Card label={t("tours.label")}>
          <p className="m-0 font-semibold">{t("tours.offerTitle")}</p>
          <p className="m-0 text-text-secondary">
            {t("tours.offerBody", {
              title: t(`${tourCopyKey(offered.key)}.title`),
              summary: t(`${tourCopyKey(offered.key)}.summary`),
            })}
          </p>
          <div className="flex flex-wrap justify-end gap-8">
            <Button
              onClick={() => {
                void recordTourAction(org, offered.key, "Dismissed");
                setClosedOffers((c) => [...c, offered.key]);
              }}
            >
              {t("tours.offerLater")}
            </Button>
            <Button variant="primary" onClick={() => startTour(offered)}>
              {t("tours.offerStart")}
            </Button>
          </div>
        </Card>
      ) : null}
      {tip ? (
        <Card label={t("tips.label")}>
          <p className="m-0 font-semibold">{t(`tips.${tip.key}.title`)}</p>
          <p className="m-0 text-text-secondary">{t(`tips.${tip.key}.body`)}</p>
          <div className="flex flex-wrap justify-end gap-8">
            <Button variant="ghost" onClick={() => openArticle(tip.article)}>
              {t("tips.learnMore")}
            </Button>
            <Button
              onClick={() => {
                setHiddenTips((h) => [...h, tip.key]);
                void dismissTipAction(org, tip.key);
              }}
            >
              {t("tips.dismiss")}
            </Button>
          </div>
        </Card>
      ) : null}
      {running ? (
        <TourStep
          key={`${running.tour.key}-${running.step}`}
          tour={running.tour}
          step={running.step}
          t={t}
          onMove={(step) => {
            if (step >= running.tour.steps.length) {
              void recordTourAction(org, running.tour.key, "Completed", running.tour.steps.length);
              setRunning(null);
            } else {
              void recordTourAction(org, running.tour.key, "Started", step);
              setRunning({ tour: running.tour, step });
            }
          }}
          onEnd={() => {
            void recordTourAction(org, running.tour.key, "Dismissed", running.step);
            setRunning(null);
          }}
        />
      ) : null}
    </>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section
      aria-label={label}
      className="fixed bottom-16 end-16 z-toast flex w-(--ui-dialog) max-w-[calc(100vw-var(--space-32))] flex-col gap-8 rounded-card bg-bg-raised p-16 text-text-13 shadow-menu forced-colors:border"
    >
      {children}
    </section>
  );
}

/**
 * One step of a guided tour: a non-modal card that takes focus, points at its target with an outline
 * when the page has one, and moves with Back, Next or Finish. Esc ends the tour.
 */
function TourStep({
  tour,
  step,
  t,
  onMove,
  onEnd,
}: {
  tour: Tour;
  step: number;
  t: Translate;
  onMove: (step: number) => void;
  onEnd: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const key = tourCopyKey(tour.key);
  const last = step === tour.steps.length - 1;

  useEffect(() => {
    ref.current?.focus();
    const selector = tour.steps[step]?.target;
    const target = selector ? document.querySelector<HTMLElement>(selector) : null;
    if (!target) return;
    const previous = target.style.outline;
    target.style.outline = "var(--stroke-width-focus) solid var(--color-focus-ring)";
    target.scrollIntoView({ block: "nearest" });
    return () => {
      target.style.outline = previous;
    };
  }, [tour, step]);

  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-label={t("tours.label")}
      aria-describedby={`tour-${tour.key}-${step}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onEnd();
        }
      }}
      className="fixed bottom-16 end-16 z-toast flex w-(--ui-dialog) max-w-[calc(100vw-var(--space-32))] flex-col gap-8 rounded-card bg-bg-raised p-16 text-text-13 shadow-menu outline-none focus-visible:ring-(length:--stroke-width-focus) focus-visible:ring-focus-ring forced-colors:border"
    >
      <p className="m-0 text-text-12 text-text-secondary">
        {t("tours.step", { current: step + 1, total: tour.steps.length })}
      </p>
      <h2 className="m-0 text-heading-16 font-semibold">{t(`${key}.steps.${step + 1}.title`)}</h2>
      <p id={`tour-${tour.key}-${step}`} className="m-0 text-text-secondary">
        {t(`${key}.steps.${step + 1}.body`)}
      </p>
      <div className="flex flex-wrap justify-end gap-8">
        <Button variant="ghost" onClick={onEnd}>
          {t("tours.skip")}
        </Button>
        {step > 0 ? <Button onClick={() => onMove(step - 1)}>{t("tours.previous")}</Button> : null}
        <Button variant="primary" onClick={() => onMove(step + 1)}>
          {last ? t("tours.finish") : t("tours.next")}
        </Button>
      </div>
    </section>
  );
}
