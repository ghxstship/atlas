-- 1112_account_deletion.sql
-- A42 Compass launch gaps, SIM-004 (journey 38; App Store guideline 5.1.1(v)). A person deletes their own
-- account from inside Compass or Gateway. Nothing could do that: account lifecycle existed only as a
-- retention purge method. The deletion contract (owner approval 2026-10-17):
--   * app.delete_my_account(p_confirm_email): the signed-in person, confirming with the email they sign in
--     with, deletes their sign-in at once. One transaction:
--       - erases their own profile data: profile, links, languages, skills, references, portfolio,
--         certifications and their shares, availability, saved searches and opportunities, favorites,
--         personal settings, snoozes, watches, subscriptions and reactions, push devices and app grants
--       - removes their name from app.people and soft-deletes the person, so every record that names them
--         keeps a person with no name
--       - ends their org memberships and external account memberships now, and cancels their engagements
--         that are still Onboarding, Blocked or Active (Closing and Complete stay for settlement)
--       - records an Erasure data subject request, Completed, in every org they belonged to or worked for,
--         so each org's DSAR register (Section 14.3) shows what happened
--       - deletes the auth user (app.people.user_id is set null by its foreign key)
--   * Kept, and said so in the result: time and pay records and tax forms (payroll retention, US default 7
--     years, Section 14.3), engagement records and signed agreements, the audit trail (personal data
--     redacted at 90 days, invariant 23), the records they created for an org (kept without their name)
--     and the erasure request record itself.
--   * Refusals (XR001), with nothing deleted:
--       - account_delete_confirmation: the typed email does not match the sign-in
--       - account_delete_legal_hold: an org they belong to or work for holds an active legal hold over the
--         records the deletion changes; the message names the org and the matter
--       - account_delete_on_shift: they are clocked in; clock out first
--       - account_delete_sole_owner: they are the only Owner of an org or the only Account Owner of an
--         external account; transfer ownership first
--   * Idempotent: a repeat call with the same session returns the stored result with replayed true.
-- It is not on the sync allowlist: deletion runs online only and never queues.

create table private.account_deletions (
  user_id uuid primary key,
  person_id uuid not null references app.people (id),
  deleted_at timestamptz not null default now(),
  result jsonb not null
);

comment on table private.account_deletions is 'One row per deleted sign-in (SIM-004): makes app.delete_my_account idempotent and records what was erased and kept. Holds no personal data beyond the ids.';
comment on column private.account_deletions.user_id is 'Deleted Supabase Auth user id. Not a foreign key: the user no longer exists.';
comment on column private.account_deletions.person_id is 'Person whose sign-in was deleted; the person row stays, with no name.';
comment on column private.account_deletions.deleted_at is 'When the account was deleted.';
comment on column private.account_deletions.result is 'The result returned to the person: erased and kept categories, orgs and engagements ended.';

alter table private.account_deletions enable row level security;
revoke all on private.account_deletions from public, anon, authenticated;
grant select on private.account_deletions to service_role;

-- Orgs a person belongs to or works for ----------------------------------------------------------------------

create or replace function private.person_related_org_ids(p_person_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.org_id from app.memberships m where m.person_id = p_person_id and m.deleted_at is null
  union
  select a.org_id from app.account_memberships a where a.person_id = p_person_id and a.deleted_at is null
  union
  select e.org_id from app.engagements e where e.person_id = p_person_id and e.deleted_at is null;
$$;

comment on function private.person_related_org_ids(uuid) is 'Orgs a person holds or held a membership, an external account membership or an engagement with (SIM-004 account deletion).';
revoke all on function private.person_related_org_ids(uuid) from public, anon, authenticated;

-- Tables whose rows the deletion changes; an active legal hold on any of them (or on every table) blocks it.
create or replace function private.account_deletion_tables()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'app.people', 'app.person_profiles', 'app.person_links', 'app.person_languages', 'app.person_skills',
    'app.person_references', 'app.portfolio_items', 'app.profile_section_visibility', 'app.person_certifications',
    'app.certification_shares', 'app.availability_calendars', 'app.availability_blocks', 'app.saved_searches',
    'app.opportunity_alerts', 'app.saved_opportunities', 'app.favorites', 'app.personal_setting_values',
    'app.inbox_snoozes', 'app.record_watchers', 'app.thread_subscriptions', 'app.thread_reads',
    'app.comment_reactions', 'app.push_subscriptions', 'app.oauth_grants', 'app.memberships',
    'app.account_memberships', 'app.engagements', 'app.dsar_requests']::text[];
$$;

comment on function private.account_deletion_tables() is 'The app tables an account deletion writes to (SIM-004). An active legal hold naming one of them, or naming no table, blocks the deletion.';
revoke all on function private.account_deletion_tables() from public, anon, authenticated;

-- What blocks a deletion, and what it keeps -------------------------------------------------------------------

create or replace function private.account_deletion_blockers(p_person_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(b order by b ->> 'code', b ->> 'org_name'), '[]'::jsonb) from (
    select jsonb_build_object('code', 'account_delete_legal_hold', 'org_id', o.id, 'org_name', o.name, 'matter', h.matter) as b
    from app.legal_holds h
    join app.organizations o on o.id = h.org_id
    where h.released_at is null and h.deleted_at is null
      and h.org_id in (select private.person_related_org_ids(p_person_id))
      and (h.table_name is null or h.table_name = any (private.account_deletion_tables()))
    union all
    select distinct jsonb_build_object('code', 'account_delete_on_shift', 'org_id', o.id, 'org_name', o.name)
    from app.time_entries t
    join app.organizations o on o.id = t.org_id
    where t.clock_out is null and t.deleted_at is null
      and (t.membership_id in (select m.id from app.memberships m where m.person_id = p_person_id)
           or t.engagement_id in (select e.id from app.engagements e where e.person_id = p_person_id))
    union all
    select jsonb_build_object('code', 'account_delete_sole_owner', 'org_id', o.id, 'org_name', o.name)
    from app.memberships m
    join app.organizations o on o.id = m.org_id
    where m.person_id = p_person_id and m.deleted_at is null and m.valid_from <= now() and m.valid_to is null
      and private.holds_owner_role(m.id)
      and not exists (
        select 1 from app.memberships m2
        where m2.org_id = m.org_id and m2.id <> m.id and m2.deleted_at is null and m2.valid_from <= now() and m2.valid_to is null
          and private.holds_owner_role(m2.id))
    union all
    select jsonb_build_object('code', 'account_delete_sole_owner', 'org_id', o.id, 'org_name', o.name)
    from app.account_memberships a
    join app.organizations o on o.id = a.org_id
    where a.person_id = p_person_id and a.deleted_at is null and a.valid_to is null
      and exists (select 1 from app.account_membership_roles r
                  where r.account_membership_id = a.id and r.account_role = 'Account Owner' and r.deleted_at is null)
      and not exists (
        select 1 from app.account_membership_roles r join app.account_memberships a2 on a2.id = r.account_membership_id
        where r.org_id = a.org_id and a2.id <> a.id and r.account_role = 'Account Owner' and r.deleted_at is null
          and a2.deleted_at is null and a2.valid_to is null)
  ) x;
$$;

comment on function private.account_deletion_blockers(uuid) is 'Why a person''s account cannot be deleted yet (SIM-004): an active legal hold over the records the deletion changes, an open time entry, or being the only Owner or Account Owner. Each entry names the code and the org.';
revoke all on function private.account_deletion_blockers(uuid) from public, anon, authenticated;

create or replace function private.account_deletion_kept(p_person_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (select m.id from app.memberships m where m.person_id = p_person_id),
  engaged as (select e.id from app.engagements e where e.person_id = p_person_id and e.deleted_at is null)
  select jsonb_agg(k.item order by k.ord) from (
    select 1 as ord, jsonb_build_object('category', 'time_and_pay', 'retention', '7 years') as item
    where exists (select 1 from app.time_entries t where t.deleted_at is null
                    and (t.membership_id in (select id from mine) or t.engagement_id in (select id from engaged)))
       or exists (select 1 from app.payroll_lines l where l.deleted_at is null and l.membership_id in (select id from mine))
    union all
    select 2, jsonb_build_object('category', 'tax_forms', 'retention', '7 years')
    where exists (select 1 from app.tax_forms f where f.person_id = p_person_id and f.deleted_at is null)
    union all
    select 3, jsonb_build_object('category', 'engagements', 'retention', '7 years')
    where exists (select 1 from engaged)
    union all
    select 4, jsonb_build_object('category', 'org_records', 'retention', 'org')
    union all
    select 5, jsonb_build_object('category', 'audit_trail', 'retention', '7 years')
    union all
    select 6, jsonb_build_object('category', 'erasure_request', 'retention', '7 years')
  ) k;
$$;

comment on function private.account_deletion_kept(uuid) is 'What an account deletion keeps, and for how long (SIM-004): time and pay records, tax forms and engagement records under payroll retention, the org''s own records without the person''s name, the audit trail and the erasure request.';
revoke all on function private.account_deletion_kept(uuid) from public, anon, authenticated;

create or replace function app.account_deletion_preview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
begin
  return jsonb_build_object(
    'person_id', v_person,
    'email', (select lower(u.email) from auth.users u where u.id = (select auth.uid())),
    'blockers', private.account_deletion_blockers(v_person),
    'kept', private.account_deletion_kept(v_person));
end;
$$;

comment on function app.account_deletion_preview() is 'What deleting the signed-in person''s account would do (SIM-004): the blockers that refuse it now, and what it keeps and why. Compass and Gateway show it on the confirmation sheet; nothing changes.';
revoke all on function app.account_deletion_preview() from public, anon;
grant execute on function app.account_deletion_preview() to authenticated, service_role;

-- Deleting the account ---------------------------------------------------------------------------------------

create or replace function app.delete_my_account(p_confirm_email text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_done jsonb;
  v_person uuid;
  v_email text;
  v_blocker jsonb;
  v_orgs uuid[];
  v_memberships uuid[];
  v_engagement record;
  v_canceled integer := 0;
  v_ended integer;
  v_ended_total integer := 0;
  v_org uuid;
  v_dsar uuid;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  -- Idempotent: a repeat with the same session answers with the stored result.
  select d.result into v_done from private.account_deletions d where d.user_id = v_uid;
  if v_done is not null then
    return v_done || jsonb_build_object('replayed', true);
  end if;
  v_person := private.require_person();
  v_email := (select lower(u.email) from auth.users u where u.id = v_uid);
  if v_email is null or lower(btrim(coalesce(p_confirm_email, ''))) <> v_email then
    perform private.refuse('account_delete_confirmation', 'Type the email address you sign in with to confirm.');
  end if;

  v_blocker := private.account_deletion_blockers(v_person) -> 0;
  if v_blocker is not null then
    case v_blocker ->> 'code'
      when 'account_delete_legal_hold' then
        perform private.refuse('account_delete_legal_hold', format(
          '%s keeps your records under a legal hold (%s). Nothing was deleted. Ask %s to release the hold, then delete your account again.',
          v_blocker ->> 'org_name', v_blocker ->> 'matter', v_blocker ->> 'org_name'));
      when 'account_delete_on_shift' then
        perform private.refuse('account_delete_on_shift', format(
          'You are clocked in at %s. Clock out, then delete your account.', v_blocker ->> 'org_name'));
      else
        perform private.refuse('account_delete_sole_owner', format(
          'You are the only owner of %s. Make someone else an owner, then delete your account.', v_blocker ->> 'org_name'));
    end case;
  end if;

  v_orgs := array(select private.person_related_org_ids(v_person));
  v_memberships := array(select m.id from app.memberships m where m.person_id = v_person);

  -- Their own profile data.
  delete from app.certification_shares s using app.person_certifications c
    where s.person_certification_id = c.id and c.person_id = v_person;
  delete from app.person_certifications where person_id = v_person;
  delete from app.availability_blocks b using app.availability_calendars c
    where b.availability_calendar_id = c.id and c.person_id = v_person;
  delete from app.availability_calendars where person_id = v_person;
  delete from app.opportunity_alerts a using app.saved_searches s
    where a.saved_search_id = s.id and s.person_id = v_person;
  delete from app.saved_searches where person_id = v_person;
  delete from app.saved_opportunities where person_id = v_person;
  delete from app.person_profiles where person_id = v_person;
  delete from app.person_links where person_id = v_person;
  delete from app.person_languages where person_id = v_person;
  delete from app.person_skills where person_id = v_person;
  delete from app.person_references where person_id = v_person;
  delete from app.portfolio_items where person_id = v_person;
  delete from app.profile_section_visibility where person_id = v_person;
  delete from app.favorites where person_id = v_person;
  delete from app.personal_setting_values where person_id = v_person;
  delete from app.inbox_snoozes where person_id = v_person;
  delete from app.record_watchers where person_id = v_person;
  delete from app.thread_subscriptions where person_id = v_person;
  delete from app.thread_reads where person_id = v_person;
  delete from app.comment_reactions where person_id = v_person;
  delete from app.push_subscriptions where membership_id = any (v_memberships);
  delete from app.oauth_grants where person_id = v_person;

  -- Memberships end now. One that starts this instant is soft-deleted, since a period cannot be empty.
  update app.memberships m
    set valid_to = case when m.valid_from < now() then now() else m.valid_to end,
        deleted_at = case when m.valid_from < now() then m.deleted_at else now() end
    where m.person_id = v_person and m.deleted_at is null and (m.valid_to is null or m.valid_to > now());
  get diagnostics v_ended = row_count;
  v_ended_total := v_ended;
  update app.account_memberships a
    set valid_to = case when a.valid_from < now() then now() else a.valid_to end,
        deleted_at = case when a.valid_from < now() then a.deleted_at else now() end
    where a.person_id = v_person and a.deleted_at is null and (a.valid_to is null or a.valid_to > now());
  get diagnostics v_ended = row_count;
  v_ended_total := v_ended_total + v_ended;

  -- Engagements still under way are canceled; Closing and Complete stay for settlement and pay.
  for v_engagement in
    select e.id, e.engagement_state::text as state from app.engagements e
    where e.person_id = v_person and e.deleted_at is null and e.engagement_state in ('Onboarding', 'Blocked', 'Active')
  loop
    perform private.transition_lifecycle('engagement', 'app.engagements', 'engagement_state', 'app.engagement_state_transitions',
      'engagement_id', v_engagement.id, v_engagement.state, 'Canceled', 'The person deleted their account.');
    v_canceled := v_canceled + 1;
  end loop;

  -- Every org they belonged to or worked for records the erasure in its DSAR register.
  foreach v_org in array v_orgs loop
    insert into app.dsar_requests (org_id, subject_person_id, subject_email, request_type, details)
    values (v_org, v_person, v_email, 'Erasure', 'Account deleted by the person from the app (account lifecycle, Section 14.7).')
    returning id into v_dsar;
    perform private.transition_lifecycle('dsar', 'app.dsar_requests', 'dsar_state', 'app.dsar_state_transitions',
      'dsar_request_id', v_dsar, 'Received', 'In Progress', 'Erasure runs at once when the person deletes their account.');
    perform private.transition_lifecycle('dsar', 'app.dsar_requests', 'dsar_state', 'app.dsar_state_transitions',
      'dsar_request_id', v_dsar, 'In Progress', 'Completed', 'Profile erased, memberships ended, sign-in deleted; retained records listed in the result.');
  end loop;

  v_result := jsonb_build_object(
    'deleted_at', now(),
    'replayed', false,
    'erased', jsonb_build_array('sign_in', 'name', 'profile', 'devices', 'preferences'),
    'kept', private.account_deletion_kept(v_person),
    'memberships_ended', v_ended_total,
    'engagements_canceled', v_canceled,
    'orgs_notified', coalesce(array_length(v_orgs, 1), 0));

  -- The person keeps no name; the records that name them keep a person with no name.
  update app.people set full_name = null, deleted_at = now() where id = v_person;
  insert into private.account_deletions (user_id, person_id, result) values (v_uid, v_person, v_result);
  delete from auth.users where id = v_uid;
  return v_result;
end;
$$;

comment on function app.delete_my_account(text) is 'Deletes the signed-in person''s account at once (SIM-004, journey 38): erases their profile data and name, ends their memberships, cancels their open engagements, records a Completed Erasure request in every related org and deletes the sign-in. Confirm with the sign-in email. Refuses (XR001, nothing deleted) under a legal hold, while clocked in, or as the only Owner. Idempotent per session. Returns what was erased and what is kept.';
revoke all on function app.delete_my_account(text) from public, anon;
grant execute on function app.delete_my_account(text) to authenticated, service_role;
