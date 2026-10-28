import { toDisplayKey } from "@xos/data/gateway-keys";
import { expect as baseExpect, test } from "./engine-test";
import { atlasAs, ORG } from "./atlas";
import { PEOPLE } from "./role-fixtures";
import { DEMO, signIn, sql } from "./support";

/**
 * R3 (owner decision 7): offerings default to Not Offered, so a crew engagement on a project that
 * offers no travel or lodging has no Travel and Lodging tab. The Owner offers travel on Project
 * Settings, Offerings in Atlas and the tab appears; a project rule for Crew set to Not offered hides
 * it again. The journey runs on a project of its own, so the demo project's offerings stay as the
 * seed left them for the other journeys, and removes that project, its engagement, value and rule
 * afterwards, so repeated local runs leave nothing behind.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

/** Two to five capital letters (projects_key_format): R and four random letters. */
function projectKey(): string {
  const letters = Array.from({ length: 4 }, () =>
    String.fromCharCode(65 + Math.floor(Math.random() * 26)),
  ).join("");
  return `R${letters}`;
}

/** Soft-deletes the journey's project and what it added there, which frees the project key too. */
async function removeProject(projectId: string): Promise<void> {
  for (const statement of [
    "update app.offering_rules set deleted_at = now() where project_id = $1 and deleted_at is null",
    `update app.setting_values set deleted_at = now()
      where scope_kind = 'Project' and scope_id = $1 and deleted_at is null`,
    "update app.engagements set deleted_at = now() where project_id = $1 and deleted_at is null",
    "update app.projects set deleted_at = now() where id = $1 and deleted_at is null",
  ]) {
    await sql(statement, [projectId]);
  }
}

test("offerings: Travel and Lodging follows the project's offering and its rules", async ({
  page,
  browser,
}) => {
  const key = projectKey();
  const [project] = await sql<{ id: string }>(
    `insert into app.projects (org_id, project_key, name, time_zone)
     values ($1, $2, $3, 'America/New_York') returning id`,
    [DEMO.org, key, `Offerings Run ${key}`],
    PEOPLE.owner,
  );
  const projectId = project?.id as string;
  try {
    const [engagement] = await sql<{ id: string }>(
      `insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis,
         arrangement, agreed_rate_minor, currency_code, start_date, end_date)
       values ($1, $2, 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', 90000, 'USD',
         '2027-06-04', '2027-06-06')
       returning id`,
      [projectId, DEMO.crew],
      PEOPLE.owner,
    );
    const engagementKey = toDisplayKey("engagement", engagement?.id as string);
    const travelTab = `/work/engagements/${engagementKey}/travel-and-lodging`;
    const tabs = page.getByRole("navigation", { name: "Engagement sections" });

    // Nothing is offered on the new project: no tab, and its route answers 404.
    await signIn(page, "crew@example.com", `/work/engagements/${engagementKey}`);
    await expect(tabs.getByRole("link", { name: "Shifts" })).toBeVisible();
    await expect(tabs.getByRole("link", { name: "Travel and Lodging" })).toHaveCount(0);
    expect((await page.goto(travelTab))?.status()).toBe(404);

    // The Owner offers travel on Project Settings, Offerings.
    const owner = await atlasAs(browser, "owner@example.com");
    await owner.page.goto(`/${ORG}/p/${key}/settings`);
    const offerings = owner.page.getByTestId("project-offerings");
    await expect(
      offerings.getByText("Platform default. Saving overrides it for this project.").first(),
    ).toBeVisible();
    await offerings.getByLabel("Travel", { exact: true }).selectOption({ label: "Provided" });
    await owner.page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(offerings.getByText("Set for this project.").first()).toBeVisible();

    // The tab appears.
    await page.goto(`/work/engagements/${engagementKey}`);
    await expect(tabs.getByRole("link", { name: "Travel and Lodging" })).toBeVisible();
    expect((await page.goto(travelTab))?.status()).toBe(200);

    // A project rule for Crew set to Not offered hides it again.
    const rule = owner.page.getByRole("form", { name: "Add rule" });
    await rule.getByLabel("Offering").selectOption({ label: "Travel" });
    await rule.getByLabel("Role type").selectOption({ label: "Crew" });
    await rule.getByLabel("Mode").selectOption({ label: "Not offered" });
    await rule.getByRole("button", { name: "Add rule" }).click();
    await expect(rule.getByText("Rule added.")).toBeVisible();
    await expect(owner.page.getByTestId("offering-rules").getByRole("row")).toHaveCount(2);
    await owner.context.close();

    await page.goto(`/work/engagements/${engagementKey}`);
    await expect(tabs.getByRole("link", { name: "Shifts" })).toBeVisible();
    await expect(tabs.getByRole("link", { name: "Travel and Lodging" })).toHaveCount(0);
    expect((await page.goto(travelTab))?.status()).toBe(404);
  } finally {
    await removeProject(projectId);
  }
});
