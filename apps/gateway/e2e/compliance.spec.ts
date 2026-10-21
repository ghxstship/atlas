import { expect, test, type Browser } from "./engine-test";
import { expectAccessible, sql, uniqueId } from "./support";

/**
 * A82 compliance journeys on Gateway (RRR-127, finding A65-014): the cookie banner with equal
 * choices, the server-side record, Cookie settings, and Global Privacy Control (Section 14.3); and
 * re-accepting the Worker Terms after a material change (Section 14.4). The config sends Global
 * Privacy Control so the banner stays out of other journeys; the cookie tests open their own
 * contexts. The "16 or older" question is covered in sign-up.spec.ts and google-sign-in.spec.ts.
 */

async function plainContext(browser: Browser) {
  return browser.newContext({ extraHTTPHeaders: {} });
}

test("the cookie banner asks once and Cookie settings changes the choice", async ({ browser }) => {
  const context = await plainContext(browser);
  const page = await context.newPage();
  await page.goto("/auth/sign-in");
  const banner = page.getByRole("region", { name: "Cookies" });
  await expect(banner).toBeVisible();
  await expect(
    banner.getByText(/remember your language and theme for 12 months/).first(),
  ).toBeVisible();
  await expectAccessible(page);
  await banner.getByRole("button", { name: "Accept all" }).click();
  await expect(banner).toHaveCount(0);
  const consent = (await context.cookies()).find((c) => c.name === "xos-consent")?.value;
  expect(consent).toMatch(/^1\.[0-9a-f]{32}\.11\.0$/);

  await page.goto("/legal/cookie-settings");
  await expect(page.getByRole("heading", { level: 1, name: "Cookie settings" })).toBeVisible();
  await expect(page.getByText("Your choice: Preferences on, Performance on.")).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "xos-acting" })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Reject all" }).click();
  await expect(page.getByText("Your choice: Preferences off, Performance off.")).toBeVisible();
  await page.goto("/legal/cookie-policy");
  await expect(page.getByRole("heading", { level: 1, name: "Cookie Policy" })).toBeVisible();
  await context.close();
});

test("Global Privacy Control replaces the banner on Gateway", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { "Sec-GPC": "1" } });
  const page = await context.newPage();
  await page.goto("/auth/sign-in");
  await expect(page.getByRole("region", { name: "Cookies" })).toHaveCount(0);
  const consent = (await context.cookies()).find((c) => c.name === "xos-consent")?.value;
  expect(consent).toMatch(/\.00\.1$/);
  await context.close();
});

test("a material change to the Worker Terms asks the worker to accept the new version", async ({
  page,
}) => {
  // A new account accepts the Worker Terms at sign-up, so it is asked again after a change.
  const email = `reaccept-${uniqueId()}@example.com`;
  await page.goto("/auth/sign-up");
  await page.locator("#signup-name").fill("Rowan Reaccept");
  await page.locator("#signup-email").fill(email);
  await page.getByRole("button", { name: "Use a password" }).click();
  await page.locator("#signup-password").fill("Tidal-Copper-Ladder-4821");
  await page.locator("#signup-terms").check();
  await page.locator("#signup-age").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL((url) => url.pathname === "/home");
  await expect(page.getByTestId("reacceptance-prompt")).toHaveCount(0);

  // The platform team announces the change (migration 1383); it applies to every worker who
  // accepted an earlier version, so the test withdraws it at the end whatever happens.
  const version = `9.${Date.now() % 100000}.0`;
  await sql(
    `select app.announce_legal_change('worker-terms', $1, 'Personal',
       'Payout disputes now go to the org first, then to the platform.', current_date + 45)`,
    [version],
  );
  try {
    await page.reload();
    const prompt = page.getByTestId("reacceptance-prompt");
    await expect(prompt).toContainText("Worker Terms: a new version takes effect on");
    await expect(prompt).toContainText("Payout disputes now go to the org first");
    await expect(prompt.getByRole("link", { name: "Read the new version" })).toHaveAttribute(
      "href",
      "/legal/worker-terms",
    );
    await expectAccessible(page);
    await prompt.getByRole("button", { name: `Accept Worker Terms ${version}` }).click();
    await expect(page.getByTestId("reacceptance-prompt")).toHaveCount(0, { timeout: 30_000 });
    const accepted = await sql<{ version: string; org: string | null }>(
      `select a.document_version as version, a.org_id::text as org
         from app.legal_acceptances a
         join app.people p on p.id = a.person_id join auth.users u on u.id = p.user_id
        where u.email = $1 and a.document_slug = 'worker-terms' order by a.accepted_at`,
      [email],
    );
    expect(accepted.map((a) => a.version)).toEqual(["1.0.0-draft", version]);
    expect(accepted.every((a) => a.org === null)).toBe(true);
  } finally {
    await sql("select app.withdraw_legal_change('worker-terms', $1)", [version]);
  }
});
