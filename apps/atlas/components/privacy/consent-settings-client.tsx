"use client";

import { ConsentSettings, type ConsentSettingsProps } from "@xos/ui/consent";
import { routerLink } from "./consent-link";

/**
 * The shared ConsentSettings of @xos/ui with its links drawn by next/link. A client module that only
 * the Cookie settings page loads; the banner on every route is the script-free one and needs none
 * (route JavaScript budget, ADR 0027).
 */
export function RoutedConsentSettings(props: Omit<ConsentSettingsProps, "renderLink">) {
  return <ConsentSettings {...props} renderLink={routerLink} />;
}
