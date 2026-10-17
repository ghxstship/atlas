import { expect, test } from "@playwright/test";
import { expectAccessible } from "./support";
import { expectAccessibleInBothThemes, ORG, signIn } from "./operations-support";

/**
 * A10 Advancing journeys (Section 20.2, RRR-56) on the demo tenant seed (supabase/seeds/0010, 0107,
 * 0109 and 0110). Journey 13: build an advance packet, send it to a recipient with a Gateway link,
 * record and review answers, record the rider, and reconcile against venue capability, where a
 * critical UNKNOWN shows as a gate 3 gap. The guest list moves from request to door. Journey 50
 * (answer by link, then claim) runs in apps/gateway/e2e/tokens.spec.ts against 0430's RPCs. Every
 * page is checked with axe in both themes.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);
expect.configure({ timeout: 20_000 });

test("every Advancing page and view renders accessibly", async ({ page }) => {
  await signIn(page, "producer@example.com");
  for (const view of ["list", "table", "board"]) {
    await page.goto(`/${ORG}/advancing/packets?view=${view}`);
    await expect(page.getByRole("heading", { level: 1, name: "Packets" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
  }
  await page.goto(`/${ORG}/advancing/submissions?filter=all`);
  await expect(page.getByRole("heading", { level: 1, name: "Submissions" })).toBeVisible();
  await expectAccessibleInBothThemes(page);
  for (const view of ["list", "table"]) {
    await page.goto(`/${ORG}/advancing/riders?view=${view}`);
    await expect(page.getByRole("heading", { level: 1, name: "Riders" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
  }
  for (const view of ["table", "matrix"]) {
    await page.goto(`/${ORG}/advancing/reconciliation?view=${view}`);
    await expect(page.getByRole("heading", { level: 1, name: "Reconciliation" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
  }
  for (const section of ["packets", "submissions", "riders", "reconciliation", "guests"]) {
    await page.goto(`/${ORG}/p/NWS/advancing?section=${section}`);
    await expect(page.getByRole("navigation", { name: "Advancing sections" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
  }
});

test("Advancing works at 375 px without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, "producer@example.com");
  for (const path of [
    `/${ORG}/advancing/packets`,
    `/${ORG}/advancing/submissions?filter=all`,
    `/${ORG}/p/NWS/advancing?section=guests`,
  ]) {
    await page.goto(path);
    await expect(page.locator("h1").first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
    await expectAccessible(page);
  }
});

test("journey 13: build, send and review an advance, record the rider and reconcile", async ({
  page,
  browser,
}) => {
  const stamp = Date.now().toString(36);
  const title = `Opener Advance ${stamp}`;
  await signIn(page, "producer@example.com");

  // Build the packet.
  await page.goto(`/${ORG}/advancing/packets?create=1`);
  const create = page.getByRole("dialog", { name: "New advance packet" });
  await create.getByLabel("Project").selectOption({ label: "NWS · Northwind Summer Series" });
  await create.getByLabel("Packet name").fill(title);
  await expectAccessible(page);
  await create.getByRole("button", { name: "Create packet" }).click();
  await page.waitForURL(/full=1/);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();

  await page.getByLabel("New section").fill("Arrival");
  await page.getByLabel("What the recipient is asked").last().fill("When do you arrive?");
  await page.getByRole("button", { name: "Add section" }).click();
  await expect(page.getByText("1. Arrival")).toBeVisible();
  await page
    .getByLabel("Add a recipient")
    .selectOption({ label: "Demo Staging Supply · Organization" });
  await page.getByRole("button", { name: "Add recipient" }).click();
  await expect(page.getByRole("button", { name: "Remove Demo Staging Supply" })).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // Send it; the section list is then fixed.
  await page.getByRole("button", { name: "Send packet" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Send packet" }).click();
  await expect(page.getByText("Awaiting answers").first()).toBeVisible();
  await expect(page.getByLabel("New section")).toHaveCount(0);

  // Issue the Gateway link: the token path and code are shown once.
  await page.getByLabel("Email for Demo Staging Supply").fill("vendor@example.com");
  await page.getByRole("button", { name: "Issue link" }).click();
  await expect(page.getByText("Link issued")).toBeVisible();
  // The link is shown in full when GATEWAY_SITE_URL names Gateway's origin, as a path otherwise.
  await expect(page.getByText(/^(https?:\/\/[^/\s]+)?\/advance\/xadv_[0-9a-f]{64}$/)).toBeVisible();
  await expectAccessible(page);

  // Record a phone answer; the Producer cannot review their own (sod_advance_submitter).
  await page.getByText("Record an answer given by phone or email").click();
  await page.getByLabel("Section", { exact: true }).selectOption({ label: "Arrival" });
  await page
    .getByLabel("Recipient", { exact: true })
    .selectOption({ label: "Demo Staging Supply" });
  await page.getByLabel("Answer", { exact: true }).fill("Landing 13:05 with a party of four.");
  await page.getByRole("button", { name: "Record answer" }).click();
  await expect(page.getByText("Landing 13:05 with a party of four.")).toBeVisible();
  await page.getByRole("button", { name: "Accept" }).first().click();
  await expect(
    page.getByText("You recorded this answer, so someone else must review it."),
  ).toBeVisible();

  // The Owner reviews it from the queue.
  const ownerContext = await browser.newContext({ reducedMotion: "reduce" });
  const owner = await ownerContext.newPage();
  await signIn(owner, "owner@example.com");
  await owner.goto(`/${ORG}/advancing/submissions`);
  await owner
    .getByRole("link", { name: /Arrival.*Demo Staging Supply/ })
    .filter({ hasText: title })
    .click();
  await expect(owner.getByText("Landing 13:05 with a party of four.")).toBeVisible();
  await expectAccessibleInBothThemes(owner);
  await owner.getByRole("button", { name: "Accept" }).click();
  // The queue moves on; the answer now sits under Reviewed as Accepted.
  await expect(owner.getByText("Landing 13:05 with a party of four.")).toHaveCount(0);
  await owner.goto(`/${ORG}/advancing/submissions?filter=reviewed`);
  await owner
    .getByRole("link", { name: /Arrival.*Demo Staging Supply/ })
    .filter({ hasText: title })
    .click();
  await expect(owner.getByText("Landing 13:05 with a party of four.")).toBeVisible();
  await expect(owner.getByText("Accepted", { exact: true }).first()).toBeVisible();
  await ownerContext.close();

  // Record the rider received from the talent and fulfill an ask.
  await page.goto(`/${ORG}/advancing/riders?create=1`);
  const rider = page.getByRole("dialog", { name: "New rider" });
  await rider.getByLabel("Project").selectOption({ label: "NWS · Northwind Summer Series" });
  await rider.getByLabel("Rider name").fill(`Opener Technical Rider ${stamp}`);
  await rider.getByRole("button", { name: "Create rider" }).click();
  await page.waitForURL(/full=1/);
  await page.getByLabel("Ask", { exact: true }).fill("Two vocal microphones");
  await page.getByLabel("Quantity", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Add ask" }).click();
  await expect(page.getByText("Two vocal microphones")).toBeVisible();
  await page.getByRole("button", { name: "Mark fulfilled" }).click();
  await expect(page.getByText(/Fulfilled /)).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // Reconcile against the venue: house power is stated UNKNOWN on a critical requirement.
  await page.goto(`/${ORG}/p/NWS/advancing?section=reconciliation`);
  await page.getByRole("button", { name: "Reconcile now" }).click();
  await page.waitForURL(/full=1/);
  await expect(page.getByText("Gate 3 is blocked")).toBeVisible();
  await expect(page.getByRole("cell", { name: /Three-phase 400 A power/ })).toBeVisible();
  await expectAccessibleInBothThemes(page);
});

test("guest list: a requested guest is approved by another person and checked in", async ({
  page,
}) => {
  const name = `Guest ${Date.now().toString(36)}`;
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/p/NWS/advancing?section=guests`);
  await page.getByRole("button", { name: "Add guest" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a guest" });
  await dialog.getByLabel("Guest name").fill(name);
  await dialog.getByLabel("Plus-ones").fill("1");
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Add guest" }).click();
  await expect(page.getByRole("link", { name })).toBeVisible();

  // The requester cannot approve their own guest.
  await page.getByRole("button", { name: `Approve ${name}` }).click();
  await expect(
    page.getByText("You requested this guest, so someone else must approve or decline them."),
  ).toBeVisible();

  // A guest someone else requested is approved, then checked in at the door.
  await page.getByRole("button", { name: "Approve Riley Chen" }).click();
  await expect(page.getByRole("button", { name: "Check in Riley Chen" })).toBeVisible();
  await page.getByRole("button", { name: "Check in Riley Chen" }).click();
  await expect(page.getByRole("button", { name: "Check in Riley Chen" })).toHaveCount(0);
  await page.getByRole("link", { name: "Riley Chen" }).click();
  await expect(page.getByRole("dialog", { name: "Riley Chen" })).toBeVisible();
  await expectAccessibleInBothThemes(page);
});
