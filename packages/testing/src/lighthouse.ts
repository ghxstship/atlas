import { lighthouseAssertions, webBudgets } from "./budgets.ts";

/**
 * Lighthouse CI for Atlas, Gateway and docs (Section 18, gate 10): every signed-in route in the
 * generated sitemaps (lighthouse-routes.ts) and the public key pages, each against the spec
 * budgets. The CLI signs in each demo person, writes one lighthouserc per person and runs
 * `lhci autorun`.
 */

export type LighthouseApp = "atlas" | "gateway" | "docs";

export interface AppTarget {
  readonly baseUrl: string;
  /** Demo account the signed-in pages use; null for apps that only serve public pages. */
  readonly email: string | null;
  readonly paths: readonly string[];
}

/** Key pages: the first screens each persona sees, the busiest lists and one record page each. */
export const lighthouseTargets: Record<LighthouseApp, AppTarget> = {
  atlas: {
    baseUrl: "http://127.0.0.1:3006",
    email: "owner@example.com",
    paths: [
      "/auth/sign-in",
      "/demo-productions/home",
      "/demo-productions/projects",
      "/demo-productions/p/NWS/overview",
      "/demo-productions/inbox",
      "/demo-productions/crew/shifts",
      "/demo-productions/finance/budgets",
    ],
  },
  gateway: {
    baseUrl: "http://127.0.0.1:3127",
    email: "crew@example.com",
    paths: ["/auth/sign-in", "/home", "/explore", "/work", "/money"],
  },
  docs: {
    baseUrl: "http://127.0.0.1:3014",
    email: null,
    paths: [
      "/en-US",
      "/en-US/reference",
      "/en-US/reference/projects",
      "/en-US/reference/projects/list",
      "/en-US/guides/getting-started",
      "/en-US/guides/self-hosting",
      "/en-US/help",
    ],
  },
};

/** Supabase password-grant session, as Auth returns it. */
export interface AuthSession {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly [key: string]: unknown;
}

/** @supabase/ssr splits cookie values longer than this into name.0, name.1 and so on. */
export const SSR_CHUNK_SIZE = 3180;

export interface SessionCookie {
  readonly name: string;
  readonly value: string;
}

/**
 * The cookies @supabase/ssr reads for a session: `base64-` plus base64url JSON, chunked the way the
 * library writes it.
 */
export function sessionCookies(name: string, session: AuthSession): SessionCookie[] {
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  if (value.length <= SSR_CHUNK_SIZE) return [{ name, value }];
  const parts: SessionCookie[] = [];
  for (let i = 0; i * SSR_CHUNK_SIZE < value.length; i += 1) {
    parts.push({
      name: `${name}.${i}`,
      value: value.slice(i * SSR_CHUNK_SIZE, (i + 1) * SSR_CHUNK_SIZE),
    });
  }
  return parts;
}

/** Environment variable that hands the session cookies to `lighthouse-session.cjs`. */
export const SESSION_COOKIES_ENV = "XOS_LH_SESSION_COOKIES";

export interface LighthouseRcInput {
  readonly baseUrl: string;
  /** The paths to visit, on `baseUrl`. */
  readonly paths: readonly string[];
  /**
   * For signed-in apps, the path of `lighthouse-session.cjs` relative to the directory lhci runs
   * in. It puts the session in the browser's cookie jar before each page. A session sent as an
   * extra Cookie header lasts only until the page sets a cookie of its own: from then on Chrome
   * sends the jar instead, so server actions, redirects and prefetches ran signed out.
   */
  readonly sessionScript: string | null;
  readonly chromePath: string | undefined;
  readonly outputDir: string;
  readonly runs?: number;
  /** Route JavaScript ceilings by path, for pages still over 200 KB (bundle-ceilings.json). */
  readonly ceilings?: Readonly<Record<string, number>>;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The spec budgets for a run's pages. Every page gets the 200 KB script budget unless it holds a
 * ceiling; pages that share a budget share one `assertMatrix` entry, matched by exact URL.
 */
export function runAssertions(
  baseUrl: string,
  paths: readonly string[],
  ceilings: Readonly<Record<string, number>> = {},
) {
  const groups = new Map<number, string[]>();
  for (const path of paths) {
    const budget = Math.max(webBudgets.routeJavaScriptGzipBytes, ceilings[path] ?? 0);
    groups.set(budget, [...(groups.get(budget) ?? []), `${baseUrl}${path}`]);
  }
  if (groups.size <= 1) return { assertions: lighthouseAssertions([...groups.keys()][0]) };
  return {
    assertMatrix: [...groups].map(([budget, urls]) => ({
      matchingUrlPattern: `^(${urls.map(escapeRegExp).join("|")})$`,
      assertions: lighthouseAssertions(budget),
    })),
  };
}

const CHROME_FLAGS = ["--headless=new", "--no-sandbox"];

/** One run's lighthouserc: desktop preset, the spec budgets as assertions, local reports only. */
export function lighthouseRc(input: LighthouseRcInput) {
  return {
    ci: {
      collect: {
        url: input.paths.map((path) => `${input.baseUrl}${path}`),
        numberOfRuns: input.runs ?? 1,
        ...(input.chromePath ? { chromePath: input.chromePath } : {}),
        // With a session script, lhci launches Chrome through puppeteer (lighthouse's own
        // puppeteer-core), so the Chrome flags go to puppeteer's launch.
        ...(input.sessionScript
          ? {
              puppeteerScript: input.sessionScript,
              puppeteerLaunchOptions: { args: CHROME_FLAGS.slice(1) },
            }
          : {}),
        settings: {
          preset: "desktop",
          ...(input.sessionScript ? {} : { chromeFlags: CHROME_FLAGS.join(" ") }),
        },
      },
      assert: runAssertions(input.baseUrl, input.paths, input.ceilings),
      upload: { target: "filesystem", outputDir: input.outputDir },
    },
  };
}

export interface PageScore {
  readonly url: string;
  /** Where the page ended; lhci asserts a report by this URL, so it must be `url`. */
  readonly finalUrl: string;
  /** The page ended on the URL it asked for, so lhci asserted it. */
  readonly landed: boolean;
  readonly performance: number | null;
  readonly accessibility: number | null;
  readonly lcpMs: number | null;
  readonly cls: number | null;
  readonly tbtMs: number | null;
  readonly scriptBytes: number | null;
  readonly withinBudget: boolean;
}

interface LighthouseResult {
  readonly finalUrl?: string;
  readonly finalDisplayedUrl?: string;
  readonly requestedUrl?: string;
  readonly categories?: Record<string, { score: number | null } | undefined>;
  readonly audits?: Record<
    string,
    | {
        numericValue?: number;
        details?: { items?: { resourceType?: string; transferSize?: number }[] };
      }
    | undefined
  >;
}

function numeric(result: LighthouseResult, audit: string): number | null {
  const value = result.audits?.[audit]?.numericValue;
  return typeof value === "number" ? value : null;
}

/**
 * Scores and budget verdict for one Lighthouse JSON report, against the page's script budget: the
 * same errors lhci asserts (lighthouseAssertions), so the summary fails what the assertions fail.
 */
export function scorePage(
  result: LighthouseResult,
  scriptBudget: number = webBudgets.routeJavaScriptGzipBytes,
): PageScore {
  const scripts = result.audits?.["resource-summary"]?.details?.items?.find(
    (item) => item.resourceType === "script",
  );
  const score = (name: string) => result.categories?.[name]?.score ?? null;
  const url = result.requestedUrl ?? result.finalDisplayedUrl ?? "";
  const finalUrl = result.finalUrl ?? result.finalDisplayedUrl ?? url;
  const page = {
    url,
    finalUrl,
    landed: url !== "" && finalUrl === url,
    performance: score("performance"),
    accessibility: score("accessibility"),
    lcpMs: numeric(result, "largest-contentful-paint"),
    cls: numeric(result, "cumulative-layout-shift"),
    tbtMs: numeric(result, "total-blocking-time"),
    scriptBytes: scripts?.transferSize ?? null,
  };
  const within = (value: number | null, max: number) => value !== null && value < max;
  return {
    ...page,
    withinBudget:
      page.accessibility === 1 &&
      within(page.lcpMs, webBudgets.largestContentfulPaintMs) &&
      within(page.cls, webBudgets.cumulativeLayoutShift) &&
      within(page.tbtMs, webBudgets.interactionToNextPaintMs) &&
      page.scriptBytes !== null &&
      page.scriptBytes <= scriptBudget,
  };
}
