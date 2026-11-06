"use client";

import { useEffect, useState } from "react";
import { onDemand, useOnDemand } from "./on-demand";

/** The Banner, the parsing and the dismissed list load only when there is a banner to show. */
const banners = onDemand(() => import("./system-banners"));

/**
 * The platform system banners (system-banners.tsx, A90) as the org and partner layouts render them. This cached route is
 * asked once the page is idle, so a banner never blocks or slows the page, and a failed fetch shows nothing; a page
 * almost never has one, so their code stays out of every route's JavaScript (A24-009, ADR 0027).
 */
export function DeferredSystemBanners({ linkLabel }: { linkLabel: string }) {
  const [live, setLive] = useState<readonly unknown[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch("/api/system-banners");
        const body = response.ok ? ((await response.json()) as { banners?: unknown }) : {};
        if (alive && Array.isArray(body.banners)) setLive(body.banners);
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
  const loaded = useOnDemand(banners, live.length > 0);
  return live.length > 0 && loaded ? (
    <loaded.SystemBanners banners={live} linkLabel={linkLabel} />
  ) : null;
}
