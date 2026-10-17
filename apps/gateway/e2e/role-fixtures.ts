import { toDisplayKey } from "@xos/data/gateway-keys";
import pg from "pg";
import { DEMO, sql, uniqueId } from "./support";

/**
 * Fixtures for the external role journeys (Section 20.2, journeys 4 and 41 to 62; A38, RRR-82):
 * what the org does before or between a party's Gateway steps, written to the local stack through
 * the same lifecycle engine and RPCs Atlas calls, so every move lands in its ledger. People and
 * accounts come from the demo seed (0010) and A38's seed (1080_a38.sql). `asPerson` runs a call as
 * that person under the `authenticated` role, the way Compass and Gateway reach the database, so
 * row level security and the RPCs' own checks apply; it stands in for a device step (a Compass
 * scan) whose server half is what the journey can check.
 */

const databaseUrl =
  process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:56922/postgres";

/** People and accounts of the demo seed (0010) and A38's seed (1080_a38.sql). */
export const PEOPLE = {
  owner: DEMO.owner,
  admin: "01920000-0000-7000-8000-000000000102",
  producer: "01920000-0000-7000-8000-000000000103",
  field: "01920000-0000-7000-8000-000000000104",
  crew: DEMO.crew,
  vendorContact: DEMO.vendorContact,
} as const;

export const ACCOUNTS = {
  vendor: "01920000-0000-7000-8000-000000000301",
} as const;

/** The project of the demo engagements (seed 0107's NWS project, fixed id of 0000). */
export const PROJECT = DEMO.project;

export function suffix(): string {
  return uniqueId().slice(-4).toUpperCase();
}

/** One statement as `person` under the authenticated role; throws the database's refusal. */
export async function asPerson<T extends Record<string, unknown>>(
  person: string,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: person, role: "authenticated" }),
    ]);
    await client.query("set local role authenticated");
    const result = await client.query(text, params);
    await client.query("commit");
    return result.rows as T[];
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

/** A lifecycle move through private.transition_lifecycle, as the demo Owner. */
export async function transition(
  entity: string,
  id: string,
  from: string,
  to: string,
  note = "Moved by the journey fixture.",
): Promise<void> {
  const plural = entity.endsWith("y") ? `${entity.slice(0, -1)}ies` : `${entity}s`;
  const table = entity === "purchase_order" ? "purchase_orders" : plural;
  const column = entity === "purchase_order" ? "po_state" : `${entity}_state`;
  await sql(
    `select private.transition_lifecycle($1, $2, $3, $4, $5, $6::uuid, $7, $8, $9)`,
    [
      entity,
      `app.${table}`,
      column,
      `app.${entity}_state_transitions`,
      `${entity}_id`,
      id,
      from,
      to,
      note,
    ],
    PEOPLE.owner,
  );
}

/**
 * Blocking onboarding requirements for one role type. Blocking is judged against the live
 * requirements, so they stay until the journey calls `retire()` (in a `finally`), which keeps
 * engagements of later journeys free of them.
 */
export async function requirements(
  roleType: string,
  list: readonly { name: string; kind: string }[],
): Promise<{ retire: () => Promise<void> }> {
  const ids: string[] = [];
  for (const r of list) {
    const [row] = await sql<{ id: string }>(
      `insert into app.onboarding_requirements (org_id, name, item_kind, role_type, verification_method, is_blocking)
       values ($1, $2, $3, $4, 'Reviewer', true) returning id`,
      [DEMO.org, r.name, r.kind, roleType],
      PEOPLE.owner,
    );
    ids.push(row?.id as string);
  }
  return {
    retire: async () => {
      if (ids.length === 0) return;
      await sql(`update app.onboarding_requirements set deleted_at = now() where id = any($1)`, [
        ids,
      ]);
    },
  };
}

export interface EngagementFixture {
  readonly id: string;
  readonly key: string;
}

/**
 * A vendor engagement for the demo vendor contact on the demo project, in Onboarding; its packet
 * holds the live Vendor requirements. The counterparty comes from seed 0228's vendor engagement,
 * because an earlier seed may hold the vendor's counterparty under another id.
 */
export async function vendorEngagement(): Promise<EngagementFixture> {
  const [row] = await sql<{ id: string }>(
    `insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification,
       pay_basis, arrangement, start_date, end_date)
     select $1, $2, e.counterparty_id, 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement',
       '2027-06-04', '2027-06-06'
     from app.engagements e where e.id = $3
     returning id`,
    [PROJECT, PEOPLE.vendorContact, DEMO.vendorEngagement],
    PEOPLE.owner,
  );
  const id = row?.id as string;
  return { id, key: toDisplayKey("engagement", id) };
}

/** The demo vendor's vendor row in the demo org (procurement's view of the same company). */
export async function demoVendorId(): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `select v.id from app.vendors v join app.counterparties c on c.id = v.counterparty_id
      where c.organization_id = $1 and v.org_id = $2 and v.deleted_at is null limit 1`,
    [ACCOUNTS.vendor, DEMO.org],
  );
  return row?.id as string;
}

/** A purchase order to the demo vendor with one priced line, approved and sent (journey 4). */
export async function sentPurchaseOrder(): Promise<{ id: string; number: number }> {
  const vendor = await demoVendorId();
  const [po] = await sql<{ id: string; po_number: string }>(
    `insert into app.purchase_orders (project_id, vendor_id, currency_code) values ($1, $2, 'USD')
     returning id, po_number::text`,
    [PROJECT, vendor],
    PEOPLE.owner,
  );
  const id = po?.id as string;
  await sql(
    `insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor)
     values ($1, 1, 'Delay tower line array, per show day', 2, 380000)`,
    [id],
    PEOPLE.owner,
  );
  await transition(
    "purchase_order",
    id,
    "Proposed",
    "Approved",
    "Approved within spend authority.",
  );
  await transition("purchase_order", id, "Approved", "Sent", "Sent to the vendor.");
  return { id, number: Number(po?.po_number) };
}

/** A current certificate of insurance on file for the demo vendor; the policy number is unique. */
export async function vendorCertificate(): Promise<{ policy: string }> {
  const policy = `GL-${suffix()}-2027`;
  await sql(
    `insert into app.insurance_certificates (vendor_id, insurer, policy_identifier, coverage_type, coverage_limit_minor,
       currency_code, valid_from, valid_to)
     values ($1, 'Atlantic Mutual', $2, 'General Liability', 200000000, 'USD', current_date - 30, current_date + 335)`,
    [await demoVendorId(), policy],
    PEOPLE.owner,
  );
  return { policy };
}

/**
 * A two-hour dock slot on the demo project's loading dock (seed 0111 zone) for the vendor
 * engagement, an hour after the dock's last slot, since slots at one dock never overlap.
 */
export async function vendorDockSlot(engagementId: string): Promise<{ id: string }> {
  const [row] = await sql<{ id: string }>(
    `with free as (
       select greatest(coalesce(max(ends_at), now()), now()) + interval '1 hour' as at
       from app.dock_slots where zone_id = '01920000-0000-7000-8000-000000111011' and deleted_at is null)
     insert into app.dock_slots (project_id, zone_id, engagement_id, starts_at, ends_at)
     select $1, '01920000-0000-7000-8000-000000111011', $2, free.at, free.at + interval '2 hours' from free
     returning id`,
    [PROJECT, engagementId],
    PEOPLE.owner,
  );
  return { id: row?.id as string };
}

/** An engagement document of `kind`, sent to the engaged party for signature. */
export async function sentDocument(
  engagementId: string,
  kind: string,
  title: string,
): Promise<{ id: string }> {
  const [doc] = await sql<{ id: string }>(
    `insert into app.engagement_documents (engagement_id, document_kind, title) values ($1, $2, $3) returning id`,
    [engagementId, kind, title],
    PEOPLE.owner,
  );
  const id = doc?.id as string;
  await transition("engagement_document", id, "Proposed", "Sent", "Sent for signature.");
  return { id };
}

/** The invoice the party submitted on an engagement's project, by its own number. */
export async function invoiceByNumber(number: string): Promise<{ id: string; state: string }> {
  const [row] = await sql<{ id: string; invoice_state: string }>(
    `select id, invoice_state::text from app.invoices where invoice_number = $1 and deleted_at is null`,
    [number],
  );
  return { id: row?.id as string, state: row?.invoice_state as string };
}

/**
 * Finance codes each line of a submitted payable invoice to a budget line of its project and
 * approves it under spend authority (Atlas Finance, Invoices; app.approve_invoice as the Owner).
 */
export async function codeAndApproveInvoice(invoiceId: string): Promise<void> {
  await sql(
    `update app.invoice_lines l set budget_line_id = (
       select bl.id from app.budget_lines bl join app.budgets b on b.id = bl.budget_id
        join app.invoices i on i.project_id = b.project_id
        where i.id = $1 and bl.deleted_at is null order by bl.line_number limit 1)
     where l.invoice_id = $1 and l.deleted_at is null`,
    [invoiceId],
    PEOPLE.owner,
  );
  await asPerson(PEOPLE.owner, `select app.approve_invoice($1, 'Delivered as ordered.')`, [
    invoiceId,
  ]);
}

/**
 * The org pays an approved payable invoice in full: an approved payment applied to it (Finance's
 * step in Atlas; Payments records it from the bank file).
 */
export async function payInvoice(invoiceId: string): Promise<void> {
  const [inv] = await sql<{ counterparty_id: string; total: string; currency_code: string }>(
    `select i.counterparty_id, (t.subtotal_minor + coalesce(t.tax_minor, 0))::text as total, i.currency_code
       from app.invoices i join app.invoice_totals t on t.invoice_id = i.id where i.id = $1`,
    [invoiceId],
  );
  const [payment] = await sql<{ id: string }>(
    `insert into app.payments (counterparty_id, direction, amount_minor, currency_code, paid_on, reference_identifier)
     values ($1, 'Payable', $2, $3, current_date, $4) returning id`,
    [inv?.counterparty_id, Number(inv?.total), inv?.currency_code, `ACH-${suffix()}`],
    PEOPLE.owner,
  );
  const id = payment?.id as string;
  await sql(
    `insert into app.payment_applications (payment_id, invoice_id, amount_minor) values ($1, $2, $3)`,
    [id, invoiceId, Number(inv?.total)],
    PEOPLE.owner,
  );
  await transition("payment", id, "Proposed", "Approved", "Paid by ACH.");
}
