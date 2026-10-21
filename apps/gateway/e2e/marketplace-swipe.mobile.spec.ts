import type { Locator, Page } from "@playwright/test";
import { expect as baseExpect, test } from "./engine-test";
import { publishCrewOpportunity } from "./fixtures";
import { DEMO, expectAccessible, signIn, sql } from "./support";

/**
 * A89 (RRR-134), finding A65-031 and Section 11.12 Discover, on a phone: swipe an Explore card right to
 * save it and left to pass, with the Save and Pass buttons beside every card as the visible equivalent
 * (Section 11.10 habit 6). Undo puts a passed card back.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

/** One horizontal touch swipe across an element, as touch pointer events. */
async function swipe(page: Page, target: Locator, dx: number): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("swipe target is not visible");
  const y = box.y + box.height / 2;
  const x = box.x + box.width / 2;
  await target.evaluate(
    (el, { x, y, dx }) => {
      const fire = (type: string, clientX: number) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 7,
            pointerType: "touch",
            isPrimary: true,
            clientX,
            clientY: y,
          }),
        );
      fire("pointerdown", x);
      for (let step = 1; step <= 6; step += 1) fire("pointermove", x + (dx * step) / 6);
      fire("pointerup", x + dx);
    },
    { x, y, dx },
  );
}

async function savedCount(opportunityId: string): Promise<string | undefined> {
  const [row] = await sql<{ n: string }>(
    `select count(*)::text as n from app.saved_opportunities where person_id = $1 and opportunity_id = $2 and deleted_at is null`,
    [DEMO.crew, opportunityId],
  );
  return row?.n;
}

test("swipe right saves and swipe left passes an Explore card, with buttons for both", async ({
  page,
}) => {
  const opp = await publishCrewOpportunity(false);
  await signIn(page, "crew@example.com", `/explore?q=${encodeURIComponent(opp.title)}`);
  const link = page.getByRole("link", { name: opp.title });
  await expect(link).toBeVisible();
  const actions = page.getByRole("group", { name: `Actions for ${opp.title}` });
  await expect(actions.getByRole("button", { name: "Save" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Pass" })).toBeVisible();
  await expectAccessible(page);

  await swipe(page, link, 160);
  await expect(page.getByText("Saved. Find it under Saved.")).toBeVisible();
  await expect.poll(() => savedCount(opp.id)).toBe("1");
  await expect(page).toHaveURL(/\/explore\?/);

  await swipe(page, page.getByRole("link", { name: opp.title }), -160);
  await expect(page.getByText(`You passed on ${opp.title}.`)).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("link", { name: opp.title })).toBeVisible();
});
