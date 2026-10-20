import { expect, test, type Page } from "./engine-test";
import { DEMO, expectAccessible, signIn, sql } from "./support";

/**
 * Help in the Gateway shell (Section 11.16): the `?` key and the Help button open the contextual help
 * panel with the page's own articles, search, the shortcut sheet, What's New and Contact Support,
 * which sends work questions to the organization in Messages and account questions to platform
 * support. The panel loads on first use, never with the page.
 */

const panel = (page: Page) => page.getByRole("dialog", { name: "Help" });

test("the ? key opens help for the page, with search, shortcuts and What's New", async ({
  page,
}) => {
  await signIn(page, "crew@example.com");
  await expect(page.getByRole("heading", { level: 1, name: /Hi, Demo/ })).toBeVisible();

  // Typing a question mark in a field is typing, not a shortcut.
  const search = page.getByRole("searchbox", { name: "Search opportunities" });
  await search.fill("?");
  await expect(panel(page)).toHaveCount(0);
  await search.fill("");
  await page.getByRole("heading", { level: 1 }).click();

  await page.keyboard.press("?");
  const help = panel(page);
  await expect(help).toBeVisible();
  const forPage = help.getByRole("region", { name: "For this page" });
  await expect(forPage.getByRole("button", { name: /^Home/ })).toBeVisible();
  await expect(
    help.getByRole("region", { name: "Everywhere in Gateway" }).getByRole("button", {
      name: /Getting around Gateway/,
    }),
  ).toBeVisible();
  await expect(help.getByRole("region", { name: "Keyboard shortcuts" })).toContainText(
    "Search Gateway",
  );
  await expect(help.getByRole("region", { name: "What's new" })).toContainText(
    "Help for every page",
  );
  await expectAccessible(page);

  await forPage.getByRole("button", { name: /^Home/ }).click();
  await expect(help.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await expect(help.getByText(/the latest steps show here/)).toBeVisible();
  await help.getByRole("button", { name: "Back to help" }).click();

  await help.getByRole("searchbox", { name: "Search help" }).fill("self-billing");
  await expect(
    help.getByRole("region", { name: "Articles matching self-billing" }).getByRole("button", {
      name: /^Invoices/,
    }),
  ).toHaveCount(2);

  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
});

test("the Help button opens help, and Contact support reaches the org or platform support", async ({
  page,
}) => {
  await sql("delete from private.account_support_requests where person_id = $1", [DEMO.crew]);
  await signIn(page, "crew@example.com", `/work/engagements/${DEMO.crewEngagementKey}/overview`);

  // The top bar's Help button; the panel is fetched on this first use.
  await page.getByRole("button", { name: "Help", exact: true }).click();
  const help = panel(page);
  await expect(help).toBeVisible();
  await expect(
    help.getByRole("region", { name: "For this page" }).getByRole("button", {
      name: /^An engagement/,
    }),
  ).toBeVisible();

  await help.getByRole("button", { name: "Contact support", exact: true }).click();
  await expect(help.getByRole("link", { name: "Message the organization" })).toHaveAttribute(
    "href",
    `/work/engagements/${DEMO.crewEngagementKey}/messages`,
  );
  await expectAccessible(page);

  await help.getByRole("button", { name: "Send request" }).click();
  await expect(
    help.getByText("Fill in the subject and the message to send the request.").first(),
  ).toBeVisible();
  await help.getByLabel("Category").selectOption("Access");
  await help.getByLabel("Subject").fill("The sign-in link arrives late");
  await help.getByLabel("What happened, and what do you need?").fill("It took ten minutes today.");
  await help.getByRole("checkbox", { name: "Attach diagnostics" }).check();
  await expect(
    help.getByText(`/work/engagements/${DEMO.crewEngagementKey}/overview`),
  ).toBeVisible();
  await help.getByRole("button", { name: "Send request" }).click();
  await expect(
    help.getByText(/Request ACC-\d{6} sent\. Platform support answers by email/),
  ).toBeVisible();

  const rows = await sql<{ category: string; route: string | null }>(
    "select category::text, route from private.account_support_requests where person_id = $1",
    [DEMO.crew],
  );
  expect(rows).toEqual([
    { category: "Access", route: `/work/engagements/${DEMO.crewEngagementKey}/overview` },
  ]);

  await help.getByRole("button", { name: "Back to help" }).click();
  await help.getByRole("button", { name: "Contact support", exact: true }).click();
  await help.getByRole("link", { name: "Message the organization" }).click();
  await expect(page).toHaveURL(new RegExp(`/work/engagements/${DEMO.crewEngagementKey}/messages$`));
  await expect(help).toHaveCount(0);
});

test("on a phone, Help is in the account menu", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, "crew@example.com", "/money/overview");
  await page.getByRole("button", { name: /Open the account menu/ }).click();
  await page.getByRole("button", { name: "Help", exact: true }).click();
  const help = panel(page);
  await expect(help).toBeVisible();
  await expect(
    help.getByRole("region", { name: "For this page" }).getByRole("button", {
      name: /^Money overview/,
    }),
  ).toBeVisible();
  await help.getByRole("button", { name: "Contact support", exact: true }).click();
  await expect(help.getByRole("link", { name: "Open Messages" })).toHaveAttribute(
    "href",
    "/messages",
  );
});
