import { expect, test } from "./engine-test";
import { expectAccessible, sql, uniqueId } from "./support";

/**
 * Gateway account creation (Section 14.4; finding A59-025): one Email field per card, the sign-in
 * link first and a password on request, and no account until the person accepts the Worker Terms.
 * The acceptance lands in the append-only legal log with the document version, for the new person,
 * as soon as the account has a session.
 */
test.use({ reducedMotion: "reduce" });

test("sign-up asks once for the email and records the Worker Terms acceptance", async ({
  page,
}) => {
  const email = `signup-${uniqueId()}@example.com`;
  await page.goto("/auth/sign-up");
  await expect(
    page.getByRole("heading", { level: 1, name: "Create your Gateway account" }),
  ).toBeVisible();
  await expect(page.locator('input[type="email"]')).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Worker Terms" })).toHaveAttribute(
    "href",
    "/legal/worker-terms",
  );
  await expect(page.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
    "href",
    "/legal/privacy-policy",
  );
  await expectAccessible(page);

  // The link needs the terms too: nothing is sent until the box is ticked.
  await page.locator("#signup-name").fill("Rowan Tester");
  await page.locator("#signup-email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("Accept the Worker Terms to create your account")).toBeVisible();
  await expect(page.locator("#signup-terms")).toHaveAttribute("aria-invalid", "true");

  // A password instead: the typed name and email carry over, and the terms still gate creation.
  await page.getByRole("button", { name: "Use a password" }).click();
  await expect(page.locator("#signup-password")).toBeFocused();
  await expect(page.locator("#signup-email")).toHaveValue(email);
  await page.locator("#signup-password").fill("Tidal-Copper-Ladder-4821");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Accept the Worker Terms to create your account")).toBeVisible();
  await expect(page.locator("#signup-email")).toHaveValue(email);
  const [none] = await sql<{ n: string }>(
    `select count(*)::text as n from auth.users where email = $1`,
    [email],
  );
  expect(none?.n).toBe("0");
  await expectAccessible(page);

  await page.locator("#signup-terms").check();
  // "18 or older" gates creation too (A82, Sections 14.3 and 14.9).
  await page.locator("#signup-password").fill("Tidal-Copper-Ladder-4821");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByText("Choose the answer that is true for you.", { exact: true }),
  ).toBeVisible();
  await page.locator("#signup-age").check();
  await page.locator("#signup-password").fill("Tidal-Copper-Ladder-4821");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL((url) => url.pathname === "/home");
  const [age] = await sql<{ surface: string }>(
    `select c.surface from private.age_confirmations c
       join app.people p on p.id = c.person_id join auth.users u on u.id = p.user_id
      where u.email = $1`,
    [email],
  );
  expect(age?.surface).toBe("Gateway");

  const accepted = await sql<{
    slug: string;
    version: string;
    org: string | null;
    pending: unknown;
  }>(
    `select a.document_slug as slug, a.document_version as version, a.org_id::text as org,
            u.raw_user_meta_data -> 'pending_legal_acceptances' as pending
       from auth.users u
       join app.legal_acceptances a on a.user_id = u.id
      where u.email = $1`,
    [email],
  );
  expect(accepted.map(({ slug, version, org }) => ({ slug, version, org }))).toEqual([
    { slug: "worker-terms", version: "1.0.0-draft", org: null },
  ]);
  expect(accepted[0]?.pending ?? null).toBeNull();
});

test("sign-in shows one Email field, the link first and a password on request", async ({
  page,
}) => {
  await page.goto("/auth/sign-in");
  await expect(page.locator('input[type="email"]')).toHaveCount(1);
  await expect(page.locator("#signin-password")).toHaveCount(0);
  await page.locator("#signin-email").fill("crew@example.com");
  await page.getByRole("button", { name: "Use a password" }).click();
  await expect(page.locator("#signin-password")).toBeFocused();
  await expect(page.locator("#signin-email")).toHaveValue("crew@example.com");
  await expect(page.getByRole("button", { name: "Sign in with password" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toHaveCount(0);
  await page.getByRole("button", { name: "Use a link" }).click();
  await expect(page.locator("#signin-password")).toHaveCount(0);
  await expectAccessible(page);
});

test("an answer of under 18 makes no account and keeps nothing typed", async ({ page }) => {
  const email = `under-${uniqueId()}@example.com`;
  await page.goto("/auth/sign-up");
  await page.locator("#signup-name").fill("Una Under");
  await page.locator("#signup-email").fill(email);
  await page.locator("#signup-terms").check();
  await page.locator("#signup-age-under").check();
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.waitForURL((url) => url.pathname === "/auth/age-refused");
  await expect(
    page.getByRole("heading", { name: "XOS accounts are for people 18 and older" }),
  ).toBeVisible();
  await expectAccessible(page);
  const [none] = await sql<{ n: string }>(
    `select count(*)::text as n from auth.users where email = $1`,
    [email],
  );
  expect(none?.n).toBe("0");
  const [refusal] = await sql<{ outcome: string; surface: string }>(
    `select outcome, surface from private.age_refusals order by refused_at desc limit 1`,
    [],
  );
  expect(refusal).toEqual({ outcome: "No Account", surface: "Gateway" });
});

test("someone who confirmed the earlier age of 16 answers again at sign-in", async ({ page }) => {
  const email = `legacy-${uniqueId()}@example.com`;
  const password = "Tidal-Copper-Ladder-4821";
  await page.goto("/auth/sign-up");
  await page.locator("#signup-name").fill("Lee Legacy");
  await page.locator("#signup-email").fill(email);
  await page.locator("#signup-terms").check();
  await page.locator("#signup-age").check();
  await page.getByRole("button", { name: "Use a password" }).click();
  await page.locator("#signup-password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL((url) => url.pathname === "/home");
  // The account as the earlier rule left it: a confirmation at 16 and none at 18.
  await sql(
    `update private.age_confirmations c set minimum_age = 16
       from app.people p join auth.users u on u.id = p.user_id
      where c.person_id = p.id and u.email = $1`,
    [email],
  );
  await page.context().clearCookies();
  await page.goto("/auth/sign-in");
  await page.locator("#signin-email").fill(email);
  await page.getByRole("button", { name: "Use a password" }).click();
  await page.locator("#signin-password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL((url) => url.pathname === "/auth/age");
  await expect(page.getByRole("heading", { name: "Confirm your age" })).toBeVisible();
  await expectAccessible(page);
  await page.locator("#age-question").check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/home");
});

test("the legal pages sign-up links to are public, and others are not served", async ({ page }) => {
  for (const [path, title] of [
    ["/legal/worker-terms", "Worker Terms"],
    ["/legal/privacy-policy", "Privacy Policy"],
  ] as const) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expectAccessible(page);
  }
  const missing = await page.goto("/legal/data-processing-agreement");
  expect(missing?.status()).toBe(404);
});
