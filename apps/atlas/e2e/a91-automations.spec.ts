import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  runAutomationJobs,
  supabaseAutomationRunStore,
  type AutomationRunResult,
} from "@xos/data/automation-runner";
import type { Page } from "@playwright/test";
import { expect, test } from "./engine-test";
import { expectAccessibleInBothThemes, ORG, signIn } from "./a16-support";
import { expectAccessible } from "./support";

/**
 * Automations (A91, RRR-136, finding A65-010, ADR 0047; Section 4.5.6 item 20). The Owner builds an automation on
 * Settings, Automations: when a Task whose title carries a tag is created, comment on it and notify the Producer. A
 * sample event tests the conditions without running anything. The Owner then creates such a Task through the public
 * API, which raises record.created; one pass of the automation worker (the code the automation-run Edge Function runs,
 * here with the local stack's service role and JWT secret) runs the actions as the Owner through the API. The run
 * history shows both steps, the record shows the comment, and the Producer has the notice. axe runs in both themes.
 *
 * E2E_SUPABASE_URL, E2E_SUPABASE_SERVICE_KEY and E2E_SUPABASE_JWT_SECRET name the local stack only.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(600_000);
expect.configure({ timeout: 30_000 });

function localStack(): { client: SupabaseClient; url: string; jwtSecret: string } {
  const url = process.env["E2E_SUPABASE_URL"];
  const key = process.env["E2E_SUPABASE_SERVICE_KEY"];
  const jwtSecret = process.env["E2E_SUPABASE_JWT_SECRET"];
  if (!url || !key || !jwtSecret) {
    throw new Error("Set E2E_SUPABASE_URL, E2E_SUPABASE_SERVICE_KEY and E2E_SUPABASE_JWT_SECRET.");
  }
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) {
    throw new Error("The automation journey runs against a local stack only.");
  }
  return {
    client: createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }),
    url,
    jwtSecret,
  };
}

/** Passes of the worker until the run of `title` settles; a retry's backoff is skipped for the test. */
async function runWorker(
  stack: ReturnType<typeof localStack>,
  origin: string,
  title: string,
): Promise<AutomationRunResult[]> {
  const app = stack.client.schema("app");
  const seen: AutomationRunResult[] = [];
  for (let pass = 0; pass < 6; pass += 1) {
    seen.push(
      ...(await runAutomationJobs({
        store: supabaseAutomationRunStore(stack.client),
        fetch: (input, init) => fetch(input, init),
        apiBaseUrl: `${origin}/api/v1`,
        signingKey: stack.jwtSecret,
        issuer: `${stack.url}/auth/v1`,
        worker: "e2e-a91",
      })),
    );
    const { data } = await app
      .from("automation_runs")
      .select("run_status")
      .contains("event_payload", { data: { title } });
    const statuses = (data ?? []).map((r) => r.run_status as string);
    if (
      statuses.length > 0 &&
      statuses.every((s) => ["Succeeded", "Failed", "Skipped"].includes(s))
    )
      break;
    await app
      .from("job_queue")
      .update({ run_after: new Date().toISOString() })
      .eq("job_kind", "automation.run")
      .eq("job_status", "Queued");
  }
  return seen;
}

async function settings(page: Page) {
  await page.goto(`/${ORG}/settings/automations`);
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
}

test("journey: build an automation, fire its event, see the actions and the run history", async ({
  page,
  baseURL,
}) => {
  const stack = localStack();
  const origin = baseURL ?? "http://127.0.0.1:3091";
  const tag = `a91-${Date.now().toString(36)}`;
  const name = `Pick up tagged tasks ${tag}`;
  const title = `Call the venue ${tag}`;
  await signIn(page, "owner@example.com");

  // Settings, Automations renders in both themes.
  await settings(page);
  await expect(page.getByRole("heading", { name: "Automations", level: 2 })).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // Build: when a record is created whose title carries the tag, comment on it and notify the Producer.
  await page.getByRole("button", { name: "New automation" }).click();
  const editor = page.getByRole("dialog", { name: "New automation" });
  await expect(editor.getByLabel("Name")).toBeVisible();
  await editor.getByLabel("Name").fill(name);
  await editor.getByLabel("When this happens").selectOption("record.created");
  await editor.getByRole("button", { name: "Add condition" }).first().click();
  await editor.getByLabel("Field").fill("data.title");
  await editor.getByLabel("Test", { exact: true }).selectOption("contains");
  await editor.getByLabel("Value").fill(tag);
  await editor.getByLabel("Comment").fill("Picked up {{data.title}}.");
  await editor.getByRole("button", { name: "Add action" }).click();
  await editor.getByLabel("Action", { exact: true }).nth(1).selectOption("notify");
  const notify = editor.getByRole("group", { name: "Action 2" });
  await notify.getByLabel("Notify").selectOption({ label: "Demo Producer" });
  await notify.getByLabel("Title").fill("New task: {{data.title}}");

  // Test with a sample event: nothing runs.
  await editor
    .getByLabel("Sample event (JSON)")
    .fill(JSON.stringify({ type: "record.created", data: { title: `Book the crew ${tag}` } }));
  await editor.getByRole("button", { name: "Test", exact: true }).click();
  await expect(editor.getByText("The conditions hold for this event.")).toBeVisible();
  await expect(editor.getByText(`New task: Book the crew ${tag}`)).toBeVisible();
  await editor
    .getByLabel("Sample event (JSON)")
    .fill(JSON.stringify({ type: "record.created", data: { title: "Book the crew" } }));
  await editor.getByRole("button", { name: "Test", exact: true }).click();
  await expect(editor.getByText("The conditions do not hold for this event.")).toBeVisible();
  await expectAccessible(page);

  await editor.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Automation saved." })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row.getByRole("switch", { name: `Run ${name}` })).toBeChecked();
  await expect(row.getByText("record.created")).toBeVisible();

  // Fire the event: the Owner creates a tagged Task through the public API.
  const roots = await page.request.get(
    `/api/v1/scope-nodes?${new URLSearchParams({ "filter[parent_id][is_null]": "true", limit: "1", fields: "id" })}`,
  );
  expect(roots.status()).toBe(200);
  const root = ((await roots.json()) as { data: { id: string }[] }).data[0]?.id;
  const created = await page.request.post("/api/v1/records", {
    headers: { "Idempotency-Key": `e2e-${tag}`, Origin: new URL(origin).origin },
    data: {
      scope_node_id: root,
      record_kind: "Task",
      title,
      phase_code: "SCP",
      xyz: "Y",
      external_visibility: [],
    },
  });
  expect(created.status()).toBe(201);
  const record = (await created.json()) as { id: string; record_key: string };

  // One pass of the worker runs the actions as the Owner through the API.
  const results = await runWorker(stack, origin, title);
  expect(results.some((r) => r.status === "Succeeded")).toBe(true);

  // The run history shows the run and its steps.
  await settings(page);
  const run = page.getByRole("row").filter({ hasText: name }).filter({ hasText: "record.created" });
  await expect(run.getByText("Succeeded")).toBeVisible();
  await page
    .getByRole("table", { name: "Recent automation runs" })
    .getByRole("row")
    .filter({ hasText: name })
    .getByRole("button", { name: "Details" })
    .click();
  const details = page.getByRole("dialog", { name: `Run of ${name}` });
  await expect(details.getByText("comments.postOnSubject")).toBeVisible();
  await expect(details.getByText("automationRuns.notify")).toBeVisible();
  await expect(details.getByText("Succeeded").first()).toBeVisible();
  await expectAccessible(page);
  await details.getByRole("button", { name: "Close" }).last().click();

  // The action: the record carries the comment, posted as the Owner.
  await page.goto(`/${ORG}/r/${record.record_key}`);
  await expect(page.getByText(`Picked up ${title}.`)).toBeVisible();

  // And the Producer has the notice.
  const { data: notices } = await stack.client
    .schema("app")
    .from("notifications")
    .select("kind, subject_id, message_args")
    .eq("kind", "automation.notice")
    .eq("subject_id", record.id);
  expect(notices?.[0]?.message_args).toMatchObject({ title: `New task: ${title}` });
});
