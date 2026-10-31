import { expect as baseExpect, test } from "./engine-test";
import { expectAccessible } from "./support";
import { createProject, newOwnerOrg } from "./b4-support";

/**
 * B4 (RRR-228, G-45 to G-47): Schedule, Workload and Clashes, computed when read. The heatmap and its table, the
 * clash register with its filters, and the travel request check, which says it is recorded in each person's access
 * log. Settings, Scheduling shows the three thresholds with their defaults. Each page passes axe.
 */

test.use({ reducedMotion: "reduce" });
const expect = baseExpect.configure({ timeout: 20_000 });

test("journey: read workload and clashes, check travel requests and the thresholds", async ({
  page,
}) => {
  const slug = await newOwnerOrg(page, "b4w", "Wren Workload");
  await createProject(page, slug, {
    key: "WRK",
    name: "Workload Week",
    from: "2027-11-12",
    to: "2027-11-14",
  });

  await page.goto(`/${slug}/schedule/workload?week=2027-11-08`);
  await expect(page.getByRole("heading", { name: "Workload", level: 1 })).toBeVisible();
  await expect(page.getByText(/Days above 10 hours read as over/)).toBeVisible();
  await expectAccessible(page);
  await page.goto(`/${slug}/schedule/workload?week=2027-11-08&view=table`);
  await expectAccessible(page);

  await page.goto(`/${slug}/schedule/clashes?from=2027-11-01&to=2027-11-30`);
  await expect(page.getByRole("heading", { name: "Clashes", level: 1 })).toBeVisible();
  await expect(page.getByText("No clashes in this period.")).toBeVisible();
  await expect(page.getByLabel("Rule")).toBeVisible();
  await expect(page.getByLabel("Severity")).toBeVisible();
  const travel = page.getByRole("region", { name: "Check travel requests" });
  await expect(travel).toContainText("Each check is recorded in the person's access log.");
  await travel.getByRole("button", { name: "Check travel requests" }).click();
  await expect(travel.getByRole("status")).toContainText("Every requested travel date fits");
  await expectAccessible(page);

  // No automatic or AI fix is offered anywhere on the register.
  await expect(page.getByRole("button", { name: /fix|resolve automatically/i })).toHaveCount(0);

  await page.goto(`/${slug}/settings/scheduling`);
  for (const [label, value] of [
    ["Workload day (hours)", "10"],
    ["Minimum changeover (minutes)", "15"],
    ["Travel buffer (minutes)", "120"],
  ] as const) {
    await expect(page.getByLabel(label)).toHaveValue(value);
  }
  await expectAccessible(page);
});
