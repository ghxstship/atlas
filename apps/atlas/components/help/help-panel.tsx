"use client";

import { Button, Drawer, InlineAlert, Input, Skeleton } from "@xos/ui";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HELP_CONTENT } from "@/help/content.generated";
import {
  articlesForNode,
  coversNode,
  forNode,
  HELP_LOCALES,
  searchArticles,
  type ArticleSummary,
  type HelpBodies,
  type HelpLocale,
  type Tip,
  type Tour,
} from "@/help/model";
import { dismissTipAction, recordTourAction, type HelpPanelState } from "@/lib/help/actions";
import { ArticleBody } from "./article";
import { ContactForm } from "./contact-form";
import { collectDiagnostics } from "./diagnostics";
import { ShortcutSheet } from "./shortcut-sheet";
import type { HelpView as View } from "./help-center";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const tourCopyKey = (key: string) => `tours.${key.replaceAll(".", "_")}`;

export interface HelpPanelProps {
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
}

/**
 * The help panel and its floating cards (Section 11.16), loaded the first time Help opens or the
 * page has a tour or tip to offer (A24-009): the articles mapped to this page, search across every
 * article, the shortcut sheet, What's New, guided tours and Contact Support. On a page with a tour
 * the person has never been offered, the tour is offered once; otherwise a contextual tip for a
 * complex feature appears once until dismissed. Tours never start on their own and can be replayed
 * from Help.
 */
export function HelpPanel({
  org,
  state,
  loadFailed,
  nodeId,
  open,
  setOpen,
  view,
  setView,
}: HelpPanelProps) {
  const t = useTranslations("help") as unknown as Translate;
  const locale = useLocale();
  const pathname = usePathname();
  const search = useSearchParams();
  const lang: HelpLocale = (HELP_LOCALES as readonly string[]).includes(locale)
    ? (locale as HelpLocale)
    : "en-US";
  const articles = HELP_CONTENT.articles[lang];
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState<{ tour: Tour; step: number } | null>(null);
  const [closedOffers, setClosedOffers] = useState<readonly string[]>([]);
  const [hiddenTips, setHiddenTips] = useState<readonly string[]>([]);
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

  // A tip or tour offer waits while a drawer, dialog, peek or the navigation drawer is open, so it
  // never covers the overlay's own actions (A59-002); it shows again once the overlay closes.
  const covered = useOverlayOpen(offered !== null || tip !== null);

  const startTour = useCallback(
    (tour: Tour) => {
      setClosedOffers((c) => [...c, tour.key]);
      setOpen(false);
      setRunning({ tour, step: 0 });
      void recordTourAction(org, tour.key, "Started", 0);
    },
    [org, setOpen],
  );

  // A replay link from Me, Preferences (`?tour=<key>`) starts that tour on its page.
  const requestedTour = search.get("tour");
  useEffect(() => {
    const tour = pageTours.find((x) => x.key === requestedTour);
    if (!tour) return;
    let live = true;
    void Promise.resolve().then(() => {
      if (live) startTour(tour);
    });
    return () => {
      live = false;
    };
  }, [requestedTour, pageTours, startTour]);

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
    <>
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
            {section(t("shortcuts.title"), <ShortcutSheet org={org} />)}
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
      {offered && !covered ? (
        <Card
          label={t("tours.label")}
          onDismiss={() => {
            void recordTourAction(org, offered.key, "Dismissed");
            setClosedOffers((c) => [...c, offered.key]);
          }}
        >
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
            <Button variant="secondary" onClick={() => startTour(offered)}>
              {t("tours.offerStart")}
            </Button>
          </div>
        </Card>
      ) : null}
      {tip && !covered ? (
        <Card
          label={t("tips.label")}
          onDismiss={() => {
            setHiddenTips((h) => [...h, tip.key]);
            void dismissTipAction(org, tip.key);
          }}
        >
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
          onMove={async (step) => {
            if (step >= running.tour.steps.length) {
              // Finishing waits for the save, so leaving the page right after never loses it.
              await recordTourAction(org, running.tour.key, "Completed", running.tour.steps.length);
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

/** Closes a floating help card on Escape wherever focus is (WCAG 1.4.13, A23-002). */
function useEscape(onEscape: () => void) {
  const latest = useRef(onEscape);
  useEffect(() => {
    latest.current = onEscape;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) latest.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

/** Any open overlay a help card would sit above: dialogs, drawers and peeks, and the shell's drawer. */
const OVERLAY =
  "[role='dialog'], [role='alertdialog'], dialog[open], .xos-shell [data-open='true']";

/** Whether an overlay is open, watched while `active` (while there is a card to show). */
function useOverlayOpen(active: boolean): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!active) return undefined;
    const check = () => setOpen(document.querySelector(OVERLAY) !== null);
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-open", "open", "role"],
    });
    return () => observer.disconnect();
  }, [active]);
  return active && open;
}

/**
 * Keeps room under the page for a showing card (`--xos-help-card-space`, read by the shell's content
 * column), so the page's last rows and actions can scroll clear of it instead of sitting under it.
 */
function useReservedSpace(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    const root = document.documentElement;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      root.style.setProperty("--xos-help-card-space", `${Math.ceil(el.offsetHeight)}px`);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--xos-help-card-space");
    };
  }, [ref]);
}

/* On phones the cards sit above the bottom tab bar, so they never cover it or the control in focus
   (WCAG 2.4.11, A23-002). */
const CARD_POSITION =
  "fixed bottom-16 max-md:bottom-[calc(var(--ui-bottom-bar)+var(--space-16))] end-16 z-toast";

function Card({
  label,
  onDismiss,
  children,
}: {
  label: string;
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  useEscape(onDismiss);
  const ref = useRef<HTMLElement>(null);
  useReservedSpace(ref);
  return (
    <section
      ref={ref}
      aria-label={label}
      data-help-card=""
      className={`${CARD_POSITION} flex w-(--ui-dialog) max-w-[calc(100vw-var(--space-32))] flex-col gap-8 rounded-card bg-bg-raised p-16 text-text-13 shadow-menu forced-colors:border`}
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
  onMove: (step: number) => void | Promise<void>;
  onEnd: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const key = tourCopyKey(tour.key);
  const last = step === tour.steps.length - 1;
  useEscape(onEnd);
  useReservedSpace(ref);

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
      className={`${CARD_POSITION} flex w-(--ui-dialog) max-w-[calc(100vw-var(--space-32))] flex-col gap-8 rounded-card bg-bg-raised p-16 text-text-13 shadow-menu outline-none focus-visible:ring-(length:--stroke-width-focus) focus-visible:ring-focus-ring forced-colors:border`}
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
        {step > 0 ? (
          <Button onClick={() => void onMove(step - 1)}>{t("tours.previous")}</Button>
        ) : null}
        <Button variant="primary" onClick={() => void onMove(step + 1)}>
          {last ? t("tours.finish") : t("tours.next")}
        </Button>
      </div>
    </section>
  );
}
