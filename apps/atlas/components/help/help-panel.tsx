"use client";

import { Button } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HELP_GUIDES } from "@/help/guides.generated";
import { forNode, type Tip, type Tour } from "@/help/model";
import { dismissTipAction, recordTourAction, type HelpPanelState } from "@/lib/help/actions";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import type { HelpView as View } from "./help-center";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const tourCopyKey = (key: string) => `tours.${key.replaceAll(".", "_")}`;

/**
 * The drawer with the articles, search, shortcuts, What's New and Contact Support loads the first
 * time Help opens. A page that only offers a tour or a tip loads this module alone, which is the
 * cards and the tour steps (gate 10: the drawer, its Radix dialog and the article index were about
 * 28 KB on a first visit to a page with a tour).
 */
const drawer = onDemand(() => import("./help-drawer"));

/** Fetches the drawer early, when a pointer or focus reaches the Help button (help-center.tsx). */
export function preloadDrawer(): void {
  void drawer.load().catch(() => undefined);
}

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
 * The help panel's floating cards and its drawer (Section 11.16), loaded the first time Help opens or
 * the page has a tour or tip to offer (A24-009). On a page with a tour the person has never been
 * offered, the tour is offered once; otherwise a contextual tip for a complex feature appears once
 * until dismissed. Tours never start on their own and can be replayed from Help. The drawer
 * (help-drawer.tsx) loads only when Help opens.
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
  const search = useSearchParams();
  const [running, setRunning] = useState<{ tour: Tour; step: number } | null>(null);
  const [closedOffers, setClosedOffers] = useState<readonly string[]>([]);
  const [hiddenTips, setHiddenTips] = useState<readonly string[]>([]);
  const loadedDrawer = useOnDemand(drawer, open);

  const seenTours = useMemo(() => new Set(state?.tours.map((x) => x.tourKey)), [state]);
  const pageTours = useMemo(() => forNode(HELP_GUIDES.tours, nodeId), [nodeId]);

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
      forNode(HELP_GUIDES.tips, nodeId).find(
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

  return (
    <>
      {loadedDrawer ? (
        <loadedDrawer.HelpDrawer
          org={org}
          state={state}
          loadFailed={loadFailed}
          nodeId={nodeId}
          open={open}
          setOpen={setOpen}
          view={view}
          setView={setView}
          pageTours={pageTours}
          seenTours={seenTours}
          startTour={startTour}
        />
      ) : null}
      {offered ? (
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
      {tip ? (
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
  return (
    <section
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
