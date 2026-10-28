import { notificationStore, type PlatformDb } from "@xos/platform";
import pg from "pg";
import { expect, test } from "./engine-test";
import { expectAccessibleInBothThemes } from "./a16-support";
import { apiPost, DEMO_ORG, signInAs } from "./a36-support";

/**
 * A127 (Section 11.10 rule 5, S11.10-06, ADR 0086): an approver approves from the approval request's email in two taps,
 * the email's Approve button and the confirm page's Approve, without opening the record. The link never acts on
 * opening, works once, and says nothing to anyone but its recipient.
 */
const PROJECT = "01920000-0000-7000-8000-000000001001";
const LOCAL = /@(127\.0\.0\.1|localhost):/;
const DATABASE_URL =
  process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";

async function withDb<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  if (!LOCAL.test(DATABASE_URL))
    throw new Error("Email links are minted against a local stack only.");
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** PlatformDb over postgres, so the email worker's store mints links here as it does in its Edge Function. */
function platformDb(client: pg.Client): PlatformDb {
  return {
    async rpc(fn, args) {
      const names = Object.keys(args);
      const { rows } = await client.query<Record<string, unknown>>(
        `select * from app.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")})`,
        names.map((n) => args[n]),
      );
      return rows;
    },
    async selectOne(table, columns, match) {
      const keys = Object.keys(match);
      const { rows } = await client.query<Record<string, unknown>>(
        `select ${columns} from app.${table} where ${keys.map((k, i) => `${k} = $${i + 1}`).join(" and ")} limit 1`,
        keys.map((k) => match[k]),
      );
      return rows[0] ?? null;
    },
  };
}

test("A127: approve a purchase order from its email in two taps", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const base = baseURL as string;

  // Producer: a purchase order submitted to the Purchase order policy; the Admin is asked first.
  const producer = await (await browser.newContext()).newPage();
  await signInAs(producer, "producer@example.com", DEMO_ORG);
  const vendors = (await (await producer.request.get("/api/v1/vendors?limit=50")).json()) as {
    data: { id: string; vendor_state: string }[];
  };
  const vendor = vendors.data.find((v) => v.vendor_state === "Active");
  expect(vendor, "an Active demo vendor").toBeTruthy();
  const po = await apiPost(producer.request, base, "/purchase-orders", {
    project_id: PROJECT,
    vendor_id: vendor?.id,
    currency_code: "USD",
  });
  await apiPost(producer.request, base, "/po-lines", {
    purchase_order_id: po["id"],
    description: "Truss segment, one-tap approval",
    quantity: 1,
    unit_price_minor: 12500,
  });
  const approval = await apiPost(producer.request, base, "/approval-instances", {
    document_type: "Purchase Order",
    document_id: po["id"],
  });
  const approvalId = String(approval["id"]);

  // The email worker mints the links of the Admin's email, as it does when it sends it.
  const links = await withDb(async (client) => {
    const { rows } = await client.query<{ delivery_id: string }>(
      `select d.id as delivery_id from app.notifications n
         join app.notification_deliveries d on d.notification_id = n.id and d.channel = 'Email'
         join app.people p on p.id = n.recipient_person_id
         join auth.users u on u.id = p.user_id
        where n.kind = 'approval.requested' and n.subject_id = $1 and u.email = 'admin@example.com'`,
      [approvalId],
    );
    const deliveryId = rows[0]?.delivery_id;
    expect(deliveryId, "the Admin's email delivery").toBeTruthy();
    const store = notificationStore(platformDb(client), {
      appUrl: base,
      fromAddress: "notifications@xos.localhost",
      postalAddress: "100 Harbor Way, Miami, FL",
      unsubscribeUrl: async () => `${base}/${DEMO_ORG}/me/notifications`,
      inboundDomain: null,
    });
    return (
      (await store.actionLinksFor?.({
        deliveryId: deliveryId as string,
        orgId: "",
        recipientPersonId: "",
        address: "admin@example.com",
        kind: "approval.requested",
        emailTemplateCode: "notification",
        messageArgs: {},
        subjectTable: "approval_instances",
        subjectId: approvalId,
      })) ?? []
    );
  });
  const approve = links.find((l) => l.action === "approve")?.url;
  expect(links.map((l) => l.action).sort()).toEqual(["approve", "reject"]);
  expect(approve).toMatch(/\/auth\/act\/xact_[0-9a-f]{48}\.[0-9a-f]{32}$/);

  // Someone else signed in learns nothing from the link.
  await producer.goto(approve as string);
  await expect(
    producer.getByText("This link was sent to someone else.", { exact: false }),
  ).toBeVisible();
  await expect(producer.getByRole("button", { name: "Approve" })).toHaveCount(0);

  // Tap one: the email's Approve opens the confirm page, which only asks.
  const admin = await (await browser.newContext()).newPage();
  await signInAs(admin, "admin@example.com", DEMO_ORG);
  await admin.goto(approve as string);
  await expect(admin.getByRole("heading", { level: 1, name: /^Approve .+\?$/ })).toBeVisible();
  await expectAccessibleInBothThemes(admin);
  const before = (await (
    await admin.request.get(`/api/v1/approval-instances/${approvalId}`)
  ).json()) as { current_step: number };
  expect(before.current_step).toBe(1);

  // Tap two: Approve.
  await admin.getByRole("button", { name: "Approve" }).click();
  await expect(admin.getByText("Approved. Nothing else to do.")).toBeVisible();
  const after = (await (
    await admin.request.get(`/api/v1/approval-instances/${approvalId}`)
  ).json()) as { current_step: number };
  expect(after.current_step).toBe(2);

  // The link works once.
  await admin.goto(approve as string);
  await expect(admin.getByText("This was already handled. Nothing else to do.")).toBeVisible();
  await expect(admin.getByRole("button", { name: "Approve" })).toHaveCount(0);
});
