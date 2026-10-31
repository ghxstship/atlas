import { expect, settle, test, type Page } from "./engine-test";
import { DEMO_ORG, signInAs } from "./a36-support";
import {
  grantZone,
  issue,
  newCategory,
  personNamed,
  PRODUCER_EMAIL,
  projectId,
  PROJECT_KEY,
  removeCategories,
} from "./b8-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * B8 (RRR-232, gaps G-145 and G-149): gate scanning on the Atlas scan log and the muster list, on the demo tenant.
 * A badge of a category that opens the Festival Lawn only is scanned In at the lawn (granted), Out (the exit is
 * recorded), and In at the VIP Terrace (denied, with the reason). A supervisor who is not the holder lets the person in
 * there with a reason; the log shows the direction, the reason and the Overridden row with who let them in. Inside now
 * counts the person in the VIP Terrace, and the Muster List groups them under it, printable, for a reader of the scan
 * log. The category is unique to the run and revoked afterwards.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);

const LAWN = "LAWN · Festival Lawn · Bayside Festival Grounds";
const VIP = "VIP · VIP Terrace · Bayside Festival Grounds";

async function scan(page: Page, zone: string, direction: "In" | "Out", number: string) {
  await page.locator("#scan-zone").selectOption({ label: zone });
  await page.locator("#scan-direction").selectOption(direction);
  await page.locator("#scan-number").fill(number);
  await page.getByRole("button", { name: "Check credential" }).click();
}

test.describe("Gate scans, overrides, Inside now and the muster list (B8)", () => {
  test("scans In and Out, shows a denial's reason, overrides it, and musters by zone", async ({
    page,
  }) => {
    const id = uniqueId().slice(-6).toUpperCase();
    const category = await newCategory(`B8G-${id}`, `Gate journey ${id}`);
    try {
      await grantZone(category, "LAWN");
      const badge = await issue(category, await personNamed("Demo Field Lead"));
      await signInAs(page, PRODUCER_EMAIL, DEMO_ORG);

      await page.goto(`/${DEMO_ORG}/credentials/scan-log?project=${PROJECT_KEY}`);
      await settle(page);
      await scan(page, LAWN, "In", badge.number);
      await expect(page.getByRole("status").filter({ hasText: badge.number })).toContainText(
        "access granted",
      );
      await scan(page, LAWN, "Out", badge.number);
      await expect(page.getByRole("status").filter({ hasText: badge.number })).toContainText(
        "exit recorded",
      );
      await scan(page, VIP, "In", badge.number);
      await expect(page.getByRole("status").filter({ hasText: badge.number })).toContainText(
        "access denied, the badge has no access to this zone",
      );

      // A supervisor lets the person in within 15 minutes, with a reason.
      await page.reload();
      await settle(page);
      const denials = page.getByRole("region", { name: "Recent denials" });
      await expect(denials).toContainText(badge.number);
      await denials.getByLabel("Reason").first().fill("Escorted by the production office.");
      await denials.getByRole("button", { name: "Let in" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Override recorded" })).toBeVisible();

      await page.goto(`/${DEMO_ORG}/credentials/scan-log?project=${PROJECT_KEY}&direction=Out`);
      const outOnly = page.getByRole("table");
      await expect(outOnly).toContainText(badge.number);
      await expect(outOnly).not.toContainText("Denied");

      await page.goto(`/${DEMO_ORG}/credentials/scan-log?project=${PROJECT_KEY}`);
      const log = page.getByRole("table");
      await expect(log.getByRole("columnheader", { name: "Direction" })).toBeVisible();
      await expect(log).toContainText("Denied: the badge has no access to this zone");
      await expect(log).toContainText("Overridden");
      await expect(log).toContainText(
        "Let in by Demo Producer: Escorted by the production office.",
      );

      const inside = page.getByRole("region", { name: "Inside now" });
      await expect(inside).toContainText("VIP");
      await expect(inside.getByRole("button", { name: "Pause updates" })).toBeVisible();
      await inside.getByRole("button", { name: "Pause updates" }).click();
      await expect(inside.getByRole("button", { name: "Resume updates" })).toBeVisible();
      await expectAccessible(page);

      await page.goto(`/${DEMO_ORG}/site-ops/muster?project=${await projectId()}`);
      await expect(page.getByRole("heading", { level: 1, name: "Muster list" })).toBeVisible();
      const vip = page.getByRole("region", { name: /^VIP · VIP Terrace/ });
      await expect(vip).toContainText("Demo Field Lead");
      await expect(vip).toContainText("Entry scan");
      await expect(page.getByRole("button", { name: "Print" })).toBeVisible();
      await page.emulateMedia({ media: "print" });
      await expect(vip.getByRole("columnheader", { name: "Name" })).toBeVisible();
      await page.emulateMedia({ media: "screen" });
      await expectAccessible(page);
    } finally {
      await removeCategories([category]);
    }
  });
});
