import { expect, test } from "@playwright/test";

/**
 * B2 public forms (RRR-226, ADR 0141; gap G-293): the anonymous side of a public form link. A wrong-shaped address is a
 * 404, a known-shaped token that does not exist is refused without a session, and GET on the open route never acts.
 * Making the link and approving a response are in Atlas; pgTAP 2916 covers every refusal.
 */

test("a public form address asks for a code and answers no-store", async ({ page }) => {
  const token = `xfrm_${"0".repeat(64)}`;
  await page.goto(`/forms/${token}`);
  await expect(page.getByLabel("Access code")).toBeVisible();
  const post = await page.request.post(`/forms/${token}/open`, {
    form: { accessCode: "000000" },
    maxRedirects: 0,
  });
  expect(post.status()).toBe(303);
  expect(post.headers()["cache-control"]).toContain("no-store");
  expect(post.headers()["location"]).toContain("reason=form_link_invalid");
  const get = await page.request.get(`/forms/${token}/open`, { maxRedirects: 0 });
  expect(get.status()).toBe(303);
  expect((await page.request.get("/forms/nope")).status()).toBe(404);
});
