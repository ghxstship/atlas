import { expect, settle, test, type Browser, type Page } from "./engine-test";
import { cognitiveLoadProblems } from "./a11y/checks";
import {
  deliverPacks,
  displayLink,
  latestMail,
  mailLinks,
  personOf,
  projectOf,
  sql,
  storedFile,
} from "./b2-support";
import { createOrganization, signUp, testEmail, uniqueId } from "./support";

/**
 * B2 stakeholder packs (RRR-226, ADR 0141; gap G-29) on a fresh org: make a pack, add a live view and a file, add two
 * recipients, each code shows at once and neither is lost to the other, the email carries a link and no code, a visitor
 * with no session opens with the code, views, downloads and acknowledges, a later email's link opens with no code, Activity
 * counts each, and revoking ends access. Every visitor is a fresh browser context.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);

async function newOwnerOrg(page: Page): Promise<{ slug: string; email: string }> {
  const id = uniqueId();
  const slug = `b2-${id}`;
  const email = testEmail("owner", id);
  await signUp(page, { name: "Pat Packer", email });
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
  return { slug, email };
}

async function visitor(browser: Browser): Promise<Page> {
  return (await browser.newContext({ reducedMotion: "reduce" })).newPage();
}

/** How many times this recipient's opens were logged. */
async function opens(email: string): Promise<number> {
  const [row] = await sql<{ n: number }>(
    `select count(*)::int as n from app.stakeholder_pack_events e
       join app.stakeholder_pack_recipients r on r.id = e.recipient_id
      where r.email = $1 and e.action = 'Opened'`,
    [email],
  );
  return row?.n ?? 0;
}

test("a pack opens with the recipient's code, serves its items and stops when revoked", async ({
  page,
  browser,
}) => {
  const { slug, email: ownerEmail } = await newOwnerOrg(page);
  const id = uniqueId();
  const owner = await personOf(ownerEmail);
  const project = await projectOf(slug, "SHW");
  await displayLink(owner, project, `Load-in ${id}`);
  await storedFile({
    person: owner,
    subjectTable: "app.projects",
    subjectId: project,
    name: `site-map-${id}.pdf`,
  });

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
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Save details" }).click();

  // Saving moves to Items: a live view and a file, one at a time, the form clearing after each.
  const subject = dialog.getByLabel("What to share");
  await expect(subject.locator("option")).toHaveCount(3);
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  await subject.selectOption({ index: 1 });
  await dialog.getByLabel("Title recipients see").fill("Show clock");
  await dialog.getByRole("button", { name: "Add item" }).click();
  await expect(dialog.getByRole("listitem").filter({ hasText: "Show clock" })).toBeVisible();
  await expect(dialog.getByLabel("Title recipients see")).toHaveValue("");
  await dialog.getByLabel("What to share").selectOption({ index: 2 });
  await dialog.getByLabel("Title recipients see").fill("Site map");
  await dialog.getByLabel("Ask to acknowledge").check();
  await dialog.getByRole("button", { name: "Add item" }).click();
  await expect(dialog.getByRole("listitem").filter({ hasText: "Site map" })).toBeVisible();

  // Two recipients in a row: each code is readable in the dialog at once, and the second does not replace the first.
  const cleo = `cleo-${id}@client.test`;
  await dialog.getByRole("button", { name: "Recipients", exact: true }).click();
  const codes = dialog.locator("[data-outside-reveal-code]");
  await dialog.getByLabel("Name", { exact: true }).fill("Cleo Client");
  await dialog.getByLabel("Email", { exact: true }).fill(cleo);
  await dialog.getByRole("button", { name: "Add recipient" }).click();
  await expect(codes).toHaveCount(1);
  const code = (await codes.first().textContent()) as string;
  expect(code).toMatch(/^[0-9]{6}$/);
  await expect(
    dialog.getByText("Give Cleo Client this code by phone or message.", { exact: false }),
  ).toBeVisible();
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("");
  await dialog.getByLabel("Name", { exact: true }).fill("Dan Dept");
  await dialog.getByLabel("Email", { exact: true }).fill(`dan-${id}@client.test`);
  await dialog.getByRole("button", { name: "Add recipient" }).click();
  await expect(codes).toHaveCount(2);
  await expect(codes.last()).toHaveText(code);
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Close" }).first().click();

  // Both codes stay above the list through the section's refresh, each until dismissed.
  const panels = page.locator("[data-outside-reveal]");
  await expect(panels).toHaveCount(2);
  await expect(panels.last().getByRole("textbox", { name: "Access code" })).toHaveValue(code);
  await expect(section.getByText(`Client pack ${id} · Cleo Client`)).toBeVisible();

  await section.getByRole("button", { name: "Manage packs", exact: true }).click();
  const manage = page.getByRole("dialog");
  await manage.getByRole("button", { name: "Open", exact: true }).click();
  await manage.getByRole("button", { name: "Delivery", exact: true }).click();
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  await manage.getByRole("button", { name: "Send invite or resend" }).click();
  await expect(manage.getByText("2 emails queued")).toBeVisible();
  await manage.getByRole("button", { name: "Close" }).first().click();

  // One pass of the worker: the email carries a sign-in link, never the code or a file.
  await deliverPacks(new URL(page.url()).origin);
  const mail = await latestMail(page.request, cleo);
  expect(mail.text).not.toContain(code);
  expect(mail.html).not.toContain(code);
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
  expect(await opens(cleo)).toBe(1);

  // A live item shows on its own page; coming back neither logs a second open nor swaps the grant under the page.
  const clock = guest.getByRole("listitem").filter({ hasText: "Show clock" });
  await clock.getByRole("link", { name: "View", exact: true }).click();
  await guest.waitForURL(/\/items\//);
  await guest.getByRole("link", { name: "Back to the pack" }).click();
  await expect(guest.getByRole("heading", { name: `Client pack ${id}` })).toBeVisible();
  await settle(guest);
  expect(await opens(cleo)).toBe(1);

  // The file downloads, and the acknowledgement is a receipt the page then shows.
  const row = guest.getByRole("listitem").filter({ hasText: "Site map" });
  const download = guest.waitForEvent("download");
  await row.getByRole("button", { name: "Download", exact: true }).click();
  expect((await download).suggestedFilename()).toBe(`site-map-${id}.pdf`);
  await row.getByLabel("Type your name to acknowledge").fill("Cleo Client");
  await row.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await expect(guest.getByText("You acknowledged this on", { exact: false })).toBeVisible();

  // Next week's email opens on this device with no code.
  await section.getByRole("button", { name: "Manage packs", exact: true }).click();
  const resend = page.getByRole("dialog");
  await resend.getByRole("button", { name: "Open", exact: true }).click();
  await resend.getByRole("button", { name: "Delivery", exact: true }).click();
  await resend.getByRole("button", { name: "Send invite or resend" }).click();
  await expect(resend.getByText("2 emails queued")).toBeVisible();
  await resend.getByRole("button", { name: "Close" }).first().click();
  await deliverPacks(new URL(page.url()).origin);
  await expect(async () => {
    const later = mailLinks(await latestMail(page.request, cleo)).pack;
    expect(later).not.toBe(pack);
    await guest.goto(later);
  }).toPass();
  await expect(guest.getByRole("heading", { name: `Client pack ${id}` })).toBeVisible();
  await expect(guest.getByLabel("Access code")).toHaveCount(0);
  await expect.poll(() => opens(cleo)).toBe(2);

  // Activity shows each, and revoking the pack ends access.
  await section.getByRole("button", { name: "Manage packs", exact: true }).click();
  const again = page.getByRole("dialog");
  await again.getByRole("button", { name: "Open", exact: true }).click();
  await again.getByRole("button", { name: "Activity", exact: true }).click();
  const grid = again.getByRole("grid", { name: "Activity by recipient" });
  const activity = grid.getByRole("row").filter({ hasText: "Cleo Client" });
  await expect(activity.getByRole("cell").nth(1)).toHaveText("2");
  await expect(activity.getByRole("cell").nth(3)).toHaveText("1");
  await expect(activity.getByRole("cell").nth(4)).toHaveText("1");
  await expect(
    again.getByText("Cleo Client acknowledged Site map on", { exact: false }),
  ).toBeVisible();
  await again.getByRole("button", { name: "Revoke pack" }).click();
  await again.getByRole("button", { name: "Revoke pack" }).last().click();
  await expect(again.getByRole("button", { name: "Revoke pack" })).toHaveCount(0);
  await again.getByRole("button", { name: "Close" }).first().click();

  await guest.reload();
  await expect(guest.getByText("This pack was withdrawn", { exact: false })).toBeVisible();
  await guest.context().close();
});

test("a pack's public pages answer no-store and a wrong token never opens", async ({ browser }) => {
  const guest = await visitor(browser);
  const token = `xpkl_${"1".repeat(64)}`;
  const open = await guest.request.post(`/share/pack/${token}/open`, {
    form: { accessCode: "000000" },
    headers: { Origin: process.env["E2E_BASE_URL"] ?? "http://127.0.0.1:3006" },
    maxRedirects: 0,
  });
  expect(open.status()).toBe(303);
  expect(open.headers()["cache-control"]).toContain("no-store");
  expect(open.headers()["x-robots-tag"]).toContain("noindex");
  expect(open.headers()["location"]).toContain("reason=pack_link_invalid");
  const get = await guest.request.get(`/share/pack/${token}/open`, { maxRedirects: 0 });
  expect(get.status()).toBe(303);
  expect(get.headers()["location"]).toBe(`/share/pack/${token}`);
  await guest.context().close();
});
