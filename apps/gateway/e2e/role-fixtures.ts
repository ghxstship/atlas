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

/** Seed 1080's people and accounts for the role journeys. */
export const ROLE_PEOPLE = {
  agency: "01920000-0000-7000-8000-000010800101",
  staffOne: "01920000-0000-7000-8000-000010800102",
  staffTwo: "01920000-0000-7000-8000-000010800103",
  contractor: "01920000-0000-7000-8000-000010800104",
  artist: "01920000-0000-7000-8000-000010800105",
  agent: "01920000-0000-7000-8000-000010800106",
  client: "01920000-0000-7000-8000-000010800107",
  sponsor: "01920000-0000-7000-8000-000010800108",
} as const;

export const ROLE_ACCOUNTS = {
  agency: "01920000-0000-7000-8000-000010800301",
  studio: "01920000-0000-7000-8000-000010800302",
  talent: "01920000-0000-7000-8000-000010800303",
  client: "01920000-0000-7000-8000-000010800304",
  sponsor: "01920000-0000-7000-8000-000010800305",
} as const;

/**
 * An engagement on the demo project for one of seed 1080's external parties, in Onboarding, with
 * the party's account as counterparty when it has one.
 */
export async function roleEngagement(input: {
  person: string;
  account?: string | null;
  roleType: "Client" | "Contractor" | "Staff" | "Artist" | "Sponsor";
  roleCode?: string;
  workerClassification?: string;
  payBasis?: string | null;
  rateMinor?: number | null;
  applicationId?: string | null;
}): Promise<EngagementFixture> {
  const [row] = await sql<{ id: string }>(
    `insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification,
       pay_basis, arrangement, agreed_rate_minor, currency_code, start_date, end_date, application_id)
     values ($1, $2,
       (select c.id from app.counterparties c where c.org_id = $3 and c.organization_id = $4 and c.deleted_at is null limit 1),
       $5, $6, $7, $8, 'Per Engagement', $9, 'USD', '2027-06-04', '2027-06-06', $10)
     returning id`,
    [
      PROJECT,
      input.person,
      DEMO.org,
      input.account ?? null,
      input.roleType,
      input.roleCode ?? (input.roleType === "Artist" ? "2000.50.02" : "5000.51.02"),
      input.workerClassification ?? "INDEPENDENT_CONTRACTOR",
      input.payBasis === undefined ? "Day Rate" : input.payBasis,
      input.rateMinor ?? null,
      input.applicationId ?? null,
    ],
    PEOPLE.owner,
  );
  const id = row?.id as string;
  return { id, key: toDisplayKey("engagement", id) };
}

/**
 * A priced change order on the demo project's working budget (seed 0115), with its client-facing
 * purpose and an internal comment thread the client must never see, sent to the client engagement
 * for approval (journey 46).
 */
export async function changeOrderForClient(
  engagementId: string,
): Promise<{ id: string; title: string; internal: string }> {
  const title = `Add a VIP riser ${suffix()}`;
  const internal = `Internal: margin 34 percent on the riser hire ${suffix()}`;
  const [co] = await sql<{ id: string }>(
    `insert into app.change_orders (project_id, budget_id, title, order_type_enum_id, reason)
     values ($1, '01920000-0000-7000-8000-000000115022', $2, 'ENM-092', 'The client asked for a VIP riser at the lawn.')
     returning id`,
    [PROJECT, title],
    PEOPLE.owner,
  );
  const id = co?.id as string;
  const [thread] = await sql<{ id: string }>(
    `insert into app.comment_threads (org_id, subject_table, subject_id) values ($1, 'app.change_orders', $2) returning id`,
    [DEMO.org, id],
    PEOPLE.owner,
  );
  await sql(
    `insert into app.comments (org_id, comment_thread_id, author_person_id, body) values ($1, $2, $3, $4)`,
    [DEMO.org, thread?.id, PEOPLE.owner, internal],
    PEOPLE.owner,
  );
  await sql(
    `insert into app.change_order_lines (change_order_id, description, urid, quantity, unit_price_minor)
     values ($1, 'VIP riser, 16 ft x 24 ft, carpeted.', '4000.01.01', 1, 640000)`,
    [id],
    PEOPLE.owner,
  );
  await asPerson(
    PEOPLE.owner,
    `select app.price_change_order($1, 'Priced from the staging quote.')`,
    [id],
  );
  await asPerson(
    PEOPLE.owner,
    `select app.request_client_approval($1, $2, null, 'Please approve the VIP riser for opening night.')`,
    [engagementId, id],
  );
  return { id, title, internal };
}

/**
 * A Draft Contractor opportunity with no pay range, made from an Approved contractor requisition
 * on the demo project (journey 44): scoped work, a lighting design package. A remote posting falls
 * under the pay transparency rules that ship with the platform and cover remote roles (1125).
 */
export async function draftContractorOpportunity(
  options: { readonly remote?: boolean } = {},
): Promise<{ id: string; title: string }> {
  const title = `Lighting Design Package ${suffix()}`;
  const [req] = await sql<{ id: string }>(
    `insert into app.requisitions (project_id, role_type, role_code, worker_classification, pay_basis, arrangement,
       headcount, rate_minor, currency_code, starts_on, ends_on, justification, requested_by)
     values ($1, 'Contractor', '9000.50.03', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', 1, 120000, 'USD',
       '2027-05-01', '2027-06-06', 'Lighting design for the summer series, delivered in two milestones.', $2)
     returning id`,
    [PROJECT, PEOPLE.owner],
    PEOPLE.owner,
  );
  await transition(
    "requisition",
    req?.id as string,
    "Proposed",
    "Approved",
    "Within the design budget.",
  );
  const [opp] = await sql<{ id: string }>(
    `insert into app.opportunities (project_id, requisition_id, role_type, role_code, title, description, visibility,
       rate_type, currency_code, starts_on, ends_on, deadline_at, is_remote)
     values ($1, $2, 'Contractor', '9000.50.03', $3, 'Lighting plot and cue design in two milestones.', 'Invited',
       'Milestone', 'USD', '2027-05-01', '2027-06-06', now() + interval '30 days', $4)
     returning id`,
    [PROJECT, req?.id, title, options.remote === true],
    PEOPLE.owner,
  );
  return { id: opp?.id as string, title };
}

/** A milestone deliverable on the contractor engagement, with the file the contractor delivers. */
export async function contractorMilestone(
  engagementId: string,
  title: string,
): Promise<{ id: string; file: string }> {
  const [record] = await sql<{ id: string }>(
    `insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
     values ($1, 'Task', 'Execute', $2, 'Y', 'Declared') returning id`,
    [PROJECT, title],
    PEOPLE.owner,
  );
  const [deliverable] = await asPerson<{ id: string }>(
    PEOPLE.owner,
    `select app.add_engagement_deliverable($1, $2) as id`,
    [engagementId, record?.id],
  );
  const file = `${title} drawings`;
  const [doc] = await sql<{ id: string }>(
    `insert into app.documents (org_id, project_id, title) values ($1, $2, $3) returning id`,
    [DEMO.org, PROJECT, file],
    PEOPLE.owner,
  );
  await sql(
    `insert into app.engagement_documents (engagement_id, document_kind, title, document_id)
     values ($1, 'Statement of Work', $2, $3)`,
    [engagementId, file, doc?.id],
    PEOPLE.owner,
  );
  return { id: deliverable?.id as string, file };
}

/**
 * A Staff opportunity published from an Approved staff requisition, with a posted pay range,
 * invited to the demo staffing agency (journey 42).
 */
export async function publishStaffOpportunity(): Promise<{
  id: string;
  key: string;
  title: string;
}> {
  const title = `Event Staff Ushers ${suffix()}`;
  const [req] = await sql<{ id: string }>(
    `insert into app.requisitions (project_id, role_type, role_code, worker_classification, pay_basis, arrangement,
       headcount, rate_minor, currency_code, starts_on, ends_on, justification, requested_by)
     values ($1, 'Staff', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', 2, 30000, 'USD',
       '2027-06-04', '2027-06-06', 'Two ushers for the main gates on show days.', $2)
     returning id`,
    [PROJECT, PEOPLE.owner],
    PEOPLE.owner,
  );
  await transition(
    "requisition",
    req?.id as string,
    "Proposed",
    "Approved",
    "Within the staffing budget.",
  );
  const [opp] = await sql<{ id: string }>(
    `insert into app.opportunities (project_id, requisition_id, role_type, role_code, title, description, visibility,
       rate_type, pay_min_minor, pay_max_minor, currency_code, starts_on, ends_on, deadline_at)
     values ($1, $2, 'Staff', '5000.51.02', $3, 'Two ushers for the main gates, June 5 and 6.', 'Invited',
       'Day', 28000, 32000, 'USD', '2027-06-04', '2027-06-06', now() + interval '30 days')
     returning id`,
    [PROJECT, req?.id, title],
    PEOPLE.owner,
  );
  const id = opp?.id as string;
  await sql(
    `insert into app.opportunity_invitations (opportunity_id, organization_id) values ($1, $2)`,
    [id, ROLE_ACCOUNTS.agency],
    PEOPLE.owner,
  );
  await transition("opportunity", id, "Draft", "Pending Approval", "Ready for approval.");
  await transition("opportunity", id, "Pending Approval", "Published", "Approved for the agency.");
  return { id, key: toDisplayKey("opportunity", id), title };
}

/** The org shortlists an application and sends its offer (Pipeline in Atlas). */
export async function offerToApplication(
  opportunityId: string,
  terms: {
    rateType: string;
    amountMinor: number;
    starts: string;
    ends: string;
    message: string;
  } = {
    rateType: "Day",
    amountMinor: 30000,
    starts: "2027-06-04",
    ends: "2027-06-06",
    message: "Both ushers, both days.",
  },
): Promise<{ applicationId: string }> {
  const [app] = await sql<{ id: string }>(
    `select id from app.applications where opportunity_id = $1 and deleted_at is null`,
    [opportunityId],
  );
  const applicationId = app?.id as string;
  await transition("application", applicationId, "Submitted", "In Review", "Screening.");
  await transition(
    "application",
    applicationId,
    "In Review",
    "Shortlisted",
    "Strongest application.",
  );
  await asPerson(
    PEOPLE.owner,
    `select app.send_offer($1, $2::app.rate_type, $3, 'USD', $4::date, $5::date, $6, now() + interval '7 days')`,
    [applicationId, terms.rateType, terms.amountMinor, terms.starts, terms.ends, terms.message],
  );
  return { applicationId };
}

/**
 * A crew call published from the demo requisition (seed 0228) and invited to one person, with a
 * posted pay range and no question (journey 41).
 */
export async function publishCrewCall(
  personId: string,
): Promise<{ id: string; key: string; title: string }> {
  const title = `Festival Deck Crew ${suffix()}`;
  const [opp] = await sql<{ id: string }>(
    `insert into app.opportunities (project_id, requisition_id, role_type, role_code, title, description, visibility,
       rate_type, pay_min_minor, pay_max_minor, currency_code, starts_on, ends_on, deadline_at)
     values ($1, '01920000-0000-7000-8000-000000228001', 'Crew', '5000.51.02', $2, 'Deck crew for the main stage changeovers.',
       'Invited', 'Day', 85000, 95000, 'USD', '2027-06-04', '2027-06-06', now() + interval '30 days')
     returning id`,
    [PROJECT, title],
    PEOPLE.owner,
  );
  const id = opp?.id as string;
  await sql(
    `insert into app.opportunity_invitations (opportunity_id, person_id) values ($1, $2)`,
    [id, personId],
    PEOPLE.owner,
  );
  await transition("opportunity", id, "Draft", "Pending Approval", "Ready for approval.");
  await transition(
    "opportunity",
    id,
    "Pending Approval",
    "Published",
    "Approved for the invited crew.",
  );
  return { id, key: toDisplayKey("opportunity", id), title };
}

/** A published shift for the engagement, the crew person's call on show day. */
export async function publishedShift(engagementId: string): Promise<{ id: string }> {
  const [row] = await sql<{ id: string }>(
    `insert into app.shifts (project_id, engagement_id, role_code, starts_at, ends_at, time_zone)
     values ($1, $2, '5000.51.02', '2027-06-05T14:00:00Z', '2027-06-05T22:00:00Z', 'America/New_York') returning id`,
    [PROJECT, engagementId],
    PEOPLE.owner,
  );
  const id = row?.id as string;
  await transition("shift", id, "Draft", "Published", "Published to the crew.");
  return { id };
}

/**
 * The crew person's clock in and out on the shift (the Compass punches' server half, as the
 * person), and the timesheet for the show day the org opens for them.
 */
export async function workedShift(
  engagementId: string,
  shiftId: string,
  person: string,
): Promise<{ timesheetId: string }> {
  // app.record_punch is what Compass calls on a phone: In, then Out, as the person.
  for (const kind of ["In", "Out"] as const) {
    await asPerson(
      person,
      `select app.record_punch(gen_random_uuid(), $1, $2::app.punch_kind, now(), 0, $3, null, null, null, null,
         'Mobile', null, null, null, $4)`,
      [PROJECT, kind, shiftId, engagementId],
    );
  }
  // The punches land today, so the timesheet covers today: its approved day is what pay bills.
  const [ts] = await sql<{ id: string }>(
    `insert into app.timesheets (project_id, engagement_id, period_start, period_end)
     values ($1, $2, current_date, current_date) returning id`,
    [PROJECT, engagementId],
    PEOPLE.owner,
  );
  return { timesheetId: ts?.id as string };
}

/** A credential of the project's Production category for the engagement's person. */
export async function engagementCredential(
  engagementId: string,
  person: string,
): Promise<{ number: string }> {
  // The credential number comes from the project's sequence.
  const [row] = await sql<{ credential_number: string }>(
    `insert into app.credentials (credential_category_id, holder_person_id, valid_from, valid_to, project_id, engagement_id)
     values ('01920000-0000-7000-8000-000000114022', $1, '2027-06-01', '2027-06-07', $2, $3)
     returning credential_number`,
    [person, PROJECT, engagementId],
    PEOPLE.owner,
  );
  return { number: row?.credential_number as string };
}

/** An open call for artists on the demo project, invited to the demo artist (journey 45). */
export async function publishArtistCall(): Promise<{ id: string; key: string; title: string }> {
  const title = `Opening Night Support Set ${suffix()}`;
  const [opp] = await sql<{ id: string }>(
    `insert into app.opportunities (project_id, role_type, role_code, title, description, visibility, rate_type,
       currency_code, starts_on, ends_on, deadline_at)
     values ($1, 'Artist', '2000.50.02', $2, 'A 45-minute support set before the headliner. Send your EPK.', 'Invited',
       'Flat', 'USD', '2027-06-05', '2027-06-05', now() + interval '30 days')
     returning id`,
    [PROJECT, title],
    PEOPLE.owner,
  );
  const id = opp?.id as string;
  await sql(
    `insert into app.opportunity_invitations (opportunity_id, person_id) values ($1, $2)`,
    [id, ROLE_PEOPLE.artist],
    PEOPLE.owner,
  );
  await transition("opportunity", id, "Draft", "Pending Approval", "Ready for approval.");
  await transition(
    "opportunity",
    id,
    "Pending Approval",
    "Published",
    "Open call for the support slot.",
  );
  return { id, key: toDisplayKey("opportunity", id), title };
}

/** The artist's set: a seeded Opening Night cue linked to the engagement (Compass shows it). */
export async function artistSetCue(engagementId: string): Promise<{ label: string }> {
  const [cue] = await sql<{ id: string; label: string }>(
    `select c.id, c.label from app.cues c join app.run_of_show r on r.id = c.run_of_show_id
      where r.project_id = $1 and r.name = 'Opening Night Running Order' and c.deleted_at is null
      order by c.position limit 1`,
    [PROJECT],
  );
  await sql(`insert into app.engagement_cues (engagement_id, cue_id) values ($1, $2)`, [
    engagementId,
    cue?.id,
  ]);
  return { label: cue?.label as string };
}

/** A sent advance packet with one section, for the artist (journey 45). */
export async function artistAdvance(person: string): Promise<{ title: string; prompt: string }> {
  const title = `Support Set Advance ${suffix()}`;
  const prompt = "List your backline and stage plot needs.";
  const [packet] = await sql<{ id: string }>(
    `insert into app.advance_packets (project_id, title, due_at) values ($1, $2, now() + interval '20 days') returning id`,
    [PROJECT, title],
    PEOPLE.owner,
  );
  await sql(
    `insert into app.advance_sections (advance_packet_id, position, title, prompt) values ($1, 1, 'Backline', $2)`,
    [packet?.id, prompt],
    PEOPLE.owner,
  );
  await sql(`insert into app.advance_recipients (advance_packet_id, person_id) values ($1, $2)`, [
    packet?.id,
    person,
  ]);
  await sql(`select app.send_advance_packet($1)`, [packet?.id], PEOPLE.owner);
  return { title, prompt };
}

/** A settlement for the artist engagement: the Producer drafts it and the Owner submits it. */
export async function submittedSettlement(
  engagementId: string,
): Promise<{ id: string; title: string }> {
  const title = `Support Set Settlement ${suffix()}`;
  const [s] = await sql<{ id: string }>(
    `insert into app.settlements (engagement_id, project_id, title, currency_code, settled_on)
     values ($1, $2, $3, 'USD', '2027-06-05') returning id`,
    [engagementId, PROJECT, title],
    PEOPLE.producer,
  );
  const id = s?.id as string;
  await sql(
    `insert into app.settlement_lines (settlement_id, line_number, line_kind, description, amount_minor) values
       ($1, 1, 'Guarantee', 'Support set guarantee', 250000),
       ($1, 2, 'Expense', 'Backline rental reimbursement', 30000)`,
    [id],
    PEOPLE.producer,
  );
  await asPerson(PEOPLE.owner, `select app.submit_settlement($1, 'Settled after the show.')`, [id]);
  return { id, title };
}

/** A shift for an engagement on the demo project: the position the org assigns. */
export async function engagementShift(engagementId: string): Promise<void> {
  await sql(
    `insert into app.shifts (project_id, engagement_id, role_code, starts_at, ends_at, time_zone)
     values ($1, $2, '5000.51.02', '2027-06-05T16:00:00Z', '2027-06-06T00:00:00Z', 'America/New_York')`,
    [PROJECT, engagementId],
    PEOPLE.owner,
  );
}

/** A sponsor entitlement of the sponsor's package on the demo project (journey 47). */
export async function sponsorEntitlement(description: string): Promise<{ id: string }> {
  const [row] = await sql<{ id: string }>(
    `insert into app.sponsor_entitlements (project_id, counterparty_id, description, quantity, due_on)
     values ($1, (select c.id from app.counterparties c where c.org_id = $2 and c.organization_id = $3 and c.deleted_at is null limit 1),
       $4, 12, '2027-06-06') returning id`,
    [PROJECT, DEMO.org, ROLE_ACCOUNTS.sponsor, description],
    PEOPLE.owner,
  );
  return { id: row?.id as string };
}

/**
 * A sign-in with the shared demo password (seed 0010's local test value), for a person a journey
 * needs fresh on every run. Returns the person id the person trigger created.
 */
export async function newSignIn(email: string, fullName: string): Promise<string> {
  await sql(
    `with u as (
       insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
         raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token,
         email_change_token_new, email_change)
       values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', $1,
         extensions.crypt('xos-demo-2026', extensions.gen_salt('bf')), now(),
         '{"provider": "email", "providers": ["email"]}'::jsonb, jsonb_build_object('full_name', $2::text), now(), now(),
         '', '', '', '')
       returning id, email)
     insert into auth.identities (id, user_id, provider_id, provider, identity_data, created_at, updated_at)
     select u.id, u.id, u.id::text, 'email', jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       now(), now() from u`,
    [email, fullName],
  );
  // As seed 0010 does: the person takes the user's id while nothing references it yet, so session
  // claims (which carry the user id) name the person.
  const [person] = await sql<{ id: string }>(
    `update app.people p set id = p.user_id from auth.users u
      where u.id = p.user_id and u.email = $1 returning p.id`,
    [email],
  );
  return person?.id as string;
}

/**
 * Journey 60: a vendor company with an external account and history with the demo org, made the
 * way seed 1080 makes Demo Lighting Rentals: its Account Owner, a counterparty row in the demo
 * org, and a completed vendor engagement the org rated.
 */
export async function externalAccountWithHistory(): Promise<{
  email: string;
  accountId: string;
  name: string;
  slug: string;
  engagementId: string;
}> {
  const tag = suffix().toLowerCase();
  const email = `supplier-${tag}@example.com`;
  const name = `Demo Rigging Supply ${tag.toUpperCase()}`;
  const slug = `demo-rigging-${tag}`;
  const person = await newSignIn(email, `Demo Supplier ${tag.toUpperCase()}`);
  const [account] = await asPerson<{ id: string }>(
    person,
    `select app.create_external_account($1, $2, 'For-Profit') as id`,
    [name, slug],
  );
  const accountId = account?.id as string;
  const [cp] = await sql<{ id: string }>(
    `insert into app.counterparties (org_id, organization_id) values ($1, $2) returning id`,
    [DEMO.org, accountId],
    PEOPLE.owner,
  );
  const [eng] = await sql<{ id: string }>(
    `insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification,
       pay_basis, arrangement, start_date, end_date)
     values ($1, $2, $3, 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement', '2027-02-01', '2027-02-03')
     returning id`,
    [PROJECT, person, cp?.id],
    PEOPLE.owner,
  );
  const engagementId = eng?.id as string;
  for (const [from, to] of [
    ["Onboarding", "Active"],
    ["Active", "Closing"],
    ["Closing", "Complete"],
  ] as const) {
    await transition("engagement", engagementId, from, to);
  }
  await sql(
    `insert into app.ratings (engagement_id, rater_side, score, comment)
     values ($1, 'Organization', 5, 'Truss arrived early and every piece was inspected.')`,
    [engagementId],
    PEOPLE.owner,
  );
  return { email, accountId, name, slug, engagementId };
}
