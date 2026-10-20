"use client";

import { findRoute } from "@xos/ia";
import { IconButton } from "@xos/ui";
import { useTranslations } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { HELP_GUIDES } from "@/help/guides.generated";
import { forNode } from "@/help/model";
import { clientSitemap } from "@/ia/sitemap.client.generated";
import { loadHelpStateAction, type HelpPanelState } from "@/lib/help/actions";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import { singleKeyShortcutsEnabled } from "@xos/ui/preferences";
import { installErrorCapture, type CollectedDiagnostics } from "./diagnostics";

/** What the help panel shows. */
export type HelpView =
  | { readonly kind: "home" }
  | { readonly kind: "article"; readonly slug: string }
  | { readonly kind: "contact"; readonly diagnostics: CollectedDiagnostics };

const HELP_EVENT = "xos:help";

/** The panel, the article index and the tour cards load on demand (A24-009). */
const panel = onDemand(() => import("./help-panel"));

/** Opens the help panel on an article, or on its home when `slug` is empty. */
export function openHelpArticle(slug: string) {
  window.dispatchEvent(new CustomEvent(HELP_EVENT, { detail: slug }));
}

/**
 * Help in the Atlas shell (Section 11.16). The Help button and the `?` key open the contextual help
 * panel (help-panel.tsx). This part stays with the page: it loads the person's tours and tips and
 * fetches the panel when Help opens, when the page has a tour or tip the person has not seen, or
 * when a replay link (`?tour=<key>`) asks for a tour.
 */
export function HelpCenter({ org }: { org: string }) {
  const t = useTranslations("help");
  const pathname = usePathname();
  const search = useSearchParams();
  const nodeId = useMemo(() => findRoute(clientSitemap, pathname)?.id ?? null, [pathname]);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<HelpView>({ kind: "home" });
  const [state, setState] = useState<HelpPanelState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

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
      if (
        event.key === "?" &&
        !typing &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        singleKeyShortcutsEnabled()
      ) {
        event.preventDefault();
        setView({ kind: "home" });
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Whether this page has something for the panel to offer: an unseen tour, an undismissed tip, or a
  // requested replay. The panel decides which one shows.
  const offers = useMemo(() => {
    const tours = forNode(HELP_GUIDES.tours, nodeId);
    const requested = search.get("tour");
    if (requested !== null && tours.some((x) => x.key === requested)) return true;
    if (!state) return false;
    const seen = new Set(state.tours.map((x) => x.tourKey));
    return (
      tours.some((x) => !seen.has(x.key)) ||
      forNode(HELP_GUIDES.tips, nodeId).some((x) => !state.dismissedTips.includes(x.key))
    );
  }, [nodeId, search, state]);

  const loaded = useOnDemand(panel, open || offers);
  const preload = () => void panel.load().catch(() => undefined);

  return (
    <>
      <IconButton
        icon="CircleHelp"
        label={t("button")}
        shortcut="?"
        data-help-trigger=""
        onPointerEnter={preload}
        onFocus={preload}
        onClick={() => {
          setView({ kind: "home" });
          setOpen(true);
        }}
      />
      {loaded ? (
        <loaded.HelpPanel
          org={org}
          state={state}
          loadFailed={loadFailed}
          nodeId={nodeId}
          open={open}
          setOpen={setOpen}
          view={view}
          setView={setView}
        />
      ) : null}
    </>
  );
}
