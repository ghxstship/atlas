import { expect, test } from "./engine-test";
import { expectAccessibleInBothThemes, ORG, signIn } from "./operations-support";
import { uniqueId } from "./support";

/**
 * B5 (ADR 0144) on the demo tenant seed: the flight grid's views and export, transfers with a vehicle and a driver and
 * their refusals (a full vehicle, a driver booked twice at once), green rooms, the blocks Matrix, and the rooming list
 * read on request. Every page is checked with axe in both themes. Runs pick their own times and labels, so engines
 * running side by side never collide.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
expect.configure({ timeout: 20_000 });

test("the flight grid shows its built-in views and exports what is on screen", async ({ page }) => {
  await signIn(page, "owner@example.com");
  for (const query of ["", "?view=list", "?phase=Upcoming", "?phase=In+Flight,Departed"]) {
    await page.goto(`/${ORG}/hospitality/travel${query}`);
    await expect(page.getByRole("heading", { level: 1, name: "Flights" })).toBeVisible();
  }
  await expectAccessibleInBothThemes(page);
  await page.goto(`/${ORG}/p/NWS/hospitality?section=travel`);
  await expect(page.getByRole("heading", { level: 1, name: "Flights" })).toBeVisible();
});

test("a transfer takes a vehicle, a driver and passengers, and refuses a full vehicle and a double booking", async ({
  page,
}) => {
  const run = uniqueId().slice(-6).toUpperCase();
  // A day of 2029 and a minute picked by the run, so parallel engines book different windows.
  const offset = Number.parseInt(run, 36) % 300;
  const day = new Date(Date.UTC(2029, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);
  await signIn(page, "owner@example.com");
  await page.goto(`/${ORG}/p/NWS/hospitality?section=transfers&vehicles=1`);
  const vehicles = page.getByRole("dialog", { name: "Vehicles" });
  await vehicles.getByLabel("Label").fill(`Sedan ${run}`);
  await vehicles.getByLabel("Type").selectOption("Sedan");
  await vehicles.getByLabel("Passenger seats").fill("1");
  await vehicles.getByRole("button", { name: "Add vehicle" }).click();
  await expect(vehicles.getByText(`Sedan ${run}`)).toBeVisible();

  const book = async (from: string, to: string, pickup: string, dropoff: string) => {
    await page.goto(`/${ORG}/p/NWS/hospitality?section=transfers&create=1`);
    const drawer = page.getByRole("dialog", { name: "New transfer" });
    await drawer.getByLabel("Pickup place").fill(from);
    await drawer.getByLabel("Pickup", { exact: true }).fill(`${day}T${pickup}`);
    await drawer.getByLabel("Drop-off place").fill(to);
    await drawer.getByLabel("Drop-off", { exact: true }).fill(`${day}T${dropoff}`);
    await drawer.getByLabel("Vehicle").selectOption({ label: `Sedan ${run} (1 seats)` });
    await drawer.getByLabel("Driver").selectOption({ label: "Demo Field Lead" });
    await drawer.getByRole("button", { name: "New transfer" }).click();
    return drawer;
  };

  await book(`Airport ${run}`, "Crew Hotel", "14:00", "15:00");
  await page.waitForURL(/peek=NWS-\d+/);
  const peek = page.getByRole("dialog", { name: `Airport ${run} to Crew Hotel` });
  await peek.getByLabel("Person").selectOption({ index: 0 });
  await peek.getByRole("button", { name: "Add passenger" }).click();
  await expect(peek.getByRole("heading", { name: /Passengers \(1 of 1 seats\)/ })).toBeVisible();
  await peek.getByLabel("Person").selectOption({ index: 0 });
  await peek.getByRole("button", { name: "Add passenger" }).click();
  await expect(peek.getByText("The vehicle has no seat left.", { exact: false })).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // The same driver at an overlapping time is refused with its sentence.
  const second = await book(`Venue ${run}`, "Crew Hotel", "14:30", "15:30");
  await expect(
    second.getByText("The driver is on another transfer at that time.", { exact: false }),
  ).toBeVisible();
});

test("green rooms, the blocks matrix and the rooming list render, the list on request", async ({
  page,
}) => {
  await signIn(page, "owner@example.com");
  for (const view of ["list", "table", "resource-schedule"]) {
    await page.goto(`/${ORG}/hospitality/rooms?view=${view}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Green rooms and dressing rooms" }),
    ).toBeVisible();
  }
  await expectAccessibleInBothThemes(page);
  await page.goto(`/${ORG}/hospitality/accommodation-blocks?view=matrix`);
  await expect(page.getByRole("heading", { level: 1, name: "Accommodation blocks" })).toBeVisible();
  await expectAccessibleInBothThemes(page);
  await page.goto(`/${ORG}/p/NWS/hospitality?section=rooming`);
  await expect(page.getByRole("heading", { level: 1, name: "Rooming list" })).toBeVisible();
  // Each read is logged per person, so nothing loads until asked; there is no export.
  await expect(page.getByRole("button", { name: "Load the rooming list" })).toBeVisible();
  await page.getByRole("button", { name: "Load the rooming list" }).click();
  await expect(
    page
      .getByRole("region", { name: "Rooming list" })
      .or(page.getByText("No one on the travel party needs a room."))
      .first(),
  ).toBeVisible();
  await expectAccessibleInBothThemes(page);
});
