import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";
import { embedTexts, localHashEmbeddings } from "@xos/ai/embeddings";
import {
  runSearchEmbeddings,
  supabaseSearchEmbeddingStore,
  type SearchEmbeddingPass,
} from "@xos/data/search-embeddings";
import { expect, settle, test } from "./engine-test";
import { ORG, signIn } from "./operations-support";
import { expectAccessible } from "./support";

/**
 * A87 (RRR-132, finding A65-005): global search in the command menu on the demo tenant seed. Recents before
 * typing, operator chips, quoted phrases and minus words, a setting reached in one search, operator hints
 * that fill the search field, and semantic search once an Admin turns it on, all from the keyboard. The
 * semantic step needs E2E_SEARCH_EMBEDDINGS: `supabase-gte` runs Supabase's gte-small through the local
 * stack's search-embed Edge Function (the default provider), `local-hash` runs the deterministic fake with a
 * dev server started with XOS_SEARCH_EMBEDDINGS=local-hash. Without it the step is skipped, and pgTAP covers
 * the database side (supabase/tests/1440_global_search.test.sql).
 */
test.use({ reducedMotion: "reduce" });
// Each journey opens several pages a development server may compile on first visit.
test.describe.configure({ mode: "serial", timeout: 480_000 });

async function openMenu(page: Page) {
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  await page.keyboard.press("ControlOrMeta+k");
  const menu = page.getByRole("dialog").filter({ has: page.getByRole("combobox") });
  await expect(menu).toBeVisible({ timeout: 30_000 });
  return menu;
}

test("the command menu lists recents, reads operators and reaches a setting in one search", async ({
  page,
}) => {
  await signIn(page, "owner@example.com");

  // Opening a record notes it for the recent items.
  await page.goto(`/${ORG}/r/NWS-12`);
  await expect(page.getByRole("heading", { name: "Production Meeting" })).toBeVisible({
    timeout: 60_000,
  });
  await settle(page);

  // Before anything is typed: Recent first, with the record just opened, then the operator hints.
  let menu = await openMenu(page);
  const recent = menu.getByRole("group", { name: "Recent" });
  await expect(recent.getByRole("option").first()).toContainText("Production Meeting", {
    timeout: 60_000,
  });
  await expect(menu.getByRole("group", { name: "Search operators" })).toBeVisible();
  await expectAccessible(page);

  // Operators: a record kind and a state narrow to the one blocked permit; Enter opens its peek.
  await page.keyboard.type("type:permit status:blocked");
  const chips = menu.getByRole("status", { name: "Search filters" });
  await expect(chips.getByText("type:permit")).toBeVisible();
  await expect(chips.getByText("status:blocked")).toBeVisible();
  const records = menu.getByRole("group", { name: "Records" });
  await expect(records.getByRole("option")).toHaveCount(1, { timeout: 60_000 });
  await expect(records.getByRole("option").first()).toContainText("Special Event Permit");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/peek=NWS-9/, { timeout: 60_000 });
  const peek = page.getByRole("dialog", { name: "Special Event Permit" });
  await expect(peek).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press("Escape");
  await expect(peek).toBeHidden({ timeout: 30_000 });

  // A quoted phrase and a minus word: "load in" without the Stage Load-In Complete milestone.
  menu = await openMenu(page);
  await page.keyboard.type('"load in" -stage');
  await expect(
    menu.getByRole("group", { name: "Records" }).getByRole("option").first(),
  ).toContainText("Load-In Window", { timeout: 60_000 });
  await expect(menu.getByText("Stage Load-In Complete")).toHaveCount(0);
  await expect(menu.getByText("Stagehand · Load-in")).toBeVisible();

  // An operator the menu does not understand says so.
  await menu.getByRole("combobox").fill("before:someday");
  await expect(menu.getByText("before:someday is not understood")).toBeVisible();

  // Any setting in one search: "time zone" opens Localization with the field focused.
  await menu.getByRole("combobox").fill("time zone");
  const settings = menu.getByRole("group", { name: "Settings" });
  await expect(settings.getByRole("option").first()).toContainText("Time zone", {
    timeout: 60_000,
  });
  // The org's Localization page is the first result, so Enter opens it.
  await expect(settings.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    new RegExp(`/${ORG}/settings/localization\\?setting=locale\\.time_zone`),
    { timeout: 60_000 },
  );
  await expect(page.getByRole("combobox", { name: "Time zone" })).toBeFocused({ timeout: 60_000 });
});

test("operator hints fill the search field and the menu passes axe in both themes", async ({
  page,
}) => {
  await signIn(page, "owner@example.com");
  for (const theme of ["light", "dark"]) {
    await page.context().addCookies([{ name: "xos-theme", value: theme, url: page.url() }]);
    await page.reload();
    await settle(page);
    const menu = await openMenu(page);
    const hint = menu.getByRole("group", { name: "Search operators" }).getByRole("option").first();
    await expect(hint).toBeVisible();
    await expectAccessible(page);
    if (theme === "dark") {
      // Keyboard only: the first hint, then Enter; the menu stays open with type: in the search field.
      // The server's recent items and actions come first; arrow down until the first hint is highlighted.
      await expect(menu.getByRole("group", { name: "Recent" })).toBeVisible({ timeout: 60_000 });
      for (let i = 0; i < 80 && (await hint.getAttribute("aria-selected")) !== "true"; i += 1) {
        await page.keyboard.press("ArrowDown");
      }
      await expect(hint).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Enter");
      await expect(menu.getByRole("combobox")).toHaveValue("type:");
      await expect(menu).toBeVisible();
    }
    await page.keyboard.press("Escape");
  }
});

test("semantic search finds a document by meaning once an Admin turns it on", async ({ page }) => {
  const url = process.env["E2E_SUPABASE_URL"];
  const key = process.env["E2E_SUPABASE_SERVICE_KEY"];
  // supabase-gte: the default, Supabase's gte-small in the search-embed Edge Function (the local stack must
  // run the Edge Runtime). local-hash: the deterministic fake, with a dev server started with
  // XOS_SEARCH_EMBEDDINGS=local-hash and the worker run here.
  const mode = process.env["E2E_SEARCH_EMBEDDINGS"];
  test.skip(
    !url || !key || (mode !== "supabase-gte" && mode !== "local-hash"),
    "Set E2E_SEARCH_EMBEDDINGS to supabase-gte or local-hash, with the local stack's service key.",
  );
  if (!url || !key) return;
  expect(url).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
  const service = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const provider = localHashEmbeddings();
  // One worker pass: the Edge Function's on the default path, this process's with the fake.
  const worker = async (): Promise<SearchEmbeddingPass> => {
    if (mode === "supabase-gte") {
      const response = await fetch(`${url}/functions/v1/search-embed`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(200);
      return (await response.json()) as SearchEmbeddingPass;
    }
    return runSearchEmbeddings({
      store: supabaseSearchEmbeddingStore(service),
      embedder: {
        provider: provider.provider,
        model: provider.model,
        embed: (texts) => embedTexts(provider, texts, "document"),
      },
    });
  };

  await signIn(page, "owner@example.com");
  const toggle = async (on: boolean) => {
    await page.goto(`/${ORG}/settings/ai-features?setting=search.semantic_enabled`);
    const box = page.getByRole("checkbox", { name: "Semantic search" });
    await expect(box).toBeFocused({ timeout: 60_000 });
    if ((await box.isChecked()) !== on) {
      await page.keyboard.press("Space");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: /^Saved\.?$/ })).toBeVisible({
        timeout: 60_000,
      });
    }
  };

  try {
    await toggle(true);
    const pass = await worker();
    expect(pass.error).toBeNull();
    expect(pass.embedded).toBeGreaterThan(0);

    // gte-small: a question in other words finds the load-in SOP. The fake knows only shared word stems:
    // "plans" shares no word prefix with "Bayfront Pier site safety plan", but the same stem.
    const [query, title, group] =
      mode === "supabase-gte"
        ? ["how do we move gear into the venue", "Load-in and staging sequence", "Documents"]
        : ["plans", "Bayfront Pier site safety plan", "Documents"];
    const menu = await openMenu(page);
    await page.keyboard.type(query);
    const documents = menu.getByRole("group", { name: group });
    // The first query wakes the model; a second try finds it warm.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const found = await documents
        .getByRole("option", { name: new RegExp(title) })
        .waitFor({ timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      if (found) break;
      await menu.getByRole("combobox").fill(query);
    }
    const hit = documents.getByRole("option", { name: new RegExp(title) });
    await expect(hit).toContainText("Related");
    await page.keyboard.press("Escape");

    // Turning it off retires the org's vectors on the next worker pass.
    await toggle(false);
    expect((await worker()).retired).toBeGreaterThan(0);
  } finally {
    // Leave the shared seed as it was even when a step above failed, without hiding that failure.
    await toggle(false).catch(() => undefined);
    await worker().catch(() => undefined);
  }
});
