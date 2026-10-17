import { expect, test } from "@playwright/test";
import { expectAccessibleInBothThemes } from "./a16-support";
import { apiPost, PARTNER_ORG, signInAs } from "./a36-support";
import { PASSWORD, testEmail, uniqueId } from "./support";

/**
 * Journey 26 (Section 20.2, Section 4.6.1): a partner org creates a client org, the client inherits the
 * partner's default brand, the partner bills it at wholesale, and partner staff read none of the
 * client's records until the client's Owner grants a support session; ending it ends access.
 */
test("journey 26: client org, inherited brand, wholesale billing and support session", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const id = uniqueId();
  const clientName = `Harbor Client ${id}`;
  const clientSlug = `harbor-client-${id}`;
  const ownerEmail = testEmail("client-owner", id);
  const venueName = `Client Boathouse ${id}`;

  // Partner: the console, then a new client org with an Owner invitation.
  await signInAs(page, "partner@example.com", PARTNER_ORG);
  await page.goto(`/partner/${PARTNER_ORG}`);
  await expect(page.getByRole("heading", { level: 1, name: "Partner console" })).toBeVisible();
  await expectAccessibleInBothThemes(page);
  await page.goto(`/partner/${PARTNER_ORG}/client-orgs`);
  await expectAccessibleInBothThemes(page);
  await page.getByRole("button", { name: "Create a client org" }).first().click();
  const create = page.getByRole("dialog", { name: "New client org" });
  await create.getByLabel("Organization name").fill(clientName);
  await expect(create.getByLabel("Web address")).toHaveValue(clientSlug);
  await create.getByLabel("Owner's email").fill(ownerEmail);
  await create.getByLabel("Plan").selectOption("core");
  await create.getByRole("button", { name: "Create and invite the Owner" }).click();
  const link = create.getByLabel("Owner invitation link");
  await expect(link).toHaveValue(/\/auth\/invite\//);
  const invite = new URL(await link.inputValue());
  await create.getByRole("button", { name: "Done" }).click();

  // Client Owner: accept the invitation and add a venue (the client's own record).
  const owner = await (await browser.newContext()).newPage();
  await owner.goto(invite.pathname);
  await owner.getByLabel(/^Full name$/).fill("Cleo Client");
  await owner.locator("#signup-email").fill(ownerEmail);
  await owner.locator("#signup-password").fill(PASSWORD);
  await owner.getByRole("button", { name: "Create account" }).click();
  await owner.getByRole("button", { name: "Accept invitation" }).click();
  await owner.waitForURL(`**/${clientSlug}/home`);
  await apiPost(owner.request, baseURL as string, "/venues", {
    name: venueName,
    jurisdiction_id: "US-FL-MIAMI-DADE",
    time_zone: "America/New_York",
  });

  // Partner: the client inherits the default brand; its records stay unreadable.
  await page.reload();
  await page.getByRole("row").filter({ hasText: clientName }).dblclick();
  const drawer = page.getByRole("dialog", { name: clientName });
  await expect(drawer.getByText("Inherits your accent #1F6FEB")).toBeVisible();
  await expect(
    drawer.getByText(/No support session is open\. You cannot read this client's records/),
  ).toBeVisible();
  await expect(drawer.getByText(venueName)).toHaveCount(0);
  await drawer.getByLabel("Monthly price").fill("65.00");
  await drawer.getByRole("button", { name: "Save the price" }).click();
  await expect(drawer.getByText("Price saved.")).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // Client Owner: grant a four-hour support session in Settings, Security.
  await owner.goto(`/${clientSlug}/settings/security`);
  const support = owner.getByRole("region", { name: "Partner support sessions" });
  await expect(support.getByText("No support session is open.")).toBeVisible();
  await support
    .getByLabel("Why does your partner need access?")
    .fill("Help us set up the first venue.");
  await support.getByRole("button", { name: "Grant a support session" }).click();
  await expect(support.getByText(/Support session open until/)).toBeVisible();
  await expectAccessibleInBothThemes(owner);

  // Partner: now the client's venue reads, never writes; then the partner ends the session.
  await page.goto(`/partner/${PARTNER_ORG}/client-orgs`);
  await page.getByRole("row").filter({ hasText: clientName }).dblclick();
  const open = page.getByRole("dialog", { name: clientName });
  await expect(open.getByText(venueName)).toBeVisible();
  await open.getByRole("button", { name: "End the support session" }).click();
  await expect(open.getByText(/No support session is open/)).toBeVisible();
  await expect(open.getByText(venueName)).toHaveCount(0);

  // Wholesale billing (Owner only): the Core client bills $49.00 at list, $39.20 at wholesale.
  await page.goto(`/partner/${PARTNER_ORG}/wholesale-billing`);
  await expect(
    page.getByText("The platform bills you each client's list price less 20 percent, in USD."),
  ).toBeVisible();
  const run = page.getByRole("button", { name: /Run wholesale billing for/ });
  if (await run.isEnabled()) {
    await run.click();
    await expect(page.getByText("Statement recorded.")).toBeVisible();
    const line = page.getByRole("row").filter({ hasText: clientName });
    await expect(line).toContainText("$49.00");
    await expect(line).toContainText("$39.20");
    await expect(line).toContainText("$65.00");
    await expect(line).toContainText("$25.80");
  } else {
    await expect(page.getByText(/is billed\./)).toBeVisible();
  }
  await expectAccessibleInBothThemes(page);
});
