import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPlanRegistry } from "@xos/schemas/plans";
import {
  billingPlanPath,
  newOrganizationPath,
  organizationStepPath,
  planIntent,
  planIntentEntry,
  planIntentLanding,
} from "@/lib/auth/plan-intent";
import { safeNext, signInErrorPath, siteUrl } from "@/lib/auth/redirect";
import { PLANS } from "@/lib/plans.generated";

/**
 * The plan intent (issue 115, docs/sign-up-links.md): /auth/sign-up?plan=<code> names a self-serve plan, the code rides
 * in `next` through every way of signing in, and the new Owner lands on Billing and Plan with that plan marked. It is a
 * display hint: an unknown, free, quoted or malformed value changes nothing, and no path from it reaches a billing action.
 */

const SELF_SERVE = PLANS.filter((plan) => plan.selfServe).map((plan) => plan.code);

/** Values a visitor can put in the address that must change nothing. */
const DROPPED: readonly unknown[] = [
  "access",
  "enterprise",
  "aurora_requests_1000",
  "founding_customer",
  "Core",
  "CORE",
  " core",
  "core ",
  "core,pro",
  "core&review=core",
  "core#x",
  "<script>alert(1)</script>",
  "//evil.example",
  "../settings/danger-zone",
  "",
  ["core", "pro"],
  ["core"],
  undefined,
  null,
  5,
  { code: "core" },
];

class Redirected extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

const session = vi.hoisted(() => ({
  viewer: null as unknown,
  orgs: [] as unknown[],
  lastOrg: undefined as string | undefined,
  user: { id: "person-1" } as unknown,
}));
const data = vi.hoisted(() => ({
  createOrganization: vi.fn(),
  subscribeExternalAccount: vi.fn(),
  recordLegalAcceptances: vi.fn(async () => ({ ok: true, data: null })),
  setSetting: vi.fn(async () => ({ ok: true, data: null })),
}));
const billing = vi.hoisted(() => ({
  startCheckoutAction: vi.fn(),
  startPlanCheckout: vi.fn(),
  createStripeClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirected(url);
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "xos-last-org" && session.lastOrg !== undefined
        ? { name, value: session.lastOrg }
        : undefined,
  }),
  headers: async () => new Headers({ host: "atlas.test" }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string, values?: Record<string, unknown>) =>
    values === undefined ? key : `${key}(${Object.values(values).join(",")})`,
}));
vi.mock("@/lib/shell/last-org", () => ({ LAST_ORG_COOKIE: "xos-last-org" }));
vi.mock("@/lib/shell/context", () => ({
  getViewer: async () => session.viewer,
  getMyOrganizations: async () => session.orgs,
}));
vi.mock("@/lib/shell/active-workspace", () => ({
  getOrgWorkspaces: async () => ({ active: null }),
}));
vi.mock("@/lib/shell/org-settings", () => ({
  getShellSettings: async () => ({ startPage: "home" }),
  startPath: (slug: string, page: string) => `/${slug}/${page}`,
}));
vi.mock("@/components/public-home", () => ({ PublicHome: () => null }));
vi.mock("@/components/auth/forms", () => ({ SignUpForm: () => null, SignInForm: () => null }));
vi.mock("@/components/auth/providers", () => ({ ProviderButtons: () => null }));
vi.mock("@/components/auth/security/passkey-sign-in", () => ({
  PasskeySignInButton: () => null,
}));
vi.mock("@/components/privacy/legal-links", () => ({ LegalLinks: () => null }));
vi.mock("@/components/auth/organization-form", () => ({ OrganizationForm: () => null }));
vi.mock("@/components/auth/subscribe-account", () => ({ SubscribeAccounts: () => null }));
vi.mock("@/lib/auth/territory", () => ({
  offeredTerritoriesPhrase: async () => "the United States",
  signupCountryOptions: async () => [{ value: "US", label: "United States" }],
  notOfferedValues: async () => ({}),
}));
vi.mock("@/lib/auth/legal", () => ({
  ownerSignupDocuments: () => [
    { slug: "terms-of-service", title: "Terms of Service" },
    { slug: "data-processing-agreement", title: "Data Processing Agreement" },
  ],
  signupAcceptances: () => [],
  clientIp: () => null,
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => ({
    auth: { getUser: async () => ({ data: { user: session.user } }) },
  }),
}));
vi.mock("@xos/data", () => ({
  acceptInvite: vi.fn(),
  createOrganization: data.createOrganization,
  getCurrentPerson: vi.fn(),
  isOrgSlug: (value: string) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value),
  listMyOrganizations: vi.fn(),
}));
vi.mock("@xos/data/consent", () => ({
  AGE_OLD_ENOUGH: "yes",
  AGE_UNDER: "under",
  ageMetadata: () => ({}),
  confirmMinimumAge: vi.fn(),
  minimumAgeConfirmed: async () => ({ ok: true, data: true }),
  owesAgeAnswer: async () => false,
  recordAgeRefusal: vi.fn(),
}));
vi.mock("@xos/data/identity", () => ({
  listSubscribableAccounts: async () => ({ ok: true, data: [] }),
  subscribeExternalAccount: data.subscribeExternalAccount,
}));
vi.mock("@xos/data/settings", () => ({
  recordLegalAcceptances: data.recordLegalAcceptances,
  setSetting: data.setSetting,
}));
vi.mock("@xos/data/account-deletion", () => ({ refuseMinimumAge: vi.fn() }));
vi.mock("@xos/data/profiles", () => ({ acceptInviteLink: vi.fn() }));
vi.mock("@/lib/billing/actions", () => ({ startCheckoutAction: billing.startCheckoutAction }));
vi.mock("@xos/platform/billing", () => ({
  startPlanCheckout: billing.startPlanCheckout,
  createStripeClient: billing.createStripeClient,
}));

const { default: SignUpPage } = await import("@/app/auth/sign-up/page");
const { default: SignInPage } = await import("@/app/auth/sign-in/page");
const { default: OrganizationPage } = await import("@/app/auth/organization/page");
const { default: EntryPage } = await import("@/app/page");
const { createOrganizationAction } = await import("@/app/auth/actions");
const { subscribeAccountAction } = await import("@/app/auth/subscribe-actions");
const { SignUpForm, SignInForm } = await import("@/components/auth/forms");
const { ProviderButtons } = await import("@/components/auth/providers");
const { OrganizationForm } = await import("@/components/auth/organization-form");
const { SubscribeAccounts } = await import("@/components/auth/subscribe-account");

type Node = { type: unknown; props: Record<string, unknown> };

/** Every element of a rendered tree, without running the components in it. */
function elements(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Node;
  return [element, ...elements(element.props["children"])];
}

const ofType = (tree: unknown, type: unknown) => elements(tree).filter((e) => e.type === type);
/** Every string and prop value in a tree, to prove a visitor's value was written nowhere. */
function written(tree: unknown): string {
  const plain = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(plain)
      : value === null || ["string", "number", "boolean"].includes(typeof value)
        ? value
        : undefined;
  return JSON.stringify(
    elements(tree).map((e) => [
      typeof e.type === "string" ? e.type : (e.type as { name?: string }).name,
      Object.fromEntries(Object.entries(e.props).map(([name, value]) => [name, plain(value)])),
    ]),
  );
}

const search = (query: Record<string, unknown>) =>
  ({ searchParams: Promise.resolve(query) }) as never;

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Redirected) return error.url;
    throw error;
  }
  throw new Error("Expected a redirect.");
}

function form(values: Record<string, string>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(values)) body.set(key, value);
  return body;
}

const org = (slug: string, ...roles: string[]) => ({
  id: `id-${slug}`,
  slug,
  name: slug,
  roles: roles.map((code) => ({ code })),
});

const NEW_ORG = { orgName: "Northwind Live", orgSlug: "northwind-live", orgCountry: "US" };

beforeEach(() => {
  session.viewer = { db: {}, person: { id: "person-1" } };
  session.orgs = [];
  session.lastOrg = undefined;
  session.user = { id: "person-1" };
  data.createOrganization.mockReset();
  data.createOrganization.mockResolvedValue({ ok: true, data: { orgId: "org-1" } });
  data.subscribeExternalAccount.mockReset();
  data.subscribeExternalAccount.mockResolvedValue({ ok: true, data: { orgId: "org-1" } });
  billing.startCheckoutAction.mockReset();
  billing.startPlanCheckout.mockReset();
  billing.createStripeClient.mockReset();
});

describe("the plan allowlist", () => {
  it("accepts exactly the plans plans.yaml sells by self-serve Checkout", () => {
    const registry = loadPlanRegistry();
    const sold = registry.plans.filter((plan) => plan.stripe !== null).map((plan) => plan.code);
    expect(SELF_SERVE).toEqual(sold);
    expect(SELF_SERVE).toEqual(["core", "pro", "team"]);
    for (const code of SELF_SERVE) expect(planIntent(code)).toBe(code);
  });

  it("drops the free plan, the quoted plan, add-ons, offers and anything malformed", () => {
    for (const value of DROPPED) expect(planIntent(value)).toBeNull();
  });

  it("builds addresses from the registry's code only", () => {
    expect(planIntentEntry("core")).toBe("/?plan=core");
    expect(organizationStepPath("pro")).toBe("/auth/organization?plan=pro");
    expect(organizationStepPath(null)).toBe("/auth/organization");
    expect(billingPlanPath("northwind-live", "team")).toBe(
      "/northwind-live/settings/billing-and-plan?plan=team#plan-team",
    );
    expect(newOrganizationPath("northwind-live", "core")).toBe(
      "/northwind-live/settings/billing-and-plan?plan=core#plan-core",
    );
    for (const value of DROPPED) {
      expect(newOrganizationPath("northwind-live", value)).toBe("/northwind-live/home");
    }
  });
});

describe("carrying the intent in next", () => {
  it("passes the redirect validation unchanged", () => {
    for (const code of SELF_SERVE) expect(safeNext(planIntentEntry(code))).toBe(`/?plan=${code}`);
  });

  it("survives a confirmation email opened in another browser", () => {
    // The address in the email is all the other browser has: no cookie and no session of the first one.
    const emailed = siteUrl("https://atlas.test", "/auth/callback", planIntentEntry("pro"));
    expect(emailed).toBe("https://atlas.test/auth/callback?next=%2F%3Fplan%3Dpro");
    const next = safeNext(new URL(emailed).searchParams.get("next"));
    expect(next).toBe("/?plan=pro");
    // The PKCE exchange fails there, so the callback sends the person to sign in, still carrying it.
    const signIn = new URL(signInErrorPath("link_invalid", next), "https://atlas.test");
    const after = safeNext(signIn.searchParams.get("next"));
    expect(planIntent(new URL(after, "https://atlas.test").searchParams.get("plan"))).toBe("pro");
  });

  it("keeps the open-redirect protection for a next that leaves the site", () => {
    for (const bad of ["//evil.example/?plan=core", "https://evil.example/?plan=core"]) {
      expect(safeNext(bad, planIntentEntry("core"))).toBe("/?plan=core");
    }
  });
});

describe("the sign-up and sign-in pages", () => {
  it("send a named plan on through next, on every way of signing up", async () => {
    const tree = await SignUpPage(search({ plan: "core" }));
    expect(ofType(tree, SignUpForm)[0]?.props["next"]).toBe("/?plan=core");
    expect(ofType(tree, ProviderButtons)[0]?.props["next"]).toBe("/?plan=core");
    const note = elements(tree).find((e) => e.props["data-testid"] === "plan-intent");
    expect(note?.props["children"]).toBe("planIntent(core.name)");
    const signIn = elements(tree).find((e) => String(e.props["href"]).startsWith("/auth/sign-in"));
    expect(signIn?.props["href"]).toBe("/auth/sign-in?next=%2F%3Fplan%3Dcore");
  });

  it("change nothing for a value that is not a self-serve plan, and write it nowhere", async () => {
    const plain = written(await SignUpPage(search({})));
    for (const value of DROPPED) {
      const tree = await SignUpPage(search({ plan: value }));
      expect(ofType(tree, SignUpForm)[0]?.props["next"]).toBe("/auth/organization");
      expect(written(tree)).toBe(plain);
    }
    const signInPlain = written(await SignInPage(search({})));
    for (const value of DROPPED) {
      expect(written(await SignInPage(search({ plan: value })))).toBe(signInPlain);
    }
  });

  it("let an invitation's next win over the plan", async () => {
    const tree = await SignUpPage(search({ plan: "core", next: "/auth/invite/abc" }));
    expect(ofType(tree, SignUpForm)[0]?.props["next"]).toBe("/auth/invite/abc");
    expect(elements(tree).some((e) => e.props["data-testid"] === "plan-intent")).toBe(false);
  });

  it("carry the plan for a person who signs in to an account they already have", async () => {
    const tree = await SignInPage(search({ plan: "team" }));
    expect(ofType(tree, SignInForm)[0]?.props["next"]).toBe("/?plan=team");
    expect(ofType(tree, ProviderButtons)[0]?.props["next"]).toBe("/?plan=team");
    const kept = await SignInPage(search({ plan: "team", next: "/acme/home" }));
    expect(ofType(kept, SignInForm)[0]?.props["next"]).toBe("/acme/home");
  });
  it("keeps the plan visible when a person without an account goes from sign-in to sign-up", async () => {
    const signUpLink = (tree: unknown) =>
      elements(tree).find((e) => String(e.props["href"]).startsWith("/auth/sign-up"))?.props[
        "href"
      ];
    const shown = async (href: unknown) => {
      const url = new URL(String(href), "https://atlas.test");
      const tree = await SignUpPage(search(Object.fromEntries(url.searchParams)));
      expect(ofType(tree, SignUpForm)[0]?.props["next"]).toBe("/?plan=pro");
      return elements(tree).find((e) => e.props["data-testid"] === "plan-intent")?.props[
        "children"
      ];
    };
    // The documented address, and the address the sign-up page's own "Sign in" link writes.
    for (const query of [{ plan: "pro" }, { next: "/?plan=pro" }]) {
      const href = signUpLink(await SignInPage(search(query)));
      expect(href).toBe("/auth/sign-up?plan=pro");
      expect(await shown(href)).toBe("planIntent(pro.name)");
    }
    // A sign-up address that carries the plan only in next shows it too.
    expect(await shown("/auth/sign-up?next=%2F%3Fplan%3Dpro")).toBe("planIntent(pro.name)");
    // Any other next is passed on as before, and a plan it does not sell by Checkout is not named.
    expect(signUpLink(await SignInPage(search({ plan: "pro", next: "/acme/home" })))).toBe(
      "/auth/sign-up?next=%2Facme%2Fhome",
    );
    expect(signUpLink(await SignInPage(search({})))).toBe("/auth/sign-up");
    for (const next of ["/?plan=enterprise", "/?plan=Pro", "/?plan=pro&x=1", "/acme?plan=pro"]) {
      expect(signUpLink(await SignInPage(search({ next })))).toBe(
        `/auth/sign-up?next=${encodeURIComponent(next)}`,
      );
      const tree = await SignUpPage(search({ next }));
      expect(elements(tree).some((e) => e.props["data-testid"] === "plan-intent")).toBe(false);
    }
  });
});

describe("the entry page", () => {
  const enter = (query: Record<string, unknown>) => redirectOf(() => EntryPage(search(query)));

  it("takes a person with no organization to the organization step with the plan", async () => {
    expect(await enter({ plan: "core" })).toBe("/auth/organization?plan=core");
    expect(await enter({ plan: "enterprise" })).toBe("/auth/organization");
    expect(await enter({})).toBe("/auth/organization");
  });

  it("opens Billing and Plan for an Owner, on the org they would open anyway", async () => {
    session.orgs = [org("alpha", "owner"), org("beta", "owner")];
    expect(await enter({ plan: "pro" })).toBe("/alpha/settings/billing-and-plan?plan=pro#plan-pro");
    session.lastOrg = "beta";
    expect(await enter({ plan: "pro" })).toBe("/beta/settings/billing-and-plan?plan=pro#plan-pro");
  });

  it("never applies the intent for a person who owns no organization", async () => {
    session.orgs = [org("alpha", "admin"), org("beta", "member")];
    expect(await enter({ plan: "pro" })).toBe("/alpha/home");
    expect(planIntentLanding(session.orgs as never, "alpha", "pro")).toBeNull();
  });

  it("uses the first organization the person owns when the one they used last is not theirs", async () => {
    session.orgs = [org("alpha", "member"), org("beta", "admin", "owner")];
    session.lastOrg = "alpha";
    expect(await enter({ plan: "team" })).toBe(
      "/beta/settings/billing-and-plan?plan=team#plan-team",
    );
  });

  it("goes to the start page as before for a value that is not a self-serve plan", async () => {
    session.orgs = [org("alpha", "owner")];
    for (const value of DROPPED) expect(await enter({ plan: value })).toBe("/alpha/home");
  });

  it("shows a signed-out visitor the public homepage, with nothing of the value in it", async () => {
    session.viewer = null;
    const tree = await EntryPage(search({ plan: "core" }));
    expect(written(tree)).toBe(written(await EntryPage(search({}))));
  });
});

describe("the organization step", () => {
  it("puts a named plan in both forms, and only a checked one", async () => {
    const tree = await OrganizationPage(search({ plan: "pro" }));
    expect(ofType(tree, OrganizationForm)[0]?.props["plan"]).toBe("pro");
    expect(ofType(tree, SubscribeAccounts)[0]?.props["plan"]).toBe("pro");
    const plain = written(await OrganizationPage(search({})));
    for (const value of DROPPED) {
      const dropped = await OrganizationPage(search({ plan: value }));
      expect(ofType(dropped, OrganizationForm)[0]?.props["plan"]).toBeNull();
      expect(written(dropped)).toBe(plain);
    }
  });

  it("keeps the plan when the session is gone", async () => {
    session.viewer = null;
    expect(await redirectOf(() => OrganizationPage(search({ plan: "core" })))).toBe(
      "/auth/sign-in?next=%2Fauth%2Forganization%3Fplan%3Dcore",
    );
    expect(await redirectOf(() => OrganizationPage(search({ plan: "access" })))).toBe(
      "/auth/sign-in?next=%2Fauth%2Forganization",
    );
  });

  it("lands the new Owner on Billing and Plan with the plan marked", async () => {
    const to = await redirectOf(() =>
      createOrganizationAction({}, form({ ...NEW_ORG, accept: "on", plan: "core" })),
    );
    expect(to).toBe("/northwind-live/settings/billing-and-plan?plan=core#plan-core");
    const subscribed = await redirectOf(() =>
      subscribeAccountAction(
        {},
        form({
          accountId: "4f1c2e7a-0000-4000-8000-000000000115",
          slug: "northwind-live",
          country: "US",
          accept: "on",
          plan: "team",
        }),
      ),
    );
    expect(subscribed).toBe("/northwind-live/settings/billing-and-plan?plan=team#plan-team");
  });

  it("creates the same organization with or without a plan, and starts no checkout", async () => {
    const values: unknown[] = [undefined, "core", "pro", "team", "enterprise", "access", "Core"];
    for (const value of values) {
      const fields = {
        ...NEW_ORG,
        accept: "on",
        ...(typeof value === "string" ? { plan: value } : {}),
      };
      await redirectOf(() => createOrganizationAction({}, form(fields)));
    }
    expect(data.createOrganization).toHaveBeenCalledTimes(values.length);
    for (const call of data.createOrganization.mock.calls) {
      expect(call[1]).toEqual({
        name: "Northwind Live",
        slug: "northwind-live",
        countryCode: "US",
      });
    }
    expect(billing.startCheckoutAction).not.toHaveBeenCalled();
    expect(billing.startPlanCheckout).not.toHaveBeenCalled();
    expect(billing.createStripeClient).not.toHaveBeenCalled();
  });

  it("goes Home as before for a value that is not a self-serve plan", async () => {
    for (const value of ["enterprise", "access", "Core", "core&x", ""]) {
      const to = await redirectOf(() =>
        createOrganizationAction({}, form({ ...NEW_ORG, accept: "on", plan: value })),
      );
      expect(to).toBe("/northwind-live/home");
    }
  });
});

describe("what the intent can reach", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("imports no billing action, Stripe client or database write", () => {
    const intent = source("../lib/auth/plan-intent.ts");
    expect([...intent.matchAll(/from "([^"]+)"/g)].map((m) => m[1])).toEqual([
      "@/lib/plans.generated",
    ]);
    for (const file of [
      "../app/auth/actions.ts",
      "../app/auth/subscribe-actions.ts",
      "../app/auth/sign-up/page.tsx",
      "../app/auth/sign-in/page.tsx",
      "../app/auth/organization/page.tsx",
      "../app/page.tsx",
    ]) {
      expect(source(file)).not.toMatch(/billing\/actions|platform\/billing|startCheckout|stripe/i);
    }
  });

  it("sets no cookie and writes no log", () => {
    const intent = source("../lib/auth/plan-intent.ts");
    expect(intent).not.toMatch(/cookies\(|console\.|localStorage|sessionStorage/);
  });
});
