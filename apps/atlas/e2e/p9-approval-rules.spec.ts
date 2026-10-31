import { getMessages } from "@xos/i18n";
import { IntlMessageFormat } from "intl-messageformat";
import pg from "pg";
import { expect, test } from "./engine-test";
import { DEMO_ORG, signInAs } from "./a36-support";

/**
 * P9 (RRR-223, gaps G-31 and G-261, ADR 0138): the Owner adds a Pass rule for one credential category in Project
 * Settings, gives it a step the Admin decides and activates it. A pass of that category then shows Awaiting approval
 * on the project's credentials, and Approvals lists it under My requests with when its approvers were last notified
 * and Reminder 0 of 3. Remind approvers sends one reminder, and the button then says when it may be pressed again.
 * The journey runs in en-US and es-US, reading every label from the catalogs. Each run makes its own category, so
 * no other journey's passes are gated, and retires its rule afterwards.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);

const PROJECT = "01920000-0000-7000-8000-000000001001";
const PROJECT_KEY = "NWS";
const ORG_ID = "01920000-0000-7000-8000-000000000001";
const OWNER = "01920000-0000-7000-8000-000000000101";
const ADMIN = "01920000-0000-7000-8000-000000000102";
const CREW = "01920000-0000-7000-8000-000000000201";

/** SQL against the local stack only, as the given person when one is named. */
async function localSql<T extends pg.QueryResultRow>(
  text: string,
  args: unknown[] = [],
  asPerson?: string,
): Promise<T[]> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) {
    throw new Error("The approval rules journey runs against a local Supabase stack only.");
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin");
    if (asPerson) {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: asPerson, role: "authenticated" }),
      ]);
    }
    const result = await client.query<T>(text, args);
    await client.query("commit");
    return result.rows;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

type Tree = { readonly [key: string]: string | Tree };

/** A catalog message of the locale, formatted. */
function messages(locale: "en-US" | "es-US") {
  const all = getMessages(locale) as unknown as Tree;
  return (key: string, values?: Record<string, string | number>): string => {
    let node: string | Tree | undefined = all;
    for (const part of key.split(".")) node = typeof node === "object" ? node[part] : undefined;
    if (typeof node !== "string") throw new Error(`missing ${key}`);
    return String(new IntlMessageFormat(node, locale).format(values));
  };
}

/** The text of a message before its first argument, for copy that ends in a time. */
function lead(message: string): string {
  return message.split("{")[0]?.trim() ?? message;
}

function raw(locale: "en-US" | "es-US", key: string): string {
  const all = getMessages(locale) as unknown as Tree;
  let node: string | Tree | undefined = all;
  for (const part of key.split(".")) node = typeof node === "object" ? node[part] : undefined;
  return typeof node === "string" ? node : key;
}

const retire: string[] = [];

test.afterAll(async () => {
  for (const id of retire) {
    await localSql(
      `select app.transition_approval_rule($1, 'Active', 'Retired', 'P9 journey finished')`,
      [id],
      OWNER,
    );
  }
});

for (const locale of ["en-US", "es-US"] as const) {
  test(`P9: a pass rule, a pass awaiting approval and Remind approvers (${locale})`, async ({
    page,
    baseURL,
  }) => {
    const t = messages(locale);
    const R = "projects.settings.approvalRules";
    const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
    const ruleName = `Pass check ${run}`;
    const [category] = await localSql<{ id: string }>(
      `insert into app.credential_categories (project_id, code, name) values ($1, $2, $3) returning id`,
      [PROJECT, `P9${run}`.slice(0, 12), `Approved access ${run}`],
      OWNER,
    );
    const categoryId = category?.id as string;
    const [admin] = await localSql<{ id: string }>(
      `select id from app.memberships where org_id = $1 and person_id = $2 and deleted_at is null limit 1`,
      [ORG_ID, ADMIN],
    );

    await page
      .context()
      .addCookies([{ name: "xos-locale", value: locale, url: baseURL as string }]);
    await signInAs(page, "owner@example.com", DEMO_ORG);

    // 1. Project Settings: a Draft rule for the category, a step the Admin decides, then Activate.
    await page.goto(`/${DEMO_ORG}/p/${PROJECT_KEY}/settings`);
    const section = page.getByTestId("project-approval-rules");
    await expect(section.getByRole("heading", { name: t(`${R}.title`) })).toBeVisible();
    const create = section.getByRole("form", { name: t(`${R}.create.label`) });
    await create.getByLabel(t(`${R}.fields.filter.Pass`)).selectOption(categoryId);
    await create.getByLabel(t(`${R}.fields.name`), { exact: true }).fill(ruleName);
    await create.getByRole("button", { name: t(`${R}.create.submit`) }).click();
    await expect(create.getByText(t(`${R}.create.done`))).toBeVisible();

    const card = section.getByTestId("approval-rule").filter({ hasText: ruleName });
    await expect(card.getByText(t("workflow.policyStates.Draft"), { exact: true })).toBeVisible();
    const step = card.getByRole("form", { name: t(`${R}.steps.addLabel`) });
    await step.getByLabel(t(`${R}.steps.name`), { exact: true }).fill("Production sign-off");
    await step.getByLabel(t(`${R}.steps.approver`)).selectOption(`member:${admin?.id ?? ""}`);
    await step.getByRole("button", { name: t(`${R}.steps.add`) }).click();
    await expect(
      card.getByText(t(`${R}.steps.stepName`, { order: 1, name: "Production sign-off" })),
    ).toBeVisible();
    await card.getByRole("button", { name: t(`${R}.transition.Active`) }).click();
    await expect(card.getByText(t("workflow.policyStates.Active"), { exact: true })).toBeVisible();
    const [rule] = await localSql<{ id: string }>(
      `select id from app.approval_rules where project_id = $1 and name = $2`,
      [PROJECT, ruleName],
    );
    retire.push(rule?.id as string);

    // 2. A pass of the category, issued by the Owner, waits on the rule.
    const [pass] = await localSql<{ id: string; credential_number: string }>(
      `insert into app.credentials (credential_category_id, holder_person_id) values ($1, $2)
       returning id, credential_number`,
      [categoryId, CREW],
      OWNER,
    );
    await page.goto(`/${DEMO_ORG}/p/${PROJECT_KEY}/credentials?category=${categoryId}`);
    await expect(
      page.getByRole("row").filter({ hasText: pass?.credential_number ?? "" }),
    ).toContainText(t("credentials.issued.approval.waiting"));

    // 3. Approvals, My requests: when the Admin was last notified, and no reminder of the 3 yet.
    await page.goto(`/${DEMO_ORG}/approvals?tab=mine`);
    const row = page.getByTestId("subject-approval").filter({ hasText: ruleName });
    await expect(
      row.getByText(t("workflow.approvals.subjects.Pass"), { exact: false }),
    ).toBeVisible();
    const reminders = row.getByTestId("approval-reminders");
    await expect(reminders).toContainText(
      lead(raw(locale, "workflow.approvals.reminders.lastNotified")),
    );
    await expect(reminders).toContainText(
      t("workflow.approvals.reminders.count", { sent: 0, limit: 3 }),
    );
    // Opened just now, so Remind approvers waits 4 hours from the request.
    await expect(
      reminders.getByRole("button", { name: t("workflow.approvals.remind.button") }),
    ).toBeDisabled();

    // 4. Five hours on, Remind approvers sends one reminder, and then says when it opens again.
    await localSql(
      `update app.subject_approvals set created_at = now() - interval '5 hours' where credential_id = $1`,
      [pass?.id],
    );
    await page.reload();
    const remind = reminders.getByRole("button", { name: t("workflow.approvals.remind.button") });
    await expect(remind).toBeEnabled();
    await remind.click();
    await expect(page.getByText(t("workflow.approvals.remind.done"))).toBeVisible();
    await expect(reminders).toContainText(
      t("workflow.approvals.reminders.count", { sent: 1, limit: 3 }),
    );
    await expect(reminders).toContainText(
      lead(raw(locale, "workflow.approvals.remind.nextAllowed")),
    );
    await expect(
      reminders.getByRole("button", { name: t("workflow.approvals.remind.button") }),
    ).toBeDisabled();
    const [sent] = await localSql<{ n: string }>(
      `select count(*)::text as n from app.notifications n join app.subject_approvals a on a.id = n.subject_id
        where n.kind = 'approval.reminder' and a.credential_id = $1 and n.recipient_person_id = $2`,
      [pass?.id, ADMIN],
    );
    expect(sent?.n).toBe("1");
  });
}
