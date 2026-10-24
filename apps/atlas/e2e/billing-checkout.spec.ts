import type { Page } from "@playwright/test";
import { expect as baseExpect, test } from "./engine-test";
import { orgIdOf, serviceClient, stepUp } from "./a79-support";
import { startFakeStripe, type FakeStripe } from "./fake-stripe";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * ADR 0033 decision 59: launch on the trial and the Access plan, with Checkout built so billing can
 * open. The Owner of an org on its Pro trial chooses a plan in Billing and Plan, passes step-up, pays on Stripe
 * Checkout and comes back on the paid plan; the customer portal then manages it. Stripe is the local fake of
 * fake-stripe.ts, which Atlas reaches through STRIPE_API_URL (playwright.config.ts and CI start the server with
 * it); the webhook applies through the platform's handler against the local stack. Each journey runs on a fresh
 * org so the demo tenant stays as it is.
 */

const STEP_UP = "Confirm it is you with your second factor, then try again.";

/** Each step is a server action that checks the database and calls the fake; on a loaded machine that is slow. */
const expect = baseExpect.configure({ timeout: 30_000 });

let stripe: FakeStripe;

test.beforeAll(async () => {
  stripe = await startFakeStripe();
});

test.afterAll(async () => {
  await stripe.close();
});

/** A new Owner on a new org, which starts its 14-day Pro trial; returns its slug and the Owner's email. */
async function trialOrg(
  page: Page,
  label: string,
): Promise<{ slug: string; email: string; name: string }> {
  const id = uniqueId();
  const slug = `${label}-${id}`;
  const name = `Checkout Co ${id}`;
  const email = testEmail(label, id);
  await signUp(page, { name: "Bea Buyer", email });
  await createOrganization(page, { name, slug });
  await page.goto(`/${slug}/settings/billing-and-plan`);
  const closed = page.getByText("Billing is not open yet");
  if (process.env["CI"]) {
    // CI starts Atlas with the fake Stripe (ci.yml), so a closed page there fails rather than skips.
    await expect(closed).toHaveCount(0);
  } else {
    test.skip(
      await closed.isVisible(),
      "Atlas runs without the fake Stripe: start it through playwright.config.ts, or set STRIPE_SECRET_KEY and STRIPE_API_URL as it does.",
    );
  }
  return { slug, email, name };
}

async function subscriptionOf(slug: string) {
  const { data, error } = await serviceClient()
    .schema("app")
    .from("subscriptions")
    .select("plan_code, subscription_state")
    .eq("org_id", await orgIdOf(slug))
    .neq("subscription_state", "canceled")
    .single();
  if (error || !data) throw new Error(`No subscription for ${slug}: ${error?.message ?? ""}`);
  return data as { plan_code: string; subscription_state: string };
}

async function checkoutsOf(slug: string) {
  const { data, error } = await serviceClient()
    .schema("app")
    .from("billing_checkouts")
    .select("stripe_checkout_session_id, plan_code, billing_interval, checkout_state")
    .eq("org_id", await orgIdOf(slug))
    .order("created_at");
  if (error) throw new Error(`billing_checkouts: ${error.message}`);
  return (data ?? []) as {
    stripe_checkout_session_id: string;
    plan_code: string;
    billing_interval: string;
    checkout_state: string;
  }[];
}

test("an Owner on the Pro trial pays for Core in Checkout and manages it in the billing portal", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { slug, email, name } = await trialOrg(page, "checkout");
  await expect(page.getByTestId("billing-lifecycle")).toContainText("14-day Pro trial");
  await expect(page.getByRole("navigation", { name: "Billing term" })).toBeVisible();
  await expectAccessible(page);

  // Choosing a plan asks for a second factor first, and Stripe hears nothing until then.
  const before = stripe.requests.length;
  const core = page.getByRole("form", { name: "Choose Core" });
  await core.getByRole("button", { name: "Choose Core" }).click();
  await expect(core.getByText(STEP_UP)).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "Set up a second factor" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(stripe.requests).toHaveLength(before);

  // With a second factor, Checkout opens on the fake, carrying the rest of the trial.
  await stepUp(page, email);
  await page.reload();
  await page
    .getByRole("form", { name: "Choose Core" })
    .getByRole("button", { name: "Choose Core" })
    .click();
  await page.waitForURL(`${stripe.url}/pay/**`);
  await expect(page.getByRole("heading", { name: "Fake Stripe Checkout" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Line items" })).toContainText(
    "xos_plan_core_monthly_v4 x 1",
  );
  await expect(page.getByText(/^Trial until \d{4}-\d{2}-\d{2}\.$/)).toBeVisible();
  await expect(page.getByText(`Customer: ${email}`)).toBeVisible();
  const [opened] = await checkoutsOf(slug);
  expect(opened).toMatchObject({
    plan_code: "core",
    billing_interval: "Monthly",
    checkout_state: "Open",
  });

  // Paying sends the webhook events; Atlas shows the paid plan.
  await page.getByRole("button", { name: "Pay and subscribe" }).click();
  await page.waitForURL(`**/${slug}/settings/billing-and-plan?checkout=done`);
  await expect(page.getByText(`Payment received. ${name} is on the Core plan.`)).toBeVisible();
  await expect(page.getByTestId("billing-lifecycle")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Billing portal" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Choose / })).toHaveCount(0);
  await expectAccessible(page);
  expect(await subscriptionOf(slug)).toEqual({ plan_code: "core", subscription_state: "active" });
  expect((await checkoutsOf(slug)).map((c) => c.checkout_state)).toEqual(["Completed"]);

  // The billing portal opens on the org's customer and comes back.
  await page.getByRole("button", { name: "Open the billing portal" }).click();
  await page.waitForURL(`${stripe.url}/portal/**`);
  await expect(page.getByRole("heading", { name: "Fake Stripe billing portal" })).toBeVisible();
  await expect(page.getByText(/^Customer: cus_fake\d+$/)).toBeVisible();
  await page.getByRole("link", { name: "Return to XOS" }).click();
  await page.waitForURL(`**/${slug}/settings/billing-and-plan`);
  await expect(page.getByRole("heading", { name: "Billing portal" })).toBeVisible();
});

test("a canceled checkout charges nothing, and choosing again expires the open session first", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { slug, email } = await trialOrg(page, "recheckout");
  await stepUp(page, email);

  // Yearly billing for Pro, then back out of Checkout.
  await page.getByRole("link", { name: "Yearly, two months free" }).click();
  await page.waitForURL(`**/${slug}/settings/billing-and-plan?term=annual`);
  const pro = page.getByRole("button", { name: "Choose Pro, billed yearly" });
  await pro.click();
  await page.waitForURL(`${stripe.url}/pay/**`);
  await expect(page.getByRole("list", { name: "Line items" })).toContainText(
    "xos_plan_pro_annual_v4 x 1",
  );
  const first = page.url().split("/").at(-1) ?? "";
  await page.getByRole("link", { name: "Back to XOS" }).click();
  await page.waitForURL(`**/${slug}/settings/billing-and-plan?checkout=canceled`);
  await expect(page.getByText("Checkout was canceled, and nothing was charged.")).toBeVisible();
  expect(await subscriptionOf(slug)).toEqual({ plan_code: "pro", subscription_state: "trialing" });

  // Choosing again expires the first session in Stripe before the second opens.
  await page.getByRole("button", { name: "Choose Team" }).click();
  await page.waitForURL(`${stripe.url}/pay/**`);
  expect(stripe.sessions.get(first)?.status).toBe("expired");
  expect((await checkoutsOf(slug)).map((c) => [c.plan_code, c.checkout_state])).toEqual([
    ["pro", "Expired"],
    ["team", "Open"],
  ]);
});
