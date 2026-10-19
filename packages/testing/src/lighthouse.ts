import { lighthouseAssertions, webBudgets } from "./budgets.ts";

/**
 * Lighthouse CI for the key Atlas, Gateway and docs pages (Section 18, gate 10). The CLI builds a
 * signed-in session cookie per app, writes one lighthouserc per app and runs `lhci autorun`.
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

/**
 * The Cookie header @supabase/ssr reads for a session: `base64-` plus base64url JSON, chunked the
 * way the library writes it.
 */
export function sessionCookieHeader(name: string, session: AuthSession): string {
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  if (value.length <= SSR_CHUNK_SIZE) return `${name}=${value}`;
  const parts: string[] = [];
  for (let i = 0; i * SSR_CHUNK_SIZE < value.length; i += 1) {
    parts.push(`${name}.${i}=${value.slice(i * SSR_CHUNK_SIZE, (i + 1) * SSR_CHUNK_SIZE)}`);
  }
  return parts.join("; ");
}

export interface LighthouseRcInput {
  readonly app: LighthouseApp;
  readonly baseUrl: string;
  readonly cookie: string | null;
  readonly chromePath: string | undefined;
  readonly outputDir: string;
  readonly runs?: number;
}

/** One app's lighthouserc: desktop preset, the spec budgets as assertions, local reports only. */
export function lighthouseRc(input: LighthouseRcInput) {
  const target = lighthouseTargets[input.app];
  return {
    ci: {
      collect: {
        url: target.paths.map((path) => `${input.baseUrl}${path}`),
        numberOfRuns: input.runs ?? 1,
        ...(input.chromePath ? { chromePath: input.chromePath } : {}),
        settings: {
          preset: "desktop",
          ...(input.cookie ? { extraHeaders: JSON.stringify({ Cookie: input.cookie }) } : {}),
          chromeFlags: "--headless=new --no-sandbox",
        },
      },
      assert: { assertions: lighthouseAssertions() },
      upload: { target: "filesystem", outputDir: input.outputDir },
    },
  };
}

export interface PageScore {
  readonly url: string;
  readonly performance: number | null;
  readonly accessibility: number | null;
  readonly lcpMs: number | null;
  readonly cls: number | null;
  readonly tbtMs: number | null;
  readonly scriptBytes: number | null;
  readonly withinBudget: boolean;
}

interface LighthouseResult {
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

/** Scores and budget verdict for one Lighthouse JSON report. */
export function scorePage(result: LighthouseResult): PageScore {
  const scripts = result.audits?.["resource-summary"]?.details?.items?.find(
    (item) => item.resourceType === "script",
  );
  const score = (name: string) => result.categories?.[name]?.score ?? null;
  const page = {
    url: result.requestedUrl ?? result.finalDisplayedUrl ?? "",
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
      within(page.lcpMs, webBudgets.largestContentfulPaintMs) &&
      within(page.cls, webBudgets.cumulativeLayoutShift) &&
      within(page.tbtMs, webBudgets.interactionToNextPaintMs) &&
      within(page.scriptBytes, webBudgets.routeJavaScriptGzipBytes),
  };
}
