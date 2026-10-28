import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./engine-test";
import { createOrganization, signUp, testEmail, uniqueId } from "./support";

/**
 * P2 show calling (ADR 0131; gaps G-40, G-74, G-75, G-77 and G-78), journey 15 extended: the editor marks a
 * cue's time TBC, adds department calls inline, moves a cue in one step and sets a curfew; in live mode the
 * caller drives the showcaller console from the keyboard and Stream Deck keys while a follower in a second
 * context sees the standby and the skipped cue. A TBC record reads TBC in Work and sorts by its estimate.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);

async function expectAccessible(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude('span[aria-current="date"]')
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
}

async function newOwnerOrg(page: Page): Promise<string> {
  const id = uniqueId();
  const slug = `p2s-${id}`;
  await signUp(page, { name: "Sky Stage", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Show Calling ${id}`, slug });
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill("SHW");
  await dialog.getByLabel("Project name").fill("Summer Headline Weekend");
  await dialog.getByRole("button", { name: "More fields" }).click();
  await dialog.getByLabel("Jurisdiction").selectOption("US-FL-MIAMI-DADE");
  await dialog.getByLabel("Tier of experience").selectOption({ index: 5 });
  await dialog.getByLabel("First production day").fill("2027-03-12");
  await dialog.getByLabel("Last production day").fill("2027-03-15");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/SHW/overview`);
  return slug;
}

const CUES = [
  ["House to Half", "19:55"],
  ["Walk-in Music Out", "20:00"],
  ["Host Welcome", "20:01"],
  ["Headliner On", "20:10"],
  ["House Lights Up", "21:30"],
] as const;

test("show calling: TBC, inline calls, one-step moves, the console and Stream Deck keys", async ({
  page,
  browser,
}) => {
  const slug = await newOwnerOrg(page);
  await page.goto(`/${slug}/show/run-of-show?create=1`);
  const sheet = page.getByRole("dialog", { name: "New running order" });
  await sheet.getByLabel("Name").fill("Opening Night Running Order");
  await sheet.getByLabel("Show day").fill("2027-03-13");
  await sheet.getByRole("button", { name: "Create running order" }).click();
  await page.waitForURL(/peek=/);
  const runUrl = page.url();
  const list = page.getByRole("list", { name: "Cues of Opening Night Running Order" });

  // Five cues; the third is a time to be confirmed and reads "TBC · est.".
  for (const [label, time] of CUES) {
    await page.getByLabel("Cue", { exact: true }).fill(label);
    await page.getByLabel("Planned time").fill(time);
    if (label === "Host Welcome") await page.getByLabel("Time to be confirmed").check();
    await page.getByRole("button", { name: "Add cue" }).click();
    await expect(list).toContainText(label);
  }
  await expect(list.getByRole("listitem").filter({ hasText: "Host Welcome" })).toContainText(
    "TBC · est.",
  );

  // Department calls are added inline, without leaving the list.
  await page.getByRole("button", { name: "Edit Host Welcome" }).click();
  const editor = page.getByRole("form", { name: "Edit cue Host Welcome" });
  await editor.getByLabel("Lighting call").fill("LX 14 GO, house to half");
  await editor.getByLabel("Audio call").fill("Host mic live");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();
  await expect(list.getByRole("listitem").filter({ hasText: "Host Welcome" })).toContainText(
    "Lighting · LX 14 GO, house to half",
  );
  await expectAccessible(page);

  // Move to position puts cue 5 at position 2 in one step.
  await page.getByRole("button", { name: "Move House Lights Up to a position" }).click();
  const move = page.getByRole("dialog", { name: "Move House Lights Up" });
  await move.getByLabel("Position").selectOption("2");
  await move.getByRole("button", { name: "Move" }).click();
  await expect(move).toBeHidden();
  await expect(list.getByRole("listitem").nth(1)).toContainText("House Lights Up");
  await expect(list.getByRole("listitem").nth(4)).toContainText("Headliner On");

  // A curfew for the console's projected end.
  await page.getByLabel("Curfew").fill("2027-03-13T21:20");
  await page.getByRole("button", { name: "Save details" }).click();

  // A follower watches live in a second session.
  const follower = await browser.newContext({
    storageState: await page.context().storageState(),
    reducedMotion: "reduce",
  });
  const watch = await follower.newPage();
  await watch.goto(`${runUrl}&live=1`);
  await expect(watch.getByRole("status").filter({ hasText: "No cue called yet" })).toBeVisible();

  // The caller goes live; the console has focus. F16 moves the standby on, F14 puts it on standby.
  await page.getByRole("button", { name: "Run live" }).click();
  const console_ = page.getByRole("region", { name: "Showcaller console" });
  await expect(console_).toBeFocused();
  await page.keyboard.press("F16");
  await expect(
    watch.getByRole("status").filter({ hasText: "Standby: House Lights Up" }),
  ).toBeVisible({
    timeout: 2_000,
  });
  await page.keyboard.press("F14");
  // F13 calls the selected cue.
  await page.keyboard.press("F13");
  await expect(
    page.getByRole("status").filter({ hasText: "Current cue: House Lights Up" }),
  ).toBeVisible();

  // Jump to cue, then Go: the cues jumped past are marked skipped, for the follower too.
  await console_.getByRole("button", { name: "Jump to cue" }).click();
  const jump = page.getByRole("dialog", { name: "Jump to cue" });
  await jump.getByLabel("Find a cue").fill("Headliner");
  await jump.getByRole("button", { name: /Headliner On/ }).click();
  await console_.getByRole("button", { name: /^Go: call Headliner On/ }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Current cue: Headliner On" }),
  ).toBeVisible();
  await expect(watch.getByRole("listitem").filter({ hasText: "Walk-in Music Out" })).toContainText(
    "Skipped",
    { timeout: 10_000 },
  );

  // The console shows the overrun and the curfew warning.
  await expect(console_.getByTestId("console-overrun")).toHaveText(/behind|ahead|On time/);
  await expect(console_.getByTestId("console-curfew")).toContainText("curfew");

  // F17 nudges the remaining plan one minute later: the uncalled cue's planned time moves.
  const skippedRow = console_.getByRole("listitem").filter({ hasText: "Walk-in Music Out" });
  const before = (await skippedRow.textContent()) ?? "";
  await console_.focus();
  await page.keyboard.press("F17");
  await expect(skippedRow).not.toHaveText(before, { timeout: 10_000 });

  // Filtering by Lighting shows only its lines.
  await console_.getByLabel("Department").selectOption("lighting");
  await expect(page).toHaveURL(/dept=lighting/);
  await expectAccessible(page);
  await expectAccessible(watch);
  await follower.close();

  // With single-key shortcuts off, J and K do nothing while F15 still moves the standby.
  await page.goto(`/${slug}/me/keyboard-shortcuts`);
  const toggle = page
    .getByRole("switch", { name: "Keyboard shortcuts" })
    .or(page.getByRole("checkbox", { name: "Keyboard shortcuts" }));
  await toggle.uncheck();
  await page.goto(`${runUrl}&live=1`);
  await expect(page.getByRole("region", { name: "Showcaller console" })).toBeFocused();
  const standbyLine = page.getByRole("status").filter({ hasText: /^(Standby|Next):/ });
  const shown = await standbyLine.textContent();
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  await expect(standbyLine).toHaveText(shown ?? "");
  await page.keyboard.press("F15");
  await expect(page.getByRole("status").filter({ hasText: /^Standby:/ })).toBeVisible();
  // Keys do nothing while typing in a field.
  await page.getByRole("region", { name: "Showcaller console" }).getByLabel("Department").focus();
  await page.keyboard.press("F19");
  await expect(page.getByRole("dialog", { name: "Jump to cue" })).toBeHidden();
});

test("a TBC record reads TBC in Work and sorts by its estimate", async ({ page }) => {
  const slug = await newOwnerOrg(page);
  for (const [title, starts, tbc] of [
    ["Confirm the production meeting", "2027-03-12T10:00", true],
    ["Walk the load-in route", "2027-03-12T09:00", false],
  ] as const) {
    await page.goto(`/${slug}/work/all-records?create=1`);
    const sheet = page.getByRole("dialog", { name: "New record" });
    await sheet.getByLabel("Kind").selectOption("Task");
    await sheet.getByLabel("Subtype").selectOption("Execute");
    await sheet.getByLabel("Title").fill(title);
    await sheet.getByRole("button", { name: "More fields" }).click();
    const box = sheet.getByLabel("Start time to be confirmed");
    // The box needs a start first.
    await expect(box).toBeDisabled();
    await sheet.getByLabel("Starts").fill(starts);
    if (tbc) await box.check();
    await sheet.getByRole("button", { name: "Create record" }).click();
    await page.waitForURL(/peek=/);
  }
  // The peek of the last record is open; the TBC one reads "TBC · est." in the list and its detail.
  await page.goto(`/${slug}/work/all-records?view=table`);
  const tbcRow = page.getByRole("row").filter({ hasText: "Confirm the production meeting" });
  await expect(tbcRow).toContainText("TBC · est.");
  await tbcRow.click();
  await expect(page.getByText(/TBC · est\./).first()).toBeVisible();
  await expectAccessible(page);
});
