"use client";

import { ConsentBanner, type ConsentBannerProps } from "@xos/ui/consent";
import { routerLink } from "./consent-link";

/**
 * The shared ConsentBanner of @xos/ui with its links drawn by next/link, so the Cookie Policy and
 * Cookie settings open without a full page load. The package draws plain anchors and knows nothing
 * of Next.js; `renderLink` is a function, so it is given here, in a client module. consent-client.tsx
 * loads this module on demand.
 */
export function RoutedConsentBanner(props: Omit<ConsentBannerProps, "renderLink">) {
  return <ConsentBanner {...props} renderLink={routerLink} />;
}
