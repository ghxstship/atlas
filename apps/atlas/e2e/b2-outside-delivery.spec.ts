import { expect, test } from "./engine-test";

/**
 * B2 outside delivery (RRR-226, ADR 0141; gap G-30): the parts that do not need the local Edge runtime. An RFC 8058 POST
 * with no Origin is refused by the Atlas proxy, which is why one-click goes through the email-unsubscribe function
 * (covered by vitest and pgTAP); a browser POST to the confirm route has an Origin and passes. The email itself needs
 * edge-runtime with fake XOS_APP_URL, XOS_POSTAL_ADDRESS and XOS_REPORT_MAILPIT_URL on the stack.
 */

test("the stop-email page never acts on a GET and its confirm refuses an unknown token", async ({
  page,
}) => {
  const token = `xpku_${"a".repeat(64)}`;
  await page.goto(`/share/pack/unsubscribe/${token}`);
  await expect(page.getByRole("heading", { name: "Stop these emails", exact: true })).toBeVisible();
  const get = await page.request.get(`/share/pack/unsubscribe/${token}/confirm`, {
    maxRedirects: 0,
  });
  expect(get.status()).toBe(303);
  await page.getByRole("button", { name: "Stop these emails", exact: true }).click();
  await expect(page.getByText("That did not work.", { exact: false })).toBeVisible();
});
