import { expect, test } from "@playwright/test";
import { expectAccessible } from "./support";
import { expectAccessibleInBothThemes, ORG, settled, signIn } from "./operations-support";

/**
 * A11 Logistics journeys (Section 20.2, RRR-57): journey 20, log a shipment, check it into a dock
 * slot, record it in the marshalling yard log and release it, on the demo tenant seed
 * (supabase/seeds/0010, 0107 and 0111). The Producer (Manager) drives it; the Field Lead, who has no
 * release authority, sees no release control. Every page is checked with axe in both themes.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
expect.configure({ timeout: 20_000 });

test("shipments, dock schedule and yard log render in every view", async ({ page }) => {
  await signIn(page, "producer@example.com");
  for (const view of ["list", "table", "board", "calendar"]) {
    await page.goto(`/${ORG}/logistics/shipments?view=${view}&month=2027-03`);
    await expect(page.getByRole("heading", { level: 1, name: "Shipments" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
  }
  for (const view of ["resource-schedule", "list", "calendar"]) {
    await page.goto(`/${ORG}/logistics/dock-schedule?view=${view}&week=2027-03-08&month=2027-03`);
    await expect(page.getByRole("heading", { level: 1, name: "Dock schedule" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
  }
  for (const view of ["list", "table", "board"]) {
    await page.goto(`/${ORG}/logistics/marshalling-yard-log?view=${view}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Marshalling yard log" }),
    ).toBeVisible();
    await expectAccessibleInBothThemes(page);
  }
  await page.goto(`/${ORG}/p/NWS/logistics?section=dock&week=2027-03-08`);
  await expect(page.getByRole("heading", { level: 1, name: "Dock schedule" })).toBeVisible();
  await expectAccessibleInBothThemes(page);
});

test("journey 20: log a shipment, check it in at a dock, log it in the yard and release it", async ({
  page,
  browser,
}) => {
  await signIn(page, "producer@example.com");
  const vehicle = `FL TRK-${Date.now().toString().slice(-5)}`;
  // A day of its own for each run, so earlier runs never hold the dock (slots never overlap).
  const offset = Math.floor(Date.now() / 1000) % 3000;
  const day = new Date(Date.UTC(2028, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);

  // Log the shipment.
  await page.goto(`/${ORG}/logistics/shipments`);
  await page.getByRole("link", { name: "Log shipment" }).first().click();
  const drawer = page.getByRole("dialog", { name: "Log shipment" });
  await drawer.getByLabel("Project").selectOption({ label: "NWS Northwind Summer Series" });
  await drawer.getByLabel("Carrier").selectOption({ label: "Coastline Freight Lines" });
  await drawer.getByLabel("Arrives").fill(`${day}T09:00`);
  await expectAccessible(page);
  await drawer.getByRole("button", { name: "Log shipment" }).click();
  await page.waitForURL(/peek=NWS-\d+/);
  const key = new URL(page.url()).searchParams.get("peek") ?? "";
  const peek = page.getByRole("dialog", { name: "Inbound from Coastline Freight Lines" });
  await expect(peek).toBeVisible();
  await expect(peek.getByText("Logged", { exact: true }).first()).toBeVisible();

  // Manifest line.
  await peek.getByLabel("Item").fill("Lighting Console");
  await peek.getByRole("button", { name: "Add line" }).click();
  await expect(peek.getByText("1 Lighting Console")).toBeVisible();
  await settled(page);

  // Book a dock slot for it; a second booking of the same window is refused.
  await peek.getByRole("link", { name: "Book dock slot" }).click();
  const book = page.getByRole("dialog", { name: "Book dock slot" });
  await book.getByLabel("Dock").selectOption({ label: "DOCK-B Loading Dock B" });
  await book.getByLabel("Starts").fill(`${day}T09:00`);
  await book.getByLabel("Ends").fill(`${day}T10:00`);
  await expectAccessible(page);
  await book.getByRole("button", { name: "Book dock slot" }).click();
  await expect(book).toBeHidden();
  await page.goto(`/${ORG}/logistics/dock-schedule?create=1&week=2027-03-08`);
  const again = page.getByRole("dialog", { name: "Book dock slot" });
  await again.getByLabel("Dock").selectOption({ label: "DOCK-B Loading Dock B" });
  await again.getByLabel("Starts").fill(`${day}T09:30`);
  await again.getByLabel("Ends").fill(`${day}T10:30`);
  await again.getByRole("button", { name: "Book dock slot" }).click();
  await expect(
    again.getByText(
      "That dock is already booked for part of this window. Pick another dock or time.",
    ),
  ).toBeVisible();
  await expectAccessible(page);

  // The vehicle arrives and is logged in the yard.
  await page.goto(`/${ORG}/logistics/marshalling-yard-log`);
  const arrival = page.getByRole("form", { name: "Record a vehicle arrival" });
  await arrival.getByLabel("Project").selectOption({ label: "NWS Northwind Summer Series" });
  await arrival.getByLabel("Plate or trailer number").fill(vehicle);
  await arrival
    .getByLabel("Shipment")
    .selectOption({ label: `${key} Inbound from Coastline Freight Lines` });
  await arrival.getByRole("button", { name: "Record arrival" }).click();
  await expect(page.getByRole("link", { name: vehicle })).toBeVisible();
  const entry = page.getByRole("form", { name: "Add log entry" });
  await entry.getByLabel("Project").selectOption({ label: "NWS Northwind Summer Series" });
  await entry.getByLabel("What happened").fill(`${vehicle} staged in lane 3.`);
  await entry
    .getByLabel("Shipment")
    .selectOption({ label: `${key} Inbound from Coastline Freight Lines` });
  await entry.getByRole("button", { name: "Add log entry" }).click();
  await expect(page.getByText(`${vehicle} staged in lane 3.`)).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // The Field Lead sees the vehicle but has no release authority.
  const field = await (await browser.newContext()).newPage();
  await signIn(field, "field@example.com");
  await field.goto(`/${ORG}/logistics/marshalling-yard-log`);
  await expect(field.getByRole("link", { name: vehicle })).toBeVisible();
  await expect(field.getByRole("button", { name: `Release ${vehicle}` })).toHaveCount(0);
  await expectAccessible(field);

  // Check in at the dock, then release, from the shipment.
  await page.goto(`/${ORG}/logistics/shipments?peek=${key}`);
  const record = page.getByRole("dialog", { name: "Inbound from Coastline Freight Lines" });
  await expect(record.getByText("At Gate", { exact: true }).first()).toBeVisible();
  await record.getByRole("button", { name: "Check in" }).click();
  await expect(record.getByText(/Checked in .* by Demo Producer/)).toBeVisible();
  await record.getByRole("button", { name: `Release ${vehicle}` }).click();
  await expect(record.getByText(/Released .* by Demo Producer/)).toBeVisible();
  await expect(record.getByText("Released", { exact: true }).first()).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // The full page shows the same record.
  await page.goto(`/${ORG}/logistics/shipments?peek=${key}&full=1`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Inbound from Coastline Freight Lines" }),
  ).toBeVisible();
  await expectAccessibleInBothThemes(page);
});
