import { deliverPacks, latestMail, localStack, mailLinks } from "./b2-support";
import { expect, test } from "./engine-test";
import { createOrganization, signUp, testEmail, uniqueId } from "./support";

/**
 * B2 outside delivery (RRR-226, ADR 0141; gap G-30). An RFC 8058 POST with no Origin is refused by the Atlas proxy, which
 * is why one-click goes through the email-unsubscribe function; a browser POST to the confirm route has an Origin and
 * passes. The scheduled email runs through the worker in this process with fake addresses, the code report-run runs. The
 * POST to the function needs edge-runtime on the stack, as CI's has: a stack without it says so in the test's annotations
 * and takes the same call straight to app.unsubscribe_pack_by_token, so only a function that is not being served at all
 * is excused. Any answer from the function itself must be its own.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);

test("a scheduled send emails a link with one-click headers and a footer, and stopping it holds", async ({
  page,
}) => {
  const id = uniqueId();
  const slug = `b2d-${id}`;
  const email = `sol-${id}@supplier.test`;
  await signUp(page, { name: "Dee Delivery", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Delivery ${id}`, slug });
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const create = page.getByRole("dialog", { name: "New project" });
  await create.getByLabel("Project key").fill("SHW");
  await create.getByLabel("Project name").fill("Summer Headline Weekend");
  await create.getByRole("button", { name: "More fields" }).click();
  await create.getByLabel("Jurisdiction").selectOption("US-FL-MIAMI-DADE");
  await create.getByLabel("Tier of experience").selectOption({ index: 5 });
  await create.getByLabel("First production day").fill("2027-03-12");
  await create.getByLabel("Last production day").fill("2027-03-15");
  await create.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/SHW/overview`);

  await page.goto(`/${slug}/p/SHW/settings#outside-access`);
  const section = page.locator("#outside-access");
  await expect(async () => {
    await section.getByRole("button", { name: "New stakeholder pack", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2_000 });
  }).toPass();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill(`Supplier pack ${id}`);
  await dialog.getByRole("button", { name: "Save details" }).click();
  await expect(dialog.getByRole("button", { name: "Add item" })).toBeVisible();
  await dialog.getByRole("button", { name: "Recipients", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Sol Supplier");
  await dialog.getByLabel("Email", { exact: true }).fill(email);
  await dialog.getByRole("button", { name: "Add recipient" }).click();
  await expect(dialog.getByText(email)).toBeVisible();
  await dialog.getByRole("button", { name: "Delivery", exact: true }).click();
  await dialog.getByLabel("Schedule", { exact: true }).selectOption("Daily");
  await dialog.getByRole("button", { name: "Save schedule" }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Schedule saved." })).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).first().click();

  // The slot comes due, the scheduler runs, the worker sends.
  const { client, url } = localStack();
  const app = client.schema("app");
  const recipient = await app
    .from("stakeholder_pack_recipients")
    .select("id, stakeholder_pack_id")
    .eq("email", email)
    .single();
  expect(recipient.error).toBeNull();
  const packId = (recipient.data as { stakeholder_pack_id: string }).stakeholder_pack_id;
  await expect(async () => {
    const moved = await app
      .from("stakeholder_pack_schedules")
      .update({ next_run_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("stakeholder_pack_id", packId)
      .select("id");
    expect(moved.data).toHaveLength(1);
  }).toPass();
  const queued = await app.rpc("queue_due_pack_schedules", {});
  expect(queued.error).toBeNull();
  expect(queued.data).toBe(1);
  expect((await app.rpc("queue_due_pack_schedules", {})).data).toBe(0);
  await deliverPacks(new URL(page.url()).origin);

  const mail = await latestMail(page.request, email);
  const { pack, stop, unsubscribeToken } = mailLinks(mail);
  expect(pack).toMatch(/^\/share\/pack\/xpkl_/);
  expect(mail.attachments).toBe(0);
  expect(mail.text).toContain("Sent by");
  expect(mail.text).toContain("100 Harbor Way");
  expect(mail.headers["List-Unsubscribe"]?.[0]).toContain(
    `/functions/v1/email-unsubscribe?token=${unsubscribeToken}`,
  );
  expect(mail.headers["List-Unsubscribe-Post"]?.[0]).toBe("List-Unsubscribe=One-Click");

  // One-click, a POST with no Origin to the function. Kong answers 502 to 504 only when no Edge runtime stands behind it.
  const oneClickUrl = (token: string) => `${url}/functions/v1/email-unsubscribe?token=${token}`;
  const oneClick = await page.request
    .post(oneClickUrl(unsubscribeToken), { headers: { Origin: "" } })
    .catch(() => null);
  const status = oneClick?.status() ?? null;
  if (status === null || (status >= 502 && status <= 504)) {
    test.info().annotations.push({
      type: "not run",
      description: `email-unsubscribe is not being served on this stack (${status ?? "no connection"}), so the POST with no Origin was not exercised. Vitest and pgTAP cover it.`,
    });
    expect((await app.rpc("unsubscribe_pack_by_token", { p_token: unsubscribeToken })).data).toBe(
      true,
    );
  } else {
    expect(status).toBe(204);
    // Repeating it changes nothing, and a token nobody holds is the function's own 404.
    const again = await page.request.post(oneClickUrl(unsubscribeToken), {
      headers: { Origin: "" },
    });
    expect(again.status()).toBe(204);
    const unknown = await page.request.post(oneClickUrl(`xpku_${"0".repeat(64)}`), {
      headers: { Origin: "" },
    });
    expect(unknown.status()).toBe(404);
  }
  const after = await app
    .from("stakeholder_pack_recipients")
    .select("unsubscribed_at")
    .eq("email", email)
    .single();
  expect((after.data as { unsubscribed_at: string | null }).unsubscribed_at).not.toBeNull();

  // The next slot skips them, and the confirm page answers the same state.
  await app
    .from("stakeholder_pack_schedules")
    .update({ next_run_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("stakeholder_pack_id", packId);
  expect((await app.rpc("queue_due_pack_schedules", {})).data).toBe(0);
  await page.goto(stop);
  await page.getByRole("button", { name: "Stop these emails", exact: true }).click();
  await expect(page.getByText("You will not get these emails again.")).toBeVisible();
});

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
