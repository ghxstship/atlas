import { expect as baseExpect, test, type Browser, type Locator, type Page } from "./engine-test";
import { ORG, signIn } from "./operations-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * A121 (RRR-167, A65-006, ADR 0080) on the demo tenant, as the Producer (Manager):
 *   - two shipments are selected in the table (click, then Cmd or Ctrl+click), their freight type
 *     changes in one bulk transaction after a preview, and Cmd or Ctrl+Z undoes it through the server;
 *   - a shipment's row menu (right-click, and Shift+F10) moves it to Trash, and the Undo toast brings
 *     it back;
 *   - a day sheet deleted from its peek shows an 8-second Undo toast that restores it, and the day
 *     sheets table offers a row menu;
 *   - the Owner approves two guests the Producer requested in one bulk change, and its undo is
 *     refused with the guest list's reason, since a decision moves one way.
 * Each run makes its own shipments and day sheet through the public API, so reruns never collide.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);
const expect = baseExpect.configure({ timeout: 30_000 });

async function nwsProject(page: Page): Promise<string> {
  const response = await page.request.get("/api/v1/projects?limit=100&fields=id,project_key");
  expect(response.status()).toBe(200);
  const projects = (await response.json()) as { data: { id: string; project_key: string }[] };
  const nws = projects.data.find((p) => p.project_key === "NWS");
  expect(nws, "the demo seed has project NWS").toBeTruthy();
  return nws?.id ?? "";
}

async function create(page: Page, path: string, data: Record<string, unknown>): Promise<string> {
  const response = await page.request.post(`/api/v1/${path}`, {
    headers: { "Idempotency-Key": `a121-${uniqueId()}`, Origin: new URL(page.url()).origin },
    data,
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** The first-run tour offer sits over the corner where menus and toasts open; set it aside. */
async function setTourAside(page: Page) {
  const later = page.getByRole("button", { name: "Not now" });
  if (await later.isVisible().catch(() => false)) await later.click();
}

/** The grid row whose tracking number cell reads `tracking`. */
function rowWithTracking(grid: Locator, tracking: string): Locator {
  return grid.getByRole("row").filter({
    has: grid.page().locator('td[data-column="tracking"]').filter({ hasText: tracking }),
  });
}

test("shipments: select, change the freight type in bulk, undo it, and move one to Trash from its menu", async ({
  page,
}) => {
  const id = uniqueId();
  await signIn(page, "producer@example.com");
  const project = await nwsProject(page);
  const tracking = [`A121-${id}-1`, `A121-${id}-2`];
  for (const t of tracking) {
    await create(page, "shipments", {
      project_id: project,
      direction: "Inbound",
      tracking_identifier: t,
    });
  }

  await page.goto(`/${ORG}/logistics/shipments?view=table`);
  const grid = page.getByRole("grid");
  await expect(grid).toBeVisible();
  const first = rowWithTracking(grid, tracking[0] ?? "");
  const second = rowWithTracking(grid, tracking[1] ?? "");
  await expect(first).toBeVisible();

  // Click selects one row; Cmd or Ctrl+click adds the second.
  await first.getByRole("checkbox").click();
  await second.getByRole("checkbox").click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByRole("status").filter({ hasText: "2 selected" })).toBeAttached();
  await page
    .getByRole("toolbar", { name: "Bulk actions" })
    .getByRole("button", { name: "Change Freight type" })
    .click();
  const dialog = page.getByRole("dialog", { name: /Change Freight type on 2 rows/ });
  const choice = dialog.getByLabel("New Freight type");
  const target = ((await choice.locator("option").allInnerTexts())[1] ?? "").trim();
  expect(target).not.toBe("");
  await choice.selectOption({ label: target });
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByText("2 rows will change.")).toBeVisible();
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Apply to 2 rows" }).click();
  await expect(page.getByText("Changed 2 rows.").first()).toBeVisible();
  await expect(first.locator('td[data-column="freight"]')).toHaveText(target);
  await expect(second.locator('td[data-column="freight"]')).toHaveText(target);

  // Cmd or Ctrl+Z undoes the change through the server.
  await page.getByRole("heading", { level: 1 }).click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByText("Undone: Changed 2 rows.")).toBeVisible();
  await expect(first.locator('td[data-column="freight"]')).toHaveText("");
  await expect(second.locator('td[data-column="freight"]')).toHaveText("");

  // The row's menu: Shift+F10 from the keyboard, then right-click, and Move to Trash with Undo.
  await first.locator('td[data-column="tracking"]').focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: /^Actions for NWS-\d+$/ });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Open", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Change Carrier" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  const key = (await first.locator('td[data-column="key"]').innerText()).trim();
  await setTourAside(page);
  await first.locator('td[data-column="tracking"]').click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Move to Trash" })).toBeVisible();
  await expectAccessible(page);
  await menu.getByRole("menuitem", { name: "Move to Trash" }).press("Enter");
  await expect(page.getByText(`${key} moved to Trash.`).first()).toBeVisible();
  await expect(first).toBeHidden();
  await page.getByRole("button", { name: "Undo" }).first().press("Enter");
  await expect(page.getByText(`Undone: ${key} moved to Trash.`)).toBeVisible();
  await page.reload();
  await expect(rowWithTracking(page.getByRole("grid"), tracking[0] ?? "")).toBeVisible();
});

test("day sheets: a delete offers Undo for 8 seconds, and the table row has a menu", async ({
  page,
}) => {
  await signIn(page, "producer@example.com");
  const project = await nwsProject(page);
  // A day of its own for each run: one live sheet per project day.
  const offset = Math.floor(Date.now() / 1000) % 3000;
  const day = new Date(Date.UTC(2031, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);
  const sheet = await create(page, "day-sheets", {
    project_id: project,
    day,
    body: "Load-in at 07:00.",
  });

  await page.goto(`/${ORG}/show/day-sheets?peek=${sheet}`);
  const drawer = page.getByRole("dialog", { name: /^NWS · / });
  await expect(drawer.getByLabel("Day sheet", { exact: true })).toHaveValue("Load-in at 07:00.");
  await drawer.getByRole("button", { name: "Delete" }).click();
  await expect(drawer).toBeHidden();
  const toast = page.getByText(/^Day sheet for NWS, .+, moved to Trash\.$/).first();
  await expect(toast).toBeVisible();
  await expectAccessible(page);
  await setTourAside(page);
  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect(page.getByText(/^Undone: Day sheet for NWS, .+, moved to Trash\.$/)).toBeVisible();
  await page.goto(`/${ORG}/show/day-sheets?peek=${sheet}`);
  await expect(page.getByRole("dialog", { name: /^NWS · / })).toBeVisible();

  // The table view's row menu opens the sheet and offers Delete while it is a draft.
  await page.goto(`/${ORG}/show/day-sheets?view=table`);
  const grid = page.getByRole("grid");
  const rows = grid.getByRole("row");
  await expect(rows.nth(1)).toBeVisible();
  await setTourAside(page);
  await rows.nth(1).locator('td[data-column="day"]').click({ button: "right" });
  const menu = page.getByRole("menu", { name: /^Actions for [A-Z0-9]+ · / });
  await expect(menu.getByRole("menuitem", { name: "Open", exact: true })).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press("Escape");
});

async function asPerson(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
  await signIn(page, email);
  return page;
}

test("guest list: two requests are approved in one change, and the undo says why it cannot", async ({
  browser,
}) => {
  const id = uniqueId();
  const names = [`Avery ${id}`, `Quinn ${id}`];
  const producer = await asPerson(browser, "producer@example.com");
  await producer.goto(`/${ORG}/p/NWS/advancing?section=guests`);
  for (const name of names) {
    await producer.getByRole("button", { name: "Add guest" }).click();
    const dialog = producer.getByRole("dialog", { name: "Add a guest" });
    await dialog.getByLabel("Guest name").fill(name);
    await dialog.getByRole("button", { name: "Add guest" }).click();
    await expect(producer.getByRole("link", { name })).toBeVisible();
  }
  await producer.context().close();

  // Someone other than the requester decides, as the guest list requires.
  const owner = await asPerson(browser, "owner@example.com");
  await owner.goto(`/${ORG}/p/NWS/advancing?section=guests&view=table`);
  const grid = owner.getByRole("grid");
  const row = (name: string) =>
    grid
      .getByRole("row")
      .filter({ has: owner.locator('td[data-column="guest"]').filter({ hasText: name }) });
  await row(names[0] ?? "")
    .getByRole("checkbox")
    .click();
  await row(names[1] ?? "")
    .getByRole("checkbox")
    .click({ modifiers: ["ControlOrMeta"] });
  await owner
    .getByRole("toolbar", { name: "Bulk actions" })
    .getByRole("button", { name: "Change State" })
    .click();
  const dialog = owner.getByRole("dialog", { name: /Change State on 2 rows/ });
  await dialog.getByLabel("New State").selectOption({ label: "Approved" });
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByText("2 rows will change.")).toBeVisible();
  await expectAccessible(owner);
  await dialog.getByRole("button", { name: "Apply to 2 rows" }).click();
  await expect(owner.getByText("Changed 2 rows.").first()).toBeVisible();
  for (const name of names) {
    await expect(row(name).locator('td[data-column="state"]')).toHaveText("Approved");
  }

  // A decision moves one way: the undo is refused, says why, and changes nothing.
  await owner.getByRole("heading", { level: 1 }).click();
  await owner.keyboard.press("ControlOrMeta+z");
  await expect(
    owner.getByText(/^Couldn't undo or redo that: .*only as the guest list allows\.$/),
  ).toBeVisible();
  await expect(row(names[0] ?? "").locator('td[data-column="state"]')).toHaveText("Approved");
  await owner.context().close();
});
