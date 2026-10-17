import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  mailpitMailer,
  runScheduledReports,
  supabaseReportDeliveryStore,
  supabaseResultFiles,
} from "@xos/data/report-deliveries";
import { supabaseReportRunStore, supabaseResultStorage } from "@xos/data/report-runs";
import { expect, test } from "./engine-test";
import { expectAccessibleInBothThemes, ORG, settled, signIn } from "./operations-support";
import { expectAccessible } from "./support";

/**
 * Journey 29 (Section 20.2; A43, finding A38-004): the Producer builds a report with a NULL-aware total
 * (Budgeted summed by line type over the demo budget, which has unpriced lines), places it on a new
 * dashboard, and schedules it by email as PDF to themselves. The schedule is made due, one pass of the
 * report worker (the same code the report-run Edge Function runs, here with the service role of the
 * local stack) renders the PDF as the Producer and emails it, and the message arrives in the local
 * Inbucket (Mailpit) with the PDF attached.
 *
 * E2E_SUPABASE_URL, E2E_SUPABASE_SERVICE_KEY and E2E_INBUCKET_URL name the local stack only.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);
expect.configure({ timeout: 20_000 });

function localStack(): { client: SupabaseClient; inbox: string } {
  const url = process.env["E2E_SUPABASE_URL"];
  const key = process.env["E2E_SUPABASE_SERVICE_KEY"];
  const inbox = process.env["E2E_INBUCKET_URL"];
  if (!url || !key || !inbox) {
    throw new Error("Set E2E_SUPABASE_URL, E2E_SUPABASE_SERVICE_KEY and E2E_INBUCKET_URL.");
  }
  for (const value of [url, inbox]) {
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(value))
      throw new Error("Journey 29 runs against a local stack only.");
  }
  return {
    client: createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }),
    inbox,
  };
}

test("journey 29: NULL-aware report on a dashboard, emailed as PDF on schedule", async ({
  page,
}) => {
  const { client, inbox } = localStack();
  const tag = Date.now().toString(36);
  const reportName = `Budget by Line Type ${tag}`;
  const dashboardName = `Show Week ${tag}`;
  await signIn(page, "producer@example.com");

  // Build: Budgeted summed by line type; the unpriced lines stay out of the totals and are counted.
  await page.goto(`/${ORG}/reports/builder`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Report name").fill(reportName);
  await page.getByLabel("Source", { exact: true }).selectOption({ label: "Budget lines" });
  await page.getByLabel("Column 1").selectOption({ label: "Budgeted" });
  await page.getByLabel("Summary").first().selectOption("Sum");
  await page.getByLabel("Group by").selectOption({ label: "Line type" });
  await page.getByRole("button", { name: "Preview" }).click();
  const preview = page.getByRole("table", { name: "Report preview" });
  await expect(preview).toContainText(/unpriced/i);
  await page.getByRole("button", { name: "Save report" }).click();
  await page.waitForURL(/report=/);
  const reportId = new URL(page.url()).searchParams.get("report") as string;

  // A dashboard for the Producer.
  await page.goto(`/${ORG}/reports/dashboards`);
  await expect(page.getByRole("heading", { name: "Dashboards", level: 1 })).toBeVisible();
  const create = page.getByRole("form", { name: "New dashboard" });
  await settled(page);
  await create.getByLabel("Dashboard name").fill(dashboardName);
  await create.getByRole("button", { name: "Create dashboard" }).click();
  await expect(page.getByRole("link", { name: new RegExp(dashboardName) })).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // On the saved report: add it to the dashboard, then schedule it by email as PDF.
  await page.goto(`/${ORG}/reports/saved-reports?peek=${reportId}`);
  const tile = page.getByRole("form", { name: "Add to a dashboard" });
  await settled(page);
  await tile.getByLabel("Dashboard").selectOption({ label: dashboardName });
  await tile.getByRole("button", { name: "Add to dashboard" }).click();
  await expect(page.getByText("Added to the dashboard.")).toBeVisible();
  const schedule = page.getByRole("form", { name: "Schedule by email" });
  await schedule.getByLabel("How often").selectOption("Daily");
  await schedule.getByLabel("Attach as").selectOption("PDF");
  await schedule.getByLabel("Demo Producer").check();
  await schedule.getByRole("button", { name: "Schedule email" }).click();
  await expect(page.getByText(/^Scheduled\./)).toBeVisible();
  await expectAccessible(page);

  // The dashboard shows the tile with its NULL-aware total.
  await page.goto(`/${ORG}/reports/dashboards`);
  await page.getByRole("link", { name: new RegExp(dashboardName) }).click();
  const grid = page.getByRole("list", { name: "Dashboard tiles" });
  await expect(grid.getByRole("link", { name: reportName })).toBeVisible();
  await expect(grid.getByText(/unpriced amount, left out of the total/)).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // The schedule comes due; one pass of the report worker renders and emails the PDF.
  const due = await client
    .schema("app")
    .from("report_schedules")
    .update({ next_run_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("report_definition_id", reportId)
    .select("id");
  expect(due.error).toBeNull();
  const outcome = await runScheduledReports({
    runs: supabaseReportRunStore(client),
    storage: supabaseResultStorage(client),
    labels: {
      field: (_source, key) => key,
      column: (_source, key, aggregate) => `${aggregate} of ${key}`,
      unpriced: "Unpriced rows",
      subtitle: ({ rows, unpriced }) => `Rows: ${rows}. Unpriced: ${unpriced}.`,
    },
    deliveries: supabaseReportDeliveryStore(client),
    files: supabaseResultFiles(client),
    mailer: mailpitMailer(inbox, { email: "reports@xos.localhost", name: "XOS Reports" }),
    copy: {
      subject: ({ report, org }) => `${report} from ${org}`,
      body: ({ report, rows }) => `${report}: ${rows} rows.`,
    },
    worker: "atlas-e2e-journey-29",
  });
  expect(outcome.queued).toBeGreaterThanOrEqual(1);
  const sent = outcome.deliveries.filter((d) => d.status === "Sent");
  expect(sent.length, JSON.stringify(outcome)).toBeGreaterThanOrEqual(1);

  // The email is in the local Inbucket with the PDF attached.
  const search = await page.request.get(
    `${inbox}/api/v1/search?query=${encodeURIComponent(`subject:"${reportName}"`)}`,
  );
  expect(search.ok()).toBe(true);
  const found = (await search.json()) as {
    messages: { ID: string; To: { Address: string }[]; Subject: string }[];
  };
  const message = found.messages.find((m) => m.Subject.startsWith(reportName));
  expect(message?.To[0]?.Address).toBe("producer@example.com");
  const detail = (await (
    await page.request.get(`${inbox}/api/v1/message/${message?.ID}`)
  ).json()) as {
    Attachments: { FileName: string; ContentType: string; Size: number }[];
  };
  expect(detail.Attachments[0]).toMatchObject({ ContentType: "application/pdf" });
  expect(detail.Attachments[0]?.FileName).toMatch(/\.pdf$/);
  expect(detail.Attachments[0]?.Size).toBeGreaterThan(1000);

  // The saved report lists the email as sent.
  await page.goto(`/${ORG}/reports/saved-reports?peek=${reportId}`);
  await expect(page.getByRole("list", { name: "Recent emails" })).toContainText("Sent");
});
