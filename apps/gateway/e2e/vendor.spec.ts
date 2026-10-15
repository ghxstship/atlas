import { expect, test } from "@playwright/test";
import { completeVendorEngagement } from "./fixtures";
import { expectAccessible, expectAccessibleInBothThemes, signIn, uniqueId } from "./support";

/**
 * Vendor reputation on Gateway (Section 20.2, journey 49): after a Complete engagement the vendor
 * rates the org, both ratings release together, and the vendor answers the org's rating with a
 * public reply on their profile. Ratings cannot be changed once given.
 */
test("a vendor rates a completed engagement and replies to the org's rating", async ({ page }) => {
  const engagement = await completeVendorEngagement();
  const reply = `Thanks for a smooth show ${uniqueId()}.`;
  await signIn(page, "vendor@example.com", `/work/engagements/${engagement.key}/overview`);

  const form = page.getByRole("form", { name: "Rate Demo Productions" });
  await expect(form).toBeVisible();
  await expectAccessibleInBothThemes(page);
  await expect(form.getByRole("button", { name: "Send rating" })).toBeDisabled();
  await form.getByRole("radio", { name: "5 stars" }).click();
  await expect(form.getByRole("radio", { name: "5 stars" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await form.getByLabel("Public comment").fill("Clear advance and fast payment.");
  await form.getByRole("button", { name: "Send rating" }).click();
  await expect(page.getByText(/^Rating sent\./)).toBeVisible();

  await page.reload();
  await expect(page.getByRole("form", { name: "Rate Demo Productions" })).toHaveCount(0);
  await expect(page.getByText(/^Thanks\. Both ratings appear/)).toBeVisible();

  await page.goto("/profile");
  const rating = page.getByRole("listitem").filter({ hasText: engagement.comment });
  await expect(rating).toBeVisible();
  await expect(rating.getByText("4 of 5")).toBeVisible();
  await expectAccessible(page);
  await rating.getByRole("textbox", { name: "Public reply" }).fill(reply);
  await rating.getByRole("button", { name: "Reply" }).click();
  await expect(rating.getByText("Reply posted.")).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("listitem").filter({ hasText: engagement.comment }).getByText(`Reply: ${reply}`),
  ).toBeVisible();
});
