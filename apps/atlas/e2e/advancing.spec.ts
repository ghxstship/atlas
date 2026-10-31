import pg from "pg";
import { expect, test } from "./engine-test";
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
  for (const section of [
    "progress",
    "packets",
    "submissions",
    "riders",
    "reconciliation",
    "guests",
  ]) {
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

const DEMO_ORG_ID = "01920000-0000-7000-8000-000000000001";
const DEMO_OWNER = "01920000-0000-7000-8000-000000000101";
const DEMO_PROJECT_ID = "01920000-0000-7000-8000-000000001001";

/** One statement against the local stack only, under the demo Owner's claims. */
async function asOwner<T extends Record<string, unknown>>(
  text: string,
  args: unknown[] = [],
): Promise<T[]> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Only a local stack is changed.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: DEMO_OWNER, role: "authenticated" }),
    ]);
    await client.query("set local role authenticated");
    const result = await client.query(text, args);
    await client.query("commit");
    return result.rows as T[];
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * R9 (RRR-189): a packet takes every section kind, each held to its kind. Reviewing a typed answer,
 * booking its Load In window as a dock slot and reading "Named 2 of 4" need the party's answer from
 * Gateway, so they run in the cross-app journey of apps/gateway/e2e/vendor.spec.ts, which drives these
 * same Atlas screens.
 */
test("R9: a packet takes typed sections, each held to its kind", async ({ page }) => {
  const stamp = Date.now().toString(36);
  // What request sections offer: the org's radio class and a crew pass of the project.
  const [radios] = await asOwner<{ name: string }>(
    `select c.name from app.asset_classes c where c.id = app.ensure_offering_asset_class($1, 'Radios')`,
    [DEMO_ORG_ID],
  );
  const radioName = radios?.name as string;
  const passName = `Crew Pass ${stamp}`;
  await asOwner(
    "insert into app.credential_categories (project_id, code, name) values ($1, $2, $3)",
    [DEMO_PROJECT_ID, `CP${stamp}`.slice(0, 12).toUpperCase(), passName],
  );
  const title = `Vendor Typed Advance ${stamp}`;
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/advancing/packets?create=1`);
  const create = page.getByRole("dialog", { name: "New advance packet" });
  await create.getByLabel("Project").selectOption({ label: "NWS · Northwind Summer Series" });
  await create.getByLabel("Packet name").fill(title);
  await create.getByRole("button", { name: "Create packet" }).click();
  await page.waitForURL(/full=1/);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();

  // Each kind that offers no catalog item: a text answer, files, a Load In window, the crew roster and the guest list.
  const add = async (name: string, kind: string) => {
    await page.getByLabel("New section").fill(name);
    await page.getByLabel("Kind", { exact: true }).selectOption({ label: kind });
    await page.getByRole("button", { name: "Add section" }).click();
    await expect(page.getByText(new RegExp(`\\d+\\. ${name}`))).toBeVisible();
  };
  await add("Arrival notes", "Text");
  await add("Stage plot", "File");
  await add("Load in", "Schedule window");
  await add("Crew", "Crew roster");
  await add("Guests", "Guest list");

  // A request section offers at least one item before it is added.
  await page.getByLabel("New section").fill("Radios");
  await page.getByLabel("Kind", { exact: true }).selectOption({ label: "Item request" });
  await page.getByRole("button", { name: "Add section" }).click();
  await expect(page.getByText("Choose at least one item or pass to offer.")).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // With a choice it goes in: radios per person, and crew passes for the whole team.
  const pick = async (label: string, name: string) => {
    const box = page.getByRole("combobox", { name: label });
    await box.click();
    await box.fill(name);
    await page.getByRole("option", { name }).click();
    await box.press("Escape");
  };
  await page.getByLabel("New section").fill("Radios");
  await page.getByLabel("Kind", { exact: true }).selectOption({ label: "Item request" });
  await page.getByLabel("Each line names a person on the crew roster").check();
  await pick("Items offered", radioName);
  await page.getByRole("button", { name: "Add section" }).click();
  await expect(page.getByText(/\d+\. Radios$/)).toBeVisible();
  await page.getByLabel("New section").fill("Crew passes");
  await page.getByLabel("Kind", { exact: true }).selectOption({ label: "Credential request" });
  await pick("Passes offered", passName);
  await page.getByRole("button", { name: "Add section" }).click();
  await expect(page.getByText(/\d+\. Crew passes$/)).toBeVisible();
  await expect(page.getByRole("list", { name: "Items offered" })).toContainText(radioName);
  await expect(page.getByRole("list", { name: "Passes offered" })).toContainText(passName);
  await expectAccessible(page);

  // The recipient answers under its engagement, with a naming deadline once one is chosen.
  await expect(page.getByLabel("Names due")).toBeDisabled();
});

/**
 * R11 (RRR-192): Advancing > Progress, every outstanding item on one screen. A packet with a Hospitality and a
 * Technical section goes to a recipient; the heatmap shows Missing, then Awaiting review once an answer is recorded,
 * and the tiles count them. The grid is walked from the keyboard to the answer, the recipient is reminded in bulk,
 * and once the Hospitality answer is accepted the Tracks pane offers its sign-off. Moving the Technical section onto
 * the signed-off track reopens it. Checked in both themes and at 375 px.
 */
test("advancing progress", async ({ page, browser }) => {
  const stamp = Date.now().toString(36);
  const title = `Progress Advance ${stamp}`;
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/advancing/packets?create=1`);
  const create = page.getByRole("dialog", { name: "New advance packet" });
  await create.getByLabel("Project").selectOption({ label: "NWS · Northwind Summer Series" });
  await create.getByLabel("Packet name").fill(title);
  await create.getByRole("button", { name: "Create packet" }).click();
  await page.waitForURL(/full=1/);
  const packetUrl = page.url();

  const add = async (name: string, track: string) => {
    await page.getByLabel("New section").fill(name);
    await page.getByLabel("Track", { exact: true }).selectOption({ label: track });
    await page.getByRole("button", { name: "Add section" }).click();
    await expect(page.getByText(new RegExp(`\\d+\\. ${name}$`))).toBeVisible();
  };
  await add("Hotel", "Hospitality");
  await add("Power", "Technical");
  await page
    .getByLabel("Add a recipient")
    .selectOption({ label: "Demo Staging Supply · Organization" });
  await page.getByRole("button", { name: "Add recipient" }).click();
  await expect(page.getByRole("button", { name: "Remove Demo Staging Supply" })).toBeVisible();
  await page.getByRole("button", { name: "Send packet" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Send packet" }).click();
  await expect(page.getByText("Awaiting answers").first()).toBeVisible();

  // The heatmap: nothing answered yet.
  const progress = `/${ORG}/p/NWS/advancing?section=progress`;
  const choosePacket = async (p: typeof page) => {
    const filter = p.getByLabel("Packet", { exact: true });
    if (await filter.count()) await filter.selectOption({ label: title });
  };
  await page.goto(progress);
  await choosePacket(page);
  const grid = page.getByRole("grid", { name: `${title}: answers by recipient and section` });
  await expect(
    grid.getByRole("gridcell", { name: "Demo Staging Supply, Hotel: Missing" }),
  ).toBeVisible();
  await expect(
    grid.getByRole("gridcell", { name: "Demo Staging Supply, Power: Missing" }),
  ).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // One answer comes in by phone; the heatmap and the tiles follow.
  await page.goto(packetUrl);
  await page.getByText("Record an answer given by phone or email").click();
  await page.getByLabel("Section", { exact: true }).selectOption({ label: "Hotel" });
  await page
    .getByLabel("Recipient", { exact: true })
    .selectOption({ label: "Demo Staging Supply" });
  await page.getByLabel("Answer", { exact: true }).fill(`Twelve rooms, three nights ${stamp}.`);
  await page.getByRole("button", { name: "Record answer" }).click();
  await expect(page.getByText(`Twelve rooms, three nights ${stamp}.`)).toBeVisible();
  await page.goto(progress);
  await choosePacket(page);
  const hotel = grid.getByRole("gridcell", { name: "Demo Staging Supply, Hotel: Awaiting review" });
  await expect(hotel).toBeVisible();
  await expect(page.getByText("Awaiting review", { exact: true }).first()).toBeVisible();

  // Remind the recipient with something outstanding.
  await page.getByRole("checkbox", { name: "Select Demo Staging Supply" }).check();
  await page.getByRole("button", { name: "Send reminder" }).click();
  await expect(page.getByText(/^Reminded \d+; \d+ reminded in the last day$/)).toBeVisible();

  // From the keyboard: the grid moves cell by cell, and Enter opens the answer.
  await grid.getByRole("gridcell", { name: "Demo Staging Supply, Power: Missing" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(hotel).toBeFocused();
  await page.keyboard.press("Enter");
  await page.waitForURL(/section=submissions/);
  await expect(page.getByText(`Twelve rooms, three nights ${stamp}.`)).toBeVisible();

  // The Owner accepts it; the Hospitality track is ready, and the Owner signs it off.
  const ownerContext = await browser.newContext({ reducedMotion: "reduce" });
  const owner = await ownerContext.newPage();
  await signIn(owner, "owner@example.com");
  await owner.goto(`/${ORG}/advancing/submissions`);
  await owner
    .getByRole("link", { name: /Hotel.*Demo Staging Supply/ })
    .filter({ hasText: title })
    .click();
  await owner.getByRole("button", { name: "Accept" }).click();
  await expect(owner.getByText(`Twelve rooms, three nights ${stamp}.`)).toHaveCount(0);
  await owner.goto(`${progress}&pane=tracks`);
  await choosePacket(owner);
  const tracks = owner.getByRole("grid", { name: `${title}: tracks by recipient` });
  const hospitality = tracks.getByRole("gridcell", {
    name: /^Demo Staging Supply, Hospitality: Ready for sign-off/,
  });
  await expect(hospitality).toBeVisible();
  await expectAccessibleInBothThemes(owner);
  await hospitality.click();
  const signOff = owner.getByRole("dialog", {
    name: "Sign off Hospitality for Demo Staging Supply",
  });
  await signOff.getByRole("button", { name: "Sign off" }).click();
  await expect(
    tracks.getByRole("gridcell", { name: /^Demo Staging Supply, Hospitality: Signed off/ }),
  ).toBeVisible();

  // Moving the unanswered Power section onto the signed-off track reopens it.
  await page.goto(packetUrl);
  await page.getByRole("button", { name: "Edit Power" }).click();
  await page.getByLabel("Track", { exact: true }).selectOption({ label: "Hospitality" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await owner.goto(`${progress}&pane=tracks`);
  await choosePacket(owner);
  await expect(
    tracks.getByRole("gridcell", { name: /^Demo Staging Supply, Hospitality: Reopened/ }),
  ).toBeVisible();
  await ownerContext.close();

  // At 375 px the panes scroll inside their region, never the page.
  await page.setViewportSize({ width: 375, height: 812 });
  for (const pane of ["packets", "crew", "allocations", "tracks"]) {
    await page.goto(`${progress}&pane=${pane}`);
    await expect(page.locator("h1").first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, pane).toBeLessThanOrEqual(0);
    await expectAccessible(page);
  }
});
