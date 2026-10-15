import { toDisplayKey } from "@xos/data/gateway-keys";
import { DEMO, sql, uniqueId } from "./support";

/**
 * Journey fixtures: what an org does in Atlas before a Gateway journey starts, written straight to
 * the local stack through the lifecycle engine Atlas uses (seed 0228's pattern), so every state move
 * lands in its ledger. Org ids derive from the parent rows.
 */

const DEMO_REQUISITION = "01920000-0000-7000-8000-000000228001";

function suffix(): string {
  return uniqueId().slice(-4).toUpperCase();
}

async function transitionOpportunity(
  id: string,
  from: string,
  to: string,
  note: string,
): Promise<void> {
  await sql(
    `select private.transition_lifecycle('opportunity', 'app.opportunities', 'opportunity_state', 'app.opportunity_state_transitions',
       'opportunity_id', $1::uuid, $2, $3, $4)`,
    [id, from, to, note],
    DEMO.owner,
  );
}

/**
 * A Crew posting from the demo requisition, published to the invited crew person; with a required
 * question unless `withQuestion` is false.
 */
export async function publishCrewOpportunity(
  withQuestion = true,
): Promise<{ id: string; key: string; title: string; question: string }> {
  const title = `Festival Truss Riggers ${suffix()}`;
  const question = "Which stages have you rigged?";
  const [row] = await sql<{ id: string }>(
    `insert into app.opportunities (project_id, requisition_id, role_type, role_code, title, description, visibility,
       rate_type, pay_min_minor, pay_max_minor, currency_code, starts_on, ends_on, deadline_at)
     values ($1, $2, 'Crew', '5000.51.02', $3, 'Truss riggers for the festival main stage. Own harness required.',
       'Invited', 'Day', 85000, 95000, 'USD', '2027-06-04', '2027-06-06', now() + interval '30 days')
     returning id`,
    [DEMO.project, DEMO_REQUISITION, title],
    DEMO.owner,
  );
  const id = row?.id as string;
  await sql(
    `insert into app.opportunity_positions (opportunity_id, label, call_at) values ($1, 'Truss Rigger', '2027-06-04T12:00:00Z')`,
    [id],
    DEMO.owner,
  );
  if (withQuestion) {
    await sql(
      `insert into app.opportunity_questions (opportunity_id, prompt, sort_order, is_required) values ($1, $2, 1, true)`,
      [id, question],
      DEMO.owner,
    );
  }
  await sql(
    `insert into app.opportunity_invitations (opportunity_id, person_id) values ($1, $2)`,
    [id, DEMO.crew],
    DEMO.owner,
  );
  await transitionOpportunity(id, "Draft", "Pending Approval", "Ready for approval.");
  await transitionOpportunity(
    id,
    "Pending Approval",
    "Published",
    "Approved for the invited crew.",
  );
  return { id, key: toDisplayKey("opportunity", id), title, question };
}

/** An agreement on the crew engagement, sent for signature. */
export async function sendCrewAgreement(): Promise<{ id: string; title: string }> {
  const title = `Crew Addendum ${suffix()}`;
  const [doc] = await sql<{ id: string }>(
    `insert into app.engagement_documents (engagement_id, document_kind, title) values ($1, 'Agreement', $2) returning id`,
    [DEMO.crewEngagement, title],
    DEMO.owner,
  );
  const id = doc?.id as string;
  await sql(
    `select private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state',
       'app.engagement_document_state_transitions', 'engagement_document_id', $1::uuid, 'Proposed', 'Sent', 'Sent for signature.')`,
    [id],
    DEMO.owner,
  );
  return { id, title };
}

/** A blocking document-upload onboarding step on the crew engagement. */
export async function addCrewOnboardingUpload(): Promise<{ name: string }> {
  const name = `Rigging Certificate ${suffix()}`;
  const [requirement] = await sql<{ id: string }>(
    `insert into app.onboarding_requirements (org_id, name, item_kind, role_type, verification_method, is_blocking)
     values ($1, $2, 'Document Upload', 'Crew', 'Reviewer', true) returning id`,
    [DEMO.org, name],
    DEMO.owner,
  );
  await sql(
    `insert into app.onboarding_items (engagement_id, onboarding_requirement_id) values ($1, $2)`,
    [DEMO.crewEngagement, requirement?.id],
    DEMO.owner,
  );
  // Retired at once so engagements created later (other journeys) do not pick the step up.
  await sql(
    `update app.onboarding_requirements set deleted_at = now() where id = $1`,
    [requirement?.id],
    DEMO.owner,
  );
  return { name };
}

/**
 * A vendor engagement for the demo vendor contact, walked to Complete, with the org's rating of the
 * vendor; the rating releases once the vendor rates back (Section 4.4.3).
 */
export async function completeVendorEngagement(): Promise<{
  id: string;
  key: string;
  comment: string;
}> {
  const comment = `Clean load-out and on budget ${suffix()}.`;
  const [row] = await sql<{ id: string }>(
    `insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification, pay_basis,
       arrangement, start_date, end_date)
     values ($1, $2, '01920000-0000-7000-8000-000000228801', 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate',
       'Per Engagement', '2027-02-10', '2027-02-12')
     returning id`,
    [DEMO.project, DEMO.vendorContact],
    DEMO.owner,
  );
  const id = row?.id as string;
  for (const [from, to] of [
    ["Onboarding", "Active"],
    ["Active", "Closing"],
    ["Closing", "Complete"],
  ] as const) {
    await sql(
      `select private.transition_lifecycle('engagement', 'app.engagements', 'engagement_state', 'app.engagement_state_transitions',
         'engagement_id', $1::uuid, $2, $3, 'Moved by the journey fixture.')`,
      [id, from, to],
      DEMO.owner,
    );
  }
  await sql(
    `insert into app.ratings (engagement_id, rater_side, score, comment) values ($1, 'Organization', 4, $2)`,
    [id, comment],
    DEMO.owner,
  );
  return { id, key: toDisplayKey("engagement", id), comment };
}

/** A Sent agreement on the crew engagement and a signing link for the crew person's email. */
export async function issueSigningLink(): Promise<{ token: string; code: string; title: string }> {
  const { id, title } = await sendCrewAgreement();
  const [issued] = await sql<{ token: string; access_code: string }>(
    `select token, access_code from app.issue_engagement_document_token($1, 'crew@example.com')`,
    [id],
    DEMO.owner,
  );
  return { token: issued?.token as string, code: issued?.access_code as string, title };
}

/** A sent advance packet with two sections for the crew person, and its advance link. */
export async function issueAdvanceLink(): Promise<{ token: string; code: string; title: string }> {
  const title = `Rigging Advance ${suffix()}`;
  const [packet] = await sql<{ id: string }>(
    `insert into app.advance_packets (project_id, title, due_at) values ($1, $2, now() + interval '20 days') returning id`,
    [DEMO.project, title],
    DEMO.owner,
  );
  const packetId = packet?.id as string;
  await sql(
    `insert into app.advance_sections (advance_packet_id, position, title, prompt) values
       ($1, 1, 'Equipment', 'What rigging equipment will you bring?'),
       ($1, 2, 'Arrival', 'When will you arrive on site?')`,
    [packetId],
    DEMO.owner,
  );
  const [recipient] = await sql<{ id: string }>(
    `insert into app.advance_recipients (advance_packet_id, person_id) values ($1, $2) returning id`,
    [packetId, DEMO.crew],
    DEMO.owner,
  );
  await sql(`select app.send_advance_packet($1)`, [packetId], DEMO.owner);
  const [issued] = await sql<{ token: string; access_code: string }>(
    `select token, access_code from app.issue_advance_token($1, 'crew@example.com')`,
    [recipient?.id],
    DEMO.owner,
  );
  return { token: issued?.token as string, code: issued?.access_code as string, title };
}
