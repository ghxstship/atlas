import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect as baseExpect, test } from "./engine-test";
import { expectAccessibleInBothThemes, ORG, signIn } from "./a16-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * A135 (RRR-197, Section 8.2, ADR 0113) on the demo tenant: the Owner sees the rules every organization keeps,
 * always on and with no control, turns on each stricter option in Settings, Separation of Duties, and the matching
 * refusal appears where the option bites:
 *   sod_receiver_po_approver          the Admin approved the seeded purchase order (seed 0116) and cannot receive it;
 *   sod_document_creator              the Admin created an order the Producer put through the policy (seed 1030),
 *                                     and cannot decide its Finance review step;
 *   sod_change_order_requester_steps  the Admin requested a change order the Owner put through a change order
 *                                     policy, and cannot decide its step.
 * Documents the refusals need are prepared through Supabase Auth as the people who would prepare them, on the local
 * stack only. Every option is switched off again afterwards, and the documents withdrawn, so no other journey
 * meets them (Playwright runs one worker).
 */

const expect = baseExpect.configure({ timeout: 20_000 });
test.use({ reducedMotion: "reduce" });

const DEMO_ORG = "01920000-0000-7000-8000-000000000001";
const DEMO_PROJECT = "01920000-0000-7000-8000-000000001001";
const WORKING_BUDGET = "01920000-0000-7000-8000-000000115022";
const DEMO_PASSWORD = `xos-demo-${"2026"}`;

const OPTIONS = {
  receiver:
    "Goods are received by someone other than a person who approved the purchase order or a change to it.",
  creator:
    "Whoever created a purchase order, change order, invoice, requisition, expense, payroll run or settlement cannot approve it or decide a step of its approval.",
  steps: "The requester of a change order cannot decide any step of its approval.",
} as const;

function stack(): { url: string; anon: string; service: string } {
  const url = process.env["E2E_SUPABASE_URL"];
  const anon = process.env["E2E_SUPABASE_ANON_KEY"];
  const service = process.env["E2E_SUPABASE_SERVICE_KEY"];
  if (!url || !anon || !service || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) {
    throw new Error(
      "Set E2E_SUPABASE_URL, E2E_SUPABASE_ANON_KEY and E2E_SUPABASE_SERVICE_KEY to the local stack.",
    );
  }
  return { url, anon, service };
}

function service(): SupabaseClient {
  const { url, service: key } = stack();
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** A demo person's own session, to prepare a document the way they would. */
async function as(email: string): Promise<SupabaseClient> {
  const { url, anon } = stack();
  const client = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: DEMO_PASSWORD });
  expect(error).toBeNull();
  return client;
}

const cleanup: (() => Promise<unknown>)[] = [];

test.afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
  await service()
    .schema("app")
    .from("org_separation_of_duties_options")
    .update({ deleted_at: new Date().toISOString() })
    .eq("org_id", DEMO_ORG)
    .is("deleted_at", null);
});

test("an Owner turns on each stricter option, and the matching refusals appear", async ({
  page,
  browser,
}) => {
  test.setTimeout(6 * 60_000);
  const id = uniqueId();

  await signIn(page, "owner@example.com");
  await page.goto(`/${ORG}/settings/separation-of-duties`);
  const rules = page.getByRole("list", { name: "Rules every organization keeps" });
  await expect(rules.getByText("Always on").first()).toBeVisible();
  await expect(rules.getByRole("button")).toHaveCount(0);
  const options = page.getByRole("list", { name: "Stricter options" });
  for (const sentence of Object.values(OPTIONS)) {
    const row = options.getByRole("listitem").filter({ hasText: sentence });
    await expect(row.getByText("Off", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: "Turn on" }).click();
    await expect(row.getByText("On", { exact: true })).toBeVisible();
  }
  await expectAccessibleInBothThemes(page);

  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, "admin@example.com");

  // sod_receiver_po_approver: the Admin approved the seeded order, which still has goods to receive.
  const { data: receipt, error: receiptError } = await service()
    .schema("app")
    .from("goods_receipts")
    .select("purchase_order_id")
    .like("note", "Two show days of the line array arrived%")
    .single();
  expect(receiptError).toBeNull();
  const seededOrder = (receipt as { purchase_order_id: string }).purchase_order_id;
  await admin.goto(`/${ORG}/procurement/receipts?create=1&order=${seededOrder}`);
  const receive = admin.getByRole("dialog");
  await receive.getByLabel(/Audio crew of three/).fill("1");
  await receive.getByRole("button", { name: "Record receipt" }).click();
  await expect(
    receive.getByText(
      "Separation of duties: your organization does not let a person who approved this purchase order receive its goods.",
      { exact: false },
    ),
  ).toBeVisible();
  await expectAccessible(admin);

  // sod_document_creator: the Admin creates an order, the Producer submits it, and the Admin may not decide it.
  const adminDb = await as("admin@example.com");
  const { data: vendor } = await service()
    .schema("app")
    .from("vendors")
    .select("id")
    .eq("org_id", DEMO_ORG)
    .eq("vendor_state", "Active")
    .is("deleted_at", null)
    .order("created_at")
    .limit(1)
    .single();
  const { data: order, error: orderError } = await adminDb
    .schema("app")
    .from("purchase_orders")
    .insert({
      project_id: DEMO_PROJECT,
      vendor_id: (vendor as { id: string }).id,
      currency_code: "USD",
    })
    .select("id, po_number")
    .single();
  expect(orderError).toBeNull();
  const { id: orderId, po_number: poNumber } = order as { id: string; po_number: number };
  cleanup.push(async () =>
    adminDb
      .schema("app")
      .from("purchase_orders")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", orderId),
  );
  expect(
    (
      await adminDb
        .schema("app")
        .from("po_lines")
        .insert({
          purchase_order_id: orderId,
          line_number: 1,
          description: `Crowd barrier ${id}`,
          quantity: 2,
          unit_price_minor: 12500,
        })
    ).error,
  ).toBeNull();
  const producerDb = await as("producer@example.com");
  const submitted = await producerDb
    .schema("app")
    .rpc("request_approval", { p_document_type: "Purchase Order", p_document_id: orderId });
  expect(submitted.error).toBeNull();
  cleanup.push(async () =>
    producerDb.schema("app").rpc("cancel_approval", {
      p_approval_instance_id: submitted.data as string,
      p_reason: "Journey finished.",
    }),
  );
  await admin.goto(`/${ORG}/approvals`);
  const orderItem = admin.getByRole("listitem").filter({
    has: admin.getByRole("heading", { name: `Purchase order ${poNumber}`, exact: true }),
  });
  await orderItem.getByRole("button", { name: "Approve step" }).click();
  await expect(
    admin.getByText(
      "You created this document, and your organization does not let its creator decide a step.",
      { exact: false },
    ),
  ).toBeVisible();
  await expectAccessible(admin);

  // The Owner turns sod_document_creator off again, after confirming the rules every org keeps stay on.
  const creatorRow = options.getByRole("listitem").filter({ hasText: OPTIONS.creator });
  await creatorRow.getByRole("button", { name: "Turn off" }).click();
  const confirm = page.getByRole("dialog", { name: "Turn off this option?" });
  await expect(confirm.getByText("The rules every organization keeps stay on.")).toBeVisible();
  await confirm.getByRole("button", { name: "Turn off" }).click();
  await expect(creatorRow.getByText("Off", { exact: true })).toBeVisible();

  // sod_change_order_requester_steps: the Admin requests a change order; the Owner puts it through a change order
  // policy whose one step the Admin holds; the Admin may not decide it.
  const { data: policy, error: policyError } = await adminDb
    .schema("app")
    .from("approval_policies")
    .insert({ org_id: DEMO_ORG, name: `Change orders ${id}`, document_type: "Change Order" })
    .select("id")
    .single();
  expect(policyError).toBeNull();
  const policyId = (policy as { id: string }).id;
  const { data: adminRole } = await service()
    .schema("app")
    .from("roles")
    .select("id")
    .is("org_id", null)
    .eq("code", "admin")
    .single();
  expect(
    (
      await adminDb
        .schema("app")
        .from("approval_steps")
        .insert({
          approval_policy_id: policyId,
          step_order: 1,
          name: "Finance review",
          approver_role_id: (adminRole as { id: string }).id,
        })
    ).error,
  ).toBeNull();
  expect(
    (
      await adminDb.schema("app").rpc("transition_approval_policy", {
        p_approval_policy_id: policyId,
        p_expected: "Draft",
        p_next: "Active",
        p_reason: "Journey.",
      })
    ).error,
  ).toBeNull();
  cleanup.push(async () =>
    adminDb.schema("app").rpc("transition_approval_policy", {
      p_approval_policy_id: policyId,
      p_expected: "Active",
      p_next: "Retired",
      p_reason: "Journey finished.",
    }),
  );
  const title = `Add a lighting tower ${id}`;
  const { data: change, error: changeError } = await adminDb
    .schema("app")
    .from("change_orders")
    .insert({
      project_id: DEMO_PROJECT,
      budget_id: WORKING_BUDGET,
      title,
      order_type_enum_id: "ENM-092",
      reason: "The promoter asked for a tower at the lawn.",
    })
    .select("id")
    .single();
  expect(changeError).toBeNull();
  const changeId = (change as { id: string }).id;
  cleanup.push(async () =>
    adminDb
      .schema("app")
      .from("change_orders")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", changeId),
  );
  expect(
    (
      await adminDb.schema("app").from("change_order_lines").insert({
        change_order_id: changeId,
        description: "Lighting tower and operator.",
        urid: "4000.01.01",
        quantity: 1,
        unit_price_minor: 180000,
      })
    ).error,
  ).toBeNull();
  expect(
    (
      await adminDb
        .schema("app")
        .rpc("price_change_order", { p_change_order_id: changeId, p_reason: "Vendor quote." })
    ).error,
  ).toBeNull();
  const ownerDb = await as("owner@example.com");
  const changeApproval = await ownerDb
    .schema("app")
    .rpc("request_approval", { p_document_type: "Change Order", p_document_id: changeId });
  expect(changeApproval.error).toBeNull();
  cleanup.push(async () =>
    ownerDb.schema("app").rpc("cancel_approval", {
      p_approval_instance_id: changeApproval.data as string,
      p_reason: "Journey finished.",
    }),
  );
  await admin.goto(`/${ORG}/approvals`);
  const changeItem = admin.getByRole("listitem").filter({ hasText: title });
  await changeItem.getByRole("button", { name: "Approve step" }).click();
  await expect(
    admin.getByText(
      "You requested this change order, and your organization does not let its requester decide a step.",
      { exact: false },
    ),
  ).toBeVisible();
  await expectAccessible(admin);
});
