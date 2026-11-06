import pg from "pg";
import { writeWorkbook } from "@xos/data/import-worker";
import { act, ORG, signIn } from "./a16-support";
import { reloadUntil, runImportWorker } from "./a36-support";
import { expect as baseExpect, settle, test, type Page } from "./engine-test";
import { uniqueId } from "./support";

/**
 * B11's longer journeys on the demo tenant (RRR-235):
 *   - acceptance 11: a shortage, Request sub-hire, invite, issue, record a quote, close, award and order from the
 *     response. The order line is a rental with the hire period and need; the shortage row is gone once the order
 *     exists, and the need reads On Order once it is approved;
 *   - acceptances 24 and 25: a .csv of needs through the wizard with dry-run counts, a re-import that updates by the
 *     strong key, an .xlsx of order lines with an unmatched row as free text, and undo of the whole batch.
 * Each run makes its own class, needs and order, so reruns see the same outcome.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);
const expect = baseExpect.configure({ timeout: 30_000 });

const PROJECT = "01920000-0000-7000-8000-000000001001";
const PROJECT_KEY = "NWS";
const ORG_ID = "01920000-0000-7000-8000-000000000001";
const OWNER = "01920000-0000-7000-8000-000000000101";

/** SQL against the local stack only, as the given person. */
async function localSql<T extends pg.QueryResultRow>(
  text: string,
  args: unknown[],
  asPerson: string,
): Promise<T[]> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) {
    throw new Error("B11's journeys run against a local Supabase stack only.");
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: asPerson, role: "authenticated" }),
    ]);
    const result = await client.query<T>(text, args);
    await client.query("commit");
    return result.rows;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

/** A class with no stock, on an element no class of the org uses, and a request for five of it far in the future. */
async function shortOfFive(className: string): Promise<void> {
  const [cls] = await localSql<{ id: string }>(
    `insert into app.asset_classes (org_id, element_id, name)
     select $1, e.element_id, $2 from xpms.elements e
     where not exists (select 1 from app.asset_classes c where c.element_id = e.element_id and c.org_id = $1)
     order by e.element_id limit 1 returning id`,
    [ORG_ID, className],
    OWNER,
  );
  await localSql(
    `select app.request_allocation($1, (select e.id from app.engagements e
        where e.project_id = $1 and e.deleted_at is null and e.engagement_state in ('Onboarding', 'Active')
        order by e.id limit 1), null, null, $2, null, null, null, 5,
      now() + interval '400 days', now() + interval '402 days', 'America/New_York', null)`,
    [PROJECT, cls?.id],
    OWNER,
  );
}

/** Approves the step an order's approval waits on, as the signed-in approver, from Approvals. */
async function decideStep(page: Page, poNumber: string, step: string) {
  await page.goto(`/${ORG}/approvals`);
  const heading = page.getByRole("heading", { name: `Purchase order ${poNumber}`, exact: true });
  const item = page.getByRole("listitem").filter({ has: heading });
  await expect(item.getByText(step).first()).toBeVisible();
  await settle(page);
  await item.getByRole("button", { name: "Approve step" }).click();
  await expect(item.getByRole("button", { name: "Approve step" })).toHaveCount(0);
}

async function openNeeds(page: Page) {
  await page.goto(`/${ORG}/p/${PROJECT_KEY}/procurement?section=needs`);
  await settle(page);
}

test("journey: a shortage becomes a sub-hire RFQ, then a rental order line", async ({
  page,
  browser,
}) => {
  const className = `Crowd Barrier ${uniqueId()}`;
  await shortOfFive(className);
  await signIn(page, "producer@example.com");

  await openNeeds(page);
  const shortSection = page.locator("section", {
    has: page.getByRole("heading", { name: "Short against own stock", exact: true }),
  });
  const short = shortSection.getByRole("listitem").filter({ hasText: className });
  await expect(short).toContainText("short 5");
  await expect(async () => {
    await short.getByRole("button", { name: "Request sub-hire", exact: true }).click();
    await expect(short.getByRole("link", { name: "Open RFQ", exact: true })).toBeVisible({
      timeout: 3_000,
    });
  }).toPass();
  await short.getByRole("link", { name: "Open RFQ", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(className) })).toBeVisible();
  await expect(page.getByText(new RegExp(`5 ${className}`)).first()).toBeVisible();

  const invitations = page.locator("section", {
    has: page.getByRole("heading", { name: "Invited vendors" }),
  });
  await invitations.getByLabel("Vendor").selectOption({ label: "Demo Staging Supply" });
  await invitations.getByRole("button", { name: "Invite vendor" }).click();
  await expect(
    invitations.getByRole("listitem").filter({ hasText: "Demo Staging Supply" }),
  ).toBeVisible();
  await act(page, page.locator("header"), "Issue to vendors", "Specification is final.");
  await expect(page.getByText("Issued", { exact: true }).first()).toBeVisible();

  // The quote answers the request line, in plain view, and takes its description and quantity from it.
  const form = page.locator("section", {
    has: page.getByRole("heading", { name: "Record a response" }),
  });
  await form.getByLabel("Responding vendor").selectOption({ label: "Demo Staging Supply" });
  await expect(form.getByLabel("Answers").first()).not.toHaveValue("");
  await form.getByLabel("Unit price").first().fill("120.00");
  await form.getByRole("button", { name: "Record a response" }).click();
  await page.waitForLoadState("networkidle");
  await expect(form.getByRole("alert")).toHaveCount(0);

  await act(page, page.locator("header"), "Close and unseal", "Deadline reached.");
  await act(page, page.locator("header"), "Award", "Only quote.");
  await act(page, page.locator("main"), "Create order from Demo Staging Supply");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Capacity counts a Proposed order, so the shortage clears while the need still reads Needs Ordered.
  const [line] = await localSql<{
    id: string;
    purchase_order_id: string;
    acquisition_kind: string;
    hire_period: string | null;
    procurement_need_id: string | null;
  }>(
    `select l.id, l.purchase_order_id, l.acquisition_kind, l.hire_period::text, l.procurement_need_id
     from app.po_lines l where l.description = $1 and l.deleted_at is null`,
    [className],
    OWNER,
  );
  expect(line?.acquisition_kind).toBe("Rental");
  expect(line?.hire_period).not.toBeNull();
  expect(line?.procurement_need_id).not.toBeNull();
  await openNeeds(page);
  await expect(short).toHaveCount(0);
  await expect(page.getByText(className, { exact: true }).first()).toBeVisible();

  // The demo tenant's approval policy (seed 1030) routes every order through Finance review and Owner sign-off before
  // someone other than the buyer approves it under spend authority. Approved, the order counts as ordered.
  const [order] = await localSql<{ po_number: number }>(
    `select po_number from app.purchase_orders where id = $1`,
    [line?.purchase_order_id],
    OWNER,
  );
  const poNumber = String(order?.po_number ?? "");
  await page.goto(`/${ORG}/approvals`);
  const submit = page.getByRole("form", { name: "Submit a document for approval" });
  const document = `Purchase order: ${PROJECT_KEY} PO ${poNumber} (${PROJECT_KEY})`;
  await submit.getByLabel("Document").selectOption({ label: document });
  await submit.getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByRole("option", { name: document })).toHaveCount(0);
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, "admin@example.com");
  await decideStep(admin, poNumber, "Finance review");
  const owner = await (await browser.newContext()).newPage();
  await signIn(owner, "owner@example.com");
  await decideStep(owner, poNumber, "Owner sign-off");
  await admin.goto(`/${ORG}/procurement/purchase-orders?peek=${line?.purchase_order_id}&full=1`);
  await act(admin, admin.locator("header"), "Approve", "Within budget and spend authority.");
  await expect(admin.getByText("Approved", { exact: true }).first()).toBeVisible();

  await page.goto(`/${ORG}/p/${PROJECT_KEY}/procurement?section=needs&view=table`);
  await settle(page);
  await expect(
    page.getByRole("grid").getByRole("row").filter({ hasText: className }),
  ).toContainText("On Order");
});

test("needs and order lines import through the wizard, and the batch undoes", async ({ page }) => {
  const id = uniqueId();
  const truss = `Truss ${id}`;
  const motor = `Motor ${id}`;
  const upload = async (
    url: string,
    file: { name: string; mimeType: string; buffer: Buffer },
  ): Promise<void> => {
    await page.goto(url);
    await settle(page);
    await page.locator("#import-file").setInputFiles(file);
    await page.getByRole("button", { name: "Upload and read" }).click();
    await page.waitForURL(/\?import=/);
    await runImportWorker();
    await reloadUntil(page, page.getByRole("heading", { name: "Map the columns" }));
  };
  const toDryRun = async () => {
    await page.getByRole("button", { name: "Confirm the mapping" }).click();
    await runImportWorker();
    await reloadUntil(page, page.getByRole("heading", { name: "Dry run" }));
  };
  const commit = async () => {
    await page.getByRole("button", { name: "Commit the import" }).click();
    await runImportWorker();
    await reloadUntil(page, page.getByRole("heading", { name: "Undo the whole batch" }));
  };
  const counts = () => page.getByRole("region", { name: "Dry run" });
  await signIn(page, "producer@example.com");
  const needsUrl = `/${ORG}/import?target=procurement_needs&project=${PROJECT}`;

  // A .csv of needs: two new rows, one of them repeated in the file and so invalid.
  await upload(needsUrl, {
    name: `needs-${id}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(
      ["Description,Quantity", `${truss},4`, `${motor},2`, `${truss.toUpperCase()},9`].join("\n"),
    ),
  });
  await expect(page.getByLabel("Column Description")).toHaveValue("description");
  await expect(page.getByLabel("Column Quantity")).toHaveValue("quantity");
  await toDryRun();
  await expect(counts().getByText("New records").locator("..")).toContainText("2");
  await commit();
  await expect(page.getByText("2 rows were written")).toBeVisible();

  // The same description updates by the strong key, and adds no second need.
  await upload(needsUrl, {
    name: `needs-again-${id}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(["Description,Quantity", `${truss},6`].join("\n")),
  });
  await toDryRun();
  await expect(counts().getByText("Updates").locator("..")).toContainText("1");
  await commit();
  const live = () =>
    localSql<{ quantity: string }>(
      `select quantity::text from app.procurement_needs where description = $1 and deleted_at is null`,
      [truss],
      OWNER,
    );
  expect((await live()).map((n) => Number(n.quantity))).toEqual([6]);

  // An .xlsx of lines on a Proposed order: an unmatched row is written as free text.
  const [order] = await localSql<{ id: string }>(
    `insert into app.purchase_orders (project_id, vendor_id, currency_code)
     select $1, v.id, 'USD' from app.vendors v
     join app.counterparties c on c.id = v.counterparty_id
     where app.counterparty_name(c) = 'Demo Staging Supply' and v.org_id = $2 limit 1 returning id`,
    [PROJECT, ORG_ID],
    OWNER,
  );
  const workbook = await writeWorkbook({
    title: `Lines ${id}`,
    sheets: [
      {
        name: "Lines",
        rows: [
          ["Line number", "Description", "Quantity"],
          ["1", `Unmatched cable ${id}`, "3"],
        ],
      },
    ],
  });
  await upload(`/${ORG}/import?target=po_lines&purchaseOrder=${order?.id}`, {
    name: `lines-${id}.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(workbook),
  });
  await toDryRun();
  await expect(page.getByText("Unmatched", { exact: true }).first()).toBeVisible();
  await commit();
  await expect(page.getByText("1 row was written")).toBeVisible();

  // Undo the batch: the order is still Proposed, so its line reverts.
  await page.getByLabel("Why undo it").fill("Imported the wrong list.");
  await page.getByRole("button", { name: "Undo the batch" }).click();
  await expect(page.getByRole("heading", { name: "Batch undone" })).toBeVisible();
  const lines = await localSql<{ id: string }>(
    `select id from app.po_lines where purchase_order_id = $1 and deleted_at is null`,
    [order?.id],
    OWNER,
  );
  expect(lines).toEqual([]);
});
