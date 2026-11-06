-- 6145_person_rating_privacy.sql
-- RRR-248, ADR 0156. A rating an org gives a named person may be a consumer report once another org can read it on a
-- platform used for hiring (15 U.S.C. 1681a), so an org's rating of a person stays with the org that gave it:
--   * private.rating_is_of_individual says when an org's rating is of a person: the engagement names a person and either
--     has no engaged account or is for crew, staff, a contractor or an artist. A vendor, client, sponsor or agency engaged
--     through an account is a company, whoever its named contact is, and its ratings read as before.
--   * private.my_rated_engagement_ids and private.internal_rating_engagement_ids say who reads an org's rating of the
--     party. For an individual the readers are that person and members of the org that gave it, not a partner org on a
--     shared project and not an account that supplied the person.
--   * app.ratings, app.rating_replies and api_external.ratings apply that rule. The view returned every released
--     rating to anyone signed in; now it returns a person's rating only to those readers, with no opt-in path, so no
--     list, sort, filter or score across orgs can be built from it.
--   * app.rating_sharing_consents records a person's own opt-in, off by default, withdrawn at any time, all ratings
--     or none. api_public.person_profile_shared_ratings is the only path it opens: one person at a time, in date
--     order, never an average, and never to someone who hires, books or staffs in any org.
--   * app.rating_disputes holds the rated person's dispute of a rating, which a platform operator decides on grounds
--     that ignore the score (6146 holds its RPCs). An upheld dispute takes the rating out of every read while the row
--     itself stays unedited as evidence.
-- The rule looks only at who is asking and which engagement the rating came from, never at the score or the comment.
-- Ratings stay always on and an org's prompt setting still hides nothing (ADR 0038).

-- Disputes -----------------------------------------------------------------------------------------------------------

create type app.rating_dispute_state as enum ('Open', 'Upheld', 'Not Upheld');
comment on type app.rating_dispute_state is 'A rated person''s dispute of a rating: Open until a platform operator upholds it, which removes the rating, or does not.';

create type app.rating_dispute_ground as enum ('Wrong Person', 'False Statement', 'Abusive Content', 'Personal Data', 'Other');
comment on type app.rating_dispute_ground is 'Why a rating is disputed. Other is for filing only: an operator upholds a dispute only on one of the named grounds, none of which is a low score or an unfavorable opinion (ADR 0156).';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('rating_dispute', 'Open', 'Upheld'),
  ('rating_dispute', 'Open', 'Not Upheld');

create table app.rating_disputes (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  rating_id uuid not null references app.ratings (id),
  disputant_person_id uuid not null references app.people (id),
  dispute_ground app.rating_dispute_ground not null,
  details text not null,
  dispute_state app.rating_dispute_state not null default 'Open',
  filed_at timestamptz not null default now(),
  org_response text,
  org_responded_by uuid references app.people (id),
  org_responded_at timestamptz,
  decision_ground app.rating_dispute_ground,
  decision_statement text,
  decided_by uuid references app.people (id),
  decided_at timestamptz,
  deleted_at timestamptz,
  constraint rating_disputes_details_length check (char_length(btrim(details)) between 1 and 4000),
  constraint rating_disputes_response_length check (org_response is null or char_length(btrim(org_response)) between 1 and 4000),
  constraint rating_disputes_response_parts check (
    (org_response is null) = (org_responded_at is null) and (org_response is null) = (org_responded_by is null)),
  constraint rating_disputes_statement_length check (decision_statement is null or char_length(btrim(decision_statement)) between 1 and 4000),
  constraint rating_disputes_decision_parts check (
    (decided_at is null) = (decided_by is null) and (decided_at is null) = (decision_statement is null)),
  constraint rating_disputes_decided_state check (decided_at is null or dispute_state <> 'Open'),
  constraint rating_disputes_ground_fits check (
    decision_ground is null or (dispute_state = 'Upheld' and decision_ground <> 'Other')),
  constraint rating_disputes_not_own check (decided_by is distinct from disputant_person_id)
);

-- A person may dispute a rating about them even after the org that gave it stops using XOS.
insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.rating_disputes', 'A rated person may still dispute a rating, and an operator still decides, while the rating org is read-only.'),
  ('app.rating_dispute_state_transitions', 'The ledger of a dispute follows the dispute while the rating org is read-only.');

call private.install_domain_table('app.rating_disputes', 'app.ratings', 'rating_id');
drop trigger if exists t15_refuse_read_only_org on app.rating_disputes;

create unique index rating_disputes_one_per_rating on app.rating_disputes (rating_id) where deleted_at is null;
create index rating_disputes_disputant_idx on app.rating_disputes (disputant_person_id);
create index rating_disputes_decided_by_idx on app.rating_disputes (decided_by);
create index rating_disputes_org_responded_by_idx on app.rating_disputes (org_responded_by);
create index rating_disputes_open_idx on app.rating_disputes (filed_at) where dispute_state = 'Open' and deleted_at is null;

call private.describe('app.rating_disputes', 'A rated person''s dispute of an org''s rating of them (ADR 0156). The org that gave the rating may answer once; a platform operator decides. Written only through the dispute RPCs. A dispute does not hide the rating while it is open, so filing one suppresses nothing.', array[
  'rating_id', 'Rating disputed.',
  'disputant_person_id', 'Rated person who disputes it, from the session.',
  'dispute_ground', 'Ground the person gave.',
  'details', 'What the person says is wrong.',
  'dispute_state', 'Open, Upheld or Not Upheld.',
  'filed_at', 'When the dispute was filed, set by the database.',
  'org_response', 'The rating org''s one answer.',
  'org_responded_by', 'Member who answered for the org, from the session.',
  'org_responded_at', 'When the org answered, set by the database.',
  'decision_ground', 'Ground on which an operator upheld the dispute; NULL otherwise.',
  'decision_statement', 'The reasons, sent to the person and the rating org.',
  'decided_by', 'Operator who decided, from the session; never the disputant and never shown outside the console.',
  'decided_at', 'When it was decided, set by the database.'
]);

create or replace function private.removed_rating_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.rating_id from app.rating_disputes d where d.dispute_state = 'Upheld' and d.deleted_at is null;
$$;

comment on function private.removed_rating_ids() is 'Ratings removed because a dispute was upheld. The rating row stays unedited as evidence; every read leaves it out.';
revoke all on function private.removed_rating_ids() from public, anon;
grant execute on function private.removed_rating_ids() to authenticated, service_role;

-- Who a rating is about ----------------------------------------------------------------------------------------------

create or replace function private.rating_is_of_individual(
  p_role_type app.external_role_type,
  p_person_id uuid,
  p_counterparty_id uuid
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_person_id is not null
    and (p_counterparty_id is null or p_role_type in ('Contractor', 'Crew', 'Staff', 'Artist'));
$$;

comment on function private.rating_is_of_individual(app.external_role_type, uuid, uuid) is 'True when an org''s rating on an engagement with these values is of an individual person: it names a person, with no engaged account, or for work a person does themselves. A vendor, client, sponsor or agency engaged through an account is a company even when the engagement names its contact (ADR 0156).';
revoke all on function private.rating_is_of_individual(app.external_role_type, uuid, uuid) from public, anon;
grant execute on function private.rating_is_of_individual(app.external_role_type, uuid, uuid) to authenticated, service_role;

-- Who reads an org's rating of the party -----------------------------------------------------------------------------

create or replace function private.my_rated_engagement_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id from app.engagements e
  left join app.counterparties c on c.id = e.counterparty_id
  where e.deleted_at is null
    and (e.person_id = private.current_person_id()
      or (not private.rating_is_of_individual(e.role_type, e.person_id, e.counterparty_id)
        and c.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))));
$$;

comment on function private.my_rated_engagement_ids() is 'Engagements whose rating by the org is about the signed-in person or their company: the engaged person, and for a company an Account Owner or Admin of the engaged account. An account that supplied an individual does not read that person''s ratings (ADR 0156).';
revoke all on function private.my_rated_engagement_ids() from public, anon;
grant execute on function private.my_rated_engagement_ids() to authenticated, service_role;

create or replace function private.internal_rating_engagement_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id from app.engagements e
  where e.project_id in (select private.project_ids_with('opportunities.engagement.read'))
    and (not private.rating_is_of_individual(e.role_type, e.person_id, e.counterparty_id)
      or e.org_id in (select private.my_org_ids()));
$$;

comment on function private.internal_rating_engagement_ids() is 'Engagements whose rating by the org the signed-in member reads as the org: those they read internally, and for an individual only as a member of the org that gave the rating. A partner on a shared project or a holder of a record grant from another org does not qualify (ADR 0156).';
revoke all on function private.internal_rating_engagement_ids() from public, anon;
grant execute on function private.internal_rating_engagement_ids() to authenticated, service_role;

call private.install_policies('app.ratings',
  $$id not in (select private.removed_rating_ids())
    and ((rater_side = 'Organization' and engagement_id in (select private.internal_rating_engagement_ids()))
      or (rater_side = 'Organization' and engagement_id in (select private.my_rated_engagement_ids())
        and private.rating_released(engagement_id))
      or (rater_side = 'Party' and engagement_id in (select private.my_party_engagement_ids()))
      or (rater_side = 'Party' and engagement_id in (select private.internal_engagement_ids('opportunities.engagement.read'))
        and private.rating_released(engagement_id)))$$);

-- Redefined from 0740: the same rule for the replies, which follow their rating.
create or replace function private.readable_rating_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id from app.ratings r
  where r.deleted_at is null and private.rating_released(r.engagement_id)
    and r.id not in (select private.removed_rating_ids())
    and ((r.rater_side = 'Organization'
          and (r.engagement_id in (select private.internal_rating_engagement_ids())
            or r.engagement_id in (select private.my_rated_engagement_ids())))
      or (r.rater_side = 'Party'
          and (r.engagement_id in (select private.internal_engagement_ids('opportunities.engagement.read'))
            or r.engagement_id in (select private.my_party_engagement_ids()))));
$$;

comment on function private.readable_rating_ids() is 'Released ratings the signed-in person reads directly: an org''s rating of the party as the org or the rated side, and a party''s rating of the org as the org or the party (ADR 0156).';

-- Redefined from 0740: the rated person answers their own rating; the account that supplied them does not.
create or replace function private.guard_rating_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_rating app.ratings;
  v_project uuid;
begin
  if tg_op = 'UPDATE' and (new.rating_id <> old.rating_id or new.body <> old.body) then
    perform private.refuse('rating_reply_immutable', 'A reply is never edited.');
  end if;
  if tg_op = 'UPDATE' then
    return new;
  end if;
  select * into v_rating from app.ratings r where r.id = new.rating_id;
  if not private.rating_released(v_rating.engagement_id) then
    perform private.refuse('rating_not_released', 'A rating can be answered once it is released.');
  end if;
  new.replied_by := v_me;
  if v_me is not null then
    select e.project_id into v_project from app.engagements e where e.id = v_rating.engagement_id;
    if (v_rating.rater_side = 'Organization' and not exists (select 1 from private.my_rated_engagement_ids() x where x = v_rating.engagement_id))
       or (v_rating.rater_side = 'Party' and not private.can_on_project(v_project, 'opportunities.rating.write')) then
      raise exception using errcode = '42501', message = 'only the rated side replies';
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_rating_reply() is 'Replies: only by the rated side (the rated person or company to the org''s rating, the org to the party''s), only once the rating is released, and never edited.';

-- The Gateway projection ---------------------------------------------------------------------------------------------

create or replace view api_external.ratings as
select rt.id, rt.rater_side, rt.score, rt.comment, rt.submitted_at,
  case when rt.rater_side = 'Organization'
    and (e.person_id = private.current_person_id()
      or rt.engagement_id in (select private.internal_rating_engagement_ids())) then e.person_id end as rated_person_id,
  case when rt.rater_side = 'Organization' then c.organization_id else e.org_id end as rated_organization_id,
  case when rt.rater_side = 'Organization' then e.org_id else c.organization_id end as rater_organization_id,
  rr.body as reply, rr.created_at as replied_at,
  rater.name as rater_organization_name,
  rt.rater_side = 'Organization' and private.rating_is_of_individual(e.role_type, e.person_id, e.counterparty_id) as is_of_individual
from app.ratings rt
join app.engagements e on e.id = rt.engagement_id
left join app.counterparties c on c.id = e.counterparty_id
left join app.rating_replies rr on rr.rating_id = rt.id and rr.deleted_at is null
left join app.organizations rater on rater.id = case when rt.rater_side = 'Organization' then e.org_id else c.organization_id end
where rt.deleted_at is null and private.rating_released(rt.engagement_id) and private.current_person_id() is not null
  and rt.id not in (select private.removed_rating_ids())
  and (rt.rater_side = 'Party' or not private.rating_is_of_individual(e.role_type, e.person_id, e.counterparty_id)
    or rt.engagement_id in (select private.my_rated_engagement_ids())
    or rt.engagement_id in (select private.internal_rating_engagement_ids()));

call private.describe('api_external.ratings', 'Released two-sided ratings and their replies (Section 4.4.3). A rating of a company or vendor, or a party''s rating of an org, reads for anyone signed in, without naming the company''s contact. An org''s rating of an individual reads only for that person and members of the org that gave it, opt-in or not (ADR 0156). Internal ratings and org notes never appear.', array[
  'id', 'Rating.', 'rater_side', 'Organization or Party.', 'score', 'Score 1 to 5.', 'comment', 'Comment.',
  'submitted_at', 'When given.', 'rated_person_id', 'Person the engagement names, for an org''s rating; only for that person and the org.',
  'rated_organization_id', 'Organization rated: the engaged account, or the org for a party''s rating.',
  'rater_organization_id', 'Organization that rated: the org, or the engaged account.', 'reply', 'Reply of the rated side.',
  'replied_at', 'When replied.', 'rater_organization_name', 'Name of the organization that rated.',
  'is_of_individual', 'True for an org''s rating of an individual, which that person may dispute.']);

revoke all on api_external.ratings from public, anon;
grant select on api_external.ratings to authenticated, service_role;

-- The person's own opt-in --------------------------------------------------------------------------------------------

create table app.rating_sharing_consents (
  id uuid primary key default private.uuid_v7(),
  person_id uuid not null references app.people (id),
  notice_version text not null,
  source app.consent_source not null,
  captured_at timestamptz not null default now(),
  captured_ip inet,
  withdrawn_at timestamptz,
  constraint rating_sharing_consents_notice_version_length check (char_length(btrim(notice_version)) between 1 and 50),
  constraint rating_sharing_consents_withdrawn_after check (withdrawn_at is null or withdrawn_at >= captured_at)
);

call private.install_person_table('app.rating_sharing_consents');
call private.describe('app.rating_sharing_consents', 'A person''s own opt-in to show organizations'' ratings of them on their profile (ADR 0156). Off until a row stands; one row per grant; a withdrawal closes the row and takes effect at once. It covers every rating or none, so no one can show only the good ones.', array[
  'id', 'Primary key, UUID v7.',
  'person_id', 'Person who chose to show their ratings.',
  'notice_version', 'Version of the notice shown when they chose.',
  'source', 'Where the choice was made.',
  'captured_at', 'When they opted in. Set by the database.',
  'captured_ip', 'Client IP address at the time, as evidence. Set by the database.',
  'withdrawn_at', 'When they withdrew, or null while the opt-in stands.'
]);

create unique index rating_sharing_consents_one_standing on app.rating_sharing_consents (person_id)
  where withdrawn_at is null and deleted_at is null;

create trigger t40_guard_rating_sharing_consent before insert or update on app.rating_sharing_consents
  for each row execute function private.guard_consent_record();

-- Only the RPC below writes these rows, so the record always carries its notice and stamps.
revoke insert, update on app.rating_sharing_consents from authenticated;
call private.install_audit_trail('app.rating_sharing_consents');

create or replace function app.set_rating_sharing(
  p_opt_in boolean,
  p_notice_version text default null,
  p_source app.consent_source default 'Web'
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
begin
  if p_opt_in is null then
    perform private.refuse('rating_sharing_choice', 'Choose whether to show your ratings.');
  end if;
  perform 1 from app.people p where p.id = v_me for update;
  if not p_opt_in then
    update app.rating_sharing_consents set withdrawn_at = now()
    where person_id = v_me and withdrawn_at is null and deleted_at is null;
    return false;
  end if;
  if p_notice_version is null or char_length(btrim(p_notice_version)) not between 1 and 50 then
    perform private.refuse('rating_sharing_notice', 'Showing your ratings needs the version of the notice you saw.');
  end if;
  if not exists (select 1 from app.rating_sharing_consents r
                 where r.person_id = v_me and r.withdrawn_at is null and r.deleted_at is null) then
    insert into app.rating_sharing_consents (person_id, notice_version, source)
    values (v_me, btrim(p_notice_version), coalesce(p_source, 'Web'));
  end if;
  return true;
end;
$$;

comment on function app.set_rating_sharing(boolean, text, app.consent_source) is 'The signed-in person opts in to showing organizations'' ratings of them on their profile, recording the notice version, or withdraws, which takes effect at once. Idempotent both ways (ADR 0156).';
revoke all on function app.set_rating_sharing(boolean, text, app.consent_source) from public, anon;
grant execute on function app.set_rating_sharing(boolean, text, app.consent_source) to authenticated, service_role;

create or replace function private.person_shares_ratings(p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.rating_sharing_consents r
                 where r.person_id = p_person_id and r.withdrawn_at is null and r.deleted_at is null);
$$;

comment on function private.person_shares_ratings(uuid) is 'True while the person''s opt-in to show their ratings stands.';
revoke all on function private.person_shares_ratings(uuid) from public, anon, authenticated;

-- A deleted account withdraws its opt-in; the closed row stays as evidence, naming a person with no name.
create or replace function private.withdraw_rating_sharing_on_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update app.rating_sharing_consents set withdrawn_at = now()
  where person_id = new.id and withdrawn_at is null and deleted_at is null;
  return null;
end;
$$;

comment on function private.withdraw_rating_sharing_on_deletion() is 'When a person record is deleted, closes that person''s opt-in to show their ratings.';
revoke all on function private.withdraw_rating_sharing_on_deletion() from public, anon, authenticated;

create trigger t85_withdraw_rating_sharing after update of deleted_at on app.people
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.withdraw_rating_sharing_on_deletion();

-- Who can never read a shared rating ---------------------------------------------------------------------------------

create or replace function private.hiring_capability_codes()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'opportunities.posting.write', 'opportunities.posting.publish', 'opportunities.application.read',
    'opportunities.application.review', 'opportunities.selection.decide', 'opportunities.offer.send',
    'opportunities.onboarding.write', 'opportunities.engagement.write', 'opportunities.pool.write',
    'people.requisition.write', 'people.requisition.approve', 'people.offer.write', 'people.offer.approve',
    'crew.shift.write']::text[];
$$;

comment on function private.hiring_capability_codes() is 'The capabilities that decide who is hired, booked, selected or put on a shift. A holder of any, in any org or on any project, never reads another org''s rating of a person (ADR 0156). A new capability of that kind joins this list.';
revoke all on function private.hiring_capability_codes() from public, anon, authenticated;

create or replace function private.viewer_decides_hiring()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
      select 1 from unnest(private.hiring_capability_codes()) c (code)
      where exists (select 1 from private.orgs_with_capability(c.code))
        or exists (select 1 from private.project_ids_with(c.code)))
    or exists (select 1 from private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]));
$$;

comment on function private.viewer_decides_hiring() is 'True when the signed-in person holds a capability that decides who is hired, booked or staffed in any org or project, or runs an external account, which may place its people on shifts. Such a viewer never reads a shared rating (ADR 0156).';
revoke all on function private.viewer_decides_hiring() from public, anon, authenticated;

-- The one path an opt-in opens ---------------------------------------------------------------------------------------

create or replace function api_public.person_profile_shared_ratings(p_handle text)
returns table (
  rating_id uuid,
  score smallint,
  comment text,
  submitted_at timestamptz,
  reply text,
  replied_at timestamptz,
  disputed boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.score, r.comment, r.submitted_at, rr.body, rr.created_at,
    exists (select 1 from app.rating_disputes d where d.rating_id = r.id and d.dispute_state = 'Open' and d.deleted_at is null)
  from private.person_profile_by_handle(p_handle) p
  join app.engagements e on e.person_id = p.person_id and e.deleted_at is null
    and private.rating_is_of_individual(e.role_type, e.person_id, e.counterparty_id)
  join app.ratings r on r.engagement_id = e.id and r.rater_side = 'Organization' and r.deleted_at is null
  left join app.rating_replies rr on rr.rating_id = r.id and rr.deleted_at is null
  where p.id is not null
    and private.current_person_id() is not null
    and private.current_person_id() <> p.person_id
    and private.profile_visible_to_me(p.person_id, p.visibility)
    and private.person_shares_ratings(p.person_id)
    and not private.viewer_decides_hiring()
    and private.rating_released(e.id)
    and r.id not in (select private.removed_rating_ids())
  order by r.submitted_at desc;
$$;

comment on function api_public.person_profile_shared_ratings(text) is 'Organizations'' ratings of one person, for their profile page, while that person''s opt-in stands (ADR 0156): every released rating or none, in date order, with no average and no rater named. Nothing for anyone signed out, for anyone who decides hiring in any org, or when the profile is hidden from the viewer. The owner reads their own through api_external.ratings.';
revoke all on function api_public.person_profile_shared_ratings(text) from public, anon;
grant execute on function api_public.person_profile_shared_ratings(text) to authenticated, service_role;

-- What the table says about itself -----------------------------------------------------------------------------------

comment on table app.ratings is 'Two-sided ratings of a completed engagement (Section 4.4.3): the org rates the party and the party rates the org. Both are released together once both are in or 14 days after the engagement completed. An org''s rating of an individual reads only inside that org and for that person (ADR 0156); a rating of a company or vendor and a party''s rating of an org read for anyone signed in. Ratings are never edited, withdrawn or suppressed by the org or the rated side (Section 14.9); gateway.ratings_enabled only decides whether the org''s members are prompted to rate and never hides or removes a rating (ADR 0038). Moderation follows policy only (abuse, personal data, a wrong or false statement), whatever the score. Internal org notes and internal ratings live elsewhere and never appear here.';
comment on column app.ratings.comment is 'Comment on the rating. Who reads it depends on who was rated, never on what it says (ADR 0156).';
comment on table app.rating_replies is 'The rated side''s one reply to a released rating (Section 4.4.3). It is read wherever the rating is.';

-- Disputes: reads, ledger and upkeep ---------------------------------------------------------------------------------

create or replace function private.org_rating_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id from app.ratings r
  where r.rater_side = 'Organization' and r.engagement_id in (select private.internal_rating_engagement_ids());
$$;

comment on function private.org_rating_ids() is 'Ratings of a party the signed-in member reads as the org that gave them, removed ones included, so the org sees what became of a dispute.';
revoke all on function private.org_rating_ids() from public, anon;
grant execute on function private.org_rating_ids() to authenticated, service_role;

call private.install_policies('app.rating_disputes',
  $$disputant_person_id = (select private.current_person_id()) or rating_id in (select private.org_rating_ids())$$);

-- Written only through the RPCs; who decided stays in the console (a notice names the platform, not the operator).
revoke all on app.rating_disputes from authenticated;
grant select (id, org_id, rating_id, disputant_person_id, dispute_ground, details, dispute_state, filed_at, org_response,
  org_responded_at, decision_ground, decision_statement, decided_at, created_at, updated_at, deleted_at)
  on app.rating_disputes to authenticated;

call private.install_lifecycle('app.rating_disputes', 'rating_dispute_id', 'dispute_state', 'rating_dispute', 'Open',
  $$rating_dispute_id in (select d.id from app.rating_disputes d
      where d.disputant_person_id = (select private.current_person_id()) or d.rating_id in (select private.org_rating_ids()))$$);
drop trigger if exists t15_refuse_read_only_org on app.rating_dispute_state_transitions;

call private.install_audit_trail('app.rating_disputes');
call private.install_default_retention('app.rating_disputes');
call private.install_default_retention('app.rating_dispute_state_transitions');
