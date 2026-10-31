import { expect, settle, test } from "./engine-test";
import { DEMO_ORG, signInAs } from "./a36-support";
import {
  localSql,
  newCategory,
  OWNER,
  PRODUCER_EMAIL,
  projectId,
  PROJECT_KEY,
  removeCategories,
} from "./b8-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * B8 (RRR-232, gaps G-68 and G-71): guest passes and guest emails on the NWS guest list. An approved guest with a pass
 * type, a table and an email gets a pass code; the list shows the pass type and the table, the peek the code and Print
 * pass, and the pass is a one-page A6 PDF, while a Requested guest has none. Email guests queues their pass; nothing is
 * sent here, since the local stack records email instead of sending it.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);

test.describe("Guest passes and guest emails (B8)", () => {
  test("stamps a pass on approval, prints it on A6 and emails it", async ({ page }) => {
    const id = uniqueId().slice(-6).toUpperCase();
    const vip = await newCategory(`B8V-${id}`, `VIP Guest ${id}`);
    const project = await projectId();
    const [approved] = await localSql<{ id: string; pass_code: string }>(
      `insert into app.guest_list_entries (project_id, guest_name, plus_ones, entry_state, pass_category_id, table_label, guest_email)
       values ($1, $2, 1, 'Approved', $3, 'Table 4', $4) returning id, pass_code`,
      [project, `Sasha Bell ${id}`, vip, `sasha.${id.toLowerCase()}@example.com`],
      OWNER,
    );
    const [requested] = await localSql<{ id: string }>(
      "insert into app.guest_list_entries (project_id, guest_name) values ($1, $2) returning id",
      [project, `Rowan Hale ${id}`],
      OWNER,
    );
    try {
      expect(approved?.pass_code).toMatch(/^GP-[A-Z2-7]{10}$/);
      await signInAs(page, PRODUCER_EMAIL, DEMO_ORG);
      const list = `/${DEMO_ORG}/p/${PROJECT_KEY}/advancing?section=guests`;
      await page.goto(`${list}&view=table`);
      const table = page.getByRole("grid");
      await expect(table.getByRole("columnheader", { name: "Pass type" })).toBeVisible();
      await expect(table).toContainText(`B8V-${id} · VIP Guest ${id}`);
      await expect(table).toContainText("Table 4");

      await page.goto(`${list}&peek=${approved?.id}`);
      const peek = page.getByRole("dialog");
      await expect(peek).toContainText(approved?.pass_code ?? "");
      await expect(peek.getByRole("link", { name: "Print pass" })).toBeVisible();

      const pdf = await page.request.get(
        `/${DEMO_ORG}/documents/guest-pass/${approved?.id}?paper=a6`,
      );
      expect(pdf.status()).toBe(200);
      expect(pdf.headers()["content-type"]).toBe("application/pdf");
      const body = (await pdf.body()).toString("latin1");
      expect(body).toContain("/MediaBox [0 0 297.64 419.53]");
      expect((body.match(/\/Type \/Page\b(?!s)/g) ?? []).length).toBe(1);
      const none = await page.request.get(
        `/${DEMO_ORG}/documents/guest-pass/${requested?.id}?paper=a6`,
      );
      expect(none.status()).toBe(404);

      await page.goto(list);
      await settle(page);
      await page.getByRole("button", { name: "Email guests" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("What to send").selectOption("Pass");
      await expect(dialog).toContainText("will be skipped");
      await dialog.getByRole("button", { name: /^Send to \d+ guests?$/ }).click();
      await expect(dialog.getByText(/^Queued for \d+ guests?$/)).toBeVisible();
      await expectAccessible(page);
    } finally {
      await localSql(
        "update app.guest_list_entries set deleted_at = now() where id = any ($1) and deleted_at is null",
        [[approved?.id, requested?.id]],
      ).catch((error: unknown) => console.warn("B8 journey cleanup", error));
      await removeCategories([vip]);
    }
  });
});
