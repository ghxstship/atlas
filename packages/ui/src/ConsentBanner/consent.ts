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

const CATEGORY = /^[a-z][a-zA-Z0-9-]{0,31}$/;

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

/** The two cookie operations the reference adapter needs; a browser or a server response fits. */
export interface ConsentCookieStore {
  get(name: string): string | undefined;
  set(name: string, value: string, options: ConsentCookieOptions): void;
}

/** The cookie value for a decision: versioned JSON, percent-encoded. */
export function serializeConsentDecision(decision: ConsentDecision): string {
  return encodeURIComponent(
    JSON.stringify({
      v: 1,
      at: decision.decidedAt,
      policy: decision.policyVersion,
      gpc: decision.gpc,
      categories: decision.categories,
    }),
  );
}

/** The decision a cookie value holds, or null when it is missing or not one this version wrote. */
export function parseConsentDecision(value: string | undefined | null): ConsentDecision | null {
  if (!value) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(decodeURIComponent(value));
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
  if (!entries.every(([name, on]) => CATEGORY.test(name) && typeof on === "boolean")) return null;
  return {
    categories: Object.fromEntries(entries) as Record<string, boolean>,
    gpc,
    decidedAt: new Date(at).toISOString(),
    policyVersion: policy,
  };
}

/** A cookie store over `document.cookie`, for a page with no server of its own. */
export function documentCookieStore(
  doc: { cookie: string } = document as { cookie: string },
): ConsentCookieStore {
  return {
    get(name) {
      const prefix = `${name}=`;
      const pair = doc.cookie.split("; ").find((entry) => entry.startsWith(prefix));
      return pair === undefined ? undefined : pair.slice(prefix.length);
    },
    set(name, value, options) {
      doc.cookie = [
        `${name}=${value}`,
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
 * necessary, since it only remembers the choice.
 */
export function cookieConsentAdapter(options: CookieConsentAdapterOptions = {}): ConsentAdapter {
  const name = options.name ?? CONSENT_DECISION_COOKIE;
  const maxAge = options.maxAge ?? CONSENT_DECISION_MAX_AGE;
  const store = (): ConsentCookieStore => options.store ?? documentCookieStore();
  const secure = (): boolean =>
    options.secure ?? (typeof location !== "undefined" && location.protocol === "https:");
  return {
    read() {
      return Promise.resolve(parseConsentDecision(store().get(name)));
    },
    write(decision) {
      store().set(name, serializeConsentDecision(decision), {
        path: "/",
        sameSite: "lax",
        secure: secure(),
        maxAge,
      });
      return Promise.resolve();
    },
  };
}
