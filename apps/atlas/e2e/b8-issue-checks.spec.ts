import { expect, settle, test } from "./engine-test";
import { DEMO_ORG, signInAs } from "./a36-support";
import {
  DEMO_ORG_ID,
  issue,
  localSql,
  newCategory,
  OWNER,
  personNamed,
  PRODUCER_EMAIL,
  PROJECT_KEY,
  removeCategories,
} from "./b8-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * B8 (RRR-232, gaps G-147 and G-148): the issue form's checks. A category that requires a certification the holder
 * lacks lists it as blocking and keeps Issue disabled, and the database refuses the issue too; a second live badge of
 * the same Access category for an overlapping window is a duplicate, while a Parking category lets one person hold
 * two passes. The Issued page shows the Source and the checks, and Needs attention lists only flagged badges.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);

test.describe("Issue checks (B8)", () => {
  test("blocks a badge until its training is met and refuses a duplicate", async ({ page }) => {
    const id = uniqueId().slice(-6).toUpperCase();
    const trained = await newCategory(`B8T-${id}`, `Trained ${id}`);
    const crew = await newCategory(`B8C-${id}`, `Crew ${id}`);
    const parking = await newCategory(`B8P-${id}`, `Parking ${id}`, "Parking");
    const holder = await personNamed("Demo Field Lead");
    try {
      const [cert] = await localSql<{ id: string }>(
        "insert into app.certifications (org_id, name, issuing_body) values ($1, $2, 'Northwind Live') returning id",
        [DEMO_ORG_ID, `Site Induction ${id}`],
        OWNER,
      );
      await localSql(
        "insert into app.credential_category_requirements (credential_category_id, certification_id) values ($1, $2)",
        [trained, cert?.id],
        OWNER,
      );
      await issue(crew, holder);

      // The database refuses what the form shows as blocking.
      await expect(issue(trained, holder)).rejects.toThrow(/credential_training_incomplete/);
      await expect(issue(crew, holder)).rejects.toThrow(/credential_duplicate/);
      await issue(parking, holder);
      await issue(parking, holder);

      await signInAs(page, PRODUCER_EMAIL, DEMO_ORG);
      await page.goto(`/${DEMO_ORG}/credentials/issued?project=${PROJECT_KEY}&create=1`);
      await settle(page);
      await page.locator("#issue-category").selectOption({ label: `B8T-${id} · Trained ${id}` });
      await page.locator("#issue-holder").selectOption({ label: "Demo Field Lead" });
      await expect(page.getByText(`Training missing: Site Induction ${id}`)).toBeVisible();
      await expect(page.getByRole("button", { name: "Issue credential" }).last()).toBeDisabled();
      await expect(page.getByRole("link", { name: "Open" }).first()).toHaveAttribute(
        "href",
        /\/people\/certifications\?peek=/,
      );

      await page.locator("#issue-category").selectOption({ label: `B8C-${id} · Crew ${id}` });
      await expect(page.getByText("Already holds a live badge of this category")).toBeVisible();
      await expect(page.getByRole("button", { name: "Issue credential" }).last()).toBeDisabled();

      await page.goto(`/${DEMO_ORG}/credentials/issued?project=${PROJECT_KEY}&view=table`);
      const table = page.getByRole("table");
      await expect(table.getByRole("columnheader", { name: "Source" })).toBeVisible();
      await expect(table.getByRole("columnheader", { name: "Checks" })).toBeVisible();
      await page.goto(
        `/${DEMO_ORG}/credentials/issued?project=${PROJECT_KEY}&view=table&attention=1`,
      );
      // Demo Field Lead holds badges of three categories here, so every row of theirs is flagged.
      await expect(page.getByRole("table")).toContainText("Other badge here");
      await expectAccessible(page);
    } finally {
      await removeCategories([trained, crew, parking]);
    }
  });
});
