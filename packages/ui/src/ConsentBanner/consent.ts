/**
 * The consent record behind ConsentBanner and ConsentSettings (Section 14.3). The components never
 * know where a decision is kept: they read and write through `ConsentAdapter`. Atlas implements it
 * over its consent log in the platform database (apps/atlas/lib/privacy/consent-adapter.ts); a site
 * with no database uses `cookieConsentAdapter`, which keeps the whole decision in one first-party
 * cookie. This module has no React and no DOM requirement, so a server can import it.
 */

/** What the visitor pressed: accept every optional category, refuse them all, or save the ticked ones. */
export type ConsentChoice = "all" | "none" | "save";

/** The consent in force: each optional category by name, and whether it came from a privacy signal. */
export interface ConsentState {
  /** Optional categories by name, true when allowed. Strictly necessary cookies are never listed. */
  readonly categories: Readonly<Record<string, boolean>>;
  /** The decision came from a Global Privacy Control signal, which refuses every optional category. */
  readonly gpc: boolean;
}

/** One decision as it is written: the consent, when it was made and the policy version shown. */
export interface ConsentDecision extends ConsentState {
  /** When the visitor decided, ISO 8601 in UTC. */
  readonly decidedAt: string;
  /** The version of the cookie policy and banner the visitor saw. */
  readonly policyVersion: string;
}

/** Where consent is kept. Implement both methods; the components call nothing else. */
export interface ConsentAdapter {
  /** The consent in force for this visitor, or null when they have not decided. */
  read(): Promise<ConsentState | null>;
  /** Stores a decision. It replaces any earlier one. */
  write(decision: ConsentDecision): Promise<void>;
}

/**
 * The rule for a category name, on write and on read alike: a letter, then letters, digits,
 * underscores or hyphens, 64 characters at most. `preferences`, `analytics_storage` and `Marketing`
 * fit; a name with a space or a semicolon does not.
 */
export const CONSENT_CATEGORY_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** True when a request carries Global Privacy Control (`Sec-GPC: 1`). */
export function sendsGlobalPrivacyControl(headers: { get(name: string): string | null }): boolean {
  return headers.get("sec-gpc")?.trim() === "1";
}

/** True when the browser reports Global Privacy Control (`navigator.globalPrivacyControl`). */
export function browserGlobalPrivacyControl(
  nav: unknown = typeof navigator === "undefined" ? undefined : navigator,
): boolean {
  if (typeof nav !== "object" || nav === null) return false;
  const signal = (nav as { globalPrivacyControl?: unknown }).globalPrivacyControl;
  return signal === true || signal === "1";
}

export interface DecideConsentInput {
  readonly choice: ConsentChoice;
  /** Every optional category the surface offers. */
  readonly categories: readonly string[];
  /** The categories ticked, read only for the `save` choice. */
  readonly selected?: Iterable<string>;
  /** A Global Privacy Control signal is present, from the request or the browser. */
  readonly gpc: boolean;
  readonly policyVersion: string;
  /** The time of the decision; now when omitted. */
  readonly now?: Date;
}

/**
 * Turns a choice into the decision to write. A Global Privacy Control signal refuses every optional
 * category whatever was pressed or ticked, and the decision records the signal.
 */
export function decideConsent(input: DecideConsentInput): ConsentDecision {
  const selected = new Set(input.selected ?? []);
  const allowed = (name: string): boolean =>
    !input.gpc && (input.choice === "all" || (input.choice === "save" && selected.has(name)));
  return {
    categories: Object.fromEntries(input.categories.map((name) => [name, allowed(name)])),
    gpc: input.gpc,
    decidedAt: (input.now ?? new Date()).toISOString(),
    policyVersion: input.policyVersion,
  };
}

/** Whether a category is allowed now: consented, not decided by a signal, and no signal present. */
export function consentAllows(state: ConsentState | null, category: string, gpc: boolean): boolean {
  return state !== null && !state.gpc && !gpc && state.categories[category] === true;
}

// The database-free reference implementation: one first-party cookie -----------------------------

/** The cookie `cookieConsentAdapter` writes unless it is given another name. */
export const CONSENT_DECISION_COOKIE = "xos-consent-decision";
/** How long the decision is remembered before the banner asks again: 12 months. */
export const CONSENT_DECISION_MAX_AGE = 60 * 60 * 24 * 365;

export interface ConsentCookieOptions {
  readonly path: "/";
  readonly sameSite: "lax";
  readonly secure: boolean;
  /** Seconds. */
  readonly maxAge: number;
}

/**
 * The two cookie operations the reference adapter needs; a browser or a server response fits.
 * Encoding is the store's job: `get` returns and `set` receives the decoded value, which is JSON
 * with quotes and commas in it. A framework's cookie jar (Next.js `cookies()`) already encodes on
 * the way out and decodes on the way in, as `documentCookieStore` does, so a decision one of them
 * writes is read by the other.
 */
export interface ConsentCookieStore {
  get(name: string): string | undefined;
  set(name: string, value: string, options: ConsentCookieOptions): void;
}

/**
 * The cookie value for a decision: versioned JSON, not encoded. Throws on a category name outside
 * `CONSENT_CATEGORY_NAME`, which `parseConsentDecision` would refuse to read back.
 */
export function serializeConsentDecision(decision: ConsentDecision): string {
  for (const name of Object.keys(decision.categories)) {
    if (!CONSENT_CATEGORY_NAME.test(name))
      throw new TypeError(
        `Consent category name ${JSON.stringify(name)} must match ${String(CONSENT_CATEGORY_NAME)}.`,
      );
  }
  return JSON.stringify({
    v: 1,
    at: decision.decidedAt,
    policy: decision.policyVersion,
    gpc: decision.gpc,
    categories: decision.categories,
  });
}

/** The decision a decoded cookie value holds, or null when it is missing or not one this version wrote. */
export function parseConsentDecision(value: string | undefined | null): ConsentDecision | null {
  if (!value) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { v, at, policy, gpc, categories } = raw as Record<string, unknown>;
  if (v !== 1 || typeof gpc !== "boolean") return null;
  if (typeof policy !== "string" || policy === "") return null;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return null;
  if (typeof categories !== "object" || categories === null || Array.isArray(categories))
    return null;
  const entries = Object.entries(categories);
  if (!entries.every(([name, on]) => CONSENT_CATEGORY_NAME.test(name) && typeof on === "boolean"))
    return null;
  return {
    categories: Object.fromEntries(entries) as Record<string, boolean>,
    gpc,
    decidedAt: new Date(at).toISOString(),
    policyVersion: policy,
  };
}

/**
 * A cookie store over `document.cookie`, for a page with no server of its own. It percent-encodes
 * the value it writes and decodes the one it reads; a pair it cannot decode reads as missing.
 */
export function documentCookieStore(
  doc: { cookie: string } = document as { cookie: string },
): ConsentCookieStore {
  return {
    get(name) {
      const prefix = `${name}=`;
      const pair = doc.cookie.split("; ").find((entry) => entry.startsWith(prefix));
      if (pair === undefined) return undefined;
      try {
        return decodeURIComponent(pair.slice(prefix.length));
      } catch {
        return undefined;
      }
    },
    set(name, value, options) {
      doc.cookie = [
        `${name}=${encodeURIComponent(value)}`,
        `Path=${options.path}`,
        `Max-Age=${options.maxAge}`,
        "SameSite=Lax",
        ...(options.secure ? ["Secure"] : []),
      ].join("; ");
    },
  };
}

export interface CookieConsentAdapterOptions {
  /** Where the cookie is read and written; `document.cookie` when omitted. */
  readonly store?: ConsentCookieStore;
  /** The cookie name; `CONSENT_DECISION_COOKIE` when omitted. */
  readonly name?: string;
  /** Seconds the decision is remembered; 12 months when omitted. */
  readonly maxAge?: number;
  /** Marks the cookie Secure; true on an https page when omitted. */
  readonly secure?: boolean;
}

/**
 * The reference `ConsentAdapter` with no database: the decision, its timestamp, the policy version
 * and the Global Privacy Control flag live in one first-party cookie. The cookie is strictly
 * necessary, since it only remembers the choice. `read` and `write` never throw: storage that
 * cannot be reached (a sandboxed frame, a blocked cookie jar) and a category name outside
 * `CONSENT_CATEGORY_NAME` reject. On a server with no `store`, `read` resolves null, since there
 * is no browser to ask, and `write` rejects.
 */
export function cookieConsentAdapter(options: CookieConsentAdapterOptions = {}): ConsentAdapter {
  const name = options.name ?? CONSENT_DECISION_COOKIE;
  const maxAge = options.maxAge ?? CONSENT_DECISION_MAX_AGE;
  const store = (): ConsentCookieStore | null =>
    options.store ?? (typeof document === "undefined" ? null : documentCookieStore());
  const secure = (): boolean =>
    options.secure ?? (typeof location !== "undefined" && location.protocol === "https:");
  return {
    // Async, so a store that throws becomes a rejection the caller can handle.
    async read() {
      return parseConsentDecision(store()?.get(name));
    },
    async write(decision) {
      const cookies = store();
      if (cookies === null)
        throw new Error("cookieConsentAdapter has no cookie store here: pass `store` on a server.");
      cookies.set(name, serializeConsentDecision(decision), {
        path: "/",
        sameSite: "lax",
        secure: secure(),
        maxAge,
      });
    },
  };
}
