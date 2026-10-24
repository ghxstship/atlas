import { ORG, signIn } from "./a16-support";
import { expect, test } from "./engine-test";
import { expectAccessible } from "./support";

/**
 * A89 (RRR-134), findings A65-008 and A65-031, the org's side in Atlas: the supplier diversity program
 * setting (gateway.supplier_diversity_program, off by default) decides whether Vendors, Directory lists
 * the certifications vendors and freelancers shared, and Settings, Notifications offers the new
 * Opportunities and Expiry reminders categories.
 */
test.use({ reducedMotion: "reduce" });

test("the supplier diversity program setting and the shared certifications under Vendors", async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);
  await signIn(page);
  const setting = async () => {
    await page.goto(`/${ORG}/settings/gateway-and-marketplace`);
    const form = page.getByRole("form", { name: "Settings on this page" });
    return { form, box: form.getByLabel("Supplier diversity program") };
  };
  const save = async (form: ReturnType<typeof page.getByRole>) => {
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form.getByRole("button", { name: "Save", exact: true })).toHaveCount(0, {
      timeout: 20_000,
    });
  };

  let { form, box } = await setting();
  await expect(box).toBeVisible();
  const wasOn = await box.isChecked();
  await expect(form.getByText(/separate consent/)).toBeVisible();
  if (wasOn) {
    await box.uncheck();
    await save(form);
  }

  await page.goto(`/${ORG}/vendors/directory`);
  const section = page.getByRole("region", { name: "Supplier diversity" });
  await expect(section.getByText(/runs no supplier diversity program/)).toBeVisible();
  await expect(section.getByRole("link", { name: "Turn it on in Settings" })).toBeVisible();
  await expectAccessible(page);

  ({ form, box } = await setting());
  await box.check();
  await save(form);
  await page.goto(`/${ORG}/vendors/directory`);
  await expect(section.getByText(/runs no supplier diversity program/)).toHaveCount(0);
  await expect(
    section.getByText(
      /Nobody has shared|shared with your organization for its supplier diversity program/,
    ),
  ).toBeVisible();
  await expectAccessible(page);

  if (!wasOn) {
    ({ form, box } = await setting());
    await box.uncheck();
    await save(form);
  }

  await page.goto(`/${ORG}/settings/notifications`);
  const defaults = page.getByRole("form", { name: "Organization notification defaults" });
  await expect(defaults.getByText("Opportunities", { exact: true }).first()).toBeVisible();
  await expect(defaults.getByText("Expiry reminders", { exact: true }).first()).toBeVisible();
});
