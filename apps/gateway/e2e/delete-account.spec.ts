import { expect as baseExpect, test } from "./engine-test";
import { newSignIn } from "./role-fixtures";
import { expectAccessible, expectAccessibleInBothThemes, signIn, sql, uniqueId } from "./support";

/**
 * Delete Account in Gateway settings (ADR 0028, journey 38; App Store guideline 5.1.1(v)): the
 * same preview, refusals and kept-records copy as Compass, through @xos/data/account-deletion. A
 * sole account owner is told what blocks deletion and gets no delete control; a person with no
 * blocker types their sign-in email, confirms, and the sign-in is gone while what the law keeps
 * stays listed.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(120_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("a sole account owner sees what blocks deleting the account", async ({ page }) => {
  await signIn(page, "vendor@example.com", "/settings/account");
  const section = page.getByRole("region", { name: "Delete Account" });
  await expect(section.getByText("Your account cannot be deleted yet")).toBeVisible();
  await expect(
    section.getByText(
      /You are the only owner of .+\. Make someone else an owner, then delete your account\./,
    ),
  ).toBeVisible();
  await expect(section.getByText("What is kept, and why")).toBeVisible();
  await expect(section.getByRole("button", { name: "Delete My Account" })).toHaveCount(0);
  await expectAccessibleInBothThemes(page);
});

test("a person deletes their account after typing their email and confirming", async ({ page }) => {
  const email = `leaving-${uniqueId()}@example.com`;
  const personId = await newSignIn(email, "Demo Leaver");
  await signIn(page, email, "/settings/account");
  const section = page.getByRole("region", { name: "Delete Account" });
  await expect(
    section.getByText("Deleting your account signs you out and erases your sign-in"),
  ).toBeVisible();
  await expect(
    section.getByText("The security audit trail, kept 7 years.", { exact: false }),
  ).toBeVisible();

  const remove = section.getByRole("button", { name: "Delete My Account" });
  await expect(remove).toBeDisabled();
  await section.getByLabel("Type your sign-in email to confirm").fill(`someone-else-${email}`);
  await expect(section.getByText("That is not the email you sign in with.")).toBeVisible();
  await section.getByLabel("Type your sign-in email to confirm").fill(email);
  await expect(remove).toBeEnabled();
  await expectAccessible(page);

  await remove.click();
  const dialog = page.getByRole("dialog", { name: "Delete your account now?" });
  await expect(dialog).toBeVisible();
  // axe samples colors only after the dialog's entrance animation ends.
  await page.mouse.move(0, 0);
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Keep my account" }).click();
  await expect(dialog).toBeHidden();
  await remove.click();
  await page
    .getByRole("dialog", { name: "Delete your account now?" })
    .getByRole("button", { name: "Delete My Account" })
    .click();

  await expect(page.getByRole("heading", { name: "Your account is deleted" })).toBeVisible();
  await expect(
    page.getByText(/Your sign-in, name and profile are erased\. Organizations told: 0\./),
  ).toBeVisible();
  await expectAccessible(page);

  const [person] = await sql<{
    user_id: string | null;
    full_name: string | null;
    deleted: boolean;
  }>(`select user_id, full_name, deleted_at is not null as deleted from app.people where id = $1`, [
    personId,
  ]);
  expect(person).toEqual({ user_id: null, full_name: null, deleted: true });
  const [users] = await sql<{ n: string }>(
    `select count(*)::text as n from auth.users where email = $1`,
    [email],
  );
  expect(users?.n).toBe("0");

  // The session is gone: the account settings page now asks to sign in.
  await page.getByRole("button", { name: "Done" }).click();
  await page.goto("/settings/account");
  await expect(page).toHaveURL(/\/auth\/sign-in/);
});
