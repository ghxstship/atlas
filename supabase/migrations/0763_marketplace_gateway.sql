-- 0763_marketplace_gateway.sql
-- A28 Engagements and Marketplace (RRR-30), Gateway group 2 for A27 (Section 4.4.3 discovery and applying):
--   * app.saved_opportunities: a person bookmarks an opportunity open to them, and removes it by soft delete
--   * api_external views of the caller's own marketplace rows: saved opportunities, saved searches, alerts,
--     application answers, agency slates, availability calendars and certification holdings
--   * api_external.opportunities gains the venue locality, and api_external.opportunity_requirements gains the
--     certification and whether the caller holds it, for the requirements check before applying
-- Venue coordinates wait on A09's venues.location; the org verified flag waits on A30's verification projection.

-- Saved opportunities ----------------------------------------------------------------------------------------------

create table app.saved_opportunities (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  opportunity_id uuid not null references app.opportunities (id),
  person_id uuid not null references app.people (id),
  saved_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index saved_opportunities_opportunity_id_idx on app.saved_opportunities (opportunity_id);
create index saved_opportunities_person_id_idx on app.saved_opportunities (person_id, saved_at);
create unique index saved_opportunities_key on app.saved_opportunities (person_id, opportunity_id) where deleted_at is null;

call private.install_domain_table('app.saved_opportunities', 'app.opportunities', 'opportunity_id');
call private.describe('app.saved_opportunities', 'Opportunities a Gateway user saved to come back to (Section 4.4.3 discovery). Owned by the person; the org never sees who saved its listing.', array[
  'org_id', 'Org of the saved opportunity, derived from it.',
  'opportunity_id', 'Saved opportunity, open to the person when saved.',
  'person_id', 'Person who saved it, set from the session.',
  'saved_at', 'When it was saved, set by the database.'
]);

create or replace function private.guard_saved_opportunity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opp app.opportunities;
begin
  if tg_op = 'UPDATE' then
    if new.opportunity_id <> old.opportunity_id or new.person_id <> old.person_id or new.saved_at <> old.saved_at then
      perform private.refuse('saved_opportunity_immutable', 'A saved opportunity keeps its opportunity and person.');
    end if;
    return new;
  end if;
  new.saved_at := now();
  if auth.uid() is null then
    return new;
  end if;
  new.person_id := private.require_person();
  select o.* into v_opp from app.opportunities o where o.id = new.opportunity_id and o.deleted_at is null;
  if v_opp.id is null or not private.opportunity_open_to(v_opp.id, v_opp.org_id, v_opp.visibility, v_opp.opportunity_state) then
    perform private.refuse('opportunity_not_available', 'This opportunity is not open to you.');
  end if;
  return new;
end;
$$;

comment on function private.guard_saved_opportunity() is 'Saved opportunities: the person from the session, only opportunities open to them (an unseen listing and a Do Not Engage flag refuse alike), and the opportunity and person never change.';

create trigger t40_guard_saved_opportunity before insert or update on app.saved_opportunities
  for each row execute function private.guard_saved_opportunity();

call private.install_policies('app.saved_opportunities',
  $$person_id = (select private.current_person_id())$$,
  $$person_id = (select private.current_person_id())$$);

revoke insert, update on app.saved_opportunities from authenticated;
grant insert (opportunity_id), update (deleted_at) on app.saved_opportunities to authenticated;

call private.install_default_retention('app.saved_opportunities', interval '1 year');

-- The caller's own marketplace rows -----------------------------------------------------------------------------------

create view api_external.my_saved_opportunities as
select s.id, s.opportunity_id, s.saved_at,
  (s.opportunity_id in (select private.visible_opportunity_ids())) as is_open
from app.saved_opportunities s
where s.deleted_at is null and s.person_id = private.current_person_id();

call private.describe('api_external.my_saved_opportunities', 'Opportunities the caller saved, newest first by saved_at. A saved listing that is no longer open to them stays listed with is_open false and its details hidden.', array[
  'id', 'Saved opportunity.', 'opportunity_id', 'Opportunity.', 'saved_at', 'When saved.',
  'is_open', 'True while the opportunity is open to the caller; its details read from api_external.opportunities.']);

create view api_external.my_saved_searches as
select s.id, s.org_id, s.name, s.role_type, s.role_code, s.cat_urid, s.jurisdiction_id, s.starts_after, s.ends_before,
  s.min_rate_minor, s.currency_code, s.alerts_enabled, s.created_at
from app.saved_searches s
where s.deleted_at is null and s.person_id = private.current_person_id();

call private.describe('api_external.my_saved_searches', 'The caller''s saved marketplace searches and their alert switch (Section 4.4.3).', array[
  'id', 'Saved search.', 'org_id', 'White-label org the search is limited to; NULL for the whole marketplace.', 'name', 'Name.',
  'role_type', 'Role type filter.', 'role_code', 'Canon role filter.', 'cat_urid', 'Canon category filter.',
  'jurisdiction_id', 'Jurisdiction filter.', 'starts_after', 'Earliest start.', 'ends_before', 'Latest end.',
  'min_rate_minor', 'Minimum pay in minor units.', 'currency_code', 'Currency of the minimum.', 'alerts_enabled', 'True when alerts are on.',
  'created_at', 'When saved.']);

create view api_external.my_opportunity_alerts as
select a.id, a.saved_search_id, a.opportunity_id, a.matched_at, a.delivered_at,
  (a.opportunity_id in (select private.visible_opportunity_ids())) as is_open
from app.opportunity_alerts a
join app.saved_searches s on s.id = a.saved_search_id and s.deleted_at is null
where a.deleted_at is null and s.person_id = private.current_person_id();

call private.describe('api_external.my_opportunity_alerts', 'Matches of the caller''s saved searches. A match whose listing is no longer open to them keeps is_open false.', array[
  'id', 'Alert.', 'saved_search_id', 'Saved search.', 'opportunity_id', 'Matched opportunity.', 'matched_at', 'When matched.',
  'delivered_at', 'When delivered.', 'is_open', 'True while the opportunity is open to the caller.']);

create view api_external.my_application_answers as
select x.id, x.application_id, x.opportunity_question_id, x.answer_text
from app.application_answers x
where x.deleted_at is null and x.application_id in (select private.my_application_ids());

call private.describe('api_external.my_application_answers', 'Answers on the caller''s applications: their own, their account''s, or a represented artist''s with the Offers scope.', array[
  'id', 'Answer.', 'application_id', 'Application.', 'opportunity_question_id', 'Question answered.', 'answer_text', 'Answer.']);

create view api_external.my_agency_slates as
select sl.id, sl.application_id, sl.person_id, p.full_name as person_name, sl.opportunity_position_id
from app.agency_slates sl
join app.people p on p.id = sl.person_id
where sl.deleted_at is null and sl.application_id in (select private.my_application_ids());

call private.describe('api_external.my_agency_slates', 'Staff the caller''s agency put forward on its applications.', array[
  'id', 'Slate entry.', 'application_id', 'Agency application.', 'person_id', 'Staff member.', 'person_name', 'Staff member name.',
  'opportunity_position_id', 'Position put forward for.']);

create view api_external.my_availability_calendars as
select c.id, c.org_id, o.name as org_name, c.time_zone, c.visibility
from app.availability_calendars c
left join app.organizations o on o.id = c.org_id
where c.deleted_at is null and c.person_id = private.current_person_id();

call private.describe('api_external.my_availability_calendars', 'The caller''s availability calendars: their own and those kept for one org.', array[
  'id', 'Calendar.', 'org_id', 'Org the calendar is kept for; NULL for the person''s own.', 'org_name', 'Org name.',
  'time_zone', 'IANA time zone.', 'visibility', 'Private, Shared on Application or Public.']);

create view api_external.my_certifications as
select h.id, h.certification_id, c.name as certification_name, c.issuing_body, h.org_id, o.name as org_name, h.issued_on, h.expires_on,
  (h.expires_on is null or h.expires_on >= current_date) as is_current, h.public_verification_consented
from app.certification_holders h
join app.certifications c on c.id = h.certification_id
join app.organizations o on o.id = h.org_id
where h.deleted_at is null and h.person_id = private.current_person_id();

call private.describe('api_external.my_certifications', 'Certifications the caller holds, as each recording org verified them, with whether they are current. Used for the requirements check before applying.', array[
  'id', 'Holding.', 'certification_id', 'Certification.', 'certification_name', 'Certification name.', 'issuing_body', 'Issuing body.',
  'org_id', 'Org that recorded and verified it.', 'org_name', 'Org name.', 'issued_on', 'Day issued.', 'expires_on', 'Day it expires.',
  'is_current', 'True when not expired.', 'public_verification_consented', 'True when the caller consents to public verification.']);

-- Opportunity detail additions (columns appended; the 0750 columns are unchanged) ------------------------------------------

create or replace view api_external.opportunities as
select op.id, op.org_id, o.name as org_name, op.title, op.description, op.role_type, op.role_code, op.cat_urid,
  v.name as venue_name, op.jurisdiction_id, op.starts_on, op.ends_on, op.visibility, op.rate_type,
  op.pay_min_minor, op.pay_max_minor, op.currency_code, (op.rate_type is null) as rate_on_request,
  op.deadline_at, op.minimum_age, op.opportunity_state,
  (select count(*) from app.opportunity_positions pp where pp.opportunity_id = op.id and pp.deleted_at is null) as position_count,
  v.locality as venue_locality
from app.opportunities op
join app.organizations o on o.id = op.org_id
left join app.venues v on v.id = op.venue_id
where op.deleted_at is null
  and (op.id in (select private.visible_opportunity_ids())
    or op.id in (select a.opportunity_id from app.applications a where a.id in (select private.my_application_ids())));

comment on column api_external.opportunities.venue_locality is 'City or locality of the venue.';

create or replace function private.holds_certification(p_certification_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_certification_id is not null and exists (
    select 1 from app.certification_holders h
    where h.certification_id = p_certification_id and h.person_id = private.current_person_id() and h.deleted_at is null
      and (h.expires_on is null or h.expires_on >= current_date));
$$;

comment on function private.holds_certification(uuid) is 'True when the signed-in person holds the certification, unexpired.';

create or replace view api_external.opportunity_requirements as
select rq.id, rq.opportunity_id, rq.requirement_kind, rq.description, ce.name as certification_name, rq.insurance_minimum_minor, rq.currency_code,
  rq.certification_id, case when rq.requirement_kind = 'Certification' then private.holds_certification(rq.certification_id) end as caller_holds
from app.opportunity_requirements rq
left join app.certifications ce on ce.id = rq.certification_id
where rq.deleted_at is null and rq.opportunity_id in (select x.id from api_external.opportunities x);

comment on column api_external.opportunity_requirements.certification_id is 'Certification required; Certification requirements only.';
comment on column api_external.opportunity_requirements.caller_holds is 'For a Certification requirement, true when the caller holds it unexpired; NULL for other kinds.';

-- Privileges ------------------------------------------------------------------------------------------------------------------

revoke all on function private.guard_saved_opportunity() from public, anon, authenticated;
revoke all on function private.holds_certification(uuid) from public, anon;
grant execute on function private.holds_certification(uuid) to authenticated, service_role;

revoke all on api_external.my_saved_opportunities, api_external.my_saved_searches, api_external.my_opportunity_alerts,
  api_external.my_application_answers, api_external.my_agency_slates, api_external.my_availability_calendars,
  api_external.my_certifications from public, anon;
grant select on api_external.my_saved_opportunities, api_external.my_saved_searches, api_external.my_opportunity_alerts,
  api_external.my_application_answers, api_external.my_agency_slates, api_external.my_availability_calendars,
  api_external.my_certifications to authenticated, service_role;
