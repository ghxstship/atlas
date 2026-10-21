import { expect, settle, test } from "./engine-test";
import { expectAccessibleInBothThemes } from "./a16-support";
import { apiPost, DEMO_ORG, signInAs } from "./a36-support";

/**
 * Journey 57 (Section 20.2, Section 11.10 rule 5): the Producer submits 21 purchase orders for
 * approval; the Finance reviewer (the Admin, the demo policy's first step) approves one through the
 * notification action a push notification calls (the server half; the device half needs a phone) and
 * 20 from the Inbox with the A key in under 60 seconds, never opening a record. Focus stays on the
 * list as each approved item leaves (A61: the count never stalls partway).
 */
const PROJECT = "01920000-0000-7000-8000-000000001001";

test("journey 57: approve from the notification action, then 20 Inbox items by keyboard", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const base = baseURL as string;

  // Producer: 21 purchase orders, each priced and submitted to the Purchase order policy.
  const producer = await (await browser.newContext()).newPage();
  await signInAs(producer, "producer@example.com", DEMO_ORG);
  const vendors = (await (await producer.request.get("/api/v1/vendors?limit=50")).json()) as {
    data: { id: string; vendor_state: string }[];
  };
  const vendor = vendors.data.find((v) => v.vendor_state === "Active");
  expect(vendor, "an Active demo vendor").toBeTruthy();
  const approvals: string[] = [];
  try {
    for (let i = 0; i < 21; i += 1) {
      const po = await apiPost(producer.request, base, "/purchase-orders", {
        project_id: PROJECT,
        vendor_id: vendor?.id,
        currency_code: "USD",
      });
      await apiPost(producer.request, base, "/po-lines", {
        purchase_order_id: po["id"],
        description: `Truss segment ${i + 1}`,
        quantity: 1,
        unit_price_minor: 10000 + i,
      });
      const approval = await apiPost(producer.request, base, "/approval-instances", {
        document_type: "Purchase Order",
        document_id: po["id"],
      });
      approvals.push(String(approval["id"]));
    }

    // Admin: the server half of approving from a push notification, for the oldest of them.
    const admin = await (await browser.newContext()).newPage();
    await signInAs(admin, "admin@example.com", DEMO_ORG);
    const first = approvals[0] as string;
    const notes = (await (
      await admin.request.get(`/api/v1/notifications?filter[subject_id][eq]=${first}&limit=5`)
    ).json()) as { data: { id: string; kind: string }[] };
    const note = notes.data.find((n) => n.kind === "approval.requested");
    expect(note, "the approval request notification").toBeTruthy();
    const acted = await apiPost(admin.request, base, `/notifications/${note?.id}/act`, {
      action: "approve",
    });
    expect(acted["archived_at"]).not.toBeNull();
    const decided = (await (
      await admin.request.get(`/api/v1/approval-instances/${first}`)
    ).json()) as {
      current_step: number;
    };
    expect(decided.current_step).toBe(2);

    // Admin: 20 approvals from the Inbox by keyboard, under 60 seconds, without opening a record.
    await admin.goto(`/${DEMO_ORG}/inbox`);
    await expect(admin.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    await expectAccessibleInBothThemes(admin);
    // The theme check ends on a reload; the A key does nothing until the page has hydrated again.
    await settle(admin);
    const items = admin.locator("[data-inbox-item]");
    await expect(items.first()).toBeVisible();
    const startUrl = admin.url();
    await items.first().focus();
    const started = Date.now();
    for (let i = 1; i <= 20; i += 1) {
      await admin.keyboard.press("a");
      await expect(
        admin.getByText(`${i} ${i === 1 ? "item" : "items"} handled this visit.`),
      ).toBeVisible();
    }
    const elapsed = Date.now() - started;
    expect(elapsed, `20 approvals took ${elapsed} ms`).toBeLessThan(60_000);
    expect(admin.url()).toBe(startUrl);

    // Every one of the 20 moved to the Owner's step, and none is left waiting on the Admin. Each key
    // press sends its decision at once and they run in parallel (A61), so the 20 are decided, not
    // just cleared from the list, within the same 60 seconds of the first press.
    await expect
      .poll(
        async () => {
          let atOwner = 0;
          for (const id of approvals.slice(1)) {
            const row = (await (
              await admin.request.get(`/api/v1/approval-instances/${id}`)
            ).json()) as {
              current_step: number;
            };
            if (row.current_step === 2) atOwner += 1;
          }
          return atOwner;
        },
        {
          timeout: Math.max(5_000, 60_000 - (Date.now() - started)),
          intervals: [500, 1_000, 2_000],
        },
      )
      .toBe(20);
    const decidedIn = Date.now() - started;
    expect(decidedIn, `20 approvals were decided in ${decidedIn} ms`).toBeLessThan(60_000);
  } finally {
    // Leave the demo tenant as it was, also after a failed step (A71): the requester withdraws every
    // approval this run opened. Left waiting, a failed run's approvals stood in the Admin's Inbox and in
    // the Owner's step of every later run.
    for (const approval of approvals) {
      await producer.request
        .post(`/api/v1/approval-instances/${approval}/cancel`, {
          data: { reason: "Journey 57 test data withdrawn." },
          headers: { Origin: base, "Idempotency-Key": `a36-withdraw-${approval}` },
        })
        .catch(() => undefined);
    }
  }
});
