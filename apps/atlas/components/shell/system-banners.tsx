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
import { useState } from "react";

/**
 * Platform system banners (A90, Section 4.10): maintenance, incidents, plan notices, as the cached route answered them
 * (deferred-system-banners.tsx). A dismissible banner a person hides stays hidden on this device.
 */
export function SystemBanners({
  banners: live,
  linkLabel,
}: {
  banners: readonly unknown[];
  linkLabel: string;
}) {
  const locale = useLocale();
  const [banners] = useState<SystemBanner[]>(() => parseBannerJson(live));
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      return parseDismissed(window.localStorage.getItem(DISMISSED_BANNERS_KEY));
    } catch (error) {
      // Storage can be off (private browsing); every banner then shows.
      if (!(error instanceof DOMException)) throw error;
      return [];
    }
  });

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
