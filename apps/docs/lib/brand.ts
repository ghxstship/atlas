/**
 * Docs site white label (A138, Section 12: the docs site wears an Enterprise org's brand, ADR 0066).
 * An org's docs live under /o/<org-slug>/… on the docs host, or on a host the deployment maps to the
 * org (XOS_DOCS_TENANT_HOSTS, after the owner points its DNS at the docs project). The proxy looks the
 * brand up through api_public.docs_brand_for_slug (migration 2310), which answers only for an
 * Enterprise org with white label in force and returns only its name, logos and accent, and hands it
 * to the page in a cookie scoped to the org's docs. Every page stays prerendered: the script below
 * applies the accent before first paint, and the brand mark swaps in the logo and name.
 */
import { launchLocales } from "@xos/i18n/locales";

/** The cookie that carries an org's docs brand from the proxy to the page. */
export const BRAND_COOKIE = "xos-docs-brand";

/** The path prefix of an org's docs on the docs host: /o/<org-slug>/… */
export const TENANT_PREFIX = "/o/";

/** How long a browser keeps a brand before the proxy looks it up again, in seconds. */
export const BRAND_MAX_AGE = 3600;

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const HEX_COLOR = /^#[0-9A-F]{6}$/;

/** Whose docs a request is for, and the path of the docs page inside them. */
export interface DocsTenant {
  readonly slug: string;
  /** "path" under /o/<slug>/ on the docs host, "host" on a host mapped to the org. */
  readonly via: "path" | "host";
  /** The docs page path, for example /en-US/guides/quickstart, or / at the root. */
  readonly rest: string;
  /** What the org's docs links start with: /o/<slug> under a path, nothing on its own host. */
  readonly base: string;
}

/** The brand the docs site wears for an org. */
export interface DocsBrand {
  readonly name: string;
  readonly logoLightUrl: string | null;
  readonly logoDarkUrl: string | null;
  /** Uppercase six-digit hex, present only when it passes the contrast gate in every theme. */
  readonly accent: string | null;
}

/** A brand as the page reads it from the cookie, with the base its links start with. */
export interface ScopedBrand extends DocsBrand {
  readonly base: string;
}

/** The host without a port, lowercased. */
export function hostName(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "");
}

/**
 * Parses XOS_DOCS_TENANT_HOSTS, comma-separated `host=org-slug` pairs such as
 * `docs.northwind-live.com=northwind-live`. Malformed pairs are skipped.
 */
export function parseTenantHosts(value: string | undefined): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const pair of (value ?? "").split(",")) {
    const [host = "", slug = ""] = pair.split("=").map((part) => part.trim().toLowerCase());
    const name = hostName(host);
    if (SLUG.test(slug) && /^[a-z0-9.-]+$/.test(name)) map.set(name, slug);
  }
  return map;
}

/**
 * The org whose docs a request is for: a host mapped to an org serves only that org's docs; on any
 * other host, a path under /o/<slug>/ does. Null for the platform docs.
 */
export function resolveTenant(
  host: string | null,
  pathname: string,
  hosts: ReadonlyMap<string, string>,
): DocsTenant | null {
  const mapped = host ? hosts.get(hostName(host)) : undefined;
  if (mapped !== undefined) return { slug: mapped, via: "host", rest: pathname, base: "" };
  if (!pathname.startsWith(TENANT_PREFIX)) return null;
  const [slug = "", ...rest] = pathname.slice(TENANT_PREFIX.length).split("/");
  if (!SLUG.test(slug) || slug.length > 48) return null;
  return { slug, via: "path", rest: `/${rest.join("/")}`, base: `${TENANT_PREFIX}${slug}` };
}

/**
 * The docs page a browser path shows. Under /o/<slug>/ the proxy rewrites to the prerendered page
 * at the rest of the path, so the client reads /o/<slug>/en-US/… where the server rendered
 * /en-US/…; the tenant base is dropped so both match the same nav item and hydration agrees.
 */
export function docsPagePath(pathname: string): string {
  if (!pathname.startsWith(TENANT_PREFIX)) return pathname;
  const [slug = "", ...rest] = pathname.slice(TENANT_PREFIX.length).split("/");
  if (!SLUG.test(slug) || slug.length > 48) return pathname;
  return `/${rest.join("/")}`;
}

/** The cookie value carrying a brand and its link base, as JSON: Next URI-encodes it in Set-Cookie. */
export function encodeBrand(brand: DocsBrand, base: string): string {
  return JSON.stringify({ ...brand, base });
}

function httpUrl(value: unknown): string | null {
  return typeof value === "string" && /^https?:\/\/[^\s"'<>]+$/.test(value) ? value : null;
}

/**
 * Reads a brand from its cookie as the browser holds it (URI-encoded JSON), refusing anything
 * malformed: a name of 1 to 200 characters, http(s) logo URLs, a six-digit hex accent and a base that
 * is empty or /o/<slug>.
 */
export function decodeBrand(value: string | null | undefined): ScopedBrand | null {
  if (!value) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(decodeURIComponent(value));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r["name"] === "string" ? r["name"].trim() : "";
  const base = r["base"];
  if (name.length < 1 || name.length > 200) return null;
  if (base !== "" && !(typeof base === "string" && /^\/o\/[a-z0-9]+(-[a-z0-9]+)*$/.test(base)))
    return null;
  const accent =
    typeof r["accent"] === "string" && HEX_COLOR.test(r["accent"]) ? r["accent"] : null;
  return {
    name,
    logoLightUrl: httpUrl(r["logoLightUrl"]),
    logoDarkUrl: httpUrl(r["logoDarkUrl"]),
    accent,
    base: base as string,
  };
}

/** A docs page path inside the org's docs: /en-US/… becomes /o/<slug>/en-US/…; other paths stay. */
export function scopedPath(path: string, base: string): string {
  if (!base || path.startsWith(`${base}/`)) return path;
  const first = path.split("/")[1] ?? "";
  return (launchLocales as readonly string[]).includes(first) ? `${base}${path}` : path;
}

/** The value of one cookie in a Cookie header or document.cookie. */
export function readCookie(cookies: string, name: string): string | null {
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

/**
 * Runs in <head> before paint on every docs page: with an org's brand cookie in scope it applies the
 * accent and marks the document branded, so the platform mark is hidden until the org's swaps in.
 * The proxy validated the accent; the script checks its shape again.
 */
export const BRAND_SCRIPT = `try{var m=document.cookie.match(/(?:^|; )${BRAND_COOKIE}=([^;]*)/);if(m){var b=JSON.parse(decodeURIComponent(m[1]));if(b&&typeof b.name==="string"){var d=document.documentElement;d.dataset.docsBrand="org";if(typeof b.accent==="string"&&/^#[0-9A-F]{6}$/.test(b.accent))d.style.setProperty("--color-accent-default",b.accent);}}}catch(e){}`;
