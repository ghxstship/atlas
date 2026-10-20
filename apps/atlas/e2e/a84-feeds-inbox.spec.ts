import { createClient } from "@supabase/supabase-js";
import { expect as baseExpect, test, type Page } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * A84 journeys (RRR-129, finding A65-018, Section 4.6.5):
 *   - calendar feeds: add a feed in Personal settings, subscribe with its link (a valid
 *     VCALENDAR), get a new link (the old one answers 404), revoke (the new one answers 404);
 *   - the project inbox: create the project's address in Project Settings, deliver mail to it as
 *     the inbound-email Edge Function does, file it as a document from the Documents tab, and
 *     discard mail whose sender did not verify.
 * Each run signs up a new owner in a new org on the local stack, so runs never collide. Delivering
 * mail needs E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_KEY for the local stack (the development
 * key `supabase status` prints, never a hosted project's).
 */

test.use({ reducedMotion: "reduce" });
// Server actions compile on first use under next dev, so their results get longer to show.
const expect = baseExpect.configure({ timeout: 30_000 });
// Each journey signs up, creates an org and visits several pages that compile on first use.
test.setTimeout(180_000);

async function newOwnerOrg(page: Page, prefix: string): Promise<{ slug: string; name: string }> {
  const id = uniqueId();
  const slug = `${prefix}-${id}`;
  const name = `Feeds ${id}`;
  await signUp(page, { name: "Pat Producer", email: testEmail("owner", id) });
  await createOrganization(page, { name, slug });
  return { slug, name };
}

async function shownLink(page: Page, scope = page.locator("body")): Promise<string> {
  const panel = scope.getByTestId("calendar-feed-link").last();
  await expect(panel).toBeVisible();
  const link = await panel.getByLabel("Subscription link").inputValue();
  expect(link).toMatch(/\/ical\/xcal_[0-9a-f]{64}\.ics$/);
  return link;
}

test("calendar feeds: subscribe, get a new link and revoke", async ({ page }) => {
  const { slug, name } = await newOwnerOrg(page, "ical");
  await page.goto(`/${slug}/me/calendar-feeds`);
  await expect(page.getByRole("heading", { name: "Calendar feeds", level: 2 })).toBeVisible();
  await expect(page.getByText("You have no calendar feeds in this organization yet.")).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("button", { name: "Add feed" }).click();
  const first = await shownLink(page);
  const live = await page.request.get(first);
  expect(live.status()).toBe(200);
  expect(live.headers()["content-type"]).toBe("text/calendar; charset=utf-8");
  expect(live.headers()["cache-control"]).toBe("private, no-cache");
  const body = await live.text();
  expect(body.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
  expect(body).toContain(`X-WR-CALNAME:My schedule at ${name}`);
  expect(body.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
  await expect(page.getByRole("list", { name: "Your calendar feeds" })).toContainText("My schedule");
  await expectAccessible(page);

  await page.reload();
  await expect(page.getByTestId("calendar-feed-link")).toHaveCount(0);
  await page.getByRole("button", { name: "Get a new link for My schedule" }).click();
  const rotate = page.getByRole("dialog", { name: "Get a new link?" });
  await expect(rotate).toBeVisible();
  await expectAccessible(page);
  await rotate.getByRole("button", { name: "Get a new link" }).click();
  await expect(rotate).toBeHidden();
  const second = await shownLink(page);
  expect(second).not.toBe(first);
  expect((await page.request.get(first)).status()).toBe(404);
  expect((await page.request.get(second)).status()).toBe(200);

  await page.getByRole("button", { name: "Revoke My schedule" }).click();
  const revoke = page.getByRole("dialog", { name: "Revoke this feed?" });
  await revoke.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("You have no calendar feeds in this organization yet.")).toBeVisible();
  expect((await page.request.get(second)).status()).toBe(404);
  expect((await page.request.get("/ical/not-a-feed.ics")).status()).toBe(404);
});

async function createProject(page: Page, slug: string, key: string, name: string) {
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill(key);
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/${key}/overview`);
}

/** Delivers one message as the inbound-email Edge Function does (app.receive_inbound_email). */
async function deliver(localPart: string, input: { subject: string; dkim: boolean; id: string }) {
  const url = process.env["E2E_SUPABASE_URL"];
  const key = process.env["E2E_SUPABASE_SERVICE_KEY"];
  if (!url || !key)
    throw new Error("Set E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_KEY to the local stack.");
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url))
    throw new Error("Mail is delivered here to a local stack only.");
  const db = createClient(url, key, {
    db: { schema: "app" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await db.rpc("receive_inbound_email", {
    p_local_part: localPart,
    p_from_address: "rigging@bayside-audio.test",
    p_subject_line: input.subject,
    p_message_id_header: `<${input.id}@bayside-audio.test>`,
    p_dkim_verified: input.dkim,
    p_body_text: "Updated plot attached. Load in moves to 07:00.",
    p_raw_object_path: `raw/${input.id}.eml`,
  });
  if (error) throw new Error(`receive_inbound_email: ${error.message}`);
}

test("project inbox: create the address, file mail as a document, discard unverified mail", async ({
  page,
}) => {
  const { slug } = await newOwnerOrg(page, "inbox");
  // Project keys are two to five capital letters.
  const key = `I${[...uniqueId().slice(-4)]
    .map((c) => String.fromCharCode(65 + (c.charCodeAt(0) % 26)))
    .join("")}`;
  await createProject(page, slug, key, "Harbor Lights Pier Nights");

  await page.goto(`/${slug}/p/${key}/settings`);
  const settings = page.locator('section[aria-labelledby="project-inbox-settings"]');
  await expect(settings).toContainText("This project has no inbox address yet.");
  await settings.getByRole("button", { name: "Create inbox address" }).click();
  const address = settings.getByLabel("Inbox address");
  await expect(address).toBeVisible();
  const full = await address.inputValue();
  expect(full).toMatch(new RegExp(`^${key.toLowerCase()}-[0-9a-f]{10}@`));
  await expectAccessible(page);
  const localPart = full.slice(0, full.indexOf("@"));
  const id = uniqueId();
  await deliver(localPart, { subject: `Rigging plot ${id}`, dkim: true, id: `ok-${id}` });
  await deliver(localPart, { subject: `Spoofed ${id}`, dkim: false, id: `bad-${id}` });

  await page.goto(`/${slug}/p/${key}/documents`);
  const inbox = page.locator('section[aria-labelledby="project-inbox"]');
  await expect(inbox).toContainText("1 message to file");
  const items = inbox.getByTestId("inbox-item");
  await expect(items).toHaveCount(2);
  await expectAccessible(page);

  const verified = items.filter({ hasText: `Rigging plot ${id}` });
  await verified.getByRole("button", { name: "File" }).click();
  const file = page.getByRole("dialog", { name: "File as a document" });
  await expect(file.getByLabel("Document title")).toHaveValue(`Rigging plot ${id}`);
  await expectAccessible(page);
  await file.getByLabel("Document title").fill(`Rigging plot ${id}, venue copy`);
  await file.getByRole("button", { name: "File" }).click();
  await expect(file).toBeHidden();
  await expect(inbox).toContainText("Nothing to file.");
  await expect(page.getByText(`Rigging plot ${id}, venue copy`).first()).toBeVisible();

  const spoofed = inbox.getByTestId("inbox-item").filter({ hasText: `Spoofed ${id}` });
  await expect(spoofed).toContainText("Sender not verified");
  await expect(spoofed.getByRole("button", { name: "File" })).toHaveCount(0);
  await spoofed.getByRole("button", { name: "Discard" }).click();
  const discard = page.getByRole("dialog", { name: "Discard this message?" });
  await discard.getByRole("textbox").fill("Forged sender.");
  await discard.getByRole("button", { name: "Discard" }).click();
  await expect(discard).toBeHidden();
  await expect(inbox.getByTestId("inbox-item")).toHaveCount(0);

  await inbox.getByRole("link", { name: "Show filed and discarded" }).click();
  await expect(inbox.getByTestId("inbox-item")).toHaveCount(2);
  await expect(inbox).toContainText(`Filed as Rigging plot ${id}, venue copy by Pat Producer`);
  await expect(inbox).toContainText("Reason: Forged sender.");
  await expectAccessible(page);
});
