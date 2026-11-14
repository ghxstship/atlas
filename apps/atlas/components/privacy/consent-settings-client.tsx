"use client";

import { ConsentSettings, type ConsentSettingsProps } from "@xos/ui/consent";
import { routerLink } from "./consent-link";

/**
 * The shared ConsentSettings of @xos/ui with its links drawn by next/link. Apart from
 * consent-client.tsx, so the root layout, which shows the banner on every route, does not send the
 * settings view with it (route JavaScript budget, ADR 0027).
 */
export function RoutedConsentSettings(props: Omit<ConsentSettingsProps, "renderLink">) {
  return <ConsentSettings {...props} renderLink={routerLink} />;
}
