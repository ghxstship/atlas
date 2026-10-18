/**
 * Continue on another device (Section 11.10 item 13, ADR 0030): the links that carry one item between
 * Atlas, Gateway and Compass, and the universal link files that let a phone open them in Compass.
 *
 * One item has three addresses:
 *   - its web page: Atlas `/{org}/r/{recordKey}` for a record, Gateway `/work/engagements/{key}` for an
 *     engagement. With universal links configured these same URLs open Compass on a phone that has it,
 *     and the web page everywhere else.
 *   - its Compass scheme link: `compass://r/{recordKey}?org={org}` or `compass://e/{engagementKey}`, the
 *     fallback that needs no domain, used while universal links are not configured.
 *   - its Compass route: `/r/{recordKey}?org={org}` or `/e/{engagementKey}`, what Compass opens.
 *
 * The record key is the display key `{project_key}-{record_number}` (app.record_display_key). This
 * module is pure: no network, no React, so Atlas, Gateway, Compass and the tests share it.
 */

/** The item a handoff link carries. */
export type HandoffTarget =
  | { readonly kind: "record"; readonly org: string; readonly recordKey: string }
  | { readonly kind: "engagement"; readonly engagementKey: string };

/** The Compass URL scheme (apps/compass/app.json `scheme`). */
export const COMPASS_SCHEME = "compass";
/** Compass's iOS bundle identifier and Android application id (apps/compass/app.json). */
export const COMPASS_APP_ID = "pro.ghxstship.compass";

/** The web paths each shell lets Compass claim, in the apple-app-site-association pattern syntax. */
export const HANDOFF_PATHS = {
  atlas: ["/*/r/*"],
  gateway: ["/work/engagements/*"],
} as const satisfies Record<string, readonly string[]>;

export type HandoffShell = keyof typeof HANDOFF_PATHS;

const RECORD_KEY = /^[A-Z]{2,5}-[1-9][0-9]{0,17}$/;
const ORG_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ENGAGEMENT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** True for a record display key such as `NWS-12`. */
export function isRecordKey(value: string): boolean {
  return RECORD_KEY.test(value);
}

function validTarget(target: HandoffTarget): boolean {
  return target.kind === "record"
    ? RECORD_KEY.test(target.recordKey) && ORG_SLUG.test(target.org)
    : ENGAGEMENT_KEY.test(target.engagementKey);
}

/** Which shell owns the item's web page. */
export function shellFor(target: HandoffTarget): HandoffShell {
  return target.kind === "record" ? "atlas" : "gateway";
}

/** The item's page on its web shell, a path without the origin. */
export function webPath(target: HandoffTarget): string {
  return target.kind === "record"
    ? `/${encodeURIComponent(target.org)}/r/${encodeURIComponent(target.recordKey)}`
    : `/work/engagements/${encodeURIComponent(target.engagementKey)}`;
}

/** The route Compass opens for the item. */
export function compassRoute(target: HandoffTarget): string {
  return target.kind === "record"
    ? `/r/${encodeURIComponent(target.recordKey)}?org=${encodeURIComponent(target.org)}`
    : `/e/${encodeURIComponent(target.engagementKey)}`;
}

/** The Compass scheme link, which opens Compass directly where it is installed. */
export function compassSchemeUrl(target: HandoffTarget): string {
  return `${COMPASS_SCHEME}:/${compassRoute(target)}`;
}

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/**
 * What the Continue on another device QR code carries. With universal links configured it is the
 * item's own web URL, which opens Compass where installed and the web page anywhere else; otherwise
 * it is the Compass scheme link.
 */
export function handoffUrl(
  target: HandoffTarget,
  options: { readonly webOrigin: string; readonly universalLinks: boolean },
): string {
  return options.universalLinks
    ? `${trimOrigin(options.webOrigin)}${webPath(target)}`
    : compassSchemeUrl(target);
}

function decode(segment: string | undefined): string | null {
  if (segment === undefined || segment === "") return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function fromParts(segments: readonly string[], query: URLSearchParams): HandoffTarget | null {
  const [first, second, third] = segments;
  let target: HandoffTarget | null = null;
  if (segments.length === 2 && first === "r") {
    const recordKey = decode(second);
    const org = query.get("org");
    if (recordKey && org) target = { kind: "record", org, recordKey };
  } else if (segments.length === 2 && first === "e") {
    const engagementKey = decode(second);
    if (engagementKey) target = { kind: "engagement", engagementKey };
  } else if (segments.length === 3 && second === "r") {
    const org = decode(first);
    const recordKey = decode(third);
    if (org && recordKey) target = { kind: "record", org, recordKey };
  } else if (segments.length >= 3 && first === "work" && second === "engagements") {
    // A deeper engagement tab (…/engagements/{key}/shifts) still hands off the engagement.
    const engagementKey = decode(third);
    if (engagementKey) target = { kind: "engagement", engagementKey };
  }
  return target && validTarget(target) ? target : null;
}

/**
 * Reads a handoff link in any of its forms: the Compass scheme link, a universal link (the web page
 * URL on any host), a Compass route or a bare web path. Anything else answers null.
 */
export function parseHandoffUrl(input: string): HandoffTarget | null {
  const value = input.trim();
  if (value === "") return null;
  let url: URL;
  try {
    url = new URL(value, "https://handoff.invalid");
  } catch {
    return null;
  }
  const query = url.searchParams;
  if (url.protocol === `${COMPASS_SCHEME}:`) {
    // compass://r/KEY parses with "r" as the host; compass:///r/KEY with an empty one.
    const host = url.hostname;
    const rest = url.pathname.split("/").filter(Boolean);
    return fromParts(host ? [host, ...rest] : rest, query);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return fromParts(url.pathname.split("/").filter(Boolean), query);
}

/**
 * Compass's answer to an incoming system path (expo-router `redirectSystemPath`): a handoff link in
 * any form becomes the Compass route for its item; every other path passes through unchanged.
 */
export function compassPathForIncoming(path: string): string {
  const target = parseHandoffUrl(path);
  return target ? compassRoute(target) : path;
}

/** Universal link configuration a web shell reads from its environment. */
export interface UniversalLinkConfig {
  /** Apple app ids, `{TEAM_ID}.{bundle id}`. */
  readonly appleAppIds: readonly string[];
  /** SHA-256 fingerprints of the Android signing certificates, colon-separated hex. */
  readonly androidFingerprints: readonly string[];
}

const TEAM_ID = /^[A-Z0-9]{10}$/;
const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Reads COMPASS_APPLE_TEAM_IDS (comma-separated Apple Developer team ids) and COMPASS_ANDROID_CERT_SHA256
 * (comma-separated signing certificate fingerprints). Malformed entries are dropped, so a typo never
 * publishes a file that claims the wrong app.
 */
export function universalLinkConfig(
  env: Readonly<Record<string, string | undefined>>,
): UniversalLinkConfig {
  return {
    appleAppIds: list(env["COMPASS_APPLE_TEAM_IDS"])
      .map((id) => id.toUpperCase())
      .filter((id) => TEAM_ID.test(id))
      .map((id) => `${id}.${COMPASS_APP_ID}`),
    androidFingerprints: list(env["COMPASS_ANDROID_CERT_SHA256"])
      .map((f) => f.toUpperCase())
      .filter((f) => FINGERPRINT.test(f)),
  };
}

/** True when a shell publishes universal links, so its QR codes carry web URLs. */
export function universalLinksEnabled(config: UniversalLinkConfig): boolean {
  return config.appleAppIds.length > 0 || config.androidFingerprints.length > 0;
}

/** The apple-app-site-association file a shell serves, or null when no Apple app is configured. */
export function appleAppSiteAssociation(
  config: UniversalLinkConfig,
  shell: HandoffShell,
): Record<string, unknown> | null {
  if (config.appleAppIds.length === 0) return null;
  return {
    applinks: {
      details: [
        {
          appIDs: [...config.appleAppIds],
          components: HANDOFF_PATHS[shell].map((path) => ({
            "/": path,
            comment: `Continue on another device: ${shell} pages Compass opens`,
          })),
        },
      ],
    },
  };
}

/** The Digital Asset Links file a shell serves, or null when no Android certificate is configured. */
export function assetLinks(config: UniversalLinkConfig): readonly Record<string, unknown>[] | null {
  if (config.androidFingerprints.length === 0) return null;
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: COMPASS_APP_ID,
        sha256_cert_fingerprints: [...config.androidFingerprints],
      },
    },
  ];
}
