import pg from "pg";
import { expect as baseExpect, test, type Page } from "./engine-test";
import { act, ORG, signIn } from "./a16-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * R7a, the supply bridge (RRR-183), on the demo tenant:
 *   - a Rental line whose hire starts after the site opens warns Delivery After Load In and still saves (G-99);
 *   - the order is approved by others and sent, then received with an asset tag: the unit comes in Received with
 *     its provenance (order, vendor, Rental, hire end) and the Hired in view lists it (G-96);
 *   - the unit goes back to the vendor as Off Hire: it is Returned, Unavailable lists it, Hired in does not, and
 *     the order's Supply section counts the return.
 * The line form has no element picker, so the line is pointed at the Digital Two-Way Radio class's element in SQL
 * while the order is still Proposed (lines change only then). Names carry a unique suffix, so reruns add new rows.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);
const expect = baseExpect.configure({ timeout: 30_000 });

const PROJECT = "01920000-0000-7000-8000-000000001001";

/** Runs one query as postgres against the local stack only (E2E_DATABASE_URL), as endTrial does. */
async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Only a local stack is changed.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

/** A hire from two to four days after the project's site window opens, as datetime-local in its zone. */
async function hireAfterLoadIn(): Promise<{ from: string; to: string }> {
  const [row] = await sql<{ from: string; to: string }>(
    `with w as (
       select p.time_zone,
         coalesce(
           (select min(r.starts_at) from app.records r
             where r.project_id = p.id and r.record_kind = 'Build' and r.deleted_at is null
               and r.record_state not in ('Deferred', 'Canceled')),
           p.starts_on::timestamp at time zone p.time_zone) as opens
       from app.projects p where p.id = $1)
     select to_char((opens + interval '2 days') at time zone time_zone, 'YYYY-MM-DD"T"HH24:MI') as "from",
            to_char((opens + interval '4 days') at time zone time_zone, 'YYYY-MM-DD"T"HH24:MI') as "to"
     from w`,
    [PROJECT],
  );
  if (!row?.from) throw new Error("The demo project has no site window.");
  return row;
}

/** Approves the step an order's approval waits on, as the signed-in approver (A33's demo policy). */
async function decideStep(page: Page, poNumber: string, step: string) {
  await page.goto(`/${ORG}/approvals`);
  const heading = page.getByRole("heading", { name: `Purchase order ${poNumber}`, exact: true });
  const item = page.getByRole("listitem").filter({ has: heading });
  await expect(item.getByText(step).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  await item.getByRole("button", { name: "Approve step" }).click();
  await expect(item.getByRole("button", { name: "Approve step" })).toHaveCount(0);
}

test("R7a: a rental line is received into stock, shows its provenance and goes back Off Hire", async ({
  page,
  browser,
}) => {
  const id = uniqueId();
  const line = `Two-way radio hire ${id}`;
  const tag = `R7A-${id}`.toUpperCase();
  const hire = await hireAfterLoadIn();
  await signIn(page, "producer@example.com");

  // A new order for the demo project, then a Rental line inside the site window's first days.
  await page.goto(`/${ORG}/procurement/purchase-orders?create=1`);
  const create = page.getByRole("dialog");
  await create.getByLabel("Project").selectOption({ label: "NWS Northwind Summer Series" });
  await create.getByLabel("Vendor").selectOption({ label: "Bayline Audio Rentals" });
  await create.getByRole("button", { name: "New purchase order" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Lines" })).toBeVisible();
  const orderUrl = page.url();
  const orderId = new URL(orderUrl).searchParams.get("peek") ?? "";
  expect(orderId).not.toBe("");

  const form = page.locator(`#po-line-${orderId}`);
  await form.getByLabel("Description").fill(line);
  await form.getByLabel("Quantity").fill("1");
  await form.getByLabel(/Unit price/).fill("85.00");
  await form.getByLabel("Acquisition").selectOption({ label: "Rental" });
  await form.getByLabel("Hire from").fill(hire.from);
  await form.getByLabel("Hire to").fill(hire.to);
  // The warning shows under the hire and never blocks the save.
  await expect(form.getByText("Delivery after load-in", { exact: false })).toBeVisible();
  await expectAccessible(page);
  await form.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByRole("grid", { name: "Lines" }).getByText(line)).toBeVisible();
  await expect(page.getByRole("grid", { name: "Lines" }).getByText(/Rental ·/)).toBeVisible();

  // Point the line at the radio class's element while the order is Proposed, so it can come into stock.
  await sql(
    `update app.po_lines l set element_id = c.element_id
       from app.asset_classes c
      where l.purchase_order_id = $1 and l.description = $2
        and c.org_id = l.org_id and c.name = 'Digital Two-Way Radio' and c.deleted_at is null`,
    [orderId, line],
  );
  const [order] = await sql<{ po_number: string }>(
    "select po_number::text from app.purchase_orders where id = $1",
    [orderId],
  );
  const poNumber = order?.po_number ?? "";

  // Approval by others under the demo policy, then the Producer sends it.
  await page.goto(`/${ORG}/approvals`);
  const submit = page.getByRole("form", { name: "Submit a document for approval" });
  const document = `Purchase order: NWS PO ${poNumber} (NWS)`;
  await submit.getByLabel("Document").selectOption({ label: document });
  await submit.getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByRole("option", { name: document })).toHaveCount(0);
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, "admin@example.com");
  await decideStep(admin, poNumber, "Finance review");
  const owner = await (await browser.newContext()).newPage();
  await signIn(owner, "owner@example.com");
  await decideStep(owner, poNumber, "Owner sign-off");
  await admin.goto(orderUrl);
  await act(admin, admin.locator("header"), "Approve", "Within budget and spend authority.");
  await expect(admin.getByText("Approved", { exact: true }).first()).toBeVisible();
  await page.goto(orderUrl);
  await act(page, page.locator("header"), "Send to vendor", "Emailed with the hire terms.");
  await expect(page.getByText("Sent", { exact: true }).first()).toBeVisible();

  // Receive the radio by its asset tag; the receipt links the unit it created.
  await page.goto(`/${ORG}/procurement/receipts?create=1&order=${orderId}`);
  const receive = page.getByRole("dialog");
  await receive.getByLabel("Asset tags").fill(tag.toLowerCase());
  await receive.getByRole("button", { name: "Record receipt" }).click();
  const receipt = page.getByRole("dialog", { name: /Receipt of/ });
  await expect(receipt).toBeVisible();
  const receiptUrl = page.url();
  await receipt.getByRole("link", { name: tag }).click();

  // The unit came in Received; its provenance names the order, the vendor and the hire.
  const unit = page.getByRole("dialog", { name: tag });
  await expect(unit.getByText("Received").first()).toBeVisible();
  await expect(unit.getByRole("heading", { name: "Provenance" })).toBeVisible();
  await expect(unit.getByRole("link", { name: `NWS-PO${poNumber}` })).toBeVisible();
  await expect(unit.getByText("Bayline Audio Rentals")).toBeVisible();
  await expect(unit.getByText("Rental", { exact: true })).toBeVisible();
  await expect(unit.getByText("Hire ends")).toBeVisible();
  await expectAccessible(page);

  // Available, so it can go back; the Hired in view lists it.
  await unit.getByRole("button", { name: "Change state" }).click();
  const move = page.getByRole("dialog", { name: `Change the state of ${tag}` });
  await move.getByLabel("Move to").selectOption({ label: "Available" });
  await move.getByLabel("Reason").fill("Checked on arrival.");
  await move.getByRole("button", { name: "Change state" }).click();
  await expect(move).toBeHidden();
  // The built-in views are presets in the saved views menu; Hired in shows its conditions as filter chips, and a
  // person can save a copy of it as their own view.
  await page.goto(`/${ORG}/assets/units?view=table`);
  const hiredIn = page.getByRole("menuitem", { name: "Hired in" });
  await expect(async () => {
    await page.getByRole("button", { name: /Saved views/ }).click();
    await expect(hiredIn).toBeVisible({ timeout: 5_000 });
  }).toPass();
  await hiredIn.click();
  await page.waitForURL(/f\.acquisition=Rental/);
  await expect(page.getByRole("grid").getByText(tag)).toBeVisible();
  await expect(async () => {
    await page.getByRole("button", { name: "Hired in" }).click();
    await expect(page.getByRole("menuitem", { name: "Save a copy of Hired in" })).toBeVisible({
      timeout: 5_000,
    });
  }).toPass();
  await page.keyboard.press("Escape");

  // Off Hire: the unit goes back to the vendor through a return on the receipt.
  await page.goto(receiptUrl);
  await page.getByRole("link", { name: "Return to vendor" }).click();
  const back = page.getByRole("dialog", { name: /Return to vendor on/ });
  await expect(back.getByLabel("Reason")).toHaveValue("Off Hire");
  await back.getByLabel(tag).check();
  await expectAccessible(page);
  await back.getByRole("button", { name: "Record return" }).click();
  await expect(page.getByRole("dialog", { name: /Receipt of/ })).toBeVisible();

  // Returned: Unavailable lists it, Hired in no longer does.
  await page.goto(`/${ORG}/assets/units?view=table&f.state.ne=Available`);
  await expect(page.getByRole("grid").getByText(tag)).toBeVisible();
  await page.goto(`/${ORG}/assets/units?view=table&f.acquisition=Rental&f.state.ne=Returned`);
  await expect(page.getByRole("grid").getByText(tag)).toHaveCount(0);
  await page.goto(`/${ORG}/assets/units?peek=${tag}`);
  await expect(page.getByRole("dialog", { name: tag }).getByText("Returned").first()).toBeVisible();

  // The order's Supply section counts one received and one returned.
  await page.goto(orderUrl);
  const supply = page.getByRole("grid", { name: "Supply" });
  const row = supply.getByRole("row").filter({ hasText: line });
  await expect(row.locator('td[data-column="received"]')).toHaveText("1");
  await expect(row.locator('td[data-column="returned"]')).toHaveText("1");
});
