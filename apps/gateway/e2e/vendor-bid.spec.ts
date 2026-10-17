import { expect, test } from "./engine-test";
import { DEMO_VENDOR_ACCOUNT, publishVendorBidOpportunity } from "./fixtures";
import { expectAccessible, signIn, sql } from "./support";

/**
 * Journey 4, Gateway half (Section 20.2; Section 11.12 Apply): an invited vendor, acting as its
 * company, sends a sealed line-item bid. A line it cannot price yet stays unpriced, never zero; a
 * refused send keeps every typed line; the bid is stored sealed on the posting.
 */
test.use({ reducedMotion: "reduce" });

test("journey 4: a vendor sends a sealed line-item bid, with one line left unpriced", async ({
  page,
}) => {
  const posting = await publishVendorBidOpportunity();
  await signIn(page, "vendor@example.com", "/explore");
  // Acting as the company account, as the account menu does (the cookie names the account).
  await page
    .context()
    .addCookies([{ name: "xos-acting", value: DEMO_VENDOR_ACCOUNT, url: page.url() }]);
  await page.goto(`/explore/${posting.key}`);
  await page.waitForLoadState("networkidle");

  const form = page.getByRole("form", { name: `Apply for ${posting.title}` });
  await expect(form).toBeVisible();
  await expect(
    form.getByText("Bids stay sealed until the deadline.", { exact: false }),
  ).toBeVisible();
  await expectAccessible(page);

  await form.locator("#line-0-description").fill("Delay tower line array, per show day");
  await form.locator("#line-0-quantity").fill("2");
  await form.locator("#line-0-price").fill("3800.00");
  await form.getByRole("button", { name: "Add line" }).click();
  await form.locator("#line-1-description").fill("Rigging engineer, per show day");
  await form.locator("#line-1-quantity").fill("2");

  // Without the availability confirmation the send is refused, and every typed line stays.
  await form.getByRole("button", { name: "Send application" }).click();
  await expect(form.locator("#line-0-description")).toHaveValue(
    "Delay tower line array, per show day",
  );
  await expect(form.locator("#line-0-price")).toHaveValue("3800.00");
  await expect(form.locator("#line-1-description")).toHaveValue("Rigging engineer, per show day");

  await form.getByLabel("I am available for these dates").check();
  await form.getByRole("button", { name: "Send application" }).click();
  await expect(page.getByText("Application sent. Follow it under Applications.")).toBeVisible();
  await expectAccessible(page);

  // Stored with both lines; the unpriced line holds no price rather than zero.
  const lines = await sql<{ description: string; unit_price_minor: string | null }>(
    `select l.description, l.unit_price_minor::text as unit_price_minor
       from app.bid_lines l
       join app.bids b on b.id = l.bid_id
       join app.applications a on a.id = b.application_id
      where a.opportunity_id = $1 order by l.description`,
    [posting.id],
  );
  expect(lines).toEqual([
    { description: "Delay tower line array, per show day", unit_price_minor: "380000" },
    { description: "Rigging engineer, per show day", unit_price_minor: null },
  ]);
});
