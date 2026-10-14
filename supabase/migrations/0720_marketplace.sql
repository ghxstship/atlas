-- 0720_marketplace.sql
-- A28 Engagements and Marketplace. The opportunity marketplace and applications (Section 4.4.3, Section 4.4.4
-- stages 2 to 5, Section 14.9):
--   * talent and vendor pools with Preferred, Approved and the internal Do Not Engage flag (reason and review
--     date required, never visible externally)
--   * opportunities with opportunity_state and its ledger, positions, requirements, questions and invitations,
--     visibility Invited, Pool, Network or Public
--   * pay transparency rules by jurisdiction: publishing is refused without a pay range where one is required
--   * saved searches, opportunity alerts, listing reports and moderation actions (notice and action)
--   * applications with application_state and its ledger, answers, sealed bids and bid lines, agency slates,
--     shortlists and interviews
-- Publishing checks live in a trigger on the state column, so no path publishes around them. Bids stay sealed
-- until the opportunity deadline; only procurement.bid.unseal reads them early (Section 8.7). External users
-- browse opportunities through api_external (0750); the app tables carry internal policies and the
-- applicant's own rows.

-- Enums and lifecycle rules ----------------------------------------------------------------------------------

create type app.opportunity_state as enum ('Draft', 'Pending Approval', 'Published', 'Paused', 'Filled', 'Closed', 'Canceled');
comment on type app.opportunity_state is 'Opportunity lifecycle (Section 4.4.4). Publishing passes through Pending Approval.';

create type app.opportunity_visibility as enum ('Invited', 'Pool', 'Network', 'Public');
comment on type app.opportunity_visibility is 'Who can see an opportunity (Section 4.4.3): named invitees, pool members, anyone who completed an engagement with the org, or the whole marketplace (Pro plan and above).';

create type app.rate_type as enum ('Hourly', 'Day', 'Flat', 'Milestone', 'Bid');
comment on type app.rate_type is 'How an opportunity''s compensation is stated (Section 4.4.3). NULL compensation shows Rate on Request, never zero.';

create type app.opportunity_requirement_kind as enum ('Certification', 'Insurance', 'Equipment');
comment on type app.opportunity_requirement_kind is 'Kinds of opportunity requirement (Section 4.4.3).';

create type app.pool_kind as enum ('Talent', 'Vendor');
comment on type app.pool_kind is 'Talent pools hold people; vendor pools hold external accounts.';

create type app.pool_standing as enum ('Preferred', 'Approved', 'Do Not Engage');
comment on type app.pool_standing is 'Standing of a pool member (Section 4.4.3). Do Not Engage is internal, needs a reason and a review date, and is never visible externally.';

create type app.application_state as enum ('Submitted', 'In Review', 'Shortlisted', 'Offered', 'Accepted', 'Declined', 'Withdrawn', 'Not Selected');
comment on type app.application_state is 'Application lifecycle (Section 4.4.4). The applicant withdraws, accepts or declines; the org reviews, shortlists, offers or does not select.';

create type app.listing_report_reason as enum ('Illegal Content', 'Discrimination', 'Fraud', 'Misleading Information', 'Missing Pay Range', 'Safety');
comment on type app.listing_report_reason is 'Grounds for reporting a listing (Section 4.4.3 abuse, EU Digital Services Act notice and action).';

create type app.moderation_action_kind as enum ('Removed', 'Restricted', 'Restored', 'No Action');
comment on type app.moderation_action_kind is 'Outcome of a moderation decision; each carries a statement of reasons to the affected party.';

create type app.interview_kind as enum ('Interview', 'Audition');
comment on type app.interview_kind is 'Selection meeting kinds (Section 4.4.4 stage 4).';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('opportunity', 'Draft', 'Pending Approval'),
  ('opportunity', 'Draft', 'Canceled'),
  ('opportunity', 'Pending Approval', 'Draft'),
  ('opportunity', 'Pending Approval', 'Published'),
  ('opportunity', 'Pending Approval', 'Canceled'),
  ('opportunity', 'Published', 'Paused'),
  ('opportunity', 'Published', 'Filled'),
  ('opportunity', 'Published', 'Closed'),
  ('opportunity', 'Published', 'Canceled'),
  ('opportunity', 'Paused', 'Published'),
  ('opportunity', 'Paused', 'Closed'),
  ('opportunity', 'Paused', 'Canceled'),
  ('opportunity', 'Filled', 'Published'),
  ('opportunity', 'Filled', 'Closed'),
  ('application', 'Submitted', 'In Review'),
  ('application', 'Submitted', 'Withdrawn'),
  ('application', 'Submitted', 'Not Selected'),
  ('application', 'In Review', 'Shortlisted'),
  ('application', 'In Review', 'Offered'),
  ('application', 'In Review', 'Not Selected'),
  ('application', 'In Review', 'Withdrawn'),
  ('application', 'Shortlisted', 'Offered'),
  ('application', 'Shortlisted', 'Not Selected'),
  ('application', 'Shortlisted', 'Withdrawn'),
  ('application', 'Offered', 'Accepted'),
  ('application', 'Offered', 'Declined'),
  ('application', 'Offered', 'Withdrawn');

insert into private.domain_event_types (code, subject, description) values
  ('opportunity.state_changed', 'opportunities', 'An opportunity moved to another opportunity state, for example Published.'),
  ('application.submitted', 'applications', 'An application, bid, EPK or agency slate was submitted.'),
  ('application.state_changed', 'applications', 'An application moved to another application state.'),
  ('listing.reported', 'listing_reports', 'A listing was reported for review.'),
  ('listing.moderated', 'moderation_actions', 'A moderation decision was recorded with its statement of reasons.');

-- Pay transparency rules -------------------------------------------------------------------------------------

create table private.pay_transparency_rules (
  jurisdiction_id text primary key references xpms.jurisdiction (jurisdiction_id),
  requires_pay_range boolean not null,
  effective_from date not null,
  citation text not null,
  constraint pay_transparency_rules_citation_length check (char_length(btrim(citation)) between 1 and 300)
);

comment on table private.pay_transparency_rules is 'Where a posted pay range is legally required (Section 4.4.3, Section 14.9). A rule applies to its jurisdiction and every jurisdiction beneath it. Rows are legal reference data maintained by the platform; canon jurisdictions must exist first.';
comment on column private.pay_transparency_rules.jurisdiction_id is 'Canon jurisdiction the rule covers, with every jurisdiction beneath it.';
comment on column private.pay_transparency_rules.requires_pay_range is 'True when postings for work there must state a pay range.';
comment on column private.pay_transparency_rules.effective_from is 'First day the rule applies.';
comment on column private.pay_transparency_rules.citation is 'The law or regulation, for example a statute section.';

alter table private.pay_transparency_rules enable row level security;
revoke all on private.pay_transparency_rules from public, anon, authenticated;
grant all on private.pay_transparency_rules to service_role;

create view app.pay_transparency_rules as
select r.jurisdiction_id, r.requires_pay_range, r.effective_from, r.citation from private.pay_transparency_rules r;
call private.describe('app.pay_transparency_rules', 'Pay transparency rules by jurisdiction: where an opportunity cannot be published without a pay range.', array[
  'jurisdiction_id', 'Jurisdiction covered, with those beneath it.',
  'requires_pay_range', 'True when a pay range is required.',
  'effective_from', 'First day the rule applies.',
  'citation', 'The law or regulation.']);
revoke all on app.pay_transparency_rules from public, anon;
grant select on app.pay_transparency_rules to authenticated, service_role;

create or replace function private.pay_range_required(p_jurisdiction_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with recursive chain as (
    select j.jurisdiction_id, j.parent from xpms.jurisdiction j where j.jurisdiction_id = p_jurisdiction_id
    union all
    select j.jurisdiction_id, j.parent from xpms.jurisdiction j join chain c on j.jurisdiction_id = c.parent
  )
  select coalesce(bool_or(r.requires_pay_range), false)
  from chain c join private.pay_transparency_rules r on r.jurisdiction_id = c.jurisdiction_id
  where r.effective_from <= current_date;
$$;

comment on function private.pay_range_required(text) is 'True when a pay transparency rule in force anywhere up the jurisdiction chain requires a posted pay range.';

-- Pools ------------------------------------------------------------------------------------------------------

create table app.talent_pools (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  pool_kind app.pool_kind not null,
  deleted_at timestamptz,
  constraint talent_pools_name_length check (char_length(btrim(name)) between 1 and 200)
);

create unique index talent_pools_org_name_key on app.talent_pools (org_id, lower(name)) where deleted_at is null;

call private.install_domain_table('app.talent_pools');
call private.describe('app.talent_pools', 'An org''s talent and vendor pools (Section 4.4.3). Internal only: no part of a pool is visible externally.', array[
  'name', 'Pool name, unique in the org ignoring case.',
  'pool_kind', 'Talent (people) or Vendor (external accounts).'
]);

create table app.pool_members (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  talent_pool_id uuid not null references app.talent_pools (id),
  person_id uuid references app.people (id),
  organization_id uuid references app.organizations (id),
  standing app.pool_standing not null,
  reason text,
  review_on date,
  deleted_at timestamptz,
  constraint pool_members_one_party check (num_nonnulls(person_id, organization_id) = 1),
  constraint pool_members_dne_reason check (standing <> 'Do Not Engage' or (reason is not null and review_on is not null)),
  constraint pool_members_reason_length check (reason is null or char_length(btrim(reason)) between 1 and 1000)
);

create index pool_members_pool_idx on app.pool_members (talent_pool_id);
create index pool_members_person_id_idx on app.pool_members (person_id);
create index pool_members_organization_id_idx on app.pool_members (organization_id);
create unique index pool_members_person_key on app.pool_members (talent_pool_id, person_id) where person_id is not null and deleted_at is null;
create unique index pool_members_organization_key on app.pool_members (talent_pool_id, organization_id) where organization_id is not null and deleted_at is null;

call private.install_domain_table('app.pool_members', 'app.talent_pools', 'talent_pool_id');
call private.describe('app.pool_members', 'People and external accounts in a pool with their standing (Section 4.4.3). A Do Not Engage flag needs a reason and a review date and never reaches any external surface. Pool members may see Pool opportunities early.', array[
  'talent_pool_id', 'Pool.',
  'person_id', 'Person in a talent pool.',
  'organization_id', 'External account in a vendor pool.',
  'standing', 'Preferred, Approved or Do Not Engage.',
  'reason', 'Why the standing was set; required for Do Not Engage. Internal.',
  'review_on', 'When the standing is reviewed; required for Do Not Engage.'
]);

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.pool_members', 'standing', 'Confidential', null),
  ('app.pool_members', 'reason', 'Confidential', null);

-- Opportunities ------------------------------------------------------------------------------------------------

create table app.opportunities (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  scope_node_id uuid references app.scope_nodes (id),
  role_type app.external_role_type not null,
  role_code text references xpms.role (role_code),
  cat_urid text references xpms.dim_category (cat_urid),
  title text not null,
  description text,
  venue_id uuid references app.venues (id),
  jurisdiction_id text references xpms.jurisdiction (jurisdiction_id),
  starts_on date,
  ends_on date,
  visibility app.opportunity_visibility not null default 'Invited',
  rate_type app.rate_type,
  pay_min_minor bigint,
  pay_max_minor bigint,
  currency_code char(3) references private.currencies (currency_code),
  deadline_at timestamptz,
  minimum_age smallint,
  opportunity_state app.opportunity_state not null default 'Draft',
  deleted_at timestamptz,
  constraint opportunities_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint opportunities_description_length check (description is null or char_length(description) <= 10000),
  constraint opportunities_dates check (ends_on is null or starts_on is null or ends_on >= starts_on),
  constraint opportunities_pay_order check (pay_min_minor is null or pay_max_minor is null or pay_min_minor <= pay_max_minor),
  constraint opportunities_pay_nonnegative check ((pay_min_minor is null or pay_min_minor >= 0) and (pay_max_minor is null or pay_max_minor >= 0)),
  constraint opportunities_pay_needs_terms check ((pay_min_minor is null and pay_max_minor is null) or (currency_code is not null and rate_type is not null and rate_type <> 'Bid')),
  constraint opportunities_minimum_age check (minimum_age is null or minimum_age between 16 and 99)
);

create index opportunities_project_id_idx on app.opportunities (project_id);
create index opportunities_scope_node_id_idx on app.opportunities (scope_node_id);
create index opportunities_role_code_idx on app.opportunities (role_code);
create index opportunities_cat_urid_idx on app.opportunities (cat_urid);
create index opportunities_venue_id_idx on app.opportunities (venue_id);
create index opportunities_jurisdiction_id_idx on app.opportunities (jurisdiction_id);
create index opportunities_currency_code_idx on app.opportunities (currency_code);
create index opportunities_state_idx on app.opportunities (opportunity_state, visibility);

call private.install_domain_table('app.opportunities', 'app.projects', 'project_id',
  array['app.scope_nodes', 'scope_node_id', 'app.venues', 'venue_id']);
call private.describe('app.opportunities', 'Opportunities published to external parties (Section 4.4.3): staffing calls, RFQs and RFPs, talent bookings, contractor scopes and sponsorship packages. The number of positions is the count of its positions. No posted compensation shows Rate on Request, never zero.', array[
  'project_id', 'Project the work is for.',
  'scope_node_id', 'Scope node of the project the work is for.',
  'role_type', 'External role type sought.',
  'role_code', 'Canon role code sought, when the opportunity is for a role.',
  'cat_urid', 'Canon URID category sought, when the opportunity is for goods or services.',
  'title', 'Title, Title Case.',
  'description', 'Description of the work.',
  'venue_id', 'Venue of the work.',
  'jurisdiction_id', 'Jurisdiction of the work when it differs from the venue''s and the project''s; pay transparency reads the first known of the three.',
  'starts_on', 'First day of the work.',
  'ends_on', 'Last day of the work.',
  'visibility', 'Invited, Pool, Network or Public.',
  'rate_type', 'Hourly, Day, Flat, Milestone or Bid; NULL is Rate on Request.',
  'pay_min_minor', 'Lower end of the posted pay range in minor units; NULL when not posted.',
  'pay_max_minor', 'Upper end of the posted pay range in minor units; NULL when not posted.',
  'currency_code', 'ISO 4217 currency of the posted pay.',
  'deadline_at', 'Deadline for applications and bids. Bids stay sealed until it passes.',
  'minimum_age', 'Minimum age for the work, 16 or older (Section 14.9).',
  'opportunity_state', 'Opportunity state. Changes only through app.transition_opportunity.'
]);

call private.install_lifecycle('app.opportunities', 'opportunity_id', 'opportunity_state', 'opportunity', 'Draft',
  $$opportunity_id in (select o.id from app.opportunities o where o.project_id in (select private.project_ids_with('opportunities.posting.read')))$$);

create trigger t90_emit_opportunity_state after insert on app.opportunity_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('opportunity.state_changed', 'opportunities', 'opportunity_id', 'from_state', 'to_state');

create table app.opportunity_positions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  opportunity_id uuid not null references app.opportunities (id),
  label text not null,
  call_at timestamptz,
  ends_at timestamptz,
  deleted_at timestamptz,
  constraint opportunity_positions_label_length check (char_length(btrim(label)) between 1 and 200),
  constraint opportunity_positions_times check (ends_at is null or call_at is null or ends_at > call_at)
);

create index opportunity_positions_opportunity_id_idx on app.opportunity_positions (opportunity_id);

call private.install_domain_table('app.opportunity_positions', 'app.opportunities', 'opportunity_id');
call private.describe('app.opportunity_positions', 'Positions an opportunity fills, one row each, with call times.', array[
  'opportunity_id', 'Opportunity.',
  'label', 'Position label, for example Rigger 2.',
  'call_at', 'Call time.',
  'ends_at', 'When the position''s work ends.'
]);

create table app.opportunity_requirements (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  opportunity_id uuid not null references app.opportunities (id),
  requirement_kind app.opportunity_requirement_kind not null,
  description text not null,
  certification_id uuid references app.certifications (id),
  insurance_minimum_minor bigint,
  currency_code char(3) references private.currencies (currency_code),
  deleted_at timestamptz,
  constraint opportunity_requirements_description_length check (char_length(btrim(description)) between 1 and 500),
  constraint opportunity_requirements_certification check ((requirement_kind = 'Certification') = (certification_id is not null)),
  constraint opportunity_requirements_insurance check (
    (requirement_kind = 'Insurance') = (insurance_minimum_minor is not null)
    and (insurance_minimum_minor is null) = (currency_code is null)
    and (insurance_minimum_minor is null or insurance_minimum_minor >= 0))
);

create index opportunity_requirements_opportunity_id_idx on app.opportunity_requirements (opportunity_id);
create index opportunity_requirements_certification_id_idx on app.opportunity_requirements (certification_id);
create index opportunity_requirements_currency_code_idx on app.opportunity_requirements (currency_code);

call private.install_domain_table('app.opportunity_requirements', 'app.opportunities', 'opportunity_id', array['app.certifications', 'certification_id']);
call private.describe('app.opportunity_requirements', 'Requirements of an opportunity (Section 4.4.3): certifications, insurance minimums and equipment.', array[
  'opportunity_id', 'Opportunity.',
  'requirement_kind', 'Certification, Insurance or Equipment.',
  'description', 'What is required.',
  'certification_id', 'Certification required; Certification requirements only.',
  'insurance_minimum_minor', 'Minimum insurance coverage in minor units; Insurance requirements only.',
  'currency_code', 'ISO 4217 currency of the insurance minimum.'
]);

create table app.opportunity_questions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  opportunity_id uuid not null references app.opportunities (id),
  prompt text not null,
  sort_order integer not null,
  is_required boolean not null default false,
  deleted_at timestamptz,
  constraint opportunity_questions_prompt_length check (char_length(btrim(prompt)) between 1 and 500)
);

create index opportunity_questions_opportunity_id_idx on app.opportunity_questions (opportunity_id, sort_order);

call private.install_domain_table('app.opportunity_questions', 'app.opportunities', 'opportunity_id');
call private.describe('app.opportunity_questions', 'Application questions of an opportunity. Questions never ask for protected attributes (Section 14.9).', array[
  'opportunity_id', 'Opportunity.',
  'prompt', 'Question text.',
  'sort_order', 'Display order.',
  'is_required', 'True when an answer is required.'
]);

create table app.opportunity_invitations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  opportunity_id uuid not null references app.opportunities (id),
  person_id uuid references app.people (id),
  organization_id uuid references app.organizations (id),
  deleted_at timestamptz,
  constraint opportunity_invitations_one_party check (num_nonnulls(person_id, organization_id) = 1)
);

create index opportunity_invitations_opportunity_id_idx on app.opportunity_invitations (opportunity_id);
create index opportunity_invitations_person_id_idx on app.opportunity_invitations (person_id);
create index opportunity_invitations_organization_id_idx on app.opportunity_invitations (organization_id);

call private.install_domain_table('app.opportunity_invitations', 'app.opportunities', 'opportunity_id');
call private.describe('app.opportunity_invitations', 'Named people and external accounts invited to an opportunity; for Invited visibility they are the only ones who see it.', array[
  'opportunity_id', 'Opportunity.',
  'person_id', 'Invited person.',
  'organization_id', 'Invited external account.'
]);

-- Moderation -----------------------------------------------------------------------------------------------------

create table app.listing_reports (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  opportunity_id uuid not null references app.opportunities (id),
  reporter_person_id uuid not null references app.people (id),
  reason app.listing_report_reason not null,
  details text,
  reported_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint listing_reports_details_length check (details is null or char_length(btrim(details)) between 1 and 4000)
);

create index listing_reports_opportunity_id_idx on app.listing_reports (opportunity_id);
create index listing_reports_reporter_person_id_idx on app.listing_reports (reporter_person_id);

call private.install_domain_table('app.listing_reports', 'app.opportunities', 'opportunity_id');
call private.describe('app.listing_reports', 'Reports of a listing by anyone who can see it (Section 4.4.3 abuse). The platform decides each under notice and action.', array[
  'opportunity_id', 'Reported opportunity.',
  'reporter_person_id', 'Person who reported, set from the session.',
  'reason', 'Ground for the report.',
  'details', 'What the reporter saw.',
  'reported_at', 'When the report was made, set by the database.'
]);

create table app.moderation_actions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  opportunity_id uuid not null references app.opportunities (id),
  listing_report_id uuid references app.listing_reports (id),
  action app.moderation_action_kind not null,
  statement_of_reasons text not null,
  decided_at timestamptz not null default now(),
  constraint moderation_actions_reasons_length check (char_length(btrim(statement_of_reasons)) between 1 and 4000)
);

create index moderation_actions_opportunity_id_idx on app.moderation_actions (opportunity_id, decided_at);
create index moderation_actions_listing_report_id_idx on app.moderation_actions (listing_report_id);

call private.install_domain_table('app.moderation_actions', 'app.opportunities', 'opportunity_id', array['app.listing_reports', 'listing_report_id'], true);
call private.describe('app.moderation_actions', 'Append-only moderation decisions on a listing with the statement of reasons sent to the affected party (EU Digital Services Act). Written only by the platform. The latest decision rules: Removed hides the listing and refuses applications until Restored.', array[
  'opportunity_id', 'Opportunity decided on.',
  'listing_report_id', 'Report that prompted the decision, when one did.',
  'action', 'Removed, Restricted, Restored or No Action.',
  'statement_of_reasons', 'Statement of reasons sent to the affected party.',
  'decided_at', 'When the decision was made.'
]);

create or replace function private.opportunity_removed(p_opportunity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select m.action in ('Removed', 'Restricted') from app.moderation_actions m
    where m.opportunity_id = p_opportunity_id and m.action <> 'No Action'
    order by m.decided_at desc, m.id desc limit 1), false);
$$;

comment on function private.opportunity_removed(uuid) is 'True when the latest moderation decision on an opportunity removed or restricted it.';

-- Saved searches and alerts ----------------------------------------------------------------------------------------

create table app.saved_searches (
  id uuid primary key default private.uuid_v7(),
  org_id uuid references app.organizations (id),
  person_id uuid not null references app.people (id),
  name text not null,
  role_type app.external_role_type,
  role_code text references xpms.role (role_code),
  cat_urid text references xpms.dim_category (cat_urid),
  jurisdiction_id text references xpms.jurisdiction (jurisdiction_id),
  starts_after date,
  ends_before date,
  min_rate_minor bigint,
  currency_code char(3) references private.currencies (currency_code),
  alerts_enabled boolean not null default true,
  deleted_at timestamptz,
  constraint saved_searches_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint saved_searches_rate check ((min_rate_minor is null) = (currency_code is null) and (min_rate_minor is null or min_rate_minor >= 0))
);

create index saved_searches_person_id_idx on app.saved_searches (person_id);
create index saved_searches_role_code_idx on app.saved_searches (role_code);
create index saved_searches_cat_urid_idx on app.saved_searches (cat_urid);
create index saved_searches_jurisdiction_id_idx on app.saved_searches (jurisdiction_id);
create index saved_searches_currency_code_idx on app.saved_searches (currency_code);

call private.install_domain_table('app.saved_searches');
call private.describe('app.saved_searches', 'A Gateway user''s saved marketplace search (Section 4.4.3 discovery); alerts go out by email and push. Owned by the person, not by an org.', array[
  'org_id', 'The org whose white-label Gateway the search is limited to (Section 4.4.7); NULL searches the whole marketplace.',
  'person_id', 'Person who saved the search.',
  'name', 'Search name.',
  'role_type', 'External role type filter.',
  'role_code', 'Canon role filter.',
  'cat_urid', 'Canon URID category filter.',
  'jurisdiction_id', 'Jurisdiction filter, including those beneath it.',
  'starts_after', 'Earliest start date.',
  'ends_before', 'Latest end date.',
  'min_rate_minor', 'Minimum posted pay in minor units.',
  'currency_code', 'Currency of the minimum pay.',
  'alerts_enabled', 'True when matches send alerts.'
]);

create table app.opportunity_alerts (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  saved_search_id uuid not null references app.saved_searches (id),
  opportunity_id uuid not null references app.opportunities (id),
  matched_at timestamptz not null default now(),
  delivered_at timestamptz,
  deleted_at timestamptz
);

create index opportunity_alerts_saved_search_id_idx on app.opportunity_alerts (saved_search_id);
create index opportunity_alerts_opportunity_id_idx on app.opportunity_alerts (opportunity_id);
create unique index opportunity_alerts_pair_key on app.opportunity_alerts (saved_search_id, opportunity_id) where deleted_at is null;

call private.install_domain_table('app.opportunity_alerts', 'app.opportunities', 'opportunity_id');
call private.describe('app.opportunity_alerts', 'Matches of a saved search to a published opportunity, written by the platform matcher; delivery is A18''s notification service.', array[
  'org_id', 'Org of the matched opportunity, derived from it.',
  'saved_search_id', 'Saved search that matched.',
  'opportunity_id', 'Matched opportunity.',
  'matched_at', 'When the match was found.',
  'delivered_at', 'When the alert was delivered.'
]);

-- Applications --------------------------------------------------------------------------------------------------------

create table app.applications (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  opportunity_id uuid not null references app.opportunities (id),
  applicant_person_id uuid references app.people (id),
  applicant_organization_id uuid references app.organizations (id),
  submitted_by uuid references app.people (id),
  profile_share_id uuid references app.profile_shares (id),
  availability_confirmed boolean not null default false,
  cover_note text,
  proposed_fee_minor bigint,
  currency_code char(3) references private.currencies (currency_code),
  application_state app.application_state not null default 'Submitted',
  deleted_at timestamptz,
  constraint applications_one_applicant check (num_nonnulls(applicant_person_id, applicant_organization_id) = 1),
  constraint applications_fee check ((proposed_fee_minor is null) = (currency_code is null) and (proposed_fee_minor is null or proposed_fee_minor >= 0)),
  constraint applications_cover_note_length check (cover_note is null or char_length(cover_note) <= 4000)
);

create index applications_opportunity_id_idx on app.applications (opportunity_id);
create index applications_applicant_person_id_idx on app.applications (applicant_person_id);
create index applications_applicant_organization_id_idx on app.applications (applicant_organization_id);
create index applications_submitted_by_idx on app.applications (submitted_by);
create index applications_profile_share_id_idx on app.applications (profile_share_id);
create index applications_currency_code_idx on app.applications (currency_code);
create unique index applications_person_key on app.applications (opportunity_id, applicant_person_id) where applicant_person_id is not null and deleted_at is null;
create unique index applications_organization_key on app.applications (opportunity_id, applicant_organization_id) where applicant_organization_id is not null and deleted_at is null;

call private.install_domain_table('app.applications', 'app.opportunities', 'opportunity_id', array['app.profile_shares', 'profile_share_id']);
call private.describe('app.applications', 'An application to an opportunity by a person (applying for themselves or through their representative) or an external account (a bid or an agency slate) (Section 4.4.3). Applications never ask for protected attributes (Section 14.9).', array[
  'opportunity_id', 'Opportunity applied to.',
  'applicant_person_id', 'Applying person.',
  'applicant_organization_id', 'Applying external account.',
  'submitted_by', 'Person who submitted, set from the session: the applicant, their representative or an account administrator.',
  'profile_share_id', 'Consent snapshot of profile fields shared with the org.',
  'availability_confirmed', 'True when the applicant confirmed availability for the dates.',
  'cover_note', 'Note from the applicant.',
  'proposed_fee_minor', 'Fee the applicant proposes instead of the posted one, in minor units (artists).',
  'currency_code', 'ISO 4217 currency of the proposed fee.',
  'application_state', 'Application state. Changes only through app.transition_application.'
]);

create or replace function private.my_application_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.id from app.applications a
  where a.deleted_at is null
    and (a.applicant_person_id = private.current_person_id()
      or a.applicant_organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))
      or (a.applicant_person_id is not null and private.represents(a.applicant_person_id, 'Offers')));
$$;

comment on function private.my_application_ids() is 'Applications the signed-in person holds on the applicant side: their own, their account''s as Account Owner or Admin, or a represented artist''s with the Offers scope.';

call private.install_lifecycle('app.applications', 'application_id', 'application_state', 'application', 'Submitted',
  $$application_id in (select a.id from app.applications a where a.opportunity_id in (select o.id from app.opportunities o where o.project_id in (select private.project_ids_with('opportunities.application.read'))))
    or application_id in (select private.my_application_ids())$$);

create trigger t90_emit_application_submitted after insert on app.applications
  for each row execute function private.emit_row_event('application.submitted', '-', 'opportunity_id');
create trigger t90_emit_application_state after insert on app.application_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('application.state_changed', 'applications', 'application_id', 'from_state', 'to_state');

create table app.application_answers (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  application_id uuid not null references app.applications (id),
  opportunity_question_id uuid not null references app.opportunity_questions (id),
  answer_text text not null,
  deleted_at timestamptz,
  constraint application_answers_length check (char_length(btrim(answer_text)) between 1 and 4000)
);

create index application_answers_application_id_idx on app.application_answers (application_id);
create index application_answers_question_idx on app.application_answers (opportunity_question_id);
create unique index application_answers_key on app.application_answers (application_id, opportunity_question_id) where deleted_at is null;

call private.install_domain_table('app.application_answers', 'app.applications', 'application_id', array['app.opportunity_questions', 'opportunity_question_id']);
call private.describe('app.application_answers', 'Answers to an opportunity''s questions, one per question per application.', array[
  'application_id', 'Application.',
  'opportunity_question_id', 'Question answered, of the same opportunity.',
  'answer_text', 'Answer.'
]);

create table app.bids (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  application_id uuid not null references app.applications (id),
  currency_code char(3) not null references private.currencies (currency_code),
  valid_until date,
  submitted_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index bids_application_key on app.bids (application_id) where deleted_at is null;
create index bids_currency_code_idx on app.bids (currency_code);

call private.install_domain_table('app.bids', 'app.applications', 'application_id');
call private.describe('app.bids', 'A vendor''s sealed line-item bid on a Bid opportunity, one per application (Section 4.4.3). Sealed until the opportunity deadline: the bidder reads only their own; the org reads it after the deadline, or earlier only with procurement.bid.unseal (Section 8.7).', array[
  'application_id', 'Application of the bidding external account.',
  'currency_code', 'ISO 4217 currency of every line.',
  'valid_until', 'Last day the bid holds.',
  'submitted_at', 'When the bid was submitted, set by the database.'
]);

create table app.bid_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  bid_id uuid not null references app.bids (id),
  description text not null,
  element_id text references xpms.elements (element_id),
  quantity numeric not null default 1,
  unit_price_minor bigint,
  deleted_at timestamptz,
  constraint bid_lines_description_length check (char_length(btrim(description)) between 1 and 500),
  constraint bid_lines_quantity_positive check (quantity > 0),
  constraint bid_lines_price_nonnegative check (unit_price_minor is null or unit_price_minor >= 0)
);

create index bid_lines_bid_id_idx on app.bid_lines (bid_id);
create index bid_lines_element_id_idx on app.bid_lines (element_id);

call private.install_domain_table('app.bid_lines', 'app.bids', 'bid_id');
call private.describe('app.bid_lines', 'Lines of a sealed bid. A NULL price is a line the vendor did not price; totals are derived and NULL-aware.', array[
  'bid_id', 'Bid.',
  'description', 'What is bid.',
  'element_id', 'Catalog element bid, when one applies.',
  'quantity', 'Quantity bid.',
  'unit_price_minor', 'Unit price in minor units of the bid currency; NULL when not priced.'
]);

create table app.agency_slates (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  application_id uuid not null references app.applications (id),
  person_id uuid not null references app.people (id),
  opportunity_position_id uuid references app.opportunity_positions (id),
  deleted_at timestamptz
);

create index agency_slates_application_id_idx on app.agency_slates (application_id);
create index agency_slates_person_id_idx on app.agency_slates (person_id);
create index agency_slates_position_idx on app.agency_slates (opportunity_position_id);
create unique index agency_slates_key on app.agency_slates (application_id, person_id) where deleted_at is null;

call private.install_domain_table('app.agency_slates', 'app.applications', 'application_id', array['app.opportunity_positions', 'opportunity_position_id']);
call private.describe('app.agency_slates', 'Named staff a staffing agency puts forward on its application, one row each (Section 4.4.3). Each must be a member of the agency''s account.', array[
  'application_id', 'Agency application.',
  'person_id', 'Named staff member.',
  'opportunity_position_id', 'Position the staff member is put forward for, when named.'
]);

create table app.shortlists (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  opportunity_id uuid not null references app.opportunities (id),
  application_id uuid not null references app.applications (id),
  rank integer not null,
  note text,
  deleted_at timestamptz,
  constraint shortlists_rank_positive check (rank > 0),
  constraint shortlists_note_length check (note is null or char_length(btrim(note)) between 1 and 2000)
);

create index shortlists_opportunity_id_idx on app.shortlists (opportunity_id, rank);
create index shortlists_application_id_idx on app.shortlists (application_id);
create unique index shortlists_application_key on app.shortlists (application_id) where deleted_at is null;

call private.install_domain_table('app.shortlists', 'app.opportunities', 'opportunity_id', array['app.applications', 'application_id']);
call private.describe('app.shortlists', 'The org''s ranked shortlist of applications for an opportunity, with internal notes (Section 4.4.4 selection). Internal only.', array[
  'opportunity_id', 'Opportunity.',
  'application_id', 'Shortlisted application of the same opportunity.',
  'rank', 'Rank, 1 first.',
  'note', 'Internal selection note. Never visible externally.'
]);

create table app.interviews (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  application_id uuid not null references app.applications (id),
  interview_kind app.interview_kind not null,
  scheduled_at timestamptz not null,
  duration_minutes integer not null,
  location_text text,
  internal_note text,
  deleted_at timestamptz,
  constraint interviews_duration check (duration_minutes between 5 and 480),
  constraint interviews_location_length check (location_text is null or char_length(btrim(location_text)) between 1 and 500),
  constraint interviews_note_length check (internal_note is null or char_length(btrim(internal_note)) between 1 and 4000)
);

create index interviews_application_id_idx on app.interviews (application_id);

call private.install_domain_table('app.interviews', 'app.applications', 'application_id');
call private.describe('app.interviews', 'Interviews and auditions of an applicant (Section 4.4.4 selection). The applicant sees the time and place through api_external; the internal note never leaves the org.', array[
  'application_id', 'Application.',
  'interview_kind', 'Interview or Audition.',
  'scheduled_at', 'Start time.',
  'duration_minutes', 'Length in minutes.',
  'location_text', 'Place or meeting link.',
  'internal_note', 'Internal note. Never visible externally.'
]);

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.shortlists', 'note', 'Confidential', null),
  ('app.interviews', 'internal_note', 'Confidential', null);

-- Engagements record the application they came from ---------------------------------------------------------------

alter table app.engagements add column application_id uuid references app.applications (id);
create index engagements_application_id_idx on app.engagements (application_id);
comment on column app.engagements.application_id is 'Accepted application the engagement came from (Section 4.4.4 stage 5), when it came from the marketplace.';
grant select (application_id), insert (application_id) on app.engagements to authenticated;

-- Visibility helpers -------------------------------------------------------------------------------------------------

create or replace function private.excluded_from_org(p_org_id uuid, p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.pool_members pm
    where pm.org_id = p_org_id and pm.deleted_at is null and pm.standing = 'Do Not Engage'
      and (pm.person_id = p_person_id
        or pm.organization_id in (
          select m.org_id from app.account_memberships m
          where m.person_id = p_person_id and m.deleted_at is null
            and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())))
  );
$$;

comment on function private.excluded_from_org(uuid, uuid) is 'True when the org has flagged the person, or an account they belong to, Do Not Engage. Used only to withhold; never projected.';

create or replace function private.person_account_ids(p_person_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.org_id from app.account_memberships m
  where m.person_id = p_person_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now());
$$;

comment on function private.person_account_ids(uuid) is 'External accounts a person actively belongs to.';

create or replace function private.opportunity_open_to_person(
  p_opportunity_id uuid,
  p_org_id uuid,
  p_visibility app.opportunity_visibility,
  p_state app.opportunity_state,
  p_person_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_person_id is null or p_state <> 'Published' or private.opportunity_removed(p_opportunity_id)
     or private.excluded_from_org(p_org_id, p_person_id) then
    return false;
  end if;
  if p_visibility = 'Public' then
    return true;
  end if;
  if exists (
    select 1 from app.opportunity_invitations i
    where i.opportunity_id = p_opportunity_id and i.deleted_at is null
      and (i.person_id = p_person_id or i.organization_id in (select private.person_account_ids(p_person_id)))) then
    return true;
  end if;
  if p_visibility = 'Pool' and exists (
    select 1 from app.pool_members pm
    where pm.org_id = p_org_id and pm.deleted_at is null and pm.standing in ('Preferred', 'Approved')
      and (pm.person_id = p_person_id or pm.organization_id in (select private.person_account_ids(p_person_id)))) then
    return true;
  end if;
  if p_visibility = 'Network' and exists (
    select 1 from app.engagements e left join app.counterparties c on c.id = e.counterparty_id
    where e.org_id = p_org_id and e.deleted_at is null and e.engagement_state = 'Complete'
      and (e.person_id = p_person_id or c.organization_id in (select private.person_account_ids(p_person_id)))) then
    return true;
  end if;
  return false;
end;
$$;

comment on function private.opportunity_open_to_person(uuid, uuid, app.opportunity_visibility, app.opportunity_state, uuid) is 'Section 4.4.3 visibility for a person: Published, not removed by moderation, not withheld by a Do Not Engage flag on the person or an account they belong to, and Public, or invited by name (the person or one of their accounts, at any visibility level), or in a pool of the org for Pool, or with a completed engagement with the org for Network. Takes the opportunity''s column values.';

create or replace function private.opportunity_open_to(
  p_opportunity_id uuid,
  p_org_id uuid,
  p_visibility app.opportunity_visibility,
  p_state app.opportunity_state
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.opportunity_open_to_person(p_opportunity_id, p_org_id, p_visibility, p_state, private.current_person_id());
$$;

comment on function private.opportunity_open_to(uuid, uuid, app.opportunity_visibility, app.opportunity_state) is 'Section 4.4.3 visibility for the signed-in person (private.opportunity_open_to_person).';

create or replace function private.visible_opportunity_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select o.id from app.opportunities o
  where o.deleted_at is null and private.opportunity_open_to(o.id, o.org_id, o.visibility, o.opportunity_state);
$$;

comment on function private.visible_opportunity_ids() is 'Opportunities open to the signed-in person in the marketplace.';

create or replace function private.bid_readable_by_org(p_application_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.applications a join app.opportunities o on o.id = a.opportunity_id
    where a.id = p_application_id
      and (private.can_on_project(o.project_id, 'procurement.bid.unseal')
        or (o.deadline_at is not null and o.deadline_at <= now() and private.can_on_project(o.project_id, 'procurement.bid.read')))
  );
$$;

comment on function private.bid_readable_by_org(uuid) is 'Sealed bids (Section 8.7): true when the signed-in member may read the bid on this application: after the opportunity deadline with procurement.bid.read on the project, or at any time with procurement.bid.unseal.';

create or replace function private.readable_bid_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select b.id from app.bids b
  where b.deleted_at is null
    and (b.application_id in (select private.my_application_ids()) or private.bid_readable_by_org(b.application_id));
$$;

comment on function private.readable_bid_ids() is 'Bids the signed-in person may read: their own side''s, or the org''s once unsealed for them.';

create or replace function private.my_saved_search_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id from app.saved_searches s where s.person_id = private.current_person_id() and s.deleted_at is null;
$$;

comment on function private.my_saved_search_ids() is 'Saved searches of the signed-in person.';

-- Guards ---------------------------------------------------------------------------------------------------------------

create or replace function private.guard_opportunity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jurisdiction text;
begin
  if tg_op = 'UPDATE' and (new.project_id <> old.project_id or new.role_type <> old.role_type) then
    perform private.refuse('opportunity_immutable', 'An opportunity keeps its project and role type.');
  end if;
  if tg_op = 'UPDATE' and old.opportunity_state not in ('Draft', 'Pending Approval') and new.opportunity_state = old.opportunity_state
     and (new.pay_min_minor is distinct from old.pay_min_minor or new.pay_max_minor is distinct from old.pay_max_minor
          or new.rate_type is distinct from old.rate_type or new.currency_code is distinct from old.currency_code
          or new.visibility <> old.visibility or new.deadline_at is distinct from old.deadline_at) then
    perform private.refuse('opportunity_published_terms', 'Compensation, visibility and deadline are fixed once published; pause, close and post a new opportunity.');
  end if;
  if new.opportunity_state = 'Published' and (tg_op = 'INSERT' or old.opportunity_state <> 'Published') then
    select coalesce(new.jurisdiction_id, v.jurisdiction_id, p.jurisdiction_id) into v_jurisdiction
    from app.projects p left join app.venues v on v.id = coalesce(new.venue_id, p.venue_id)
    where p.id = new.project_id;
    if v_jurisdiction is null then
      perform private.refuse('opportunity_jurisdiction_unknown', 'An opportunity needs a known jurisdiction before it is published, so pay transparency can be checked.');
    end if;
    if new.role_type in ('Contractor', 'Crew', 'Staff') and private.pay_range_required(v_jurisdiction)
       and (new.pay_min_minor is null or new.pay_max_minor is null) then
      perform private.refuse('pay_range_required', format('A pay range is required to publish work in %s.', v_jurisdiction));
    end if;
    if new.visibility = 'Public' and not private.org_has_feature(new.org_id, 'public_marketplace_listings') then
      perform private.refuse('plan_feature_unavailable', 'Public marketplace listings need the Pro plan or above.');
    end if;
    if new.rate_type = 'Bid' and new.deadline_at is null then
      perform private.refuse('bid_deadline_required', 'A bid opportunity needs a deadline; bids stay sealed until it passes.');
    end if;
    if private.opportunity_removed(new.id) then
      perform private.refuse('opportunity_removed', 'A removed listing cannot be published until moderation restores it.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_opportunity() is 'Opportunities: project and role type fixed; compensation, visibility and deadline fixed once published; publishing refuses an unknown jurisdiction, a missing pay range on a Contractor, Crew or Staff posting where a pay transparency rule requires one, Public visibility below the Pro plan, a bid opportunity without a deadline and a removed listing.';

create trigger t44_guard_opportunity before insert or update on app.opportunities
  for each row execute function private.guard_opportunity();

create or replace function private.guard_pool_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind app.pool_kind := (select p.pool_kind from app.talent_pools p where p.id = new.talent_pool_id);
begin
  if (v_kind = 'Talent') <> (new.person_id is not null) then
    perform private.refuse('pool_member_kind', 'Talent pools hold people; vendor pools hold external accounts.');
  end if;
  if new.organization_id = new.org_id then
    perform private.refuse('pool_member_own_org', 'An org does not pool itself.');
  end if;
  if tg_op = 'UPDATE' and (new.talent_pool_id <> old.talent_pool_id or new.person_id is distinct from old.person_id
      or new.organization_id is distinct from old.organization_id) then
    perform private.refuse('pool_member_immutable', 'A pool membership keeps its pool and party.');
  end if;
  return new;
end;
$$;

comment on function private.guard_pool_member() is 'Pool members match the pool kind, are never the org itself and keep their pool and party.';

create trigger t40_guard_pool_member before insert or update on app.pool_members
  for each row execute function private.guard_pool_member();

create or replace function private.guard_application()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_opp app.opportunities;
begin
  if tg_op = 'UPDATE' then
    if new.opportunity_id <> old.opportunity_id or new.applicant_person_id is distinct from old.applicant_person_id
       or new.applicant_organization_id is distinct from old.applicant_organization_id or new.submitted_by is distinct from old.submitted_by then
      perform private.refuse('application_immutable', 'An application keeps its opportunity and applicant.');
    end if;
    return new;
  end if;
  select * into v_opp from app.opportunities o where o.id = new.opportunity_id;
  new.submitted_by := v_me;
  if auth.uid() is null then
    return new;
  end if;
  if v_opp.deadline_at is not null and v_opp.deadline_at <= now() then
    perform private.refuse('application_deadline_passed', 'The deadline for this opportunity has passed.');
  end if;
  if not private.opportunity_open_to_person(v_opp.id, v_opp.org_id, v_opp.visibility, v_opp.opportunity_state,
      coalesce(new.applicant_person_id, v_me)) then
    perform private.refuse('opportunity_not_available', 'This opportunity is not open to you.');
  end if;
  if new.applicant_person_id is not null and new.applicant_person_id <> v_me
     and not private.represents(new.applicant_person_id, 'Offers') then
    raise exception using errcode = '42501', message = 'only the applicant or their representative with the Offers scope applies';
  end if;
  if new.applicant_organization_id is not null and new.applicant_organization_id not in (
      select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[])) then
    raise exception using errcode = '42501', message = 'an Account Owner or Admin applies for the account';
  end if;
  if new.profile_share_id is not null and not exists (
    select 1 from app.profile_shares s where s.id = new.profile_share_id and s.revoked_at is null
      and (s.person_id = new.applicant_person_id or s.organization_id = new.applicant_organization_id)) then
    perform private.refuse('application_profile_share', 'An application carries the applicant''s own unrevoked profile share.');
  end if;
  return new;
end;
$$;

comment on function private.guard_application() is 'Applications: submitted by the applicant, their representative (Offers scope) or an Account Owner or Admin, before the deadline, to a Published opportunity open to them; a Do Not Engage flag withholds with the same refusal as an unseen listing, so the flag never shows. Applicant and opportunity never change.';

create trigger t40_guard_application before insert or update on app.applications
  for each row execute function private.guard_application();

create or replace function private.assert_application_open(p_application_id uuid)
returns app.opportunities
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_opp app.opportunities;
begin
  select o.* into v_opp from app.applications a join app.opportunities o on o.id = a.opportunity_id
  where a.id = p_application_id and a.application_state = 'Submitted' and a.deleted_at is null;
  if v_opp.id is null then
    perform private.refuse('application_not_editable', 'An application changes only while it is Submitted.');
  end if;
  if v_opp.deadline_at is not null and v_opp.deadline_at <= now() then
    perform private.refuse('application_deadline_passed', 'The deadline for this opportunity has passed.');
  end if;
  return v_opp;
end;
$$;

comment on function private.assert_application_open(uuid) is 'Refuses changes to an application''s answers, bid or slate once it has left Submitted or the opportunity deadline has passed; returns the opportunity.';

create or replace function private.guard_application_child()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_application uuid;
  v_opp app.opportunities;
  v_app app.applications;
begin
  if tg_table_name = 'bid_lines' then
    select b.application_id into v_application from app.bids b where b.id = (v_row ->> 'bid_id')::uuid;
  else
    v_application := (v_row ->> 'application_id')::uuid;
  end if;
  if tg_op = 'UPDATE' and tg_table_name <> 'bid_lines' and v_application is distinct from (to_jsonb(old) ->> 'application_id')::uuid then
    perform private.refuse('application_child_immutable', format('%s rows keep their application.', tg_table_name));
  end if;
  if auth.uid() is not null then
    v_opp := private.assert_application_open(v_application);
  else
    select o.* into v_opp from app.applications a join app.opportunities o on o.id = a.opportunity_id where a.id = v_application;
  end if;
  select * into v_app from app.applications a where a.id = v_application;
  if tg_table_name = 'application_answers' then
    if not exists (
      select 1 from app.opportunity_questions q
      where q.id = (v_row ->> 'opportunity_question_id')::uuid and q.opportunity_id = v_app.opportunity_id) then
      perform private.refuse('answer_question_mismatch', 'An answer answers a question of the same opportunity.');
    end if;
  elsif tg_table_name = 'bids' then
    if v_opp.rate_type is distinct from 'Bid' then
      perform private.refuse('bid_not_bid_opportunity', 'Bids are submitted only to Bid opportunities.');
    end if;
    if v_app.applicant_organization_id is null then
      perform private.refuse('bid_account_only', 'A bid comes from an external account.');
    end if;
    new := jsonb_populate_record(new, jsonb_build_object('submitted_at', now()));
  elsif tg_table_name = 'agency_slates' then
    if v_app.applicant_organization_id is null or not exists (
      select 1 from app.account_memberships m
      where m.org_id = v_app.applicant_organization_id and m.person_id = (v_row ->> 'person_id')::uuid
        and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
      perform private.refuse('slate_member_required', 'A slate names members of the agency''s own account.');
    end if;
    if (v_row ->> 'opportunity_position_id') is not null and not exists (
      select 1 from app.opportunity_positions p
      where p.id = (v_row ->> 'opportunity_position_id')::uuid and p.opportunity_id = v_app.opportunity_id) then
      perform private.refuse('slate_position_mismatch', 'A slate position belongs to the same opportunity.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_application_child() is 'Answers, bids, bid lines and agency slates change only while their application is Submitted and before the deadline (bids are then sealed and fixed); answers match the opportunity''s questions, bids only on Bid opportunities from accounts, slates only name the agency''s own members.';

create trigger t40_guard_application_answer before insert or update on app.application_answers
  for each row execute function private.guard_application_child();
create trigger t40_guard_bid before insert or update on app.bids
  for each row execute function private.guard_application_child();
create trigger t40_guard_bid_line before insert or update on app.bid_lines
  for each row execute function private.guard_application_child();
create trigger t40_guard_agency_slate before insert or update on app.agency_slates
  for each row execute function private.guard_application_child();

create or replace function private.guard_shortlist()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from app.applications a where a.id = new.application_id and a.opportunity_id = new.opportunity_id) then
    perform private.refuse('shortlist_application_mismatch', 'A shortlist entry is an application of the same opportunity.');
  end if;
  return new;
end;
$$;

comment on function private.guard_shortlist() is 'Shortlist entries are applications of the shortlist''s opportunity.';

create trigger t40_guard_shortlist before insert or update on app.shortlists
  for each row execute function private.guard_shortlist();

create or replace function private.guard_listing_report()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opp app.opportunities;
begin
  if tg_op = 'UPDATE' then
    perform private.refuse('listing_report_immutable', 'A report is never edited.');
  end if;
  new.reported_at := now();
  if auth.uid() is null then
    return new;
  end if;
  new.reporter_person_id := private.current_person_id();
  select * into v_opp from app.opportunities o where o.id = new.opportunity_id;
  if not private.opportunity_open_to(v_opp.id, v_opp.org_id, v_opp.visibility, v_opp.opportunity_state)
     and not private.can_on_project(v_opp.project_id, 'opportunities.posting.read') then
    raise exception using errcode = '42501', message = 'only someone who can see a listing reports it';
  end if;
  return new;
end;
$$;

comment on function private.guard_listing_report() is 'Listing reports come from someone who can see the listing, stamped with the session person and time, and are never edited.';

create trigger t40_guard_listing_report before insert or update on app.listing_reports
  for each row execute function private.guard_listing_report();

create or replace function private.guard_engagement_application()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app app.applications;
begin
  if new.application_id is null then
    return new;
  end if;
  select * into v_app from app.applications a where a.id = new.application_id;
  if v_app.application_state is distinct from 'Accepted' then
    perform private.refuse('engagement_application_not_accepted', 'An engagement comes from an accepted application.');
  end if;
  if (select o.project_id from app.opportunities o where o.id = v_app.opportunity_id) <> new.project_id
     or (v_app.applicant_person_id is not null and v_app.applicant_person_id is distinct from new.person_id)
     or (v_app.applicant_organization_id is not null and v_app.applicant_organization_id is distinct from
         (select c.organization_id from app.counterparties c where c.id = new.counterparty_id)) then
    perform private.refuse('engagement_application_mismatch', 'An engagement names the project and party of its application.');
  end if;
  return new;
end;
$$;

comment on function private.guard_engagement_application() is 'An engagement from the marketplace names an accepted application of the same project and party.';

create trigger t46_guard_engagement_application before insert or update of application_id on app.engagements
  for each row execute function private.guard_engagement_application();

call private.install_tenant_guards('app.engagements', 'app.projects', 'project_id',
  array['app.counterparties', 'counterparty_id', 'app.labor_agreements', 'labor_agreement_id', 'app.applications', 'application_id']);

-- Policies ---------------------------------------------------------------------------------------------------------------

call private.install_policies('app.talent_pools',
  $$org_id in (select private.orgs_with_capability('opportunities.application.read'))$$,
  $$org_id in (select private.orgs_with_capability('opportunities.pool.write'))$$);
call private.install_policies('app.pool_members',
  $$org_id in (select private.orgs_with_capability('opportunities.application.read'))$$,
  $$org_id in (select private.orgs_with_capability('opportunities.pool.write'))$$);

call private.install_policies('app.opportunities',
  $$project_id in (select private.project_ids_with('opportunities.posting.read'))$$,
  $$project_id in (select private.project_ids_with('opportunities.posting.write'))$$);

create or replace function private.internal_opportunity_ids(p_capability text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select o.id from app.opportunities o where o.project_id in (select private.project_ids_with(p_capability));
$$;

comment on function private.internal_opportunity_ids(text) is 'Opportunities of projects on which the signed-in member holds the capability.';

call private.install_policies('app.opportunity_positions',
  $$opportunity_id in (select private.internal_opportunity_ids('opportunities.posting.read'))$$,
  $$opportunity_id in (select private.internal_opportunity_ids('opportunities.posting.write'))$$);
call private.install_policies('app.opportunity_requirements',
  $$opportunity_id in (select private.internal_opportunity_ids('opportunities.posting.read'))$$,
  $$opportunity_id in (select private.internal_opportunity_ids('opportunities.posting.write'))$$);
call private.install_policies('app.opportunity_questions',
  $$opportunity_id in (select private.internal_opportunity_ids('opportunities.posting.read'))$$,
  $$opportunity_id in (select private.internal_opportunity_ids('opportunities.posting.write'))$$);
call private.install_policies('app.opportunity_invitations',
  $$opportunity_id in (select private.internal_opportunity_ids('opportunities.posting.read'))
    or person_id = (select private.current_person_id())
    or organization_id in (select private.my_account_ids(null))$$,
  $$opportunity_id in (select private.internal_opportunity_ids('opportunities.posting.write'))$$);

call private.install_policies('app.listing_reports',
  $$reporter_person_id = (select private.current_person_id())
    or org_id in (select private.orgs_with_capability('opportunities.marketplace.manage'))$$,
  $$reporter_person_id = (select private.current_person_id())$$);
call private.install_policies('app.moderation_actions',
  $$org_id in (select private.orgs_with_capability('opportunities.posting.read'))
    or listing_report_id in (select r.id from app.listing_reports r where r.reporter_person_id = (select private.current_person_id()))$$);

call private.install_policies('app.saved_searches',
  $$person_id = (select private.current_person_id())$$,
  $$person_id = (select private.current_person_id())$$);
call private.install_policies('app.opportunity_alerts',
  $$saved_search_id in (select private.my_saved_search_ids())$$);

call private.install_policies('app.applications',
  $$opportunity_id in (select private.internal_opportunity_ids('opportunities.application.read'))
    or applicant_person_id = (select private.current_person_id())
    or applicant_organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))
    or (applicant_person_id is not null and private.represents(applicant_person_id, 'Offers'))$$,
  $$applicant_person_id = (select private.current_person_id())
    or applicant_organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))
    or (applicant_person_id is not null and private.represents(applicant_person_id, 'Offers'))$$);

create or replace function private.internal_application_ids(p_capability text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.id from app.applications a
  where a.opportunity_id in (select private.internal_opportunity_ids(p_capability));
$$;

comment on function private.internal_application_ids(text) is 'Applications to opportunities of projects on which the signed-in member holds the capability.';

call private.install_policies('app.application_answers',
  $$application_id in (select private.internal_application_ids('opportunities.application.read'))
    or application_id in (select private.my_application_ids())$$,
  $$application_id in (select private.my_application_ids())$$);
call private.install_policies('app.bids',
  $$application_id in (select private.my_application_ids()) or private.bid_readable_by_org(application_id)$$,
  $$application_id in (select private.my_application_ids())$$);
call private.install_policies('app.bid_lines',
  $$bid_id in (select private.readable_bid_ids())$$,
  $$bid_id in (select b.id from app.bids b where b.application_id in (select private.my_application_ids()))$$);
call private.install_policies('app.agency_slates',
  $$application_id in (select private.internal_application_ids('opportunities.application.read'))
    or application_id in (select private.my_application_ids())$$,
  $$application_id in (select private.my_application_ids())$$);
call private.install_policies('app.shortlists',
  $$opportunity_id in (select private.internal_opportunity_ids('opportunities.application.review'))$$,
  $$opportunity_id in (select private.internal_opportunity_ids('opportunities.application.review'))$$);
call private.install_policies('app.interviews',
  $$application_id in (select private.internal_application_ids('opportunities.application.read'))$$,
  $$application_id in (select private.internal_application_ids('opportunities.application.review'))$$);

-- Column privileges: state, stamps and the applicant are never written directly after insert.
revoke insert, update on app.applications, app.listing_reports, app.opportunity_alerts from authenticated;
grant insert (opportunity_id, applicant_person_id, applicant_organization_id, profile_share_id, availability_confirmed, cover_note,
  proposed_fee_minor, currency_code) on app.applications to authenticated;
grant update (availability_confirmed, cover_note, proposed_fee_minor, currency_code, deleted_at) on app.applications to authenticated;
grant insert (opportunity_id, reason, details) on app.listing_reports to authenticated;
revoke insert, update on app.bids from authenticated;
grant insert (application_id, currency_code, valid_until), update (valid_until, deleted_at) on app.bids to authenticated;
revoke insert, update on app.opportunities from authenticated;
grant insert (project_id, scope_node_id, role_type, role_code, cat_urid, title, description, venue_id, jurisdiction_id, starts_on, ends_on,
  visibility, rate_type, pay_min_minor, pay_max_minor, currency_code, deadline_at, minimum_age) on app.opportunities to authenticated;
grant update (scope_node_id, role_code, cat_urid, title, description, venue_id, jurisdiction_id, starts_on, ends_on, visibility, rate_type,
  pay_min_minor, pay_max_minor, currency_code, deadline_at, minimum_age, deleted_at) on app.opportunities to authenticated;

-- Transition RPCs ----------------------------------------------------------------------------------------------------------

create or replace function app.transition_opportunity(p_opportunity_id uuid, p_expected app.opportunity_state, p_next app.opportunity_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select o.project_id from app.opportunities o where o.id = p_opportunity_id and o.deleted_at is null);
  v_capability text := case when p_next = 'Published' then 'opportunities.posting.publish' else 'opportunities.posting.write' end;
begin
  perform private.require_person();
  if v_project is null or not private.can_on_project(v_project, v_capability) then
    raise exception using errcode = '42501', message = format('%s is required on the project', v_capability);
  end if;
  return private.transition_lifecycle('opportunity', 'app.opportunities', 'opportunity_state', 'app.opportunity_state_transitions',
    'opportunity_id', p_opportunity_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_opportunity(uuid, app.opportunity_state, app.opportunity_state, text) is 'Moves an opportunity with compare-and-set. Publishing needs opportunities.posting.publish on the project and passes the publishing checks of private.guard_opportunity; every other move needs opportunities.posting.write.';

create or replace function app.transition_application(p_application_id uuid, p_expected app.application_state, p_next app.application_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select o.project_id from app.applications a join app.opportunities o on o.id = a.opportunity_id
                     where a.id = p_application_id and a.deleted_at is null);
  v_capability text;
begin
  perform private.require_person();
  if v_project is null then
    raise exception using errcode = '42501', message = 'application not found';
  end if;
  if p_next in ('Withdrawn', 'Accepted', 'Declined') then
    if not exists (select 1 from private.my_application_ids() x where x = p_application_id) then
      raise exception using errcode = '42501', message = 'only the applicant side withdraws, accepts or declines';
    end if;
  else
    v_capability := case p_next when 'Offered' then 'opportunities.offer.send' when 'Not Selected' then 'opportunities.selection.decide'
                    else 'opportunities.application.review' end;
    if not private.can_on_project(v_project, v_capability) then
      raise exception using errcode = '42501', message = format('%s is required on the project', v_capability);
    end if;
  end if;
  return private.transition_lifecycle('application', 'app.applications', 'application_state', 'app.application_state_transitions',
    'application_id', p_application_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_application(uuid, app.application_state, app.application_state, text) is 'Moves an application with compare-and-set. The applicant side (the applicant, their representative with Offers, or an Account Owner or Admin) withdraws, accepts or declines; the org reviews and shortlists (opportunities.application.review), offers (opportunities.offer.send) or does not select (opportunities.selection.decide).';

-- Views ----------------------------------------------------------------------------------------------------------------------

-- Definer views with their own row filters (ADR 0016 item 14): a security_invoker view over bids and bid lines
-- would run bid line policies that re-read bids while the view scans them.
create view app.bid_totals as
select b.id as bid_id, b.application_id, b.currency_code,
  case when count(l.id) filter (where l.unit_price_minor is null) = 0 and count(l.id) > 0
       then sum(round(l.quantity * l.unit_price_minor))::bigint end as total_minor,
  count(l.id) filter (where l.unit_price_minor is null) as unpriced_line_count
from app.bids b
left join app.bid_lines l on l.bid_id = b.id and l.deleted_at is null
where b.deleted_at is null and b.id in (select private.readable_bid_ids())
group by b.id, b.application_id, b.currency_code;

call private.describe('app.bid_totals', 'Bid totals derived from their lines, NULL-aware: a bid with an unpriced line has no total and counts its unpriced lines. Rows follow the sealed bid rule of app.bids.', array[
  'bid_id', 'Bid.',
  'application_id', 'Application.',
  'currency_code', 'Currency.',
  'total_minor', 'Sum of quantity times unit price in minor units; NULL when any line is unpriced.',
  'unpriced_line_count', 'Lines without a price.'
]);

create view app.opportunity_position_counts as
select o.id as opportunity_id, count(p.id) as position_count
from app.opportunities o
left join app.opportunity_positions p on p.opportunity_id = o.id and p.deleted_at is null
where o.deleted_at is null and o.project_id in (select private.project_ids_with('opportunities.posting.read'))
group by o.id;

call private.describe('app.opportunity_position_counts', 'Number of positions of each opportunity, derived from its positions.', array[
  'opportunity_id', 'Opportunity.',
  'position_count', 'Positions.'
]);

revoke all on app.bid_totals, app.opportunity_position_counts from public, anon;
grant select on app.bid_totals, app.opportunity_position_counts to authenticated, service_role;

-- Function privileges ----------------------------------------------------------------------------------------------------------

revoke all on function private.pay_range_required(text) from public, anon, authenticated;
revoke all on function private.opportunity_removed(uuid) from public, anon;
revoke all on function private.my_application_ids() from public, anon;
revoke all on function private.excluded_from_org(uuid, uuid) from public, anon, authenticated;
revoke all on function private.opportunity_open_to(uuid, uuid, app.opportunity_visibility, app.opportunity_state) from public, anon;
revoke all on function private.opportunity_open_to_person(uuid, uuid, app.opportunity_visibility, app.opportunity_state, uuid) from public, anon, authenticated;
revoke all on function private.person_account_ids(uuid) from public, anon, authenticated;
revoke all on function private.visible_opportunity_ids() from public, anon;
revoke all on function private.bid_readable_by_org(uuid) from public, anon;
revoke all on function private.readable_bid_ids() from public, anon;
revoke all on function private.my_saved_search_ids() from public, anon;
revoke all on function private.internal_opportunity_ids(text) from public, anon;
revoke all on function private.internal_application_ids(text) from public, anon;
revoke all on function private.assert_application_open(uuid) from public, anon, authenticated;
revoke all on function private.guard_opportunity() from public, anon, authenticated;
revoke all on function private.guard_pool_member() from public, anon, authenticated;
revoke all on function private.guard_application() from public, anon, authenticated;
revoke all on function private.guard_application_child() from public, anon, authenticated;
revoke all on function private.guard_shortlist() from public, anon, authenticated;
revoke all on function private.guard_listing_report() from public, anon, authenticated;
revoke all on function private.guard_engagement_application() from public, anon, authenticated;

grant execute on function private.opportunity_removed(uuid) to authenticated, service_role;
grant execute on function private.my_application_ids() to authenticated, service_role;
grant execute on function private.opportunity_open_to(uuid, uuid, app.opportunity_visibility, app.opportunity_state) to authenticated, service_role;
grant execute on function private.visible_opportunity_ids() to authenticated, service_role;
grant execute on function private.bid_readable_by_org(uuid) to authenticated, service_role;
grant execute on function private.readable_bid_ids() to authenticated, service_role;
grant execute on function private.my_saved_search_ids() to authenticated, service_role;
grant execute on function private.internal_opportunity_ids(text) to authenticated, service_role;
grant execute on function private.internal_application_ids(text) to authenticated, service_role;

revoke all on function app.transition_opportunity(uuid, app.opportunity_state, app.opportunity_state, text) from public, anon;
revoke all on function app.transition_application(uuid, app.application_state, app.application_state, text) from public, anon;
grant execute on function app.transition_opportunity(uuid, app.opportunity_state, app.opportunity_state, text) to authenticated, service_role;
grant execute on function app.transition_application(uuid, app.application_state, app.application_state, text) to authenticated, service_role;
