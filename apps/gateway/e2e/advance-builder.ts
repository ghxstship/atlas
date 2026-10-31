import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { atlasAs, ORG } from "./atlas";

/**
 * The org's side of the R9 advance journeys (RRR-189), in Atlas: the Owner builds a typed advance
 * packet through the packet builder, adds the recipient under its engagement with an optional naming
 * deadline, and sends it. Nothing here writes a section, choice or answer with SQL, so every row the
 * journeys check came through the screens a producer uses.
 */

export type SectionKind =
  | "Text"
  | "File"
  | "Schedule window"
  | "Item request"
  | "Credential request"
  | "Crew roster"
  | "Guest list";

export interface SectionSpec {
  readonly title: string;
  readonly kind: SectionKind;
  /** Schedule window: the window's label in the Window select, such as "Load in". */
  readonly windowKind?: string;
  /** Item and credential requests: each line names a person on the roster. */
  readonly perPerson?: boolean;
  /** Item and credential requests: the asset class or credential category names offered. */
  readonly choices?: readonly string[];
}

export interface SentPacket {
  readonly context: BrowserContext;
  readonly page: Page;
  /** The packet's page in Atlas, to come back to for the review. */
  readonly url: string;
}

/** Picks options of a MultiSelect by their names, then closes its list. */
async function pick(page: Page, label: string, names: readonly string[]): Promise<void> {
  const box = page.getByRole("combobox", { name: label });
  await expect(box).toBeVisible();
  for (const name of names) {
    await box.click();
    await box.fill(name);
    await page.getByRole("option", { name }).click();
  }
  await box.press("Escape");
}

/**
 * Builds and sends a packet as the demo Owner. `project` is the project's label in the Project
 * select ("NWS · Northwind Summer Series"); `party` and `engagementId` are the option values of the
 * recipient (`counterparty:<id>` or `person:<id>`) and its engagement; `namesDue` is a
 * datetime-local value in the project's zone.
 */
export async function sendTypedPacket(
  browser: Browser,
  input: {
    readonly project: string;
    readonly title: string;
    readonly sections: readonly SectionSpec[];
    readonly party: string;
    readonly engagementId: string;
    readonly namesDue?: string;
  },
): Promise<SentPacket> {
  const { context, page } = await atlasAs(browser, "owner@example.com");
  await page.goto(`/${ORG}/advancing/packets?create=1`);
  const create = page.getByRole("dialog", { name: "New advance packet" });
  await create.getByLabel("Project").selectOption({ label: input.project });
  await create.getByLabel("Packet name").fill(input.title);
  await create.getByRole("button", { name: "Create packet" }).click();
  await page.waitForURL(/full=1/);
  await expect(page.getByRole("heading", { level: 1, name: input.title })).toBeVisible();
  const url = page.url();

  for (const section of input.sections) {
    await page.getByLabel("New section").fill(section.title);
    await page.getByLabel("Kind", { exact: true }).selectOption({ label: section.kind });
    if (section.kind === "Schedule window" && section.windowKind) {
      await page.getByLabel("Window", { exact: true }).selectOption({ label: section.windowKind });
    }
    if (section.kind === "Item request" || section.kind === "Credential request") {
      if (section.perPerson) {
        await page.getByLabel("Each line names a person on the crew roster").check();
      }
      await pick(
        page,
        section.kind === "Item request" ? "Items offered" : "Passes offered",
        section.choices ?? [],
      );
    }
    await page.getByRole("button", { name: "Add section" }).click();
    await expect(page.getByText(new RegExp(`\\d+\\. ${section.title}$`))).toBeVisible();
  }

  await page.getByLabel("Add a recipient").selectOption(input.party);
  await page.getByLabel("Engagement", { exact: true }).selectOption(input.engagementId);
  if (input.namesDue) await page.getByLabel("Names due").fill(input.namesDue);
  await page.getByRole("button", { name: "Add recipient" }).click();
  await expect(page.getByText(/^Answers as /)).toBeVisible();

  await page.getByRole("button", { name: "Send packet" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Send packet" }).click();
  await expect(page.getByText("Awaiting answers").first()).toBeVisible();
  return { context, page, url };
}

/** An answer on the packet page: its card, which names the section and the recipient. */
export function answerCard(page: Page, section: string, recipient: string) {
  return page
    .getByRole("listitem")
    .filter({ hasText: recipient })
    .filter({ has: page.getByText(section, { exact: true }) });
}

/** Accepts the answer to one section, as the Owner on the packet page. */
export async function acceptAnswer(page: Page, section: string, recipient: string): Promise<void> {
  const card = answerCard(page, section, recipient);
  await card.getByRole("button", { name: "Accept" }).click();
  await expect(card.getByText("Accepted", { exact: true })).toBeVisible();
}

/** The page fits a 375 px wide screen without sideways scrolling. */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}
