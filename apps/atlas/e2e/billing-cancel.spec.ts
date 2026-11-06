import type { Page } from "@playwright/test";
import pg from "pg";
import { expect as baseExpect, test } from "./engine-test";
import { orgIdOf, serviceClient, stepUp } from "./a79-support";
import { startFakeStripe, type FakeStripe } from "./fake-stripe";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";
import { createStripeClient, readBillingEnv, runStripeCancellations } from "@xos/platform/billing";
import { stripeCancellationStore, supabaseDb } from "@xos/platform";

/**
 * Legal issue 1 (ADR 0161): canceling or deleting an org stops Stripe, online and with no human step. A paying Owner ends a
 * plan, cancels the org and deletes another, on a fake of Stripe; when Stripe is unreachable the page says it is not
 * confirmed, the worker retries, and only once Stripe accepts does the page say so. Each journey runs on a fresh org.
 */

const expect = baseExpect.configure({ timeout: 30_000 });

let stripe: FakeStripe;

test.beforeAll(async () => {
  stripe = await startFakeStripe();
});

test.afterAll(async () => {
  await stripe.close();
});

/** A new Owner on a new org who has agreed to the renewal terms and paid for Core on the fake. */
async function paidOrg(page: Page, label: string) {
  const id = uniqueId();
  const slug = `${label}-${id}`;
  const name = `Stop Co ${id}`;
  const email = testEmail(label, id);
  await signUp(page, { name: "Sam Stopper", email });
  await createOrganization(page, { name, slug });
  await stepUp(page, email);
  await page.goto(`/${slug}/settings/billing-and-plan?review=core`);
  await page.getByRole("checkbox", { name: /I agree to these renewal terms/ }).check();
  await page.getByRole("button", { name: "Agree and continue to payment" }).click();
  await page.waitForURL(`${stripe.url}/pay/**`);
  await page.getByRole("button", { name: "Pay and subscribe" }).click();
  await page.waitForURL(`**/${slug}/settings/billing-and-plan?checkout=done`);
  await expect(page.getByRole("heading", { name: "End the plan" })).toBeVisible();
  const subscription = [...stripe.subscriptions.values()].at(-1);
  if (!subscription) throw new Error("The fake created no subscription");
  return { slug, name, email, subscription };
}

/** Kinds of the org's notifications, read with the service role. */
async function noticesOf(slug: string): Promise<string[]> {
  const { data, error } = await serviceClient()
    .schema("app")
    .from("notifications")
    .select("kind")
    .eq("org_id", await orgIdOf(slug));
  if (error) throw new Error(`notifications: ${error.message}`);
  return ((data ?? []) as { kind: string }[]).map((n) => n.kind);
}

/** One run of the org-lifecycle worker's Stripe step, against the fake, as the Edge Function makes it. */
async function runWorker() {
  const billing = readBillingEnv({
    STRIPE_SECRET_KEY: "sk_test_abcdefghij",
    STRIPE_API_URL: stripe.url,
  });
  return runStripeCancellations({
    stripe: await createStripeClient(billing),
    store: stripeCancellationStore(supabaseDb(serviceClient())),
    worker: "journey",
    livemode: false,
    sink: null,
  });
}

/** Makes every queued cancel of the subscription due now, since the worker backs off after a failure. */
async function makeDue(subscriptionId: string): Promise<void> {
  const client = new pg.Client({
    connectionString:
      process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres",
  });
  await client.connect();
  try {
    await client.query(
      "update private.stripe_cancellations set next_attempt_at = now() - interval '1 second' where stripe_subscription_id = $1 and cancellation_state = 'Queued'",
      [subscriptionId],
    );
  } finally {
    await client.end();
  }
}

test("the agreement is recorded, and ending a plan stops the renewal with one button and no second factor", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { slug, subscription } = await paidOrg(page, "endplan");
  await expect.poll(() => noticesOf(slug)).toContain("billing.purchase_confirmed");
  await expectAccessible(page);

  await expect(page.getByText(/You will not be charged again/)).toBeVisible();
  await expect(page.getByText(/not refunded unless the law requires it/).first()).toBeVisible();
  await page.getByRole("button", { name: "End plan", exact: true }).click();
  const notice = page.getByTestId("stripe-cancellation");
  await expect(notice.getByText("This plan is ending")).toBeVisible();
  expect(stripe.subscriptions.get(subscription.id)?.cancel_at_period_end).toBe(true);
  await expect(page.getByRole("button", { name: "End plan", exact: true })).toHaveCount(0);
  await expect.poll(() => noticesOf(slug)).toContain("billing.plan_ending");
  await expectAccessible(page);
});

test("canceling the org cancels Stripe at once and says no refund, and says so only once Stripe has", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { slug, name, subscription } = await paidOrg(page, "cancelorg");

  await page.goto(`/${slug}/settings/danger-zone`);
  await expect(
    page.getByText(/Time you already paid for is not refunded unless the law requires it/).first(),
  ).toBeVisible();
  const cancel = page.getByRole("form", { name: "Cancel the organization" });
  await cancel.getByRole("textbox", { name: `Type ${name} to confirm` }).fill(name);
  await cancel.getByRole("textbox", { name: "Why are you canceling?" }).fill("Closing down.");
  await cancel.getByRole("button", { name: "Cancel the organization" }).click();

  await expect(page.getByTestId("stripe-cancellation").first()).toContainText(
    "Stripe has accepted the cancellation",
  );
  expect(stripe.subscriptions.get(subscription.id)?.status).toBe("canceled");
  await expect.poll(() => noticesOf(slug)).toContain("billing.cancellation_confirmed");
  await expectAccessible(page);
});

test("when Stripe is unreachable the org is canceled, the page tells the truth, and the worker finishes the job", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { slug, name, subscription } = await paidOrg(page, "stripedown");

  stripe.setDown(true);
  try {
    await page.goto(`/${slug}/settings/danger-zone`);
    const cancel = page.getByRole("form", { name: "Cancel the organization" });
    await cancel.getByRole("textbox", { name: `Type ${name} to confirm` }).fill(name);
    await cancel.getByRole("textbox", { name: "Why are you canceling?" }).fill("Closing down.");
    await cancel.getByRole("button", { name: "Cancel the organization" }).click();

    const notice = page.getByTestId("stripe-cancellation").first();
    await expect(notice).toContainText("Cancellation not confirmed yet");
    await expect(notice).not.toContainText("Stripe has accepted");
    expect(stripe.subscriptions.get(subscription.id)?.status).not.toBe("canceled");

    // The worker fails too: still not confirmed, and now the owners are told by email as well.
    expect((await runWorker()).failed).toBeGreaterThan(0);
    await expect.poll(() => noticesOf(slug)).toContain("billing.cancellation_delayed");
    await page.reload();
    await expect(page.getByTestId("stripe-cancellation").first()).toContainText(
      "Cancellation not confirmed yet",
    );
  } finally {
    stripe.setDown(false);
  }

  // Stripe is back. The retry waits out its backoff, which this journey skips by moving the row's next attempt.
  await makeDue(subscription.id);
  expect((await runWorker()).accepted).toBeGreaterThan(0);
  expect(stripe.subscriptions.get(subscription.id)?.status).toBe("canceled");
  await page.reload();
  await expect(page.getByTestId("stripe-cancellation").first()).toContainText(
    "Stripe has accepted the cancellation",
  );
  await expect.poll(() => noticesOf(slug)).toContain("billing.cancellation_confirmed");
});

test("deleting an org cancels Stripe, and recovering it leaves the paid plan ended", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { slug, name, email, subscription } = await paidOrg(page, "deleteorg");
  await stepUp(page, email);
  await page.goto(`/${slug}/settings/danger-zone`);
  await expect(
    page.getByText(/time you already paid for is not refunded unless the law requires it/),
  ).toBeVisible();
  const remove = page.getByRole("form", { name: "Delete the organization" });
  await remove.getByRole("textbox", { name: `Type ${name} to confirm deletion` }).fill(name);
  await remove.getByRole("textbox", { name: "Why are you deleting it?" }).fill("Closing down.");
  await remove.getByRole("button", { name: "Delete the organization" }).click();
  await expect(page.getByTestId("stripe-cancellation").first()).toContainText(
    "Stripe has accepted the cancellation",
  );
  expect(stripe.subscriptions.get(subscription.id)?.status).toBe("canceled");
});
