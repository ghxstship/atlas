-- 0750_api_external.sql
-- A28 Engagements and Marketplace. Section 8.7 projections: column-allowlisted views in api_external, the only
-- path by which external users (Gateway and external Compass) read engagement data. Each view names its
-- columns; none carries internal notes, margins, budget lines, other parties' rates, internal ratings, pool
-- standing or Do Not Engage flags, reviewer notes, or encrypted identifiers.
--
-- Every view runs as its owner with an explicit row filter built from the Section 8.7 helpers (engagement areas
-- and the state time box: operational access opens at Active, narrows to money and documents at Complete and
-- closes 18 months later except the person's own tax forms and payments). Running as owner keeps policy helpers
-- from re-reading a table a security_invoker view is scanning (ADR 0016 item 14).

-- Engagements -------------------------------------------------------------------------------------------------------

create view api_external.engagements as
select e.id, e.org_id, o.name as org_name, e.project_id, p.name as project_name, e.role_type, e.role_code, r.job_title,
  e.person_id, c.organization_id as account_id, e.pay_basis, e.arrangement,
  case when 'money' = any (a.areas) then coalesce(e.agreed_rate_minor, ol.rate_minor, rc.standard_rate_minor) end as rate_minor,
  case when 'money' = any (a.areas) then
    case when e.agreed_rate_minor is not null then e.currency_code when ol.rate_minor is not null then ol.currency_code else rc.currency_code end
  end as rate_currency_code,
  e.start_date, e.end_date, e.engagement_state, a.areas
from app.engagements e
join app.organizations o on o.id = e.org_id
join app.projects p on p.id = e.project_id
join xpms.role r on r.role_code = e.role_code
left join app.counterparties c on c.id = e.counterparty_id
left join xpms.rate_card rc on rc.role_code = e.role_code and rc.worker_classification = e.worker_classification
  and rc.pay_basis = e.pay_basis and rc.arrangement = e.arrangement
left join lateral (
  select l.rate_minor, k.currency_code
  from app.rate_card_lines l join app.rate_cards k on k.id = l.rate_card_id
  where l.org_id = e.org_id and l.deleted_at is null and k.deleted_at is null
    and l.role_code = e.role_code and l.worker_classification = e.worker_classification
    and l.pay_basis = e.pay_basis and l.arrangement = e.arrangement
    and k.effective_from <= e.start_date and (k.effective_to is null or k.effective_to >= e.start_date)
  order by k.effective_from desc limit 1
) ol on true
cross join lateral (select array(select s from private.engagement_scope(e.id) s order by s) as areas) a
where e.deleted_at is null and e.id in (select private.my_engagement_ids('engagement'));

call private.describe('api_external.engagements', 'The caller''s external engagements (Section 8.7): their own, their account''s or a represented artist''s, while the engagement area is open. The rate is the party''s own and appears only while the money area is open; internal notes never appear.', array[
  'id', 'Engagement.',
  'org_id', 'Engaging org.',
  'org_name', 'Engaging org name.',
  'project_id', 'Project.',
  'project_name', 'Project name.',
  'role_type', 'External role type.',
  'role_code', 'Canon role.',
  'job_title', 'Job title from the Roles Library.',
  'person_id', 'Engaged person.',
  'account_id', 'Engaged external account.',
  'pay_basis', 'Pay basis.',
  'arrangement', 'Arrangement.',
  'rate_minor', 'The party''s rate in minor units while the money area is open; NULL otherwise or when unpaid.',
  'rate_currency_code', 'Currency of the rate.',
  'start_date', 'First day.',
  'end_date', 'Last day.',
  'engagement_state', 'Engagement state.',
  'areas', 'Areas open to the caller: engagement, documents, onboarding, operational, money.'
]);

create view api_external.engagement_documents as
select d.id, d.engagement_id, d.document_kind, d.title, d.document_id, d.expires_on, d.engagement_document_state
from app.engagement_documents d
where d.deleted_at is null and d.engagement_id in (select private.my_engagement_ids('documents'));

call private.describe('api_external.engagement_documents', 'Documents of the caller''s engagements while the documents area is open.', array[
  'id', 'Document.', 'engagement_id', 'Engagement.', 'document_kind', 'Kind.', 'title', 'Title.',
  'document_id', 'Stored document.', 'expires_on', 'Expiry.', 'engagement_document_state', 'Document state.']);

create view api_external.onboarding_items as
select i.id, i.engagement_id, r.name, r.item_kind, r.is_blocking, r.verification_method, i.submitted_at,
  lv.outcome as latest_outcome, lv.expires_on, private.onboarding_item_passes(i.id) as passes,
  private.requirement_satisfied(i.engagement_id, i.onboarding_requirement_id) as satisfied
from app.onboarding_items i
join app.onboarding_requirements r on r.id = i.onboarding_requirement_id
left join lateral (
  select v.outcome, v.expires_on from app.onboarding_verifications v
  where v.onboarding_item_id = i.id order by v.verified_at desc, v.id desc limit 1
) lv on true
where i.deleted_at is null and i.engagement_id in (select private.my_engagement_ids('onboarding'));

call private.describe('api_external.onboarding_items', 'The caller''s onboarding packet items and their progress while the onboarding area is open. Reviewer notes never appear.', array[
  'id', 'Item.', 'engagement_id', 'Engagement.', 'name', 'Requirement name.', 'item_kind', 'Kind.',
  'is_blocking', 'True when the item blocks Active.', 'verification_method', 'Automatic or Reviewer.',
  'submitted_at', 'When submitted.', 'latest_outcome', 'Latest verification outcome.', 'expires_on', 'Expiry.',
  'passes', 'True when the item passes.', 'satisfied', 'True when it passes or a verified item carries over.']);

create view api_external.engagement_threads as
select t.id, t.engagement_id, t.subject, t.created_at
from app.engagement_threads t
where t.deleted_at is null and t.engagement_id in (select private.my_engagement_ids('engagement'));

call private.describe('api_external.engagement_threads', 'Threads of the caller''s engagements while the engagement area is open.', array[
  'id', 'Thread.', 'engagement_id', 'Engagement.', 'subject', 'Subject.', 'created_at', 'When opened.']);

create view api_external.engagement_messages as
select m.id, m.engagement_thread_id, m.author_person_id, pe.full_name as author_name, m.body, m.sent_at
from app.engagement_messages m
join app.engagement_threads t on t.id = m.engagement_thread_id and t.deleted_at is null
left join app.people pe on pe.id = m.author_person_id
where t.engagement_id in (select private.my_engagement_ids('engagement'));

call private.describe('api_external.engagement_messages', 'Messages on the caller''s engagement threads.', array[
  'id', 'Message.', 'engagement_thread_id', 'Thread.', 'author_person_id', 'Author.', 'author_name', 'Author name.',
  'body', 'Text.', 'sent_at', 'When sent.']);

create view api_external.records as
select r.id, r.project_id, r.record_kind, r.record_subtype, r.record_state, r.title, r.starts_at, r.ends_at, r.due_at, r.time_zone
from app.records r
where r.deleted_at is null and private.is_engaged_party(r.project_id)
  and exists (
    select 1 from app.record_external_visibility v
    where v.record_id = r.id and v.deleted_at is null
      and (v.external_role_type in (select private.engaged_role_types(r.project_id))
        or v.person_id = private.current_person_id()
        or v.organization_id in (select private.engaged_organization_ids(r.project_id))));

call private.describe('api_external.records', 'Project records whose external visibility names the caller''s role type, person or organization, on projects where the caller holds an Active or Closing engagement (Section 8.7 operational access).', array[
  'id', 'Record.', 'project_id', 'Project.', 'record_kind', 'Record kind.', 'record_subtype', 'Subtype.',
  'record_state', 'Record state.', 'title', 'Title.', 'starts_at', 'Start.', 'ends_at', 'End.', 'due_at', 'Due.',
  'time_zone', 'IANA time zone of typed local times.']);

-- Money and tax -----------------------------------------------------------------------------------------------------------

create view api_external.payments as
select pm.id, pm.org_id, o.name as org_name, c.organization_id as account_id, pm.amount_minor, pm.currency_code, pm.paid_on,
  pm.reference_identifier, pm.payment_state
from app.payments pm
join app.counterparties c on c.id = pm.counterparty_id
join app.organizations o on o.id = pm.org_id
where pm.deleted_at is null and pm.direction = 'Payable' and pm.payment_state <> 'Proposed'
  and c.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[]))
  and exists (select 1 from app.engagements e where e.counterparty_id = pm.counterparty_id and e.deleted_at is null);

call private.describe('api_external.payments', 'Payments an org made to the caller''s account, for its Account Owners, Admins and Finance members (Section 4.4.5). Payments are the party''s own records and never close.', array[
  'id', 'Payment.', 'org_id', 'Paying org.', 'org_name', 'Paying org name.', 'account_id', 'Account paid.',
  'amount_minor', 'Amount in minor units.', 'currency_code', 'Currency.', 'paid_on', 'Payment date.',
  'reference_identifier', 'Remittance reference.', 'payment_state', 'Payment state.']);

create view api_external.tax_forms as
select t.id, t.org_id, o.name as org_name, t.person_id, t.organization_id as account_id, t.form_kind, t.tin_last4,
  t.foreign_performer_withholding, t.signed_at
from app.tax_forms t
join app.organizations o on o.id = t.org_id
where t.deleted_at is null
  and (t.person_id = private.current_person_id()
    or t.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[])));

call private.describe('api_external.tax_forms', 'The caller''s own tax forms and their account''s; only the last four of the identifier. Own tax documents never close (Section 8.7).', array[
  'id', 'Form.', 'org_id', 'Org the form was given to.', 'org_name', 'Org name.', 'person_id', 'Payee person.',
  'account_id', 'Payee account.', 'form_kind', 'Form.', 'tin_last4', 'Last four of the identifier.',
  'foreign_performer_withholding', 'Foreign performer withholding.', 'signed_at', 'When signed.']);

create view api_external.payout_accounts as
select pa.id, pa.org_id, pa.person_id, pa.organization_id as account_id, pa.provider, pa.account_last4
from app.payout_accounts pa
where pa.deleted_at is null
  and (pa.person_id = private.current_person_id()
    or pa.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[])));

call private.describe('api_external.payout_accounts', 'The caller''s payout destinations by org: provider and last four only.', array[
  'id', 'Payout account.', 'org_id', 'Paying org.', 'person_id', 'Payee person.', 'account_id', 'Payee account.',
  'provider', 'Provider.', 'account_last4', 'Last four the provider reports.']);

-- Marketplace -----------------------------------------------------------------------------------------------------------

create view api_external.opportunities as
select op.id, op.org_id, o.name as org_name, op.title, op.description, op.role_type, op.role_code, op.cat_urid,
  v.name as venue_name, op.jurisdiction_id, op.starts_on, op.ends_on, op.visibility, op.rate_type,
  op.pay_min_minor, op.pay_max_minor, op.currency_code, (op.rate_type is null) as rate_on_request,
  op.deadline_at, op.minimum_age, op.opportunity_state,
  (select count(*) from app.opportunity_positions pp where pp.opportunity_id = op.id and pp.deleted_at is null) as position_count
from app.opportunities op
join app.organizations o on o.id = op.org_id
left join app.venues v on v.id = op.venue_id
where op.deleted_at is null
  and (op.id in (select private.visible_opportunity_ids())
    or op.id in (select a.opportunity_id from app.applications a where a.id in (select private.my_application_ids())));

call private.describe('api_external.opportunities', 'Opportunities open to the caller in the marketplace (Section 4.4.3 visibility), and those they have applied to. Opportunities without posted compensation show Rate on Request, never zero.', array[
  'id', 'Opportunity.', 'org_id', 'Org.', 'org_name', 'Org name.', 'title', 'Title.', 'description', 'Description.',
  'role_type', 'External role type.', 'role_code', 'Canon role.', 'cat_urid', 'Canon category.', 'venue_name', 'Venue.',
  'jurisdiction_id', 'Jurisdiction of the work.', 'starts_on', 'First day.', 'ends_on', 'Last day.', 'visibility', 'Visibility.',
  'rate_type', 'Rate type.', 'pay_min_minor', 'Lower end of posted pay.', 'pay_max_minor', 'Upper end of posted pay.',
  'currency_code', 'Currency.', 'rate_on_request', 'True when no compensation is posted.', 'deadline_at', 'Deadline.',
  'minimum_age', 'Minimum age.', 'opportunity_state', 'State.', 'position_count', 'Positions.']);

create view api_external.opportunity_positions as
select pp.id, pp.opportunity_id, pp.label, pp.call_at, pp.ends_at
from app.opportunity_positions pp
where pp.deleted_at is null and pp.opportunity_id in (select x.id from api_external.opportunities x);

call private.describe('api_external.opportunity_positions', 'Positions of opportunities open to the caller.', array[
  'id', 'Position.', 'opportunity_id', 'Opportunity.', 'label', 'Label.', 'call_at', 'Call time.', 'ends_at', 'End.']);

create view api_external.opportunity_questions as
select q.id, q.opportunity_id, q.prompt, q.sort_order, q.is_required
from app.opportunity_questions q
where q.deleted_at is null and q.opportunity_id in (select x.id from api_external.opportunities x);

call private.describe('api_external.opportunity_questions', 'Application questions of opportunities open to the caller.', array[
  'id', 'Question.', 'opportunity_id', 'Opportunity.', 'prompt', 'Question.', 'sort_order', 'Order.', 'is_required', 'Required.']);

create view api_external.opportunity_requirements as
select rq.id, rq.opportunity_id, rq.requirement_kind, rq.description, ce.name as certification_name, rq.insurance_minimum_minor, rq.currency_code
from app.opportunity_requirements rq
left join app.certifications ce on ce.id = rq.certification_id
where rq.deleted_at is null and rq.opportunity_id in (select x.id from api_external.opportunities x);

call private.describe('api_external.opportunity_requirements', 'Requirements of opportunities open to the caller.', array[
  'id', 'Requirement.', 'opportunity_id', 'Opportunity.', 'requirement_kind', 'Kind.', 'description', 'What is required.',
  'certification_name', 'Certification required.', 'insurance_minimum_minor', 'Insurance minimum in minor units.', 'currency_code', 'Currency.']);

create view api_external.applications as
select a.id, a.opportunity_id, a.applicant_person_id, a.applicant_organization_id, a.submitted_by, a.availability_confirmed,
  a.cover_note, a.proposed_fee_minor, a.currency_code, a.application_state, a.created_at as submitted_at
from app.applications a
where a.id in (select private.my_application_ids());

call private.describe('api_external.applications', 'The caller''s applications: their own, their account''s, or a represented artist''s with the Offers scope. Shortlist ranks and internal notes never appear.', array[
  'id', 'Application.', 'opportunity_id', 'Opportunity.', 'applicant_person_id', 'Applying person.',
  'applicant_organization_id', 'Applying account.', 'submitted_by', 'Submitter.', 'availability_confirmed', 'Availability confirmed.',
  'cover_note', 'Cover note.', 'proposed_fee_minor', 'Proposed fee.', 'currency_code', 'Currency.',
  'application_state', 'State.', 'submitted_at', 'When submitted.']);

create view api_external.bids as
select b.id, b.application_id, b.currency_code, b.valid_until, b.submitted_at
from app.bids b
where b.deleted_at is null and b.application_id in (select private.my_application_ids());

call private.describe('api_external.bids', 'The caller''s own sealed bids. A bidder never sees another bidder.', array[
  'id', 'Bid.', 'application_id', 'Application.', 'currency_code', 'Currency.', 'valid_until', 'Valid until.', 'submitted_at', 'When submitted.']);

create view api_external.bid_lines as
select l.id, l.bid_id, l.description, l.element_id, l.quantity, l.unit_price_minor
from app.bid_lines l
join app.bids b on b.id = l.bid_id and b.deleted_at is null
where l.deleted_at is null and b.application_id in (select private.my_application_ids());

call private.describe('api_external.bid_lines', 'Lines of the caller''s own bids.', array[
  'id', 'Line.', 'bid_id', 'Bid.', 'description', 'Description.', 'element_id', 'Catalog element.',
  'quantity', 'Quantity.', 'unit_price_minor', 'Unit price in minor units; NULL when not priced.']);

create view api_external.interviews as
select i.id, i.application_id, i.interview_kind, i.scheduled_at, i.duration_minutes, i.location_text
from app.interviews i
where i.deleted_at is null and i.application_id in (select private.my_application_ids());

call private.describe('api_external.interviews', 'Interviews and auditions on the caller''s applications: time and place, never internal notes.', array[
  'id', 'Interview.', 'application_id', 'Application.', 'interview_kind', 'Interview or Audition.',
  'scheduled_at', 'Start.', 'duration_minutes', 'Minutes.', 'location_text', 'Place or link.']);

-- Ratings ------------------------------------------------------------------------------------------------------------------

create view api_external.ratings as
select rt.id, rt.rater_side, rt.score, rt.comment, rt.submitted_at,
  case when rt.rater_side = 'Organization' then e.person_id end as rated_person_id,
  case when rt.rater_side = 'Organization' then c.organization_id else e.org_id end as rated_organization_id,
  case when rt.rater_side = 'Organization' then e.org_id else c.organization_id end as rater_organization_id,
  rr.body as reply, rr.created_at as replied_at
from app.ratings rt
join app.engagements e on e.id = rt.engagement_id
left join app.counterparties c on c.id = e.counterparty_id
left join app.rating_replies rr on rr.rating_id = rt.id and rr.deleted_at is null
where rt.deleted_at is null and private.rating_released(rt.engagement_id) and private.current_person_id() is not null;

call private.describe('api_external.ratings', 'Released two-sided ratings and their replies, as profiles show them (Section 4.4.3, Section 4.8.2). Only released ratings appear; internal ratings and org notes never do.', array[
  'id', 'Rating.', 'rater_side', 'Organization or Party.', 'score', 'Score 1 to 5.', 'comment', 'Comment.',
  'submitted_at', 'When given.', 'rated_person_id', 'Person rated, for an org''s rating of a person.',
  'rated_organization_id', 'Organization rated: the engaged account, or the org for a party''s rating.',
  'rater_organization_id', 'Organization that rated: the org, or the engaged account.', 'reply', 'Public reply of the rated side.',
  'replied_at', 'When replied.']);

-- Accounts and representation -----------------------------------------------------------------------------------------------

create view api_external.my_accounts as
select o.id as account_id, o.name, o.slug, o.organization_type,
  array(select r from private.account_role(o.id) r order by r) as my_roles
from app.organizations o
where o.id in (select private.my_account_ids(null));

call private.describe('api_external.my_accounts', 'External accounts the caller belongs to, with their account roles.', array[
  'account_id', 'Account.', 'name', 'Name.', 'slug', 'Slug.', 'organization_type', 'Legal form.', 'my_roles', 'The caller''s account roles.']);

create view api_external.account_members as
select m.id as account_membership_id, m.org_id as account_id, m.person_id, pe.full_name, m.valid_from, m.valid_to,
  array(select r.account_role from app.account_membership_roles r where r.account_membership_id = m.id and r.deleted_at is null order by r.account_role) as roles
from app.account_memberships m
join app.people pe on pe.id = m.person_id
where m.deleted_at is null and (m.valid_to is null or m.valid_to > now())
  and m.org_id in (select private.my_account_ids(null));

call private.describe('api_external.account_members', 'The roster of accounts the caller belongs to.', array[
  'account_membership_id', 'Account membership.', 'account_id', 'Account.', 'person_id', 'Member.', 'full_name', 'Name.',
  'valid_from', 'Since.', 'valid_to', 'Until.', 'roles', 'Account roles.']);

create view api_external.representations as
select r.id, r.org_id as account_id, o.name as account_name, r.artist_person_id, ap.full_name as artist_name, r.representative_person_id,
  r.expires_on, r.accepted_at, r.revoked_at,
  array(select s.scope from app.representation_scopes s where s.representation_id = r.id and s.deleted_at is null order by s.scope) as scopes
from app.representations r
join app.organizations o on o.id = r.org_id
join app.people ap on ap.id = r.artist_person_id
where r.id in (select private.my_representation_ids());

call private.describe('api_external.representations', 'Representations the caller is party to, with scopes, expiry and acceptance.', array[
  'id', 'Representation.', 'account_id', 'Representing account.', 'account_name', 'Account name.', 'artist_person_id', 'Artist.',
  'artist_name', 'Artist name.', 'representative_person_id', 'Named agent.', 'expires_on', 'Expiry.', 'accepted_at', 'Accepted.',
  'revoked_at', 'Revoked.', 'scopes', 'Scopes.']);

-- Availability --------------------------------------------------------------------------------------------------------------

create view api_external.availability as
select b.id, c.person_id, c.id as availability_calendar_id, b.starts_at, b.ends_at, b.availability_kind
from app.availability_blocks b
join app.availability_calendars c on c.id = b.availability_calendar_id and c.deleted_at is null
where b.deleted_at is null and private.availability_shared_with_me(c.person_id, c.org_id, c.visibility);

call private.describe('api_external.availability', 'Availability periods the caller may see; the owner''s notes never appear.', array[
  'id', 'Block.', 'person_id', 'Person.', 'availability_calendar_id', 'Calendar.', 'starts_at', 'Start.', 'ends_at', 'End.',
  'availability_kind', 'Kind.']);

-- Privileges ------------------------------------------------------------------------------------------------------------------

do $$
declare
  v record;
begin
  for v in select c.oid::regclass as rel from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'api_external' and c.relkind = 'v' loop
    execute format('revoke all on %s from public, anon', v.rel);
    execute format('grant select on %s to authenticated, service_role', v.rel);
  end loop;
end $$;
