import { expect, test } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { writeWorkbook } from "@xos/data/import-worker";
import { expectAccessibleInBothThemes } from "./a16-support";
import { DEMO_ORG, reloadUntil, runImportWorker, signInAs } from "./a36-support";
import { uniqueId } from "./support";

/**
 * A83 (RRR-128, finding A65-025; Section 4.6.2 steps 1 to 3): a workbook with two sheets is read sheet by sheet.
 * The import reads its first sheet with data, lists the other with the target the Playbook proposes and imports it
 * on its own; suggestions say where they came from, and Aurora (the e2e fixture model, XOS_AI_FAKE=1) suggests
 * the columns header similarity misses, for the person to confirm. A Google Sheets link is offered when the
 * imports.google_sheets flag is on, and the database refuses it without a Connected Google Drive connection.
 */

const DEMO_ORG_ID = "01920000-0000-7000-8000-000000000001";

function service(): SupabaseClient {
  const url = process.env["E2E_SUPABASE_URL"];
  const key = process.env["E2E_SUPABASE_SERVICE_KEY"];
  if (!url || !key || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) {
    throw new Error("Set E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_KEY to the local stack.");
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

test("every sheet of a workbook is detected, mapped with Aurora's help and imported on its own", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const id = uniqueId();
  const app = service().schema("app");
  // The demo Admin turns mapping help on (Settings, AI features), as the journey's precondition.
  const switched = await app
    .from("ai_settings")
    .update({ mapping_enabled: true })
    .eq("org_id", DEMO_ORG_ID);
  expect(switched.error).toBeNull();

  const workbook = await writeWorkbook({
    title: `Tour ${id}`,
    sheets: [
      {
        name: "Rooms",
        rows: [
          ["Hall", "Region Code", "Local Clock", "Street"],
          [`Harbor Hall ${id}`, "US-FL-MIAMI-DADE", "America/New_York", "1 Pier Rd"],
        ],
      },
      {
        name: "Vendor Directory",
        rows: [
          ["VENDOR ID", "COMPANY", "COUNTERPARTY TYPE"],
          ["V-1", `Bayfront Lighting ${id}`, ""],
          ["V-2", `Harbor Staging ${id}`, ""],
        ],
      },
    ],
  });

  await signInAs(page, "owner@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/import`);
  await page.getByLabel("Import into").selectOption("venues");
  await page.locator("#import-file").setInputFiles({
    name: `tour-${id}.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(workbook),
  });
  await page.getByRole("button", { name: "Upload and read" }).click();
  await page.waitForURL(/\?import=/);

  await runImportWorker();
  await reloadUntil(page, page.getByRole("heading", { name: "Map the columns" }));
  await expect(page.getByText("Sheet Rooms")).toBeVisible();
  const sheets = page.getByRole("list", { name: "Sheets in this workbook" });
  await expect(sheets).toContainText("Rooms");
  await expect(sheets).toContainText("This import");
  await expect(sheets).toContainText("Vendor Directory");
  await expect(sheets).toContainText(
    "2 rows. Proposed target: Customers and other companies, from the Playbook.",
  );

  // Header similarity finds the street; Aurora suggests the three columns it misses, for the person to confirm.
  await expect(page.getByLabel("Column Street")).toHaveValue("street_address");
  await expect(page.getByText("From the column name").first()).toBeVisible();
  await expect(page.getByLabel("Column Hall")).toHaveValue("");
  await expectAccessibleInBothThemes(page);
  await page.getByRole("button", { name: "Suggest with Aurora" }).click();
  await expect(
    page.getByText("Aurora suggested 3 columns. Check them before you confirm."),
  ).toBeVisible();
  await expect(page.getByLabel("Column Hall")).toHaveValue("name");
  await expect(page.getByLabel("Column Region Code")).toHaveValue("jurisdiction_id");
  await expect(page.getByLabel("Column Local Clock")).toHaveValue("time_zone");
  await expect(page.getByText("Suggested by Aurora")).toHaveCount(3);
  await page.getByRole("button", { name: "Confirm the mapping" }).click();
  await expect(page.getByText("Checking every row")).toBeVisible({ timeout: 20_000 });
  await runImportWorker();
  await reloadUntil(page, page.getByRole("heading", { name: "Dry run" }));

  // The other sheet becomes its own import, into the target the Playbook proposes.
  const vendorRow = sheets.getByRole("listitem").filter({ hasText: "Vendor Directory" });
  await expect(vendorRow.getByLabel("Import Vendor Directory into")).toHaveValue("counterparties");
  const first = page.url();
  await vendorRow.getByRole("button", { name: "Import this sheet" }).click();
  await page.waitForURL((url) => url.toString() !== first);
  await runImportWorker();
  await reloadUntil(page, page.getByRole("heading", { name: "Map the columns" }));
  await expect(page.getByText("Sheet Vendor Directory")).toBeVisible();
  await expect(page.getByLabel("Column COMPANY")).toHaveValue("name");
  await expect(page.getByLabel("Column COUNTERPARTY TYPE")).toHaveValue("counterparty_type");
  await expect(page.getByText("From the Playbook column map")).toHaveCount(2);
  await expect(page.getByLabel("Column VENDOR ID")).toHaveValue("");
  await expectAccessibleInBothThemes(page);
});

test("a Google Sheets link is offered and needs a Connected Google Drive connection", async ({
  page,
}) => {
  await signInAs(page, "owner@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/import`);
  await page.getByText("A Google Sheets link", { exact: true }).click();
  await page.getByLabel("Import into").selectOption("venues");
  await page
    .getByRole("textbox", { name: "Google Sheets link" })
    .fill("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit");
  await page.getByRole("button", { name: "Read the sheet" }).click();
  await expect(
    page.getByText(
      "Connect Google Drive in Settings, Integrations, before importing a Google Sheets link.",
    ),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("textbox", { name: "Google Sheets link" })).toHaveValue(
    "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit",
  );
  await expectAccessibleInBothThemes(page);
});
