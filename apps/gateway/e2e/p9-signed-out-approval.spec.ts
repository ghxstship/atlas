import { MailpitTransport } from "@xos/email";
import { dispatchEmail, notificationStore, type PlatformDb } from "@xos/platform";
import { expect as baseExpect, test, type Page } from "./engine-test";
import { PEOPLE, PROJECT, suffix, transition, vendorEngagement } from "./role-fixtures";
import { expectAccessible, sql } from "./support";

/**
 * P9 (RRR-223, gap G-31, ADR 0138; Section 7.5 invariant 8): an outside approver decides from the approval email
 * without signing in. The project's Pass rule names the vendor's engagement with "decide from email" on; a pass of its
 * category emails the vendor contact (no member of the org) an Approve and a Reject link that open signed out. The
 * page shows the org, the action and the masked address, and nothing about the pass; "Email me a code" sends a 6-digit
 * code; a wrong code says how many tries are left; the right code shows the request, and Approve approves it. Reopened,
 * the link says it was handled. A second run locks the link after five wrong codes. Every email goes through the
 * local stack's Mailpit inbox, never a real recipient.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

/** The local stack's Mailpit inbox (Supabase inbucket); block 569 by default, like the stack. */
const INBOX = process.env["E2E_INBUCKET_URL"] ?? "http://127.0.0.1:56924";
const VENDOR_EMAIL = "vendor@example.com";
const LINK = /href="([^"]*\/auth\/act\/xact_[0-9a-f]{48}\.[0-9a-f]{32})"/g;

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

/** The email worker sends what is queued into the local inbox, minting links and codes as it renders. */
async function sendEmail(baseURL: string): Promise<void> {
  await dispatchEmail(
    notificationStore(platformDb, {
      appUrl: "http://127.0.0.1:3006",
      gatewayUrl: baseURL,
      fromAddress: "notifications@xos.localhost",
      postalAddress: "100 Harbor Way, Miami, FL",
      unsubscribeUrl: async () => `${baseURL}/settings/notifications`,
      inboundDomain: null,
    }),
    new MailpitTransport(INBOX),
    500,
  );
}

interface Summary {
  readonly ID: string;
  readonly Subject: string;
  readonly Created: string;
}

/** The newest message to the vendor contact whose subject matches, sent at or after `since`. */
async function newestMessage(
  subject: RegExp,
  since: number,
): Promise<{ HTML: string; Text: string }> {
  let found: Summary | undefined;
  await expect
    .poll(async () => {
      const response = await fetch(
        `${INBOX}/api/v1/search?query=${encodeURIComponent(`to:${VENDOR_EMAIL}`)}`,
      );
      const body = (await response.json()) as { messages?: Summary[] };
      found = (body.messages ?? [])
        .filter((m) => subject.test(m.Subject) && Date.parse(m.Created) >= since - 5_000)
        .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0];
      return found?.ID ?? null;
    })
    .not.toBeNull();
  return (await (await fetch(`${INBOX}/api/v1/message/${found?.ID}`)).json()) as {
    HTML: string;
    Text: string;
  };
}

/**
 * A pass the project's Pass rule holds for the vendor's sign-off: a fresh vendor engagement, a credential category of
 * its own (so no other journey's passes are gated), an Active rule with one engagement step that decides from email,
 * and a pass of the category issued by the Owner.
 */
async function gatedPass() {
  const engagement = await vendorEngagement();
  const code = `P9${suffix()}`;
  const [category] = await sql<{ id: string }>(
    `insert into app.credential_categories (project_id, code, name) values ($1, $2, $3) returning id`,
    [PROJECT, code, `Vendor approved ${code}`],
    PEOPLE.owner,
  );
  const [rule] = await sql<{ id: string }>(
    `insert into app.approval_rules (project_id, subject, name, credential_category_id)
     values ($1, 'Pass', $2, $3) returning id`,
    [PROJECT, `Vendor sign-off ${code}`, category?.id],
    PEOPLE.owner,
  );
  await sql(
    `insert into app.approval_rule_steps (approval_rule_id, step_order, name, approver_engagement_id, signed_out_links)
     values ($1, 1, 'Vendor sign-off', $2, true)`,
    [rule?.id, engagement.id],
    PEOPLE.owner,
  );
  await sql(
    `select app.transition_approval_rule($1, 'Draft', 'Active', 'P9 journey')`,
    [rule?.id],
    PEOPLE.owner,
  );
  const [pass] = await sql<{ id: string; credential_number: string }>(
    `insert into app.credentials (credential_category_id, holder_person_id) values ($1, $2)
     returning id, credential_number`,
    [category?.id, PEOPLE.crew],
    PEOPLE.owner,
  );
  return {
    engagementId: engagement.id,
    ruleId: rule?.id as string,
    passId: pass?.id as string,
    number: pass?.credential_number as string,
  };
}

async function finish(gated: Awaited<ReturnType<typeof gatedPass>>): Promise<void> {
  await sql(
    `select app.transition_approval_rule($1, 'Active', 'Retired', 'P9 journey finished')`,
    [gated.ruleId],
    PEOPLE.owner,
  );
  await transition("engagement", gated.engagementId, "Onboarding", "Canceled", "Journey finished.");
}

/** The approval email's Approve and Reject links, in the order its buttons show (A127). */
async function approvalLinks(baseURL: string, number: string, since: number) {
  await sendEmail(baseURL);
  const email = await newestMessage(new RegExp(`${number}`), since);
  const links = [...email.HTML.matchAll(LINK)].map(
    (m) => new URL((m[1] ?? "").replaceAll("&amp;", "&")).pathname,
  );
  expect(links).toHaveLength(2);
  return { approve: links[0] as string, reject: links[1] as string };
}

/** Email me a code, then the code from the email the worker sends. */
async function requestCode(page: Page, baseURL: string): Promise<string> {
  const since = Date.now();
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByText("Code sent. It works for 10 minutes.")).toBeVisible();
  await sendEmail(baseURL);
  const email = await newestMessage(/^Your code to decide for /, since);
  const code = /\b(\d{6})\b/.exec(email.Text)?.[1];
  expect(code, "the 6-digit code in the email").toMatch(/^\d{6}$/);
  return code as string;
}

/** A code that is not the right one. */
function wrong(code: string): string {
  return String((Number(code) + 1) % 1_000_000).padStart(6, "0");
}

async function approvalState(passId: string): Promise<string | undefined> {
  const [row] = await sql<{ approval_state: string }>(
    `select approval_state::text from app.subject_approval_status where credential_id = $1`,
    [passId],
  );
  return row?.approval_state;
}

test("P9: an outside approver approves a pass from the email with a code, signed out", async ({
  page,
  baseURL,
}) => {
  const base = baseURL as string;
  const since = Date.now();
  const gated = await gatedPass();
  try {
    expect(await approvalState(gated.passId)).toBe("In Review");
    const { approve } = await approvalLinks(base, gated.number, since);

    // Signed out, the link shows what it does, for which org, and where the code goes; nothing about the pass.
    await page.goto(approve);
    await expect(page).toHaveURL(/\/auth\/act\//);
    await expect(
      page.getByRole("heading", { level: 1, name: "Approve this request from your email" }),
    ).toBeVisible();
    await expect(page.getByText("We email a 6-digit code to v***@example.com.")).toBeVisible();
    await expect(page.getByText(gated.number)).toHaveCount(0);
    await expectAccessible(page);

    const code = await requestCode(page, base);

    // A wrong code says how many tries are left before the link locks, and the approval stays undecided.
    const field = page.getByLabel("Code from your email");
    await field.fill(wrong(code));
    await page.getByRole("button", { name: "Show the request" }).click();
    await expect(
      page.getByText("That code is wrong or has expired. 4 tries left", { exact: false }),
    ).toBeVisible();
    expect(await approvalState(gated.passId)).toBe("In Review");

    // The right code shows the request and its step; Approve decides it.
    await field.fill(code);
    await page.getByRole("button", { name: "Show the request" }).click();
    await expect(
      page.getByRole("heading", { level: 2, name: new RegExp(gated.number) }),
    ).toBeVisible();
    await expect(page.getByText("Step: Vendor sign-off")).toBeVisible();
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText("Approved. Nothing else to do.")).toBeVisible();
    await expect.poll(() => approvalState(gated.passId)).toBe("Approved");
    const [decision] = await sql<{ decided_via: string; approver_person_id: string }>(
      `select d.decided_via::text, d.approver_person_id from app.subject_approval_decisions d
         join app.subject_approvals a on a.id = d.subject_approval_id where a.credential_id = $1`,
      [gated.passId],
    );
    expect(decision).toEqual({
      decided_via: "Email link",
      approver_person_id: PEOPLE.vendorContact,
    });

    // Reopened, the link says it was handled.
    await page.goto(approve);
    await expect(page.getByText("This was already handled. Nothing else to do.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Email me a code" })).toHaveCount(0);
  } finally {
    await finish(gated);
  }
});

test("P9: five wrong codes lock the link, even for the right code", async ({ page, baseURL }) => {
  const base = baseURL as string;
  const since = Date.now();
  const gated = await gatedPass();
  try {
    const { reject } = await approvalLinks(base, gated.number, since);
    await page.goto(reject);
    await expect(
      page.getByRole("heading", { level: 1, name: "Reject this request from your email" }),
    ).toBeVisible();
    const code = await requestCode(page, base);
    const field = page.getByLabel("Code from your email");
    for (let left = 4; left >= 1; left -= 1) {
      await field.fill(wrong(code));
      await page.getByRole("button", { name: "Show the request" }).click();
      await expect(
        page.getByText(`${left} ${left === 1 ? "try" : "tries"} left before the link locks`, {
          exact: false,
        }),
      ).toBeVisible();
    }
    await field.fill(wrong(code));
    await page.getByRole("button", { name: "Show the request" }).click();
    await expect(
      page.getByText("Too many wrong codes. This link is locked; sign in to decide."),
    ).toBeVisible();

    // Locked for both links of the email, whatever code comes next.
    await page.goto(reject);
    await expect(
      page.getByText("Too many wrong codes. This link is locked; sign in to decide."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Email me a code" })).toHaveCount(0);
    const [locked] = await sql<{ failed_attempts: number }>(
      `select max(t.failed_attempts)::int as failed_attempts from private.notification_action_tokens t
         join app.notifications n on n.id = t.notification_id
         join app.subject_approvals a on a.id = n.subject_id
        where a.credential_id = $1`,
      [gated.passId],
    );
    expect(locked?.failed_attempts).toBe(5);
    expect(await approvalState(gated.passId)).toBe("In Review");
  } finally {
    await finish(gated);
  }
});
