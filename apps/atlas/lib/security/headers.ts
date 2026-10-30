/**
 * Security headers (Section 9: strict Content Security Policy with nonces, HSTS, same-site
 * cookies and CSRF protection on server actions). The proxy applies them to every page response.
 */

export interface CspInput {
  readonly nonce: string;
  readonly development: boolean;
  /** The Supabase API origin; OAuth and email links leave through it. */
  readonly supabaseOrigin: string;
  /** Whether Atlas is served over https; only then are subresources upgraded. */
  readonly secureSite: boolean;
}

/**
 * Where the consent screens live: Google's (Sign in with Google, ADR 0036, and Connect with Google for Drive, B16)
 * and Microsoft's (Connect with Microsoft for OneDrive, B16). Without JavaScript those forms post natively, and
 * browsers check form-action on every redirect of that navigation. Other providers add their origin here when
 * they are turned on.
 */
export const OAUTH_AUTHORIZE_ORIGINS = [
  "https://accounts.google.com",
  "https://login.microsoftonline.com",
] as const;

/**
 * The Supabase Realtime socket's origin (live updates, ADR 0044): the API origin with ws or wss in
 * place of http or https. Pages open it only to receive changes; every other call stays same-origin.
 */
export function realtimeOrigin(supabaseOrigin: string): string {
  return supabaseOrigin.replace(/^http/i, "ws");
}

/**
 * A strict policy: scripts run only with this response's nonce ('strict-dynamic' lets them load
 * their own chunks), styles come from the site or carry the nonce, and nothing may frame Atlas.
 * Style attributes stay allowed because React and Radix position overlays with them. Development
 * adds what the Next.js dev server needs: eval for error overlays, inline styles and the HMR socket.
 */
export function buildCsp({ nonce, development, supabaseOrigin, secureSite }: CspInput): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(development ? ["'unsafe-eval'"] : []),
    ],
    "style-src": ["'self'", development ? "'unsafe-inline'" : `'nonce-${nonce}'`],
    "style-src-attr": ["'unsafe-inline'"],
    "img-src": ["'self'", "blob:", "data:"],
    "font-src": ["'self'", "data:"],
    "connect-src": [
      "'self'",
      ...(development ? ["ws:", "wss:"] : []),
      realtimeOrigin(supabaseOrigin),
    ],
    // The service worker and the web manifest (A96): stated outright, since 'strict-dynamic' makes the browser
    // ignore 'self' in script-src, which worker-src would otherwise fall back to.
    "worker-src": ["'self'"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'", supabaseOrigin, ...OAUTH_AUTHORIZE_ORIGINS],
    "frame-ancestors": ["'none'"],
    ...(secureSite ? { "upgrade-insecure-requests": [] } : {}),
  };
  return Object.entries(directives)
    .map(([name, values]) => [name, ...values].join(" "))
    .join("; ");
}

/** Headers every Atlas page carries besides the CSP. HSTS is sent when Atlas is served over https. */
export function securityHeaders(secureSite: boolean): Record<string, string> {
  return {
    ...(secureSite
      ? { "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload" }
      : {}),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

/** 128 random bits, base64 encoded, fresh for every request. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF check for state-changing requests (server actions, the sign-out form): the Origin header
 * must name this site. Browsers always send Origin on cross-site POSTs, so a missing Origin on a
 * POST is treated as cross-site too. Next.js runs its own Origin check on server actions as well.
 */
export function isCrossSiteMutation(input: {
  readonly method: string;
  readonly origin: string | null;
  readonly host: string | null;
  readonly siteOrigin: string;
}): boolean {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return false;
  if (!input.origin) return true;
  let origin: URL;
  try {
    origin = new URL(input.origin);
  } catch (error) {
    if (error instanceof TypeError) return true;
    throw error;
  }
  if (origin.origin === new URL(input.siteOrigin).origin) return false;
  return input.host === null || origin.host !== input.host;
}
