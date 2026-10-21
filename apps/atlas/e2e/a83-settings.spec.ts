import { expect, test } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expectAccessibleInBothThemes } from "./a16-support";
import { DEMO_ORG, signInAs } from "./a36-support";
import { uniqueId } from "./support";

/**
 * A83 (RRR-128): Settings, Integrations. Warehouse delivery is an Enterprise feature (finding A65-029): a Team
 * org is told so; an Enterprise org adds a bucket, stores its credential, asks for a delivery, sees it queued and
 * the columns that are never delivered, then deletes the destination. A provider webhook that failed for good
 * (finding A65-013) is sent back by the Admin with a reason. The plan change and the dead letter are set up with
 * the local service key, as the billing service and the integration worker would.
 */

const DEMO_ORG_ID = "01920000-0000-7000-8000-000000000001";
const DEMO_SLACK = "01920000-0000-7000-8000-000000219003";

function service(): SupabaseClient {
  const url = process.env["E2E_SUPABASE_URL"];
  const key = process.env["E2E_SUPABASE_SERVICE_KEY"];
  if (!url || !key || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) {
    throw new Error("Set E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_KEY to the local stack.");
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function setPlan(plan: "team" | "enterprise") {
  const { error } = await service()
    .schema("app")
    .from("subscriptions")
    .update({ plan_code: plan })
    .eq("org_id", DEMO_ORG_ID)
    .is("deleted_at", null);
  expect(error).toBeNull();
}

test.describe.configure({ mode: "serial" });

test("warehouse delivery: Team orgs are told it is Enterprise", async ({ page }) => {
  await setPlan("team");
  await signInAs(page, "owner@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/settings/integrations`);
  await expect(page.getByRole("heading", { name: "Warehouse delivery" })).toBeVisible();
  await expect(page.getByText("Warehouse delivery is part of the Enterprise plan.")).toBeVisible();
});

test("warehouse delivery: an Enterprise org adds a bucket, stores its credential and asks for a delivery", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const id = uniqueId();
  await setPlan("enterprise");
  try {
    await signInAs(page, "owner@example.com", DEMO_ORG);
    await page.goto(`/${DEMO_ORG}/settings/integrations`);
    const panel = page.getByRole("region", { name: "Warehouse delivery" });
    await expect(panel.getByText("Columns never delivered")).toBeVisible();
    await expect(
      panel.getByText("pay_rates.rate_minor: Restricted, never delivered"),
    ).toBeVisible();

    const form = page.getByRole("form", { name: "Add a destination" });
    await form.getByLabel("Name").fill(`Analytics Lake ${id}`);
    await form.getByLabel("Bucket").fill(`northwind-lake-${id}`.toLowerCase().slice(0, 60));
    await form.getByLabel("Region").fill("us-east-1");
    await form.getByLabel("Delivery hour (UTC)").fill("3");
    await form.getByRole("button", { name: "Add destination" }).click();
    await expect(page.getByText("Destination added. Store its credential next.")).toBeVisible();

    const destination = page.getByRole("listitem").filter({ hasText: `Analytics Lake ${id}` });
    await expect(destination.getByText("No credential stored yet.")).toBeVisible();
    await destination.getByRole("button", { name: "Deliver now" }).click();
    await expect(
      destination.getByText("Store the bucket credential before the first delivery."),
    ).toBeVisible();

    // A runtime-built credential for a bucket that does not exist; nothing is ever sent from the test.
    const credential = JSON.stringify({
      access_key_id: ["e2e", "key", id].join("-"),
      secret_access_key: ["e2e", "secret", id].join("-"),
    });
    await destination.getByRole("textbox", { name: "Bucket credential (JSON)" }).fill("not json");
    await destination.getByRole("button", { name: "Store credential" }).click();
    await expect(
      destination.getByText(
        "The credential must be JSON with access_key_id and secret_access_key.",
      ),
    ).toBeVisible();
    await destination.getByRole("textbox", { name: "Bucket credential (JSON)" }).fill(credential);
    await destination.getByRole("button", { name: "Store credential" }).click();
    await expect(page.getByText("Credential stored.")).toBeVisible();

    await page.reload();
    const stored = page.getByRole("listitem").filter({ hasText: `Analytics Lake ${id}` });
    await expect(stored.getByText(/Credential stored /)).toBeVisible();
    await stored.getByRole("button", { name: "Deliver now" }).click();
    await expect(stored.getByText("Delivery queued. It starts within a minute.")).toBeVisible();
    await page.reload();
    const deliveries = page.getByRole("region", { name: "Recent deliveries" });
    await expect(deliveries).toContainText("Queued");
    await expect(deliveries).toContainText(`Analytics Lake ${id}`);
    await expectAccessibleInBothThemes(page);

    await page
      .getByRole("listitem")
      .filter({ hasText: `Analytics Lake ${id}` })
      .getByRole("button", { name: "Delete destination" })
      .click();
    // The destination leaves the list, and its pending delivery fails when the worker claims it.
    await expect(
      page.getByRole("listitem").filter({ hasText: `Analytics Lake ${id}` }),
    ).toHaveCount(0, {
      timeout: 20_000,
    });
  } finally {
    await setPlan("team");
  }
});

test("provider webhooks: the Admin sends a dead letter back with a reason", async ({ page }) => {
  const app = service().schema("app");
  const key = `e2e-${uniqueId()}`;
  const recorded = await app.rpc("record_integration_inbound_event", {
    p_connection_id: DEMO_SLACK,
    p_kind: "Link Unfurl",
    p_idempotency_key: key,
    p_payload: { team_id: "T0DEMO", links: [] },
  });
  expect(recorded.error).toBeNull();
  const eventId = (recorded.data as { event_id: string }[])[0]?.event_id ?? "";
  expect(
    (await app.rpc("claim_integration_inbound_event", { p_event_id: eventId })).error,
  ).toBeNull();
  const failed = await app.rpc("fail_integration_inbound_event", {
    p_event_id: eventId,
    p_error_code: "slack_invalid_auth",
    p_error_message: "Slack refused the token: invalid_auth.",
    p_retryable: false,
  });
  expect(failed.data).toBe("Dead Letter");

  await signInAs(page, "owner@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/settings/integrations`);
  const panel = page.getByRole("region", { name: "Provider webhooks" });
  const letter = panel
    .getByRole("listitem")
    .filter({ hasText: "Slack refused the token: invalid_auth." })
    .first();
  await expect(letter).toContainText("Slack, link unfurl");
  await letter.getByLabel("Why try again").fill("The Slack app was reinstalled.");
  await letter.getByRole("button", { name: "Try again" }).click();
  // Sent back, it is no longer a dead letter, so it leaves the list.
  await expect(panel.getByText("The Slack app was reinstalled.")).toHaveCount(0);
  await expect(
    panel.getByRole("listitem").filter({ hasText: "Slack refused the token: invalid_auth." }),
  ).toHaveCount(0, {
    timeout: 20_000,
  });
  const { data } = await app
    .from("integration_inbound_events")
    .select("inbound_state")
    .eq("id", eventId)
    .single();
  expect((data as { inbound_state: string } | null)?.inbound_state).toBe("Received");
  await expectAccessibleInBothThemes(page);
});
