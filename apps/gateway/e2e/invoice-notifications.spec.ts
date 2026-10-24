import { MailpitTransport } from "@xos/email";
import { dispatchEmail, notificationStore, type PlatformDb } from "@xos/platform";
import { expect as baseExpect, test } from "./engine-test";
import {
  asPerson,
  codeAndApproveInvoice,
  payInvoice,
  PEOPLE,
  projectToday,
  suffix,
  transition,
  vendorEngagement,
} from "./role-fixtures";
import { expectAccessible, signIn, sql } from "./support";

/**
 * Journey 56's notifications (Section 20.2; migration 1131, finding A38-002): the vendor follows
 * an invoice from Submitted to Paid and is notified at each step, in Gateway (Home, Updates), by
 * email into the local stack's inbox, and with a Push delivery record. Reaching a phone is the
 * device step. The vendor's own choices in Settings, Notifications decide the channels.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

/** The local stack's Mailpit inbox (Supabase inbucket); block 569 by default, like the stack. */
const INBOX = process.env["E2E_INBUCKET_URL"] ?? "http://127.0.0.1:56924";

/** PlatformDb over the fixtures' postgres connection, so the email worker runs here as it does in its Edge Function. */
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

test("journey 56: the vendor is notified at each invoice step, honoring their choices", async ({
  page,
}) => {
  // The vendor keeps Email and Push on for invoices and payments, saved in Gateway settings.
  await signIn(page, "vendor@example.com", "/settings/notifications");
  const prefs = page.getByRole("form", { name: "Notification preferences" });
  // Opportunities and expiry reminders have their own rows of channels (1461, 1463).
  const finance = prefs.getByRole("group", { name: "Invoices and payments" });
  await finance.getByLabel("Email").uncheck();
  await prefs.getByRole("button", { name: "Save preferences" }).click();
  await expect(prefs.getByText("Saved. New notifications follow these choices.")).toBeVisible();
  const choice = async () =>
    (
      await sql<{ enabled: boolean }>(
        `select enabled from app.person_notification_preferences
          where person_id = $1 and category_code = 'finance' and channel = 'Email' and deleted_at is null`,
        [PEOPLE.vendorContact],
      )
    )[0]?.enabled;
  await expect.poll(choice).toBe(false);
  await finance.getByLabel("Email").check();
  await finance.getByLabel("Push to Compass").check();
  await prefs.getByRole("button", { name: "Save preferences" }).click();
  await expect.poll(choice).toBe(true);
  await expectAccessible(page);

  // Submitted, Approved, Scheduled and Paid: each step notifies the vendor's account.
  const engagement = await vendorEngagement();
  await transition("engagement", engagement.id, "Onboarding", "Active", "Vendor onboarded.");
  const number = `DSS-N-${suffix()}`;
  // Issued today on the project's calendar, so the approval posts in the open period even on the last
  // evening of a month, when the database's UTC date is already in the next one.
  const today = await projectToday();
  const [submitted] = await asPerson<{ id: string }>(
    PEOPLE.vendorContact,
    `select app.submit_engagement_invoice($1, $2, $3::date, $3::date + 30, 'USD',
       '[{"description": "Delay towers, one show day", "quantity": 1, "unit_price_minor": 380000}]'::jsonb) as id`,
    [engagement.id, number, today],
  );
  const invoiceId = submitted?.id as string;
  await codeAndApproveInvoice(invoiceId);
  await payInvoice(invoiceId);

  const kinds = await sql<{ kind: string; channels: string }>(
    `select n.kind, coalesce(string_agg(d.channel::text, ',' order by d.channel), '') as channels
       from app.notifications n
       left join app.notification_deliveries d on d.notification_id = n.id and d.notification_created_at = n.created_at
      where n.recipient_person_id = $1 and n.subject_id = $2
      group by n.kind order by n.kind`,
    [PEOPLE.vendorContact, invoiceId],
  );
  expect(kinds).toEqual([
    { kind: "invoice.approved", channels: "Email,Push" },
    { kind: "invoice.paid", channels: "Email,Push" },
    { kind: "invoice.scheduled", channels: "Email,Push" },
    { kind: "invoice.submitted", channels: "Email,Push" },
  ]);

  // In Gateway: Home lists the updates, newest first, each linking to Money, Invoices.
  await page.goto("/home");
  const updates = page.getByRole("list", { name: "Updates" });
  await expect(
    updates.getByRole("link", { name: `Demo Productions paid invoice ${number}` }),
  ).toBeVisible();
  await expect(
    updates.getByRole("link", { name: `Demo Productions received invoice ${number}` }),
  ).toBeVisible();
  await expectAccessible(page);
  await updates.getByRole("link", { name: `Demo Productions paid invoice ${number}` }).click();
  await expect(page).toHaveURL(/\/money\/invoices$/);

  // By email: the worker sends the four into the local inbox (never a real recipient).
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
    .poll(async () => (await inboxSubjects("vendor@example.com")).filter((s) => s.includes(number)))
    .toEqual(
      expect.arrayContaining([
        `Invoice received: ${number}`,
        `Invoice approved: ${number}`,
        `Payment scheduled: ${number}`,
        `Invoice paid: ${number}`,
      ]),
    );

  // Push: one delivery per step is recorded; with no registered device the worker suppresses it
  // and says why, so reaching a phone stays a device step.
  const [push] = await sql<{ n: string }>(
    `select count(*)::text as n from app.notification_deliveries d join app.notifications n on n.id = d.notification_id
      where n.recipient_person_id = $1 and n.subject_id = $2 and d.channel = 'Push'`,
    [PEOPLE.vendorContact, invoiceId],
  );
  expect(push?.n).toBe("4");
});
