/**
 * Continue on another device in Compass (Section 11.10 item 13, ADR 0030). A QR code in Atlas or Gateway
 * opens `compass://r/{recordKey}?org={org}` or `compass://e/{engagementKey}`, or the page's own URL once
 * universal links are on; `app/+native-intent.tsx` turns every form into the Compass route. A record
 * whose kind Compass has a screen for opens natively, with that screen one tap away; every other record
 * shows its key and title and opens on Atlas, and an engagement opens on Gateway.
 */
import { webPath, type HandoffTarget } from "@xos/ia/handoff";

/** A Compass screen that holds a record kind's work. */
export interface NativeScreen {
  readonly route: string;
  /** compass.record.open.* key of the button that opens it. */
  readonly label: string;
  readonly icon: string;
}

/**
 * Record kinds Compass has a screen for (apps/compass/app): shifts on the schedule, inspections on the
 * inspection walk, training on the training list. Kept in one table so a new screen joins in one line.
 */
export const NATIVE_RECORD_SCREENS: Readonly<Record<string, NativeScreen>> = {
  Shift: { route: "/schedule", label: "compass.record.open.schedule", icon: "calendar" },
  Inspection: {
    route: "/inspections",
    label: "compass.record.open.inspections",
    icon: "clipboard-check",
  },
  Training: {
    route: "/workforce/training",
    label: "compass.record.open.training",
    icon: "book-open",
  },
};

/** The Compass screen for a record kind, or null when the record opens on the web. */
export function nativeScreenFor(kind: string): NativeScreen | null {
  return NATIVE_RECORD_SCREENS[kind] ?? null;
}

/** The web page that holds the item: Atlas for a record, Gateway for an engagement. */
export function webFallbackUrl(
  target: HandoffTarget,
  config: { readonly atlasUrl: string; readonly gatewayUrl: string },
): string {
  const origin = target.kind === "record" ? config.atlasUrl : config.gatewayUrl;
  return `${origin.replace(/\/+$/, "")}${webPath(target)}`;
}

/** The record a handoff route names, from expo-router's params, or null when it names none. */
export function recordTargetFromParams(
  params: { readonly recordKey?: string | string[]; readonly org?: string | string[] },
  fallbackOrg: string | null,
): HandoffTarget | null {
  const key = Array.isArray(params.recordKey) ? params.recordKey[0] : params.recordKey;
  const org = (Array.isArray(params.org) ? params.org[0] : params.org) ?? fallbackOrg;
  if (!key || !org) return null;
  return { kind: "record", org, recordKey: key };
}
