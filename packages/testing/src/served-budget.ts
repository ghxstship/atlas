import { webBudgets } from "./budgets.ts";
import { keyPages, type BudgetApp } from "./bundle-budget.ts";
import { lighthouseTargets } from "./lighthouse.ts";

/**
 * Route JavaScript as Lighthouse counts it, from a running server (Section 18, gate 10): every
 * script a cold load of the page fetches until the network goes quiet, at its transfer size. That
 * takes in what the build manifests cannot show (bundle-budget.ts): the modules a page fetches
 * after hydration without anyone clicking, such as the shell's key handler or a quick-add form a
 * page renders open. CI runs it in the journeys job, which serves the production builds on the
 * demo stack, so a page that would fail the nightly Lighthouse run fails on its pull request.
 */

/** The Chrome DevTools Protocol network events the measure reads. */
export type NetworkEvent =
  | { readonly kind: "request"; readonly id: string; readonly type: string; readonly url: string }
  | { readonly kind: "finished"; readonly id: string; readonly encodedDataLength: number };

export interface ScriptRequest {
  readonly url: string;
  readonly transferBytes: number;
}

/**
 * The scripts among a page's requests, at their transfer size: Lighthouse's `transferSize`, which
 * is the protocol's `encodedDataLength` (headers, framing and the compressed body).
 */
export function scriptRequests(events: readonly NetworkEvent[]): ScriptRequest[] {
  const scripts = new Map<string, string>();
  const out: ScriptRequest[] = [];
  for (const event of events) {
    if (event.kind === "request") {
      if (event.type === "Script") scripts.set(event.id, event.url);
      continue;
    }
    const url = scripts.get(event.id);
    if (url !== undefined) out.push({ url, transferBytes: event.encodedDataLength });
  }
  return out;
}

/** An app the served measure visits: its base URL and the person its signed-in pages need. */
export interface ServedTarget {
  readonly app: BudgetApp;
  readonly baseUrl: string;
  readonly email: string | null;
  readonly paths: readonly string[];
}

/** The key pages of the apps Lighthouse visits, with their default base URLs. */
export function servedTargets(
  apps: readonly ("atlas" | "gateway" | "docs")[],
  baseUrls: Readonly<Partial<Record<string, string>>> = {},
): ServedTarget[] {
  const pages = keyPages();
  return apps.map((app) => ({
    app,
    baseUrl: baseUrls[app] ?? lighthouseTargets[app].baseUrl,
    email: lighthouseTargets[app].email,
    paths: pages[app],
  }));
}

export interface ServedRow {
  readonly app: BudgetApp;
  readonly path: string;
  readonly scripts: readonly ScriptRequest[];
  readonly transferBytes: number;
  readonly budgetBytes: number;
  readonly pass: boolean;
}

/** One page's verdict against the route JavaScript budget, or the ceiling recorded for it. */
export function servedRow(
  app: BudgetApp,
  path: string,
  scripts: readonly ScriptRequest[],
  ceilings: Readonly<Record<string, number>> = {},
): ServedRow {
  const transferBytes = scripts.reduce((sum, s) => sum + s.transferBytes, 0);
  const budgetBytes = Math.max(webBudgets.routeJavaScriptGzipBytes, ceilings[`${app}${path}`] ?? 0);
  return { app, path, scripts, transferBytes, budgetBytes, pass: transferBytes <= budgetBytes };
}
