import { findRoute, getNode, guardRoute, matchRoute, type NavContext, type Sitemap } from "@xos/ia";

/**
 * The proxy route guard (ADR 0006, Section 4.5.9), as a pure decision so it is tested for every
 * role. A route the viewer may not see is 404, never 403: hidden and missing pages look the same.
 */
export type GuardDecision =
  | { readonly kind: "pass" }
  | { readonly kind: "redirect"; readonly to: string }
  | { readonly kind: "not-found" };

export interface GuardInput {
  readonly path: string;
  readonly search: string;
  readonly signedIn: boolean;
  /** The viewer's navigation context in an org, or null when they are not a member of it. */
  readonly navFor: (slug: string) => Promise<NavContext | null>;
}

export const SIGN_IN_PATH = "/auth/sign-in";

/** Paths the shell serves outside the sitemap: the entry redirect and the auth flows. */
function isShellPath(path: string): boolean {
  return path === "/" || path === "/auth" || path.startsWith("/auth/");
}

export function signInRedirect(path: string, search: string): string {
  return `${SIGN_IN_PATH}?next=${encodeURIComponent(`${path}${search}`)}`;
}

export async function decideRoute(sitemap: Sitemap, input: GuardInput): Promise<GuardDecision> {
  const { path, search, signedIn } = input;
  if (isShellPath(path)) return { kind: "pass" };

  // `/{org}` alone opens the org's Home.
  const orgRoot = matchRoute("/{org}", path, sitemap.params);
  if (orgRoot) {
    const home = `/${orgRoot["org"]}/home`;
    return signedIn
      ? { kind: "redirect", to: home }
      : { kind: "redirect", to: signInRedirect(home, "") };
  }

  const match = findRoute(sitemap, path);
  if (!match) return { kind: "pass" };
  const auth = getNode(sitemap, match.id).node.auth ?? "session";
  if (auth !== "session") return { kind: "pass" };
  if (!signedIn) return { kind: "redirect", to: signInRedirect(path, search) };

  const slug = match.params["org"] ?? match.params["partnerSlug"];
  const nav = slug === undefined ? null : await input.navFor(slug);
  if (!nav) return { kind: "not-found" };
  return guardRoute(sitemap, path, nav).status === 200 ? { kind: "pass" } : { kind: "not-found" };
}
