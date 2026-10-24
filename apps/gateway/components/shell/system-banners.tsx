"use client";

import { Banner } from "@xos/ui";
import {
  addDismissed,
  bannerText,
  bannerTone,
  DISMISSED_BANNERS_KEY,
  parseBannerJson,
  parseDismissed,
  visibleBanners,
  type SystemBanner,
} from "@xos/data/system-banners";
import { useLocale } from "next-intl";
import { useEffect, useState } from "react";

/**
 * Platform system banners (A90, Section 4.10): maintenance, incidents, plan notices. Fetched from this app's own
 * cached route once the page is idle, so a banner never blocks or slows the page; a failed fetch shows nothing. A
 * dismissible banner a person hides stays hidden on this device.
 */
export function SystemBanners({ linkLabel }: { linkLabel: string }) {
  const locale = useLocale();
  const [banners, setBanners] = useState<SystemBanner[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      let stored: string | null = null;
      try {
        stored = window.localStorage.getItem(DISMISSED_BANNERS_KEY);
      } catch (error) {
        // Storage can be off (private browsing); every banner then shows.
        if (!(error instanceof DOMException)) throw error;
      }
      try {
        const response = await fetch("/api/system-banners");
        const body = response.ok ? ((await response.json()) as { banners?: unknown }) : {};
        if (!alive) return;
        setDismissed(parseDismissed(stored));
        setBanners(parseBannerJson(body.banners));
      } catch (error) {
        // A banner outage never breaks a page; the next page load asks again.
        if (!(error instanceof TypeError || error instanceof SyntaxError)) throw error;
      }
    };
    const idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 1));
    idle(() => void load());
    return () => {
      alive = false;
    };
  }, []);

  const shown = visibleBanners(banners, dismissed);
  if (shown.length === 0) return null;
  const dismiss = (id: string) => {
    setDismissed((current) => {
      const next = addDismissed(JSON.stringify(current), id);
      try {
        window.localStorage.setItem(DISMISSED_BANNERS_KEY, next);
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
      }
      return parseDismissed(next);
    });
  };
  return (
    <div className="mb-16 flex flex-col gap-8" data-testid="system-banners">
      {shown.map((banner) => (
        <Banner
          key={banner.id}
          tone={bannerTone(banner.severity)}
          {...(banner.dismissible ? { onDismiss: () => dismiss(banner.id) } : {})}
        >
          <span className="flex flex-wrap items-baseline gap-8">
            <span>{bannerText(banner, locale)}</span>
            {banner.linkUrl ? (
              <a
                href={banner.linkUrl}
                className="font-medium text-accent-text underline"
                rel="noopener noreferrer"
                target="_blank"
              >
                {linkLabel}
              </a>
            ) : null}
          </span>
        </Banner>
      ))}
    </div>
  );
}
