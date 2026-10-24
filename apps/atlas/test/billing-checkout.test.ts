import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as PlatformBilling from "@xos/platform/billing";
import type * as DataBilling from "@xos/data/billing";
import type * as DataLifecycle from "@xos/data/org-lifecycle";
import type { OrgContext } from "@/lib/shell/context";

/**
 * ADR 0033 decision 59: XOS launches on the trial and the Access plan, and billing opens when the owner
 * sets STRIPE_SECRET_KEY. Without the key, Billing and Plan says billing is not open yet, its Choose buttons
 * and the trial notice's Add a card stay disabled, and both server actions answer billing_not_open without
 * reaching Stripe. With the key, each failure of the Checkout and portal flow comes back as its refusal, and a
 * paid checkout whose subscription has not synced yet offers no second Checkout.
 */
const config = vi.hoisted(() => ({ key: undefined as string | undefined }));
const platform = vi.hoisted(() => ({
  createStripeClient: vi.fn(async () => ({})),
  startPlanCheckout: vi.fn(),
  openBillingPortal: vi.fn(),
}));
const ctx = vi.hoisted(
  () =>
    ({
      org: { id: "org-1", slug: "northwind-live", name: "Northwind Live" },
      viewer: { db: {}, email: "owner@northwind.test" },
    }) as unknown as OrgContext,
);
const data = vi.hoisted(() => ({
  account: null as unknown,
  getBillingAccount: vi.fn(),
  banner: null as unknown,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  env: () => ({
    ATLAS_SITE_URL: "https://atlas.test",
    STRIPE_SECRET_KEY: config.key,
    STRIPE_API_URL: undefined,
  }),
}));
vi.mock("@xos/platform/billing", async (importOriginal) => ({
  ...(await importOriginal<typeof PlatformBilling>()),
  createStripeClient: platform.createStripeClient,
  startPlanCheckout: platform.startPlanCheckout,
  openBillingPortal: platform.openBillingPortal,
}));
vi.mock("@xos/data/billing", async (importOriginal) => ({
  ...(await importOriginal<typeof DataBilling>()),
  getBillingAccount: data.getBillingAccount,
}));
vi.mock("@xos/data/org-lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof DataLifecycle>()),
  getOrgBannerStatus: async () => ({ ok: true, data: data.banner }),
}));
vi.mock("@xos/data", () => ({
  getSubscription: async () => ({
    ok: true,
    data: { planCode: "pro", state: "trialing", trialEndsAt: "2026-11-05T05:00:00Z" },
  }),
  getSeatUsage: async () => ({
    ok: true,
    data: {
      used: 2,
      limit: 10,
      planSeats: 10,
      extraSeats: 0,
      sellsExtraSeats: true,
      grandfathered: false,
    },
  }),
}));

/** Catalog keys come back as written, with their values in brackets, so each label names its plan. */
function keys(key: string, values?: Record<string, unknown>): string {
  return values === undefined ? key : `${key}(${Object.values(values).join(",")})`;
}
vi.mock("next-intl/server", () => ({
  getTranslations: async () => Object.assign(keys, { has: () => true }),
  getFormatter: async () => ({ number: String, dateTime: () => "Nov 5, 2026" }),
}));
vi.mock("@/lib/shell/translate", () => ({ getTranslate: async () => keys }));
vi.mock("@/lib/platform/format", () => ({ getFormatters: async () => ({ date: String }) }));
vi.mock("@/lib/shell/time-zone", () => ({ getOrgTimeZone: async () => "UTC" }));
vi.mock("@/lib/shell/require-node", () => ({ requireNode: async () => ctx }));
vi.mock("@/lib/platform/action-context", () => ({ contextFor: async () => ctx }));
vi.mock("@/components/settings/section-header", () => ({ SectionHeader: () => null }));
vi.mock("@/components/settings/billing-forms", () => ({
  CheckoutButton: function CheckoutButton() {
    return null;
  },
  BillingPortalButton: function BillingPortalButton() {
    return null;
  },
}));

const { CheckoutCompletedError, NotSelfServeError, PriceNotFoundError, BillingNotConfiguredError } =
  await import("@xos/platform/billing");
const { BillingDataError } = await import("@/lib/billing/stripe");
const { openBillingPortalAction, startCheckoutAction } = await import("@/lib/billing/actions");
const { default: BillingSettingsPage } = await import("@/app/[org]/settings/billing-and-plan/page");
const { BillingLifecycleNotice } = await import("@/components/lifecycle/billing-notice");
const { BillingPortalButton, CheckoutButton } = await import("@/components/settings/billing-forms");
const { Button, InlineAlert } = await import("@/components/ui");
const { PLANS } = await import("@/lib/plans.generated");

const TRIAL = {
  trialPlan: "pro",
  trialEndsAt: "2026-11-05T05:00:00Z",
  billingState: null,
  pastDueSince: null,
};

function form(values: Record<string, string>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(values)) body.set(key, value);
  return body;
}

const choose = form({ org: "northwind-live", plan: "core", interval: "Monthly" });
const portal = form({ org: "northwind-live" });

type Node = { type: unknown; props: Record<string, unknown> };

/** Every element of a rendered tree, without running the components in it. */
function elements(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Node;
  return [element, ...elements(element.props["children"])];
}

const ofType = (tree: unknown, type: unknown) => elements(tree).filter((e) => e.type === type);
const textOf = (node: Node): string =>
  [node.props["children"]]
    .flat(Infinity)
    .filter((c) => typeof c === "string")
    .join("");

async function page(search: Record<string, string> = {}): Promise<unknown> {
  return BillingSettingsPage({
    params: Promise.resolve({ org: "northwind-live" }),
    searchParams: Promise.resolve(search),
  } as never);
}

beforeEach(() => {
  config.key = undefined;
  platform.createStripeClient.mockClear();
  platform.startPlanCheckout.mockReset();
  platform.openBillingPortal.mockReset();
  data.getBillingAccount.mockReset();
  data.getBillingAccount.mockImplementation(async () => ({ ok: true, data: data.account }));
  data.account = {
    paidThroughStripe: false,
    hasStripeCustomer: false,
    awaitingSubscription: false,
    interval: null,
    currentPeriodEnd: null,
  };
  data.banner = TRIAL;
});

describe("billing before the owner sets the Stripe key", () => {
  it("answers billing_not_open from both actions, and never reaches Stripe", async () => {
    expect(await startCheckoutAction({}, choose)).toMatchObject({ rule: "billing_not_open" });
    expect(await openBillingPortalAction({}, portal)).toMatchObject({ rule: "billing_not_open" });
    expect(platform.createStripeClient).not.toHaveBeenCalled();
    expect(platform.startPlanCheckout).not.toHaveBeenCalled();
    expect(platform.openBillingPortal).not.toHaveBeenCalled();
  });

  it("still checks the plan and term first", async () => {
    const bad = form({ org: "northwind-live", plan: "Core!", interval: "Weekly" });
    expect(await startCheckoutAction({}, bad)).toMatchObject({ error: "input" });
  });

  it("shows Billing and Plan closed: the notice, disabled Choose buttons, no term and no Stripe calls", async () => {
    const tree = await page();
    expect(ofType(tree, InlineAlert).map(textOf)).toContain("notAvailable");
    expect(ofType(tree, CheckoutButton)).toEqual([]);
    expect(ofType(tree, BillingPortalButton)).toEqual([]);
    expect(elements(tree).some((e) => e.type === "nav")).toBe(false);
    const disabled = ofType(tree, Button)
      .filter((b) => b.props["disabled"] === true)
      .map(textOf);
    for (const plan of PLANS.filter((p) => p.selfServe && p.code !== "pro")) {
      expect(disabled).toContain(`choose(shell.plans.${plan.code}.name)`);
    }
    const [notice] = ofType(tree, BillingLifecycleNotice);
    expect(notice?.props["billing"]).toEqual({ open: false, portal: false, awaiting: false });
    expect(data.getBillingAccount).not.toHaveBeenCalled();
  });

  it("keeps the trial notice's Add a card disabled, and says how to get it done", async () => {
    const notice = await BillingLifecycleNotice({
      ctx,
      billing: { open: false, portal: false, awaiting: false },
    });
    expect(ofType(notice, CheckoutButton)).toEqual([]);
    const [button] = ofType(notice, Button);
    expect(button?.props["disabled"]).toBe(true);
    expect(button && textOf(button)).toBe("banners.trialAction");
    expect(ofType(notice, InlineAlert).map(textOf)).toEqual(["billing.notConnected"]);
  });
});

describe("billing once the key is set", () => {
  beforeEach(() => {
    config.key = "sk_test_abcdefghij";
  });

  it("opens Checkout and answers with the Stripe URL to go to", async () => {
    platform.startPlanCheckout.mockResolvedValue({
      sessionId: "cs_test_New1",
      url: "https://checkout.stripe.test/cs_test_New1",
    });
    expect(await startCheckoutAction({}, choose)).toMatchObject({
      ok: true,
      id: "cs_test_New1",
      value: "https://checkout.stripe.test/cs_test_New1",
    });
    expect(platform.startPlanCheckout.mock.calls[0]?.[3]).toEqual({
      orgId: "org-1",
      planCode: "core",
      interval: "Monthly",
      livemode: false,
      customerEmail: "owner@northwind.test",
      successUrl: "https://atlas.test/northwind-live/settings/billing-and-plan?checkout=done",
      cancelUrl: "https://atlas.test/northwind-live/settings/billing-and-plan?checkout=canceled",
    });
  });

  it("answers each failure of Checkout with its refusal", async () => {
    const cases: [unknown, Record<string, string>][] = [
      [new CheckoutCompletedError("cs_test_Paid"), { rule: "checkout_completed" }],
      [new NotSelfServeError("enterprise", "quote"), { rule: "plan_not_self_serve" }],
      [new PriceNotFoundError("xos_core_monthly"), { rule: "billing_price_missing" }],
      [new BillingNotConfiguredError("STRIPE_SECRET_KEY"), { rule: "billing_not_open" }],
      [
        new BillingDataError({ kind: "refusal", rule: "step_up_required", message: "" }),
        { rule: "step_up_required" },
      ],
      [
        new BillingDataError({ kind: "refusal", rule: "checkout_completed", message: "" }),
        { rule: "checkout_completed" },
      ],
      [new BillingDataError({ kind: "not-found" }), { error: "notFound" }],
    ];
    for (const [error, state] of cases) {
      platform.startPlanCheckout.mockRejectedValueOnce(error);
      expect(await startCheckoutAction({}, choose)).toMatchObject(state);
    }
  });

  it("says Stripe could not be reached for anything else", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    platform.startPlanCheckout.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await startCheckoutAction({}, choose)).toMatchObject({ error: "unexpected" });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("opens the portal, or answers the database's refusal", async () => {
    platform.openBillingPortal.mockResolvedValueOnce("https://billing.stripe.test/p/1");
    expect(await openBillingPortalAction({}, portal)).toMatchObject({
      ok: true,
      value: "https://billing.stripe.test/p/1",
    });
    platform.openBillingPortal.mockRejectedValueOnce(
      new BillingDataError({ kind: "refusal", rule: "billing_no_customer", message: "" }),
    );
    expect(await openBillingPortalAction({}, portal)).toMatchObject({
      rule: "billing_no_customer",
    });
  });

  it("offers Checkout for each self-serve plan, and Add a card for the trial's plan", async () => {
    const tree = await page();
    expect(ofType(tree, InlineAlert).map(textOf)).not.toContain("notAvailable");
    expect(ofType(tree, CheckoutButton).map((b) => b.props["plan"])).toEqual(
      PLANS.filter((p) => p.selfServe).map((p) => p.code),
    );
    const notice = await BillingLifecycleNotice({
      ctx,
      billing: { open: true, portal: false, awaiting: false },
    });
    expect(ofType(notice, CheckoutButton).map((b) => b.props["plan"])).toEqual(["pro"]);
  });

  it("offers no second Checkout while a paid one waits for its subscription to sync", async () => {
    data.account = {
      paidThroughStripe: false,
      hasStripeCustomer: false,
      awaitingSubscription: true,
      interval: null,
      currentPeriodEnd: null,
    };
    const tree = await page();
    expect(ofType(tree, InlineAlert).map(textOf)).toContain("checkoutPending");
    expect(ofType(tree, CheckoutButton)).toEqual([]);
    expect(elements(tree).some((e) => e.type === "nav")).toBe(false);
    const [notice] = ofType(tree, BillingLifecycleNotice);
    expect(notice?.props["billing"]).toEqual({ open: true, portal: false, awaiting: true });
    const trial = await BillingLifecycleNotice({
      ctx,
      billing: { open: true, portal: false, awaiting: true },
    });
    expect(ofType(trial, CheckoutButton)).toEqual([]);
    expect(ofType(trial, Button)[0]?.props["disabled"]).toBe(true);
    expect(ofType(trial, InlineAlert)).toEqual([]);
  });
});
