-- 0764_offers.sql
-- A28 Engagements and Marketplace (RRR-30), Gateway group 3 and Section 4.4.4 stage 5 (Offer: terms issued;
-- accepted, countered or declined). The platform's one offers table (orchestrator decision, RRR-71: requisition
-- hires reach an offer through opportunity, application, offer):
--   * app.offers with the Offer lifecycle and its ledger, one live offer per application
--   * app.offer_versions: append-only terms, each version proposed by one side; the latest version is the one in
--     force and says whose turn it is
--   * RPCs: the org sends, revises after a counter, accepts a counter or withdraws; the party counters, accepts or
--     declines. Each keeps the application state in step (Offered, Accepted, Declined, Not Selected)
--   * an application with an offer reaches Accepted only through an accepted offer
--   * api_external.offers, api_external.offer_versions and api_external.my_given_ratings for Gateway

-- Lifecycle ----------------------------------------------------------------------------------------------------------

create type app.offer_state as enum ('Sent', 'Countered', 'Accepted', 'Declined', 'Withdrawn', 'Expired');
comment on type app.offer_state is 'Offer lifecycle (Section 4.4.4 stage 5): Sent awaits the party, Countered awaits the org; Accepted, Declined, Withdrawn and Expired are final.';

create type app.offer_side as enum ('Organization', 'Party');
comment on type app.offer_side is 'Which side proposed an offer version: the org or the applicant side.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('offer', 'Sent', 'Countered'),
  ('offer', 'Sent', 'Accepted'),
  ('offer', 'Sent', 'Declined'),
  ('offer', 'Sent', 'Withdrawn'),
  ('offer', 'Sent', 'Expired'),
  ('offer', 'Countered', 'Sent'),
  ('offer', 'Countered', 'Accepted'),
  ('offer', 'Countered', 'Withdrawn'),
  ('offer', 'Countered', 'Expired'),
  -- An org that withdraws its offer ends the selection for that applicant.
  ('application', 'Offered', 'Not Selected');

insert into private.domain_event_types (code, subject, description) values
  ('offer.state_changed', 'offers', 'An offer was countered, revised, accepted, declined, withdrawn or expired.');

-- Tables -------------------------------------------------------------------------------------------------------------------

create table app.offers (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  application_id uuid not null references app.applications (id),
  offer_state app.offer_state not null default 'Sent',
  deleted_at timestamptz
);

create index offers_application_id_idx on app.offers (application_id);
create unique index offers_live_key on app.offers (application_id) where deleted_at is null and offer_state in ('Sent', 'Countered', 'Accepted');

call private.install_domain_table('app.offers', 'app.applications', 'application_id');
call private.describe('app.offers', 'Offers on applications (Section 4.4.4 stage 5). One live offer per application. Terms live in app.offer_versions; the latest version is in force.', array[
  'application_id', 'Application the offer answers.',
  'offer_state', 'Offer state. Changes only through the offer RPCs.'
]);

create table app.offer_versions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  offer_id uuid not null references app.offers (id),
  version_number integer not null default 0,
  proposed_side app.offer_side not null,
  proposed_by uuid references app.people (id),
  rate_type app.rate_type,
  amount_minor bigint,
  currency_code char(3) references private.currencies (currency_code),
  starts_on date,
  ends_on date,
  message text,
  expires_at timestamptz,
  constraint offer_versions_amount check ((amount_minor is null) = (currency_code is null) and (amount_minor is null or amount_minor >= 0)),
  constraint offer_versions_amount_needs_rate check (amount_minor is null or (rate_type is not null and rate_type <> 'Bid')),
  constraint offer_versions_dates check (ends_on is null or starts_on is null or ends_on >= starts_on),
  constraint offer_versions_message_length check (message is null or char_length(btrim(message)) between 1 and 4000)
);

create index offer_versions_offer_idx on app.offer_versions (offer_id, version_number);
create index offer_versions_proposed_by_idx on app.offer_versions (proposed_by);
create index offer_versions_currency_code_idx on app.offer_versions (currency_code);
create unique index offer_versions_number_key on app.offer_versions (offer_id, version_number);

call private.install_domain_table('app.offer_versions', 'app.offers', 'offer_id', '{}', true);
call private.describe('app.offer_versions', 'Append-only terms of an offer, one row per proposal or counter, numbered by the database. Both sides read every version; nothing internal is stored here.', array[
  'offer_id', 'Offer.',
  'version_number', 'Version within the offer, issued by the database; the highest is in force.',
  'proposed_side', 'Organization or Party.',
  'proposed_by', 'Person who proposed it, set from the session.',
  'rate_type', 'Hourly, Day, Flat or Milestone.',
  'amount_minor', 'Offered amount per rate unit in minor units; NULL when the version leaves the amount open.',
  'currency_code', 'ISO 4217 currency of the amount.',
  'starts_on', 'First day of the work offered.',
  'ends_on', 'Last day of the work offered.',
  'message', 'Message to the other side with the terms. Visible to both sides.',
  'expires_at', 'When the version lapses unanswered.'
]);

call private.install_lifecycle('app.offers', 'offer_id', 'offer_state', 'offer', 'Sent',
  $$offer_id in (select o.id from app.offers o where o.application_id in (select private.internal_application_ids('opportunities.application.read'))
    or o.application_id in (select private.my_application_ids()))$$);

create trigger t90_emit_offer_state after insert on app.offer_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('offer.state_changed', 'offers', 'offer_id', 'from_state', 'to_state');

create or replace function private.number_offer_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.version_number := coalesce((select max(v.version_number) from app.offer_versions v where v.offer_id = new.offer_id), 0) + 1;
  new.proposed_by := private.current_person_id();
  return new;
end;
$$;

comment on function private.number_offer_version() is 'Numbers offer versions within their offer and stamps the proposer from the session.';

create trigger t40_number_offer_version before insert on app.offer_versions
  for each row execute function private.number_offer_version();

-- Accepted only through an accepted offer ------------------------------------------------------------------------------------

create or replace function private.guard_application_offer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.application_state = 'Accepted' and old.application_state <> 'Accepted'
     and exists (select 1 from app.offers o where o.application_id = new.id and o.deleted_at is null)
     and not exists (select 1 from app.offers o where o.application_id = new.id and o.deleted_at is null and o.offer_state = 'Accepted') then
    perform private.refuse('offer_not_accepted', 'Accept the offer in force to accept this application.');
  end if;
  return new;
end;
$$;

comment on function private.guard_application_offer() is 'An application that carries an offer becomes Accepted only once that offer is Accepted, so the terms in force are always the terms agreed.';

create trigger t48_guard_application_offer before update of application_state on app.applications
  for each row execute function private.guard_application_offer();

create or replace function private.close_offer_on_withdrawal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offer app.offers;
begin
  select o.* into v_offer from app.offers o
  where o.application_id = new.id and o.deleted_at is null and o.offer_state in ('Sent', 'Countered');
  if v_offer.id is not null then
    perform private.transition_lifecycle('offer', 'app.offers', 'offer_state', 'app.offer_state_transitions', 'offer_id',
      v_offer.id, v_offer.offer_state::text, case v_offer.offer_state when 'Sent' then 'Declined' else 'Withdrawn' end,
      'The applicant withdrew the application.');
  end if;
  return null;
end;
$$;

comment on function private.close_offer_on_withdrawal() is 'When the applicant side withdraws an application, its open offer closes: Declined while awaiting the applicant, Withdrawn while awaiting the org.';

create trigger t86_close_offer_on_withdrawal after update of application_state on app.applications
  for each row when (new.application_state = 'Withdrawn' and old.application_state <> 'Withdrawn')
  execute function private.close_offer_on_withdrawal();

-- Policies ---------------------------------------------------------------------------------------------------------------------

call private.install_policies('app.offers',
  $$application_id in (select private.internal_application_ids('opportunities.application.read'))
    or application_id in (select private.my_application_ids())$$);

create or replace function private.readable_offer_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select o.id from app.offers o
  where o.application_id in (select private.internal_application_ids('opportunities.application.read'))
     or o.application_id in (select private.my_application_ids());
$$;

comment on function private.readable_offer_ids() is 'Offers the signed-in person reads: on applications they read for the org, or hold on the applicant side.';

call private.install_policies('app.offer_versions',
  $$offer_id in (select private.readable_offer_ids())$$);

-- RPCs ---------------------------------------------------------------------------------------------------------------------------

create or replace function private.offer_context(p_offer_id uuid)
returns table (offer app.offers, application app.applications, project_id uuid, latest app.offer_versions)
language sql
stable
security definer
set search_path = ''
as $$
  select o, a, op.project_id,
    (select v from app.offer_versions v where v.offer_id = o.id order by v.version_number desc limit 1)
  from app.offers o
  join app.applications a on a.id = o.application_id
  join app.opportunities op on op.id = a.opportunity_id
  where o.id = p_offer_id and o.deleted_at is null;
$$;

comment on function private.offer_context(uuid) is 'An offer with its application, project and the version in force.';

create or replace function private.add_offer_version(
  p_offer_id uuid, p_side app.offer_side, p_rate_type app.rate_type, p_amount_minor bigint, p_currency_code text,
  p_starts_on date, p_ends_on date, p_message text, p_expires_at timestamptz)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_expires_at is not null and p_expires_at <= now() then
    perform private.refuse('offer_expiry_past', 'An offer expires in the future.');
  end if;
  insert into app.offer_versions (offer_id, proposed_side, rate_type, amount_minor, currency_code, starts_on, ends_on, message, expires_at)
  values (p_offer_id, p_side, p_rate_type, p_amount_minor, p_currency_code, p_starts_on, p_ends_on, nullif(btrim(p_message), ''), p_expires_at)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function private.add_offer_version(uuid, app.offer_side, app.rate_type, bigint, text, date, date, text, timestamptz) is 'Appends a version of terms to an offer; expiry must be in the future.';

create or replace function private.assert_offer_turn(p_latest app.offer_versions, p_side app.offer_side)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_latest.proposed_side = p_side then
    perform private.refuse('offer_not_your_turn', 'The other side has not answered these terms yet.');
  end if;
  if p_latest.expires_at is not null and p_latest.expires_at <= pg_catalog.now() then
    perform private.refuse('offer_expired', 'These terms have expired; ask for new terms.');
  end if;
end;
$$;

comment on function private.assert_offer_turn(app.offer_versions, app.offer_side) is 'Refuses a response to an offer by the side that proposed the terms in force, and any response after those terms expired.';

create or replace function private.assert_applicant_side(p_application_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from private.my_application_ids() x where x = p_application_id) then
    raise exception using errcode = '42501', message = 'only the applicant side answers an offer';
  end if;
end;
$$;

comment on function private.assert_applicant_side(uuid) is 'Raises 42501 unless the signed-in person holds the application on the applicant side.';

create or replace function private.assert_offer_sender(p_project_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.can_on_project(p_project_id, 'opportunities.offer.send') then
    raise exception using errcode = '42501', message = 'opportunities.offer.send is required on the project';
  end if;
end;
$$;

comment on function private.assert_offer_sender(uuid) is 'Raises 42501 unless the signed-in member holds opportunities.offer.send on the project.';

create or replace function app.send_offer(
  p_application_id uuid, p_rate_type app.rate_type, p_amount_minor bigint, p_currency_code text,
  p_starts_on date, p_ends_on date, p_message text, p_expires_at timestamptz)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_app app.applications;
  v_project uuid;
  v_offer uuid;
begin
  perform private.require_person();
  select a.* into v_app from app.applications a where a.id = p_application_id and a.deleted_at is null;
  select o.project_id into v_project from app.opportunities o where o.id = v_app.opportunity_id;
  if v_app.id is null then
    raise exception using errcode = '42501', message = 'application not found';
  end if;
  perform private.assert_offer_sender(v_project);
  if v_app.application_state not in ('In Review', 'Shortlisted') then
    perform private.refuse('offer_application_state', 'Offers go to applications In Review or Shortlisted.');
  end if;
  if exists (select 1 from private.my_application_ids() x where x = p_application_id) then
    perform private.refuse('sod_offer_self', 'A person cannot send an offer on their own application.');
  end if;
  insert into app.offers (application_id) values (p_application_id) returning id into v_offer;
  perform private.add_offer_version(v_offer, 'Organization', p_rate_type, p_amount_minor, p_currency_code, p_starts_on, p_ends_on, p_message, p_expires_at);
  perform private.transition_lifecycle('application', 'app.applications', 'application_state', 'app.application_state_transitions',
    'application_id', p_application_id, v_app.application_state::text, 'Offered', 'Offer sent.');
  return v_offer;
end;
$$;

comment on function app.send_offer(uuid, app.rate_type, bigint, text, date, date, text, timestamptz) is 'The org sends an offer on an application In Review or Shortlisted (opportunities.offer.send on the project): creates the offer with its first terms and moves the application to Offered. Returns the offer id.';

create or replace function app.counter_offer(
  p_offer_id uuid, p_rate_type app.rate_type, p_amount_minor bigint, p_currency_code text,
  p_starts_on date, p_ends_on date, p_message text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c record;
begin
  perform private.require_person();
  select * into c from private.offer_context(p_offer_id);
  if (c.offer).id is null then
    raise exception using errcode = '42501', message = 'offer not found';
  end if;
  perform private.assert_applicant_side((c.application).id);
  perform private.assert_offer_turn(c.latest, 'Party');
  perform private.transition_lifecycle('offer', 'app.offers', 'offer_state', 'app.offer_state_transitions', 'offer_id',
    p_offer_id, (c.offer).offer_state::text, 'Countered', 'Countered by the applicant.');
  return private.add_offer_version(p_offer_id, 'Party', p_rate_type, p_amount_minor, p_currency_code, p_starts_on, p_ends_on, p_message, null);
end;
$$;

comment on function app.counter_offer(uuid, app.rate_type, bigint, text, date, date, text) is 'The applicant side counters the terms in force with its own (Section 4.4.4 stage 5). Returns the new version id.';

create or replace function app.revise_offer(
  p_offer_id uuid, p_rate_type app.rate_type, p_amount_minor bigint, p_currency_code text,
  p_starts_on date, p_ends_on date, p_message text, p_expires_at timestamptz)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c record;
begin
  perform private.require_person();
  select * into c from private.offer_context(p_offer_id);
  if (c.offer).id is null then
    raise exception using errcode = '42501', message = 'offer not found';
  end if;
  perform private.assert_offer_sender(c.project_id);
  perform private.assert_offer_turn(c.latest, 'Organization');
  perform private.transition_lifecycle('offer', 'app.offers', 'offer_state', 'app.offer_state_transitions', 'offer_id',
    p_offer_id, (c.offer).offer_state::text, 'Sent', 'Revised terms sent.');
  return private.add_offer_version(p_offer_id, 'Organization', p_rate_type, p_amount_minor, p_currency_code, p_starts_on, p_ends_on, p_message, p_expires_at);
end;
$$;

comment on function app.revise_offer(uuid, app.rate_type, bigint, text, date, date, text, timestamptz) is 'The org answers a counter with revised terms (opportunities.offer.send). Returns the new version id.';

create or replace function app.accept_offer(p_offer_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c record;
  v_side app.offer_side;
begin
  perform private.require_person();
  select * into c from private.offer_context(p_offer_id);
  if (c.offer).id is null then
    raise exception using errcode = '42501', message = 'offer not found';
  end if;
  if exists (select 1 from private.my_application_ids() x where x = (c.application).id) then
    v_side := 'Party';
  else
    perform private.assert_offer_sender(c.project_id);
    v_side := 'Organization';
  end if;
  perform private.assert_offer_turn(c.latest, v_side);
  perform private.transition_lifecycle('offer', 'app.offers', 'offer_state', 'app.offer_state_transitions', 'offer_id',
    p_offer_id, (c.offer).offer_state::text, 'Accepted', case v_side when 'Party' then 'Accepted by the applicant.' else 'Counter accepted by the org.' end);
  perform private.transition_lifecycle('application', 'app.applications', 'application_state', 'app.application_state_transitions',
    'application_id', (c.application).id, 'Offered', 'Accepted', 'Offer accepted.');
end;
$$;

comment on function app.accept_offer(uuid) is 'Accepts the terms in force: the applicant side accepts the org''s terms, or the org (opportunities.offer.send) accepts a counter. Moves the offer and the application to Accepted; the engagement is created from it next (Section 4.4.4 stage 6).';

create or replace function app.decline_offer(p_offer_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c record;
begin
  perform private.require_person();
  select * into c from private.offer_context(p_offer_id);
  if (c.offer).id is null then
    raise exception using errcode = '42501', message = 'offer not found';
  end if;
  perform private.assert_applicant_side((c.application).id);
  perform private.assert_offer_turn(c.latest, 'Party');
  perform private.transition_lifecycle('offer', 'app.offers', 'offer_state', 'app.offer_state_transitions', 'offer_id',
    p_offer_id, (c.offer).offer_state::text, 'Declined', p_reason);
  perform private.transition_lifecycle('application', 'app.applications', 'application_state', 'app.application_state_transitions',
    'application_id', (c.application).id, 'Offered', 'Declined', p_reason);
end;
$$;

comment on function app.decline_offer(uuid, text) is 'The applicant side declines the org''s terms; the offer and the application become Declined.';

create or replace function app.withdraw_offer(p_offer_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c record;
begin
  perform private.require_person();
  select * into c from private.offer_context(p_offer_id);
  if (c.offer).id is null then
    raise exception using errcode = '42501', message = 'offer not found';
  end if;
  perform private.assert_offer_sender(c.project_id);
  perform private.transition_lifecycle('offer', 'app.offers', 'offer_state', 'app.offer_state_transitions', 'offer_id',
    p_offer_id, (c.offer).offer_state::text, 'Withdrawn', p_reason);
  perform private.transition_lifecycle('application', 'app.applications', 'application_state', 'app.application_state_transitions',
    'application_id', (c.application).id, 'Offered', 'Not Selected', p_reason);
end;
$$;

comment on function app.withdraw_offer(uuid, text) is 'The org withdraws an offer that is Sent or Countered (opportunities.offer.send); the application becomes Not Selected.';

create or replace function app.expire_offers()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
  v_count integer := 0;
begin
  if auth.uid() is not null then
    raise exception using errcode = '42501', message = 'offers expire through the platform job';
  end if;
  for v in
    select o.id, o.offer_state, o.application_id from app.offers o
    where o.deleted_at is null and o.offer_state in ('Sent', 'Countered')
      and (select lv.expires_at from app.offer_versions lv where lv.offer_id = o.id order by lv.version_number desc limit 1) <= now()
  loop
    perform private.transition_lifecycle('offer', 'app.offers', 'offer_state', 'app.offer_state_transitions', 'offer_id',
      v.id, v.offer_state::text, 'Expired', 'The terms lapsed unanswered.');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function app.expire_offers() is 'Platform job (service role): offers whose terms in force lapsed unanswered become Expired. The application stays Offered so the org can send new terms or withdraw.';

-- Gateway projections --------------------------------------------------------------------------------------------------------------

create view api_external.offers as
select o.id, o.application_id, a.opportunity_id, o.offer_state, o.created_at as sent_at
from app.offers o
join app.applications a on a.id = o.application_id
where o.deleted_at is null and o.application_id in (select private.my_application_ids());

call private.describe('api_external.offers', 'Offers on the caller''s applications: their own, their account''s, or a represented artist''s with the Offers scope.', array[
  'id', 'Offer.', 'application_id', 'Application.', 'opportunity_id', 'Opportunity.', 'offer_state', 'Offer state.', 'sent_at', 'When the first terms were sent.']);

create view api_external.offer_versions as
select v.id, v.offer_id, v.version_number, v.proposed_side, v.rate_type, v.amount_minor, v.currency_code, v.starts_on, v.ends_on,
  v.message, v.expires_at, v.created_at as proposed_at
from app.offer_versions v
join app.offers o on o.id = v.offer_id and o.deleted_at is null
where o.application_id in (select private.my_application_ids());

call private.describe('api_external.offer_versions', 'Every version of the terms of the caller''s offers, highest version in force. Who proposed on the org side never appears.', array[
  'id', 'Version.', 'offer_id', 'Offer.', 'version_number', 'Version number.', 'proposed_side', 'Organization or Party.',
  'rate_type', 'Rate type.', 'amount_minor', 'Amount in minor units; NULL when left open.', 'currency_code', 'Currency.',
  'starts_on', 'First day.', 'ends_on', 'Last day.', 'message', 'Message with the terms.', 'expires_at', 'When the terms lapse.',
  'proposed_at', 'When proposed.']);

create view api_external.my_given_ratings as
select r.id, r.engagement_id, r.org_id, o.name as org_name, r.score, r.comment, r.submitted_at, private.rating_released(r.engagement_id) as is_released
from app.ratings r
join app.organizations o on o.id = r.org_id
where r.deleted_at is null and r.rater_side = 'Party' and r.engagement_id in (select private.my_party_engagement_ids());

call private.describe('api_external.my_given_ratings', 'Ratings the caller''s side gave orgs after completed engagements, released or still held until the org rates too or 14 days pass.', array[
  'id', 'Rating.', 'engagement_id', 'Engagement.', 'org_id', 'Org rated.', 'org_name', 'Org name.', 'score', 'Score from 1 to 5.',
  'comment', 'Public comment.', 'submitted_at', 'When given.', 'is_released', 'True once both ratings show.']);

-- Retention, audit and privileges -------------------------------------------------------------------------------------------------------

call private.install_default_retention('app.offers');
call private.install_default_retention('app.offer_versions');
call private.install_default_retention('app.offer_state_transitions');
call private.install_audit_trail('app.offers');

revoke insert, update on app.offers, app.offer_versions from authenticated;

revoke all on function private.number_offer_version() from public, anon, authenticated;
revoke all on function private.guard_application_offer() from public, anon, authenticated;
revoke all on function private.close_offer_on_withdrawal() from public, anon, authenticated;
revoke all on function private.offer_context(uuid) from public, anon, authenticated;
revoke all on function private.add_offer_version(uuid, app.offer_side, app.rate_type, bigint, text, date, date, text, timestamptz) from public, anon, authenticated;
revoke all on function private.assert_offer_turn(app.offer_versions, app.offer_side) from public, anon, authenticated;
revoke all on function private.assert_applicant_side(uuid) from public, anon, authenticated;
revoke all on function private.assert_offer_sender(uuid) from public, anon, authenticated;
revoke all on function private.readable_offer_ids() from public, anon;
grant execute on function private.readable_offer_ids() to authenticated, service_role;

revoke all on function app.send_offer(uuid, app.rate_type, bigint, text, date, date, text, timestamptz) from public, anon;
revoke all on function app.counter_offer(uuid, app.rate_type, bigint, text, date, date, text) from public, anon;
revoke all on function app.revise_offer(uuid, app.rate_type, bigint, text, date, date, text, timestamptz) from public, anon;
revoke all on function app.accept_offer(uuid) from public, anon;
revoke all on function app.decline_offer(uuid, text) from public, anon;
revoke all on function app.withdraw_offer(uuid, text) from public, anon;
revoke all on function app.expire_offers() from public, anon, authenticated;
grant execute on function app.send_offer(uuid, app.rate_type, bigint, text, date, date, text, timestamptz) to authenticated, service_role;
grant execute on function app.counter_offer(uuid, app.rate_type, bigint, text, date, date, text) to authenticated, service_role;
grant execute on function app.revise_offer(uuid, app.rate_type, bigint, text, date, date, text, timestamptz) to authenticated, service_role;
grant execute on function app.accept_offer(uuid) to authenticated, service_role;
grant execute on function app.decline_offer(uuid, text) to authenticated, service_role;
grant execute on function app.withdraw_offer(uuid, text) to authenticated, service_role;
grant execute on function app.expire_offers() to service_role;

revoke all on api_external.offers, api_external.offer_versions, api_external.my_given_ratings from public, anon;
grant select on api_external.offers, api_external.offer_versions, api_external.my_given_ratings to authenticated, service_role;
