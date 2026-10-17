import { expect, test } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * Aurora AI (A25, Section 4.7): Cmd or Ctrl+J and the Ask Aurora button open the assistant panel,
 * which is keyboard-complete and axe clean in both themes with reduced motion; a new org on the
 * free Access plan sees the plan refusal, never a prompt box; and Settings, AI Features shows the
 * six switches off and locked until the plan includes Aurora AI. No model is called.
 */
test.use({ reducedMotion: "reduce" });

test("the Aurora panel and AI Features settings refuse cleanly on a plan without Aurora", async ({
  page,
}) => {
  test.setTimeout(3 * 60_000);
  const id = uniqueId();
  const slug = `aurora-${id}`;
  await signUp(page, { name: "Avery Aurora", email: testEmail("aurora", id) });
  await createOrganization(page, { name: `Aurora ${id}`, slug });

  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.goto(`/${slug}/home`);
    await page.keyboard.press("ControlOrMeta+j");
    const panel = page.getByRole("dialog", { name: "Aurora" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/you are talking with Aurora, an AI assistant/i)).toBeVisible();
    await expect(panel.getByText("Aurora AI is not in your plan")).toBeVisible();
    await expect(panel.getByRole("button", { name: "View plans" })).toBeVisible();
    await expect(panel.getByLabel("Ask about your org's records")).toHaveCount(0);
    await expectAccessible(page);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  }

  await page.getByRole("button", { name: "Ask Aurora" }).click();
  await expect(page.getByRole("dialog", { name: "Aurora" })).toBeVisible();
  await page.keyboard.press("Escape");

  const response = await page.goto(`/${slug}/settings/ai-features`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Aurora AI features" })).toBeVisible();
  for (const label of [
    "Assistant",
    "Ask in plain language",
    "Document extraction",
    "Drafting",
    "Summaries",
    "Mapping help",
  ]) {
    const control = page
      .getByRole("switch", { name: label })
      .or(page.getByRole("checkbox", { name: label }));
    await expect(control).not.toBeChecked();
    await expect(control).toBeDisabled();
  }
  await expect(page.getByText(/Aurora AI is not in this org's plan/)).toBeVisible();
  await expect(page.getByRole("link", { name: "AI Features Notice" })).toBeVisible();
  await expectAccessible(page);
});
