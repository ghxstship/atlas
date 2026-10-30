import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "./a79-support";
import { expect as baseExpect, test, type Page } from "./engine-test";
import { ORG, signIn } from "./operations-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * B7 (RRR-231, ADR 0146) on the demo tenant's Northwind Summer Series (NWS):
 *   - a named project feed with cues for the Production team, fetched through /ical/{token}.ics, carries its name as
 *     X-WR-CALNAME and the running order's cues as events;
 *   - a day sheet downloads for one team with one show department's cues, as version 2;
 *   - a Tour Book of show week is created on the Documents tab and downloads as one PDF;
 *   - the wrap-up on the Reports tab takes a debrief point, a management summary drafted with Aurora (the fixture model
 *     of XOS_AI_FAKE=1, as a95 runs it), saved, completed and downloaded, then reopened.
 * Every new panel is checked with axe. What a run adds is removed afterwards with the service role.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 30_000 });

const ORG_ID = "01920000-0000-7000-8000-000000000001";
const PRODUCTION_TEAM = "01920000-0000-7000-8000-000000000501";
const PROJECT = "NWS";
const RUN = "Opening Night Running Order";

async function projectId(client: SupabaseClient): Promise<string> {
  const { data, error } = await client
    .schema("app")
    .from("projects")
    .select("id")
    .eq("org_id", ORG_ID)
    .eq("project_key", PROJECT)
    .single();
  if (error) throw new Error(`project ${PROJECT}: ${error.message}`);
  return (data as { id: string }).id;
}

async function showDaySheet(client: SupabaseClient): Promise<string> {
  const { data, error } = await client
    .schema("app")
    .from("day_sheets")
    .select("id")
    .eq("project_id", await projectId(client))
    .eq("day", "2027-03-13")
    .is("deleted_at", null)
    .single();
  if (error) throw new Error(`day sheet: ${error.message}`);
  return (data as { id: string }).id;
}

const run = uniqueId().slice(-6);

test.afterAll(async () => {
  const app = serviceClient().schema("app");
  await app
    .from("calendar_feeds")
    .update({ revoked_at: new Date().toISOString() })
    .like("name", `B7 ${run}%`)
    .is("revoked_at", null);
  await app
    .from("document_books")
    .update({ deleted_at: new Date().toISOString() })
    .like("name", `B7 ${run}%`)
    .is("deleted_at", null);
});

test("a named project feed with cues for a team serves its name and the cues", async ({ page }) => {
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/me/calendar-feeds`);
  await expect(page.getByRole("heading", { name: "Calendar feeds", level: 2 })).toBeVisible();
  const add = page.getByRole("form", { name: "Add a feed" });
  await add
    .getByLabel("Feed")
    .selectOption({ label: `Project: ${PROJECT} Northwind Summer Series` });
  await add.getByLabel("Name").fill(`B7 ${run} Show calls`);
  await add.getByRole("checkbox", { name: "Cues" }).check();
  await add.getByLabel("Audience").selectOption("team");
  await add.getByLabel("Team").selectOption(PRODUCTION_TEAM);
  await expectAccessible(page);
  await add.getByRole("button", { name: "Add feed" }).click();
  const link = await page
    .getByTestId("calendar-feed-link")
    .last()
    .getByLabel("Subscription link")
    .inputValue();
  expect(link).toMatch(/\/ical\/xcal_[0-9a-f]{64}\.ics$/);
  const body = await (await page.request.get(link)).text();
  expect(body).toContain(`X-WR-CALNAME:B7 ${run} Show calls`);
  expect(body).toContain(`SUMMARY:${RUN} · House to Half`);
  await expect(page.getByRole("list", { name: "Your calendar feeds" })).toContainText(
    `B7 ${run} Show calls`,
  );
  await expect(page.getByRole("list", { name: "Your calendar feeds" })).toContainText(
    "Team: Production",
  );
  await expectAccessible(page);
});

test("a day sheet downloads for one team and one show department", async ({ page }) => {
  const sheet = await showDaySheet(serviceClient());
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/show/day-sheets?peek=${sheet}`);
  await page.getByRole("button", { name: "Download for…" }).click();
  const panel = page.getByTestId("day-sheet-audience-download");
  await panel.getByLabel("Team").selectOption(PRODUCTION_TEAM);
  await panel.getByLabel("Show department").selectOption("lighting");
  await panel.getByLabel("Paper size").selectOption("a4");
  await expectAccessible(page);
  const href = await panel.getByRole("link", { name: "Download PDF" }).getAttribute("href");
  expect(href).toBe(
    `/${ORG}/documents/day-sheet/${sheet}?team=${PRODUCTION_TEAM}&dept=lighting&paper=a4`,
  );
  const pdf = await page.request.get(href ?? "");
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(pdf.headers()["x-document-template-version"]).toBe("2");
  expect(pdf.headers()["content-disposition"]).toContain("production-a4.pdf");
  expect(
    (
      await page.request.get(
        `/${ORG}/documents/day-sheet/${sheet}?team=${PRODUCTION_TEAM}&department=5000`,
      )
    ).status(),
  ).toBe(400);
});

test("a Tour Book is created and downloads as one PDF", async ({ page }) => {
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/p/${PROJECT}/documents`);
  await expect(page.getByRole("heading", { name: "Books", level: 2 })).toBeVisible();
  await page.getByRole("button", { name: "New book" }).click();
  const dialog = page.getByRole("dialog", { name: "New book" });
  await dialog.getByLabel("Name").fill(`B7 ${run} Opening week`);
  await dialog.getByLabel("First day").fill("2027-03-12");
  await dialog.getByLabel("Last day").fill("2027-03-14");
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Save book" }).click();
  await expect(dialog).toBeHidden();
  const book = page.getByTestId("book").filter({ hasText: `B7 ${run} Opening week` });
  await expect(book).toContainText("Tour Book");
  await expectAccessible(page);
  const href = await book.getByRole("link", { name: "Download PDF" }).getAttribute("href");
  const pdf = await page.request.get(href ?? "");
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(pdf.headers()["x-book-skipped"]).toBe("0");
  expect((await pdf.body()).subarray(0, 8).toString("latin1")).toBe("%PDF-1.7");
});

async function wrapUp(page: Page) {
  await page.goto(`/${ORG}/p/${PROJECT}/reports`);
  const section = page.getByTestId("wrap-up");
  await expect(section.getByRole("heading", { name: "Wrap-up", level: 2 })).toBeVisible();
  return section;
}

test.describe("the wrap-up with Aurora", () => {
  test.use({ baseURL: process.env["E2E_AURORA_URL"] ?? "http://127.0.0.1:3016" });

  test("takes a point and an Aurora summary, then completes, downloads and reopens", async ({
    page,
  }) => {
    await signIn(page, "producer@example.com");
    const section = await wrapUp(page);
    await section.getByRole("button", { name: "Add a point" }).click();
    await section.getByLabel("Area").selectOption("Crew");
    await section.getByLabel("Kind").selectOption("To Improve");
    await section
      .getByLabel("Point")
      .fill(`B7 ${run}: call the crew 30 minutes earlier on show day.`);
    await section.getByRole("button", { name: "Save point" }).click();
    await expect(
      section.getByTestId("debrief-point").filter({ hasText: `B7 ${run}` }),
    ).toBeVisible();

    await section.getByRole("button", { name: "Summarize" }).click();
    const panel = page.getByRole("dialog", { name: "Summarize with Aurora" });
    await expect(panel.getByRole("heading", { name: "What Aurora receives" })).toBeVisible();
    await expectAccessible(page);
    await panel.getByRole("button", { name: "Send to Aurora" }).click();
    await expect(panel.getByText("AI-generated")).toBeVisible();
    await panel.getByRole("button", { name: "Use as management summary" }).click();
    await expect(panel).toBeHidden();
    await expect(section.getByLabel("Management summary")).not.toHaveValue("");
    await section.getByRole("button", { name: "Save summary" }).click();
    await expect(section.getByText("Summary saved.")).toBeVisible();
    await page.reload();
    await expect(
      page.getByText(/Drafted with Aurora and reviewed by Demo Producer on/),
    ).toBeVisible();
    await expectAccessible(page);

    await page.getByTestId("wrap-up").getByRole("button", { name: "Complete debrief" }).click();
    await expect(page.getByTestId("wrap-up")).toContainText("Completed");
    const pdf = await page.request.get(
      (await page
        .getByTestId("wrap-up")
        .getByRole("link", { name: "Download PDF" })
        .getAttribute("href")) ?? "",
    );
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    await page.getByTestId("wrap-up").getByRole("button", { name: "Reopen debrief" }).click();
    await expect(
      page.getByTestId("wrap-up").getByRole("button", { name: "Complete debrief" }),
    ).toBeVisible();

    const app = serviceClient().schema("app");
    await app
      .from("project_debrief_items")
      .update({ deleted_at: new Date().toISOString() })
      .like("body", `B7 ${run}%`);
  });
});
