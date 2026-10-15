import { expect, test, type Page } from "@playwright/test";
import { expectAccessibleInBothThemes, ORG, settled, signIn } from "./operations-support";

/**
 * A12 Assets journeys (Section 20.2, RRR-57) on the demo tenant seed (supabase/seeds/0010, 0107 and
 * 0112): every Assets page in every view its sitemap node offers, journey 19 (check out and return a
 * unit by scan and see the custody ledger), journey 23's asset half (a damaged unit written off by
 * an approver), records with comments, lots through the ledger, NULL costs, and the role boundary.
 * Every page is checked with axe in both themes.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);
expect.configure({ timeout: 20_000 });

const PAGES: [string, string, string[]][] = [
  ["asset-classes", "Catalog of Asset Classes", ["table", "list", "gallery"]],
  ["units", "Units", ["table", "list", "resource-schedule"]],
  ["lots", "Lots", ["table", "list"]],
  ["custody-ledger", "Custody Ledger", ["table", "list"]],
  ["maintenance", "Maintenance", ["list", "table", "calendar", "board"]],
  ["damage", "Damage", ["list", "table", "board", "gallery"]],
];

function suffix(): string {
  return Date.now().toString(36).toUpperCase().slice(-5);
}

async function lookUp(page: Page, code: string) {
  await page.getByLabel("Asset tag, serial or lot label").fill(code);
  await page.getByRole("button", { name: "Look up" }).click();
}

test("every Assets page renders in every view it offers", async ({ page }) => {
  await signIn(page, "producer@example.com");
  for (const [slug, title, views] of PAGES) {
    for (const view of views) {
      await page.goto(`/${ORG}/assets/${slug}?view=${view}`);
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expectAccessibleInBothThemes(page);
    }
  }
  for (const view of ["table", "list", "resource-schedule"]) {
    await page.goto(`/${ORG}/p/NWS/assets?view=${view}`);
    await expect(page.getByRole("heading", { level: 1, name: "Assets on NWS" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
  }
  // A filter survives a view switch (Section 11.15).
  await page.goto(`/${ORG}/assets/units?view=table&filter=Deployed`);
  await page.getByRole("radio", { name: "List" }).click();
  await expect(page).toHaveURL(/filter=Deployed/);
  await expect(page.getByText("MH-002 · Spot Fixture")).toBeVisible();
  await expect(page.getByText("MH-001 · Spot Fixture")).toBeHidden();
});

test("journey 19: check out and return a unit by scan and see the custody ledger", async ({
  page,
}) => {
  await signIn(page, "producer@example.com");
  const tag = `RAD-E2E-${suffix()}`;

  // Register a unit; it starts Proposed and opens in the peek.
  await page.goto(`/${ORG}/assets/units`);
  await page.getByRole("button", { name: "Register unit" }).first().click();
  const register = page.getByRole("dialog", { name: "Register unit" });
  await register.getByLabel("Asset class").selectOption({ label: "Digital Two-Way Radio" });
  await register.getByLabel("Asset tag").fill(tag.toLowerCase());
  await register.getByLabel("Home venue").selectOption({ label: "Northwind Gear Warehouse" });
  await settled(page);
  await register.getByRole("button", { name: "Register unit" }).click();
  await page.waitForURL(new RegExp(`peek=${tag}`));
  const peek = page.getByRole("dialog", { name: tag });
  await expect(peek.getByText("Proposed").first()).toBeVisible();

  // Received, then Available, through the lifecycle with a reason each time.
  for (const next of ["Received", "Available"]) {
    await peek.getByRole("button", { name: "Change state" }).click();
    const move = page.getByRole("dialog", { name: `Change the state of ${tag}` });
    await move.getByLabel("Move to").selectOption({ label: next });
    await move.getByLabel("Reason").fill(`Demo arrival, ${next}.`);
    await move.getByRole("button", { name: "Change state" }).click();
    await expect(move).toBeHidden();
    await expect(page.getByRole("dialog", { name: tag }).getByText(next).first()).toBeVisible();
  }

  // An unknown code is NO_ANSWER, never a guess.
  await page.goto(`/${ORG}/assets/custody-ledger`);
  await lookUp(page, "NOPE-404-XYZ");
  await expect(page.getByText("Nothing found for NOPE-404-XYZ")).toBeVisible();
  await expect(page.getByText("NO_ANSWER")).toBeVisible();
  await settled(page);

  // Check it out by scanning its tag.
  await lookUp(page, tag);
  await expect(page.getByText("It is Available now.")).toBeVisible();
  await page.getByRole("button", { name: "Check out" }).click();
  const out = page.getByRole("dialog", { name: `Check out ${tag}` });
  await out.getByLabel("Member who takes it").selectOption({ label: "Demo Field Lead" });
  await out.getByLabel("Project").selectOption({ label: "NWS · Northwind Summer Series" });
  await out.getByLabel("Note").fill("Stage left radio.");
  await settled(page);
  await out.getByRole("button", { name: "Check out" }).click();
  await expect(out).toBeHidden();
  await expect(page.getByRole("row", { name: new RegExp(tag) }).first()).toContainText(
    "Demo Field Lead",
  );

  // Return it: it comes back to its home venue and is Available again.
  await lookUp(page, tag);
  await expect(page.getByText("It is Deployed now.")).toBeVisible();
  await page.getByRole("button", { name: "Check in" }).click();
  const back = page.getByRole("dialog", { name: `Check in ${tag}` });
  await back.getByRole("button", { name: "Check in" }).click();
  await expect(back).toBeHidden();
  await expect(page.getByRole("row", { name: new RegExp(tag) }).first()).toContainText(
    "Northwind Gear Warehouse",
  );

  // The unit's custody record shows both moves, newest first.
  await page.goto(`/${ORG}/assets/units?peek=${tag}&full=1`);
  await expect(page.getByRole("heading", { name: new RegExp(tag) })).toBeVisible();
  const custody = page.locator("section", { has: page.getByRole("heading", { name: "Custody" }) });
  await expect(custody.getByRole("listitem")).toHaveCount(2);
  await expect(custody.getByRole("listitem").first()).toContainText("Northwind Gear Warehouse");
  await expect(page.getByText("Checked out by scan.")).toBeVisible();
  await expect(page.getByText("Checked in by scan.")).toBeVisible();
  await expectAccessibleInBothThemes(page);
});

test("journey 23: a damaged unit is written off by an approver, with a comment", async ({
  page,
}) => {
  await signIn(page, "owner@example.com");
  // The demo seed's damage report is listed.
  await page.goto(`/${ORG}/assets/damage`);
  await expect(page.getByText(/^MH-005 · Yoke cracked/).first()).toBeVisible();

  // A unit of this run's own goes out, comes back damaged and is reported.
  const tag = `MH-E2E-${suffix()}`;
  await page.goto(`/${ORG}/assets/units`);
  await page.getByRole("button", { name: "Register unit" }).first().click();
  const register = page.getByRole("dialog", { name: "Register unit" });
  await register.getByLabel("Asset class").selectOption({ label: "Spot Fixture" });
  await register.getByLabel("Asset tag").fill(tag);
  await register.getByRole("button", { name: "Register unit" }).click();
  await page.waitForURL(new RegExp(`peek=${tag}`));
  for (const next of ["Received", "Available", "Deployed", "Damaged"]) {
    await page
      .getByRole("dialog", { name: tag })
      .getByRole("button", { name: "Change state" })
      .click();
    const move = page.getByRole("dialog", { name: `Change the state of ${tag}` });
    await move.getByLabel("Move to").selectOption({ label: next });
    await move.getByLabel("Reason").fill(`Journey 23, ${next}.`);
    await move.getByRole("button", { name: "Change state" }).click();
    await expect(move).toBeHidden();
    await expect(page.getByRole("dialog", { name: tag }).getByText(next).first()).toBeVisible();
  }
  const peek = page.getByRole("dialog", { name: tag });
  await peek.getByRole("button", { name: "Report damage" }).click();
  const report = page.getByRole("dialog", { name: "Report damage" });
  await report.getByLabel("Description").fill("Lens shattered when the case fell.");
  await report.getByRole("button", { name: "Report damage" }).click();
  await expect(report).toBeHidden();

  // The approver comments, then writes it off (Damaged to Retired needs assets.write_off.approve).
  const note = `Write-off approved ${suffix()}.`;
  await page.getByRole("dialog", { name: tag }).getByLabel("Write a comment").fill(note);
  await page
    .getByRole("dialog", { name: tag })
    .getByRole("button", { name: "Post comment" })
    .click();
  await expect(page.getByText(note)).toBeVisible();
  await page
    .getByRole("dialog", { name: tag })
    .getByRole("button", { name: "Change state" })
    .click();
  const writeOff = page.getByRole("dialog", { name: `Change the state of ${tag}` });
  await writeOff.getByLabel("Move to").selectOption({ label: "Retired" });
  await writeOff.getByLabel("Reason").fill("Written off; the lens costs more than the fixture.");
  await writeOff.getByRole("button", { name: "Change state" }).click();
  await expect(writeOff).toBeHidden();
  await expect(page.getByRole("dialog", { name: tag }).getByText("Retired").first()).toBeVisible();
  await settled(page);
});

test("lots move through the ledger and a recount records the difference", async ({ page }) => {
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/assets/lots`);
  await page.getByRole("radio", { name: "List" }).click();
  await page
    .getByRole("row", { name: /Box Truss 12 in/ })
    .getByRole("button", { name: "Open" })
    .click();
  const peek = page.getByRole("dialog", { name: /Box Truss 12 in/ });
  await expect(peek.getByText("Counted, 2 difference").first()).toBeVisible();
  await peek.getByRole("button", { name: "Record count" }).click();
  const count = page.getByRole("dialog", { name: "Record a count" });
  const counted = 30 + (Date.now() % 7);
  await count.getByLabel("Counted quantity").fill(String(counted));
  await count.getByRole("button", { name: "Record count" }).click();
  await expect(count).toBeHidden();
  await expect(
    page
      .getByRole("dialog", { name: /Box Truss 12 in/ })
      .getByText(String(counted))
      .first(),
  ).toBeVisible();
  await settled(page);
});

test("maintenance keeps an unknown cost unknown and damage is reported from a unit", async ({
  page,
}) => {
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/assets/maintenance?view=table`);
  await expect(page.getByText("Cost unknown").first()).toBeVisible();
  await page.getByRole("button", { name: "Record maintenance" }).first().click();
  const form = page.getByRole("dialog", { name: "Record maintenance" });
  await form.getByLabel("Asset unit").selectOption({ label: "GEN-001 · Towable Generator" });
  const work = `Coolant flushed ${suffix()}.`;
  await form.getByLabel("Description").fill(work);
  await form.getByLabel("Cost in USD").fill("125.50");
  await settled(page);
  await form.getByRole("button", { name: "Record maintenance" }).click();
  await expect(form).toBeHidden();
  await expect(page.getByText(work)).toBeVisible();
  await expect(page.getByText("$125.50").first()).toBeVisible();

  await page.goto(`/${ORG}/assets/units?peek=RAD-002`);
  const peek = page.getByRole("dialog", { name: "RAD-002" });
  await peek.getByRole("button", { name: "Report damage" }).click();
  const damage = page.getByRole("dialog", { name: "Report damage" });
  const what = `Antenna snapped ${suffix()}.`;
  await damage.getByLabel("Description").fill(what);
  await damage.getByRole("button", { name: "Report damage" }).click();
  await expect(damage).toBeHidden();
  await page.goto(`/${ORG}/assets/damage`);
  await expect(page.getByText(`RAD-002 · ${what}`)).toBeVisible();
});

test("a new asset class binds to a canon element", async ({ page }) => {
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/assets/asset-classes`);
  await page.getByRole("button", { name: "New asset class" }).first().click();
  const form = page.getByRole("dialog", { name: "New asset class" });
  await form.getByLabel("Find a canon element").fill("Laser Projector");
  await form.getByRole("button", { name: "Find" }).click();
  await expect(form.getByLabel("Canon element")).toBeVisible();
  const name = `Laser Projector ${suffix()}`;
  await form.getByLabel("Name").fill(name);
  await settled(page);
  await form.getByRole("button", { name: "Create class" }).click();
  // A canon element holds one class per org: the first run creates it, a later run is refused by name.
  await expect(
    page
      .getByText(name)
      .or(form.getByText("That value is already taken in this organization.", { exact: false })),
  ).toBeVisible();
});

test("a field lead sees assets without create controls", async ({ page }) => {
  await signIn(page, "field@example.com");
  await page.goto(`/${ORG}/assets/units`);
  await expect(page.getByRole("heading", { level: 1, name: "Units" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Register unit" })).toHaveCount(0);
  await settled(page);
});
