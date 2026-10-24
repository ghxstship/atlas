import { MailpitTransport } from "@xos/email";
import { dispatchEmail, notificationStore, type PlatformDb } from "@xos/platform";
import { atlasAs, ORG } from "./atlas";
import { expect as baseExpect, settledGoto, test } from "./engine-test";
import { publishCrewOpportunity } from "./fixtures";
import { DEMO, expectAccessible, signIn, sql, uniqueId } from "./support";

/**
 * A89 (RRR-134), findings A65-008 and A65-031: a saved search alerts the person by email and on
 * Explore Alerts; Explore ranks by the published factors with the missing filters; Save and Pass work
 * by button and by key, a pass offers Undo; the profile strength meter links to each gap; quiet hours
 * are the person's own; supplier diversity certifications are shared by separate consent with an org
 * that runs a program, which reads them in Atlas.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

const INBOX = process.env["E2E_INBUCKET_URL"] ?? "http://127.0.0.1:56924";

const platformDb: PlatformDb = {
  async rpc(fn, args) {
    const names = Object.keys(args);
    const rows = await sql<Record<string, unknown>>(
      `select * from app.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")})`,
      names.map((n) => args[n]),
    );
    const [first] = rows;
    return rows.length === 1 && first && Object.keys(first).join() === fn ? first[fn] : rows;
  },
  async selectOne(table, columns, match) {
    const keys = Object.keys(match);
    const [row] = await sql<Record<string, unknown>>(
      `select ${columns} from app.${table} where ${keys.map((k, i) => `${k} = $${i + 1}`).join(" and ")} limit 1`,
      keys.map((k) => match[k]),
    );
    return row ?? null;
  },
};

async function inboxSubjects(to: string): Promise<string[]> {
  const response = await fetch(`${INBOX}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
  const body = (await response.json()) as { messages?: { Subject: string }[] };
  return (body.messages ?? []).map((m) => m.Subject);
}

test("A65-008: a saved search alerts the crew person by email, push and on Explore Alerts", async ({
  page,
}) => {
  const name = `Truss calls ${uniqueId().slice(-4)}`;
  // Earlier runs' saved searches would match too, and a listing is notified once per person, under the
  // first search that matched it; this journey starts with none.
  await sql(
    `update app.saved_searches set deleted_at = now() where person_id = $1 and deleted_at is null`,
    [DEMO.crew],
  );
  await signIn(page, "crew@example.com", "/explore?role=Crew&q=Truss");
  const save = page.getByRole("form", { name: "Save this search" });
  await save.getByLabel("Search name").fill(name);
  await save.getByRole("button", { name: "Save search" }).click();
  await expect(page.getByText("Search saved. Manage it under Alerts.")).toBeVisible();

  // The org publishes a matching Crew call to the crew person; the matcher runs as pg_cron would.
  const opp = await publishCrewOpportunity(false);
  await sql("select private.match_saved_searches()");
  const notified = await sql<{ channels: string; path: string }>(
    `select coalesce(string_agg(d.channel::text, ',' order by d.channel), '') as channels, n.message_args ->> 'gatewayPath' as path
       from app.notifications n
       left join app.notification_deliveries d on d.notification_id = n.id and d.notification_created_at = n.created_at
      where n.recipient_person_id = $1 and n.kind = 'opportunity.matched' and n.subject_id = $2
      group by n.message_args`,
    [DEMO.crew, opp.id],
  );
  expect(notified).toEqual([{ channels: "Email,Push", path: `/explore/${opp.key}` }]);

  await dispatchEmail(
    notificationStore(platformDb, {
      appUrl: "http://127.0.0.1:3006",
      gatewayUrl: "http://127.0.0.1:3127",
      fromAddress: "notifications@xos.localhost",
      postalAddress: "100 Harbor Way, Miami, FL",
      unsubscribeUrl: async () => "http://127.0.0.1:3127/settings/notifications",
      inboundDomain: null,
    }),
    new MailpitTransport(INBOX),
    500,
  );
  await expect
    .poll(async () =>
      (await inboxSubjects("crew@example.com")).filter((s) => s.includes(opp.title)),
    )
    .toEqual([`New match for ${name}: ${opp.title}`]);

  await page.goto("/explore/alerts");
  const matches = page.getByRole("region", { name: "Recent matches" });
  await expect(matches.getByRole("link", { name: opp.title })).toBeVisible();
  await expect(matches.getByText(new RegExp(`Matched ${name} on`))).toBeVisible();
  await expectAccessible(page);

  // The saved search's row: turn alerts off with its key, as the swipe would.
  const row = page.getByRole("group", { name: `Actions for ${name}` });
  await row.getByRole("button", { name: "Turn off" }).focus();
  await page.keyboard.press("a");
  await expect
    .poll(
      async () =>
        (
          await sql<{ on: boolean }>(
            `select alerts_enabled as on from app.saved_searches where person_id = $1 and name = $2 and deleted_at is null`,
            [DEMO.crew, name],
          )
        )[0]?.on,
    )
    .toBe(false);
});

test("A65-008 and A65-031: ranked Explore, save by key, pass with Undo", async ({ page }) => {
  const opp = await publishCrewOpportunity(false);
  await signIn(page, "crew@example.com", `/explore?q=${encodeURIComponent(opp.title)}`);
  await expect(page.getByLabel("Order")).toHaveValue("recommended");
  const actions = page.getByRole("group", { name: `Actions for ${opp.title}` });
  await expect(page.getByRole("link", { name: opp.title })).toBeVisible();
  await expectAccessible(page);

  // Save with the S key while focus is inside the card.
  await page.getByRole("link", { name: opp.title }).focus();
  await page.keyboard.press("s");
  await expect(page.getByText("Saved. Find it under Saved.")).toBeVisible();
  await expect
    .poll(
      async () =>
        (
          await sql<{ n: string }>(
            `select count(*)::text as n from app.saved_opportunities where person_id = $1 and opportunity_id = $2 and deleted_at is null`,
            [DEMO.crew, opp.id],
          )
        )[0]?.n,
    )
    .toBe("1");

  // Pass by button: the card leaves, with Undo in its place.
  await actions.getByRole("button", { name: "Pass" }).click();
  await expect(page.getByText(`You passed on ${opp.title}.`)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("link", { name: opp.title })).toHaveCount(0);
  await page.goto(`/explore?q=${encodeURIComponent(opp.title)}&passed=1`);
  await page
    .getByRole("group", { name: `Actions for ${opp.title}` })
    .getByRole("button", { name: "Undo" })
    .click();
  await expect(page.getByText("Back in your results.")).toBeVisible();
  await page.goto(`/explore?q=${encodeURIComponent(opp.title)}`);
  await expect(page.getByRole("link", { name: opp.title })).toBeVisible();

  // How ranking works names the four factors and their points.
  await page.goto("/explore/how-ranking-works");
  await expect(page.getByText("Skills, up to 40 points.")).toBeVisible();
  await expect(page.getByText("Availability, up to 10 points.")).toBeVisible();
  await expectAccessible(page);
});

test("A65-031: the profile strength meter links to each gap; quiet hours are the person's own", async ({
  page,
}) => {
  await signIn(page, "crew@example.com", "/profile");
  const missing = page.getByRole("list", { name: /missing/ });
  if ((await missing.count()) > 0) {
    const first = missing.getByRole("link").first();
    const href = (await first.getAttribute("href")) ?? "";
    expect(href).toMatch(/^\/(settings\/)?profile#[a-z-]+$/);
    await first.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.locator(`#${href.split("#")[1]}`)).toBeVisible();
  }

  await page.goto("/settings/notifications");
  const quiet = page.getByRole("form", { name: "Quiet hours" });
  await quiet.getByLabel("Start").fill("22:00");
  await quiet.getByLabel("End").fill("07:00");
  await quiet.getByLabel("Time zone").fill("America/New_York");
  await quiet.getByRole("button", { name: "Save quiet hours" }).click();
  await expect(quiet.getByText("Saved. Pushes wait out these hours.")).toBeVisible();
  const [row] = await sql<{ zone: string; start: string }>(
    `select time_zone as zone, quiet_hours_start::text as start from app.person_notification_settings where person_id = $1 and deleted_at is null`,
    [DEMO.crew],
  );
  expect(row).toEqual({ zone: "America/New_York", start: "22:00:00" });
  await expect(
    page
      .getByRole("form", { name: "Notification preferences" })
      .getByText("Opportunities", { exact: true }),
  ).toBeVisible();
  await expectAccessible(page);
  // Quiet hours off again, so other journeys' pushes are not held (demo people sign in as their own id).
  await sql(`select app.set_my_quiet_hours('America/New_York')`, [], DEMO.crew);
});

test("A65-031: a supplier diversity certification is shared by separate consent and read in Atlas", async ({
  page,
  browser,
}) => {
  const body = `Florida OSD ${uniqueId().slice(-4)}`;
  await sql(
    `select app.set_setting($1, 'gateway.supplier_diversity_program', 'Organization', $1, p_value_boolean => true)`,
    [DEMO.org],
    DEMO.owner,
  );
  await signIn(page, "crew@example.com", "/profile");
  const add = page.getByRole("form", { name: "Add certification" });
  await add.getByLabel("Certification").selectOption({ label: "Women-owned business" });
  await add.getByLabel("Certified by").fill(body);
  await add.getByLabel("Certificate number").fill("FL-WBE-2026-118842");
  await add.getByRole("button", { name: "Add certification" }).click();
  const region = page.getByRole("region", { name: "Supplier diversity" });
  await expect(region.getByText(body)).toBeVisible();
  await expect(region.getByText(/Number ending 8842/).first()).toBeVisible();
  const share = region
    .getByRole("listitem")
    .filter({ hasText: body })
    .getByRole("form", { name: "Share this certification" });
  await share.getByLabel("Share with").selectOption({ label: "Demo Productions" });
  await share.getByRole("button", { name: "Share" }).click();
  await expect(
    region.getByRole("listitem").filter({ hasText: body }).getByRole("button", { name: "Revoke" }),
  ).toBeVisible();
  await expectAccessible(page);

  const atlas = await atlasAs(browser, "owner@example.com");
  settledGoto(atlas.page);
  await atlas.page.goto(`/${ORG}/vendors/directory`);
  const shared = atlas.page.getByRole("region", { name: "Supplier diversity" });
  await expect(shared.getByRole("cell", { name: body })).toBeVisible();
  await expect(shared.getByRole("cell", { name: "FL-WBE-2026-118842" })).toBeVisible();
  await atlas.context.close();

  // The read is in the person's own access log.
  const [viewed] = await sql<{ n: string }>(
    `select count(*)::text as n from app.supplier_diversity_events e
       join app.supplier_diversity_certifications c on c.id = e.supplier_diversity_certification_id
      where c.person_id = $1 and c.certifying_body = $2 and e.action = 'supplier_diversity.viewed'`,
    [DEMO.crew, body],
  );
  expect(Number(viewed?.n)).toBeGreaterThan(0);
});
