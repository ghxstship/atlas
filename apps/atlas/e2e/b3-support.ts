import { expect, type Locator } from "./engine-test";

/**
 * Gate 27 for a dialog opened over a drawer (B3, ADR 0142). cognitiveLoadProblems picks the first visible dialog in the
 * page, which is the drawer, so a dialog over it is measured here: at most seven visible fields and one primary action.
 */
export async function expectDialogWithinLoad(dialog: Locator): Promise<void> {
  await expect(dialog).toBeVisible();
  const fields = dialog.locator("input, select, textarea, [role='combobox'], [role='switch']");
  let visible = 0;
  for (const field of await fields.all()) {
    if (!(await field.isVisible())) continue;
    const type = (await field.getAttribute("type")) ?? "";
    if (!["hidden", "submit", "button", "reset", "search"].includes(type)) visible += 1;
  }
  expect(visible, "visible fields in the dialog").toBeLessThanOrEqual(7);
  await expect
    .poll(async () => {
      const primaries = dialog.locator("button.xos-fill-accent, a.xos-fill-accent");
      let count = 0;
      for (const primary of await primaries.all()) if (await primary.isVisible()) count += 1;
      return count;
    })
    .toBeLessThanOrEqual(1);
}
