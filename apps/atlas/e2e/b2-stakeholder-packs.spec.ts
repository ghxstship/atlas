import { expect, test, type Browser, type Page } from "./engine-test";
import { deliverPacks, latestMail, mailLinks } from "./b2-support";
import { createOrganization, signUp, testEmail, uniqueId } from "./support";

/**
 * B2 stakeholder packs (RRR-226, ADR 0141; gap G-29) on a fresh org: make a pack, add a live view and a recipient, the
 * code shows once and stays through a refresh, the email carries a link and no code, a visitor with no session opens with
 * the code, Activity counts it, and revoking ends access. Every visitor is a fresh browser context.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);

async function newOwnerOrg(page: Page): Promise<string> {
  const id = uniqueId();
  const slug = `b2-${id}`;
  await signUp(page, { name: "Pat Packer", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Packs ${id}`, slug });
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill("SHW");
  await dialog.getByLabel("Project name").fill("Summer Headline Weekend");
  await dialog.getByRole("button", { name: "More fields" }).click();
  await dialog.getByLabel("Jurisdiction").selectOption("US-FL-MIAMI-DADE");
  await dialog.getByLabel("Tier of experience").selectOption({ index: 5 });
  await dialog.getByLabel("First production day").fill("2027-03-12");
  await dialog.getByLabel("Last production day").fill("2027-03-15");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/SHW/overview`);
  return slug;
}

async function visitor(browser: Browser): Promise<Page> {
  return (await browser.newContext({ reducedMotion: "reduce" })).newPage();
}

test("a pack opens with the recipient's code, shows its items and stops when revoked", async ({
  page,
  browser,
}) => {
  const slug = await newOwnerOrg(page);
  const id = uniqueId();
  await page.goto(`/${slug}/p/SHW/settings#outside-access`);
  const section = page.locator("#outside-access");
  await expect(section.getByRole("heading", { name: "Outside access", exact: true })).toBeVisible();

  // The dialog body loads on the first click of a static control.
  await expect(async () => {
    await section.getByRole("button", { name: "New stakeholder pack", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2_000 });
  }).toPass();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill(`Client pack ${id}`);
  await dialog.getByLabel("Message to recipients").fill("Welcome to the show.");
  await dialog.getByRole("button", { name: "Save details" }).click();

  // Saving moves to Items; recipients are their own step.
  await expect(dialog.getByRole("button", { name: "Add item" })).toBeVisible();
  await dialog.getByRole("button", { name: "Recipients", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Cleo Client");
  await dialog.getByLabel("Email", { exact: true }).fill(`cleo-${id}@client.test`);
  await dialog.getByRole("button", { name: "Add recipient" }).click();
  await expect(dialog.getByText(`cleo-${id}@client.test`)).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).first().click();

  // The code stays visible in the panel above the list, through a refresh of the section.
  const panel = page.locator("[data-outside-reveal]");
  await expect(panel).toBeVisible();
  const code = await panel.getByRole("textbox", { name: "Access code" }).inputValue();
  expect(code).toMatch(/^[0-9]{6}$/);
  await expect(
    panel.getByText("It is shown once and never emailed", { exact: false }),
  ).toBeVisible();

  await expect(section.getByText(`Client pack ${id} · Cleo Client`)).toBeVisible();

  // The recipient's own link comes by email; here it is minted the way the worker does (the delivery spec covers mail).
  await section.getByRole("button", { name: "Manage packs", exact: true }).click();
  const manage = page.getByRole("dialog");
  await manage.getByRole("button", { name: "Open", exact: true }).click();
  await manage.getByRole("button", { name: "Delivery", exact: true }).click();
  await manage.getByRole("button", { name: "Send invite or resend" }).click();
  await expect(manage.getByText("1 email queued")).toBeVisible();
  await manage.getByRole("button", { name: "Close" }).first().click();

  // One pass of the worker: the email carries a sign-in link, never the code or a file.
  await deliverPacks(new URL(page.url()).origin);
  const mail = await latestMail(page.request, `cleo-${id}@client.test`);
  expect(mail.text).not.toContain(code);
  expect(mail.attachments).toBe(0);
  const { pack } = mailLinks(mail);

  const guest = await visitor(browser);
  await guest.goto(pack);
  await guest.getByLabel("Access code").fill(code === "000000" ? "000001" : "000000");
  await guest.getByRole("button", { name: "Open pack" }).click();
  await expect(guest.getByText("That code did not match.", { exact: false })).toBeVisible();
  await guest.getByLabel("Access code").fill(code);
  await guest.getByRole("button", { name: "Open pack" }).click();
  await expect(guest.getByRole("heading", { name: `Client pack ${id}` })).toBeVisible();
  await expect(guest.getByText("For Cleo Client")).toBeVisible();
  await expect(guest.getByText("Team note")).toHaveCount(0);

  // Activity counts the open, from the events.
  await section.getByRole("button", { name: "Manage packs", exact: true }).click();
  const again = page.getByRole("dialog");
  await again.getByRole("button", { name: "Open", exact: true }).click();
  await again.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(again.getByRole("grid", { name: "Activity by recipient" })).toContainText(
    "Cleo Client",
  );
  await again.getByRole("button", { name: "Revoke pack" }).click();
  await again.getByRole("button", { name: "Revoke pack" }).last().click();
  await again.getByRole("button", { name: "Close" }).first().click();

  await guest.reload();
  await expect(guest.getByText("This pack was withdrawn", { exact: false })).toBeVisible();
  await guest.close();
});

test("a pack's public pages answer no-store and a wrong token never opens", async ({ browser }) => {
  const guest = await visitor(browser);
  const token = `xpkl_${"1".repeat(64)}`;
  const open = await guest.request.post(`/share/pack/${token}/open`, {
    form: { accessCode: "000000" },
    maxRedirects: 0,
  });
  expect(open.status()).toBe(303);
  expect(open.headers()["cache-control"]).toContain("no-store");
  expect(open.headers()["x-robots-tag"]).toContain("noindex");
  expect(open.headers()["location"]).toContain("reason=pack_link_invalid");
  const get = await guest.request.get(`/share/pack/${token}/open`, { maxRedirects: 0 });
  expect(get.status()).toBe(303);
  expect(get.headers()["location"]).toBe(`/share/pack/${token}`);
  await guest.close();
});
