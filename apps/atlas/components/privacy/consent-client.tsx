"use client";

import {
  ConsentBanner,
  ConsentSettings,
  type ConsentBannerProps,
  type ConsentLinkRenderer,
  type ConsentSettingsProps,
} from "@xos/ui/consent";
import type { Route } from "next";
import Link from "next/link";

/**
 * The shared ConsentBanner and ConsentSettings of @xos/ui with their links drawn by next/link, so
 * the Cookie Policy and Cookie settings open without a full page load. The package draws plain
 * anchors and knows nothing of Next.js; `renderLink` is a function, so it is given here, in a
 * client module of its own that the root layout can load without the rest of the library (ADR 0027).
 */
const routerLink: ConsentLinkRenderer = (link, className) => (
  <Link href={link.href as Route} className={className}>
    {link.label}
  </Link>
);

export function RoutedConsentBanner(props: Omit<ConsentBannerProps, "renderLink">) {
  return <ConsentBanner {...props} renderLink={routerLink} />;
}

export function RoutedConsentSettings(props: Omit<ConsentSettingsProps, "renderLink">) {
  return <ConsentSettings {...props} renderLink={routerLink} />;
}
