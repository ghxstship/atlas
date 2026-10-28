import { latencyOf } from "@xos/testing";
import { expectAcknowledged, watchFor } from "@xos/testing/playwright";
import { apiPost, DEMO_ORG, signInAs } from "./a36-support";
import { expect as baseExpect, settle, test, type Page } from "./engine-test";
import { uniqueId } from "./support";

/**
 * A145 (Section 11.10 rule 9, RRR-208): every action acknowledges within 100 ms. Each journey measures, inside the
 * page, from the pointer or key press to the first frame that shows the action's outcome, on the demo tenant
 * (seeds 0010, 0107 and 0115, project NWS): an inline edit in the budget grid, a record's state change on the
 * board, an approval from the Inbox, a page pinned to Favorites and a record created from the quick add row. After
 * each, the server's answer is checked to agree with what was shown.
 */

test.use({ reducedMotion: "reduce" });
test.describe.configure({ timeout: 180_000 });
const expect = baseExpect.configure({ timeout: 20_000 });

const PROJECT = "NWS";
const PROJECT_ID = "01920000-0000-7000-8000-000000001001";

/**
 * Keeps, beside the acknowledgment, when the server's own answer reached the screen: what the person waited for
 * before the change was optimistic.
 */
function noteServer(label: string, elapsedMs: number): void {
  test.info().annotations.push({
    type: "latency",
    description: `${label}, server answer on screen: ${elapsedMs.toFixed(1)} ms`,
  });
}

/** The project's chip under a quick add field, once `~NWS` has resolved. */
function scopeChip(field: ReturnType<Page["getByRole"]>) {
  return field
    .locator("xpath=ancestor::form[1]/following-sibling::div[1]")
    .getByText("Northwind Summer Series", { exact: true });
}

/** Creates a record on NWS from the quick add row of All records, where `title` is the only match. */
async function quickAddRecord(page: Page, title: string): Promise<void> {
  await page.goto(`/${DEMO_ORG}/work/all-records?q=${encodeURIComponent(title)}`);
  // The row loads with the page's other client code.
  await settle(page);
  const field = page.getByRole("textbox", { name: "Quick add a record" });
  await field.fill(`${title} ~${PROJECT}`);
  // The scope resolves to the project before the line is saved, as a person sees its chip.
  await expect(scopeChip(field)).toBeVisible();
  await field.press("Enter");
  await page.waitForURL(/peek=NWS-\d+/);
}

test("create: the quick add row shows the record being added within 100 ms", async ({ page }) => {
  const title = `Latency create ${uniqueId()}`;
  await signInAs(page, "owner@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/work/all-records?q=${encodeURIComponent(title)}`);
  await settle(page);
  const field = page.getByRole("textbox", { name: "Quick add a record" });
  await field.fill(`${title} ~${PROJECT}`);
  await expect(scopeChip(field)).toBeVisible();

  const peekOpen = await watchFor(page, { selector: '[role="dialog"]', text: title });
  await expectAcknowledged(page, "Quick add create", () => field.press("Enter"), {
    selector: "p",
    text: `Adding ${title}`,
  });
  noteServer("Quick add create", latencyOf(await peekOpen()));
  // The server's record opens in the peek, and the line it replaced is gone.
  await page.waitForURL(/peek=NWS-\d+/);
  await expect(page.getByRole("dialog", { name: title })).toBeVisible();
  await expect(page.getByText(`Adding ${title}`)).toHaveCount(0);
});

test("inline edit: a budget grid cell shows its new value within 100 ms", async ({ page }) => {
  const id = uniqueId();
  await signInAs(page, "producer@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/finance/budgets?project=${PROJECT}&create=1`);
  const sheet = page.getByRole("dialog", { name: "New budget" });
  await sheet.getByLabel("Budget name").fill(`Latency ${id}`);
  await sheet.getByRole("button", { name: "New budget" }).click();
  await page.waitForURL(/peek=/);
  const budget = new URL(page.url()).searchParams.get("peek") ?? "";
  await page.goto(`/${DEMO_ORG}/finance/budgets?project=${PROJECT}&budget=${budget}`);
  await settle(page);
  await page.getByRole("button", { name: "Add line" }).click();
  const add = page.getByRole("dialog", { name: "Add line" });
  await add.getByLabel("Description").fill(`Delay towers ${id}`);
  await add.getByLabel("URID").fill("4000.01.01");
  await expect(page.getByRole("listbox").getByRole("option").first()).toContainText("4000.01.01");
  await add.getByLabel("URID").press("Enter");
  await add.getByLabel("Unit price").fill("1500.00");
  await add.getByRole("button", { name: "Add line" }).click();
  await expect(add).toBeHidden();
  await settle(page);

  const grid = page.getByRole("grid", { name: "Budget lines" });
  await grid.getByRole("gridcell", { name: new RegExp(`Delay towers ${id}`) }).dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(`Delay towers, two sets ${id}`);
  await expectAcknowledged(page, "Budget cell edit", () => page.keyboard.press("Enter"), {
    selector: '[role="gridcell"]',
    text: `Delay towers, two sets ${id}`,
  });
  // The save lands against the line's version, and a fresh read shows it.
  await settle(page);
  await page.reload();
  await expect(grid).toContainText(`Delay towers, two sets ${id}`);
});

test("state change: a record moved on the board settles in its new column within 100 ms", async ({
  page,
}) => {
  const title = `Latency move ${uniqueId()}`;
  await signInAs(page, "owner@example.com", DEMO_ORG);
  await quickAddRecord(page, title);

  const boardUrl = `/${DEMO_ORG}/work/all-records?view=board&q=${encodeURIComponent(title)}`;
  await page.goto(boardUrl);
  await settle(page);
  const board = page.getByRole("region", { name: "Records by state" });
  const columns = await board
    .locator("section[aria-label]:has(> header h3)")
    .evaluateAll((sections) => sections.map((s) => s.getAttribute("aria-label") ?? ""));
  const card = board.locator("article[data-item]", { hasText: title });
  const from = await card.locator("xpath=ancestor::section[1]").getAttribute("aria-label");
  const to = columns[columns.indexOf(from ?? "") + 1] ?? "";
  expect(to, `a column after ${from}`).not.toBe("");

  // Space picks the card up, the arrow carries it to the next column, and Space drops it there.
  await card.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  // The card is carried into the next column and keeps the focus there, still held.
  const carried = board.locator(`section[aria-label="${to}"] article[data-item]`, { hasText: title });
  await expect(carried).toBeFocused();
  await expectAcknowledged(page, "Board state change", () => page.keyboard.press("Space"), {
    selector: `section[aria-label="${to}"] article[data-item]:not([aria-pressed])`,
    text: title,
  });
  // The move is the record's state change: a fresh read of the board has it in the new column.
  await settle(page);
  await page.reload();
  await expect(
    page
      .getByRole("region", { name: "Records by state" })
      .locator(`section[aria-label="${to}"]`)
      .locator("article[data-item]", { hasText: title }),
  ).toBeVisible();
});

test("Inbox approve: the approved item leaves the list within 100 ms", async ({
  browser,
  baseURL,
}) => {
  const base = baseURL as string;
  // The Producer submits one purchase order to the Purchase order policy; the Admin decides its first step.
  const producer = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
  await signInAs(producer, "producer@example.com", DEMO_ORG);
  const vendors = (await (await producer.request.get("/api/v1/vendors?limit=50")).json()) as {
    data: { id: string; vendor_state: string }[];
  };
  const vendor = vendors.data.find((v) => v.vendor_state === "Active");
  expect(vendor, "an Active demo vendor").toBeTruthy();
  const po = await apiPost(producer.request, base, "/purchase-orders", {
    project_id: PROJECT_ID,
    vendor_id: vendor?.id,
    currency_code: "USD",
  });
  await apiPost(producer.request, base, "/po-lines", {
    purchase_order_id: po["id"],
    description: `Latency truss ${uniqueId()}`,
    quantity: 1,
    unit_price_minor: 12_500,
  });
  const approval = String(
    (
      await apiPost(producer.request, base, "/approval-instances", {
        document_type: "Purchase Order",
        document_id: po["id"],
      })
    )["id"],
  );
  try {
    const admin = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
    await signInAs(admin, "admin@example.com", DEMO_ORG);
    const notes = (await (
      await admin.request.get(`/api/v1/notifications?filter[subject_id][eq]=${approval}&limit=5`)
    ).json()) as { data: { id: string; kind: string }[] };
    const note = notes.data.find((n) => n.kind === "approval.requested");
    expect(note, "the approval request notification").toBeTruthy();

    await admin.goto(`/${DEMO_ORG}/inbox`);
    await expect(admin.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    await settle(admin);
    const item = admin.locator(`[data-inbox-item="${note?.id}"]`);
    await expect(item).toBeVisible();
    await expectAcknowledged(
      admin,
      "Inbox approve",
      () => item.getByRole("button", { name: "Approve" }).click(),
      { selector: `[data-inbox-item="${note?.id}"]`, absent: true },
    );
    await expect(admin.getByText("1 item handled this visit.")).toBeVisible();
    // The decision reached the server: the approval moved to the Owner's step.
    await expect
      .poll(async () => {
        const row = (await (
          await admin.request.get(`/api/v1/approval-instances/${approval}`)
        ).json()) as { current_step: number };
        return row.current_step;
      })
      .toBe(2);
  } finally {
    // Leave the demo tenant as it was (A71): the requester withdraws the approval this run opened.
    await producer.request
      .post(`/api/v1/approval-instances/${approval}/cancel`, {
        data: { reason: "A145 test data withdrawn." },
        headers: { Origin: base, "Idempotency-Key": `a145-withdraw-${approval}` },
      })
      .catch(() => undefined);
  }
});

test("favorite: Pin page and Unpin page answer within 100 ms and hold", async ({ page }) => {
  await signInAs(page, "owner@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/work/all-records`);
  await settle(page);
  const favorites = page.locator('section[aria-labelledby="favorites-heading"]');
  const button = (name: string) => favorites.getByRole("button", { name, exact: true });
  const shows = (text: string) => ({
    selector: 'section[aria-labelledby="favorites-heading"] button',
    text,
  });
  // A run stopped partway may have left the page pinned.
  if (await button("Unpin page").isVisible()) {
    await button("Unpin page").click();
    await expect(button("Pin page")).toBeVisible();
    await settle(page);
  }

  const listed = await watchFor(page, {
    selector: 'nav[aria-label="Favorites"] a',
    text: "All Records",
  });
  await expectAcknowledged(page, "Pin page", () => button("Pin page").click(), shows("Unpin page"));
  noteServer("Pin page", latencyOf(await listed()));
  // The label holds while the server saves and the Favorites refresh: it never flips back.
  const flippedBack = await watchFor(page, shows("Pin page"), {
    afterInput: false,
    timeout: 3_000,
  });
  await expect(flippedBack()).rejects.toThrow();
  await page.reload();
  await expect(button("Unpin page")).toBeVisible();
  await settle(page);

  await expectAcknowledged(
    page,
    "Unpin page",
    () => button("Unpin page").click(),
    shows("Pin page"),
  );
  await settle(page);
  await page.reload();
  await expect(button("Pin page")).toBeVisible();
});
