"use client";

import dynamic from "next/dynamic";

/**
 * The platform system banners (system-banners.tsx, A90) as the org and partner layouts render them. They show nothing
 * until a fetch made once the page is idle returns a banner, so their code (the Banner, the parsing and the dismissed
 * list) loads after the page rather than with it (A24-009), leaving room in every route's JavaScript.
 */
export const DeferredSystemBanners = dynamic(
  () => import("./system-banners").then((m) => m.SystemBanners),
  { ssr: false },
);
