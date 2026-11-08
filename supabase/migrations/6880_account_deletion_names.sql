-- 6880_account_deletion_names.sql
-- RRR-248. Deleting an account (1112, last restated in 1670) cleared app.people.full_name but kept the optional
-- given_name and family_name that 1340 added beside it, which the person enters in Settings, Account and Sign in with
-- Apple can fill at the first sign-in. Now a deletion clears every name and contact field on the person and the account,
-- and keeps only what payroll law and the retention schedule require, apart from the person:
--
--   * app.delete_my_account (from 1670, which no later migration redefines) clears full_name, given_name and
--     family_name together. The sign-in it deletes takes its identities with it, the Apple names and email included.
--   * private.erase_account_contacts: the account's own addresses. Its SCIM identities (the user name an identity
--     provider sent, usually a work email, and the provider's id for it) are soft-deleted, made inactive and given
--     placeholders, so a later push from the provider never finds the person. The invitations it accepted to an org, an
--     external account or a crew roster keep their row and dates, with the address replaced by one at erased.invalid
--     (RFC 2606), so no org can match the nameless person back to an address.
--   * private.wage_record_names: the rule for names on wage records. Payroll records must name the worker (29 CFR
--     516.2(a)(1) under the FLSA, and 29 CFR 5.5(a)(3)(i) for the certified payroll of a covered contract). The FLSA
--     requires payroll records to be kept 3 years (29 CFR 516.5), and the retention schedule keeps payroll, timesheets
--     and pay records 7 years by default in the United States, the only launch market. So the deletion copies the names off the person
--     into this private table first, one row per org:
--       - an org with the person's time entries or payroll lines keeps them until 7 years after the latest of those
--         records, and every later one extends that: a trigger on app.time_entries and app.payroll_lines moves
--         retain_until when a record for a deleted person is written after the deletion, such as the final payroll run of
--         the last pay period;
--       - an org that could still pay the person but has no record of theirs yet (a membership current or ended in the
--         last 90 days, or an engagement kept for settlement and pay, Closing or Complete) keeps them 90 days, longer
--         than the last monthly pay period and its payroll run take. A record written in that time keeps them 7 years
--         after it; otherwise they are purged then, and a record the org first writes later carries no name.
--     A person with no name, or no such org, leaves nothing here. The table is never granted to a signed-in caller and
--     is read only where a wage record must print a name: app.certified_payroll (from 6060) falls back to it for a
--     deleted worker. Every other read, the time entries, payroll lines and engagements themselves included, shows a
--     person with no name.
--   * private.purge_wage_record_names, nightly at 03:19 UTC, deletes the names whose period has ended, unless an
--     active legal hold in that org covers any of the wage record tables (private.wage_record_tables), in which case
--     they wait for its release.
--   * private.account_deletion_tables (from 1670) adds the four tables the deletion now also writes, and
--     private.account_deletion_blockers (from 1112) looks for holds in every org whose rows of them it rewrites, so a
--     legal hold over any of them blocks it as before. private.account_deletion_kept (from 1112) counts time and pay
--     records as the names rule does. The other kept records are unchanged: tax forms keep the legal name and address
--     the form carries, signed agreements the signed name and OSHA cases the employee's details, each for its own
--     retention period in the schedule, and each org's register keeps the completed erasure request.

-- 1. Names kept for wage records ---------------------------------------------------------------------------------------

create table private.wage_record_names (
  org_id uuid not null references app.organizations (id) on delete cascade,
  person_id uuid not null references app.people (id) on delete cascade,
  full_name text,
  given_name text,
  family_name text,
  last_wage_record_on date,
  retain_until date not null,
  recorded_at timestamptz not null default now(),
  primary key (org_id, person_id),
  constraint wage_record_names_some_name check (coalesce(full_name, given_name, family_name) is not null)
);

create index wage_record_names_person_idx on private.wage_record_names (person_id);
create index wage_record_names_retain_until_idx on private.wage_record_names (retain_until);

comment on table private.wage_record_names is 'Names a deleted person''s wage records keep in one org (6880): payroll records must name the worker (29 CFR 516.2(a)(1); 29 CFR 5.5(a)(3)(i) for certified payroll), so account deletion copies the names here before it clears them from app.people. Read only by wage record outputs such as app.certified_payroll; never granted to a signed-in caller. Purged when retain_until passes, unless a legal hold covers the wage records.';
comment on column private.wage_record_names.org_id is 'Org whose time entries or payroll lines are the person''s, or that could still pay them.';
comment on column private.wage_record_names.person_id is 'The deleted person; app.people keeps no name for them.';
comment on column private.wage_record_names.full_name is 'Full name the person had given, as it was when they deleted their account.';
comment on column private.wage_record_names.given_name is 'Optional given name the person had, as it was when they deleted their account.';
comment on column private.wage_record_names.family_name is 'Optional family name the person had, as it was when they deleted their account.';
comment on column private.wage_record_names.last_wage_record_on is 'Date of the latest of the person''s time entries (clock-in, UTC) and payroll lines (end of the pay period) in the org, including those written after the deletion; null while the org has none.';
comment on column private.wage_record_names.retain_until is 'Last day the names are kept: 7 years after last_wage_record_on (retention schedule, payroll, timesheets and pay records, United States default), or 90 days after the deletion while the org has no wage record of the person.';
comment on column private.wage_record_names.recorded_at is 'When the account deletion copied the names.';

alter table private.wage_record_names enable row level security;
revoke all on private.wage_record_names from public, anon, authenticated;
grant select on private.wage_record_names to service_role;

create or replace function private.wage_record_tables()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'app.people', 'app.memberships', 'app.engagements', 'app.time_entries', 'app.timesheets', 'app.pay_periods',
    'app.payroll_runs', 'app.payroll_lines', 'app.certified_payroll_submissions']::text[];
$$;

comment on function private.wage_record_tables() is 'The tables that hold a worker''s wage records or name them (6880). An active legal hold in an org over one of them, or over every table, keeps the names in private.wage_record_names past their period.';
revoke all on function private.wage_record_tables() from public, anon, authenticated;

create or replace function private.retain_wage_record_names(p_person_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with records as (
    select t.org_id, (t.clock_in at time zone 'UTC')::date as worked_on
    from app.time_entries t
    where t.deleted_at is null
      and (t.membership_id in (select m.id from app.memberships m where m.person_id = p_person_id)
           or t.engagement_id in (select e.id from app.engagements e where e.person_id = p_person_id))
    union all
    select l.org_id, pp.ends_on
    from app.payroll_lines l
    join app.payroll_runs r on r.id = l.payroll_run_id
    join app.pay_periods pp on pp.id = r.pay_period_id
    where l.deleted_at is null and l.membership_id in (select m.id from app.memberships m where m.person_id = p_person_id)
  ), latest as (
    select r.org_id, max(r.worked_on) as last_on from records r group by r.org_id
  ), payable as (
    -- Orgs that could still write a wage record: a membership current or ended in the last 90 days, or an engagement
    -- kept for settlement and pay.
    select m.org_id from app.memberships m
    where m.person_id = p_person_id and m.deleted_at is null and (m.valid_to is null or m.valid_to > now() - interval '90 days')
    union
    select e.org_id from app.engagements e
    where e.person_id = p_person_id and e.deleted_at is null and e.engagement_state in ('Closing', 'Complete')
  ), orgs as (
    select l.org_id, l.last_on from latest l
    union all
    select p.org_id, null::date from payable p where p.org_id not in (select l.org_id from latest l)
  )
  insert into private.wage_record_names (org_id, person_id, full_name, given_name, family_name, last_wage_record_on, retain_until)
  select o.org_id, pe.id, pe.full_name, pe.given_name, pe.family_name, o.last_on,
    coalesce((o.last_on + interval '7 years')::date, current_date + 90)
  from orgs o
  cross join app.people pe
  where pe.id = p_person_id and coalesce(pe.full_name, pe.given_name, pe.family_name) is not null
  on conflict (org_id, person_id) do update
    set full_name = excluded.full_name, given_name = excluded.given_name, family_name = excluded.family_name,
        last_wage_record_on = greatest(private.wage_record_names.last_wage_record_on, excluded.last_wage_record_on),
        retain_until = greatest(private.wage_record_names.retain_until, excluded.retain_until), recorded_at = now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function private.retain_wage_record_names(uuid) is 'Copies a person''s names into private.wage_record_names (6880): for every org with their time entries or payroll lines, kept 7 years after the latest of them, and for every org that could still pay them (a membership current or ended in the last 90 days, or a Closing or Complete engagement) with none yet, kept 90 days. Account deletion calls it before it clears the names. Returns the number of orgs.';
revoke all on function private.retain_wage_record_names(uuid) from public, anon, authenticated;

create or replace function private.extend_wage_record_names()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid;
  v_on date;
begin
  if new.deleted_at is not null then
    return null;
  end if;
  -- app.time_entries is partitioned, so the trigger fires on a partition; payroll lines are one table.
  if tg_table_name <> 'payroll_lines' then
    v_person := coalesce((select m.person_id from app.memberships m where m.id = new.membership_id),
                         (select e.person_id from app.engagements e where e.id = new.engagement_id));
    v_on := (new.clock_in at time zone 'UTC')::date;
  else
    v_person := (select m.person_id from app.memberships m where m.id = new.membership_id);
    v_on := (select pp.ends_on from app.payroll_runs r join app.pay_periods pp on pp.id = r.pay_period_id
             where r.id = new.payroll_run_id);
  end if;
  -- Only a deleted person has a row, so for everyone else this updates nothing.
  update private.wage_record_names w
    set last_wage_record_on = greatest(w.last_wage_record_on, v_on),
        retain_until = greatest(w.retain_until, (v_on + interval '7 years')::date)
    where w.org_id = new.org_id and w.person_id = v_person and v_on is not null;
  return null;
end;
$$;

comment on function private.extend_wage_record_names() is 'After a time entry or payroll line is written (6880): when its person deleted their account and the org keeps their names in private.wage_record_names, keeps them until 7 years after the record (the clock-in date, or the end of the line''s pay period) if that is later, so records written after the deletion, such as the final payroll run, are covered too.';
revoke all on function private.extend_wage_record_names() from public, anon, authenticated;

create trigger t95_extend_wage_record_names after insert or update of clock_in, deleted_at, membership_id, engagement_id
  on app.time_entries for each row execute function private.extend_wage_record_names();
create trigger t95_extend_wage_record_names after insert or update of deleted_at, payroll_run_id, membership_id
  on app.payroll_lines for each row execute function private.extend_wage_record_names();

create or replace function private.purge_wage_record_names()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from private.wage_record_names w
  where w.retain_until < current_date
    and not exists (
      select 1 from unnest(private.wage_record_tables()) t (table_name)
      where w.org_id in (select private.held_org_ids(t.table_name)));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function private.purge_wage_record_names() is 'Nightly (6880): deletes the wage record names whose retention period has ended, except in an org with an active legal hold over any wage record table (private.wage_record_tables) or every table, where they wait for its release. Returns the number deleted.';
revoke all on function private.purge_wage_record_names() from public, anon, authenticated;

select cron.schedule('xos_purge_wage_record_names', '19 3 * * *', 'select private.purge_wage_record_names()');

-- 2. The account's own addresses ----------------------------------------------------------------------------------------

create or replace function private.erase_account_contacts(p_person_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  -- SCIM identities: the provider's user name and id for the person go, so a later push finds no one.
  update app.scim_identities i
    set active = false, deleted_at = coalesce(i.deleted_at, now()),
        user_name = 'erased-' || replace(i.id::text, '-', ''), external_id = 'erased-' || replace(i.id::text, '-', '')
    where i.person_id = p_person_id;
  -- Invitations the account accepted keep their row and dates, with an address that reaches no one.
  update app.invites i set email = 'erased-' || replace(i.id::text, '-', '') || '@erased.invalid'
    where i.accepted_person_id = p_person_id;
  update app.account_invitations i set email = 'erased-' || replace(i.id::text, '-', '') || '@erased.invalid'
    where i.accepted_person_id = p_person_id;
  update app.roster_invitations i set email = 'erased-' || replace(i.id::text, '-', '') || '@erased.invalid'
    where i.claimed_person_id = p_person_id;
end;
$$;

comment on function private.erase_account_contacts(uuid) is 'Erases the contact fields an account leaves outside the person (6880): its SCIM identities are soft-deleted, made inactive and given placeholder user names and ids, and the invitations it accepted or claimed (org, external account and crew roster) get an address at erased.invalid. Called by app.delete_my_account once the person is deleted.';
revoke all on function private.erase_account_contacts(uuid) from public, anon, authenticated;

create or replace function private.account_contact_org_ids(p_person_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select i.org_id from app.scim_identities i where i.person_id = p_person_id
  union
  select i.org_id from app.invites i where i.accepted_person_id = p_person_id
  union
  select i.org_id from app.account_invitations i where i.accepted_person_id = p_person_id
  union
  select i.org_id from app.roster_invitations i where i.claimed_person_id = p_person_id;
$$;

comment on function private.account_contact_org_ids(uuid) is 'Orgs whose SCIM identities or accepted invitations private.erase_account_contacts rewrites for a person (6880), so the deletion''s legal hold check covers them even where the person''s membership is gone.';
revoke all on function private.account_contact_org_ids(uuid) from public, anon, authenticated;

-- 3. Account deletion (from 1670) ---------------------------------------------------------------------------------------

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
    'app.comment_reactions', 'app.push_subscriptions', 'app.person_push_devices', 'app.push_tickets', 'app.oauth_grants',
    'app.memberships', 'app.account_memberships', 'app.engagements', 'app.dsar_requests', 'app.scim_identities',
    'app.invites', 'app.account_invitations', 'app.roster_invitations']::text[];
$$;

comment on function private.account_deletion_tables() is 'The app tables an account deletion writes to (SIM-004), with the person''s own push devices and the tickets of every device it removes (A101), and the SCIM identities and accepted invitations whose addresses it erases (6880). An active legal hold naming one of them, or naming no table, blocks the deletion.';
revoke all on function private.account_deletion_tables() from public, anon, authenticated;

-- Restated from 1112, its latest definition, with only the legal hold check changed: it covers the orgs whose SCIM
-- identities and invitations the deletion rewrites as well as the person's related orgs.
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
      and h.org_id in (select private.person_related_org_ids(p_person_id)
                       union select private.account_contact_org_ids(p_person_id))
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

comment on function private.account_deletion_blockers(uuid) is 'Why a person''s account cannot be deleted yet (SIM-004): an active legal hold over the records the deletion changes, in any org it changes them in (6880), an open time entry, or being the only Owner or Account Owner. Each entry names the code and the org.';
revoke all on function private.account_deletion_blockers(uuid) from public, anon, authenticated;

-- Restated from 1112, its latest definition, with only time and pay changed: it counts time entries on every engagement
-- of the person, soft-deleted or not, as private.retain_wage_record_names does.
create or replace function private.account_deletion_kept(p_person_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (select m.id from app.memberships m where m.person_id = p_person_id),
  worked as (select e.id from app.engagements e where e.person_id = p_person_id),
  engaged as (select e.id from app.engagements e where e.person_id = p_person_id and e.deleted_at is null)
  select jsonb_agg(k.item order by k.ord) from (
    select 1 as ord, jsonb_build_object('category', 'time_and_pay', 'retention', '7 years') as item
    where exists (select 1 from app.time_entries t where t.deleted_at is null
                    and (t.membership_id in (select id from mine) or t.engagement_id in (select id from worked)))
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

comment on function private.account_deletion_kept(uuid) is 'What an account deletion keeps, and for how long (SIM-004): time and pay records (time entries on any of the person''s memberships or engagements, and payroll lines, as private.retain_wage_record_names counts them, 6880), tax forms and engagement records under payroll retention, the org''s own records without the person''s name, the audit trail and the erasure request.';
revoke all on function private.account_deletion_kept(uuid) from public, anon, authenticated;

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

  -- Each org's wage records keep the name payroll law requires, before the person loses it (6880).
  perform private.retain_wage_record_names(v_person);

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
  -- Their devices, membership and own, with the tickets that name them (A101).
  delete from app.push_tickets t using app.push_subscriptions ps
    where t.push_subscription_id = ps.id and ps.membership_id = any (v_memberships);
  delete from app.push_tickets t using app.person_push_devices pd
    where t.person_push_device_id = pd.id and pd.person_id = v_person;
  delete from app.push_subscriptions where membership_id = any (v_memberships);
  delete from app.person_push_devices where person_id = v_person;
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

  -- The person keeps no name, full, given or family; the records that name them keep a person with no name (6880).
  update app.people set full_name = null, given_name = null, family_name = null, deleted_at = now() where id = v_person;
  -- The account's own addresses go too: its SCIM identities and the invitations it accepted. This runs once the person
  -- is deleted, so an org that has since become read-only cannot refuse it.
  perform private.erase_account_contacts(v_person);
  insert into private.account_deletions (user_id, person_id, result) values (v_uid, v_person, v_result);
  delete from auth.users where id = v_uid;
  return v_result;
end;
$$;

comment on function app.delete_my_account(text) is 'Deletes the signed-in person''s account at once (SIM-004, journey 38): erases their profile data, their full, given and family names, their push devices (their own and per membership, with the tickets that name them, A101) and the account''s SCIM identities and accepted invitation addresses (6880), ends their memberships, cancels their open engagements, records a Completed Erasure request in every related org and deletes the sign-in. Names an org''s wage records must keep go to private.wage_record_names first. Confirm with the sign-in email. Refuses (XR001, nothing deleted) under a legal hold, while clocked in, or as the only Owner. Idempotent per session. Returns what was erased and what is kept.';
revoke all on function app.delete_my_account(text) from public, anon;
grant execute on function app.delete_my_account(text) to authenticated, service_role;

-- 4. Certified payroll (from 6060) ---------------------------------------------------------------------------------------
-- Restated from 6060, its latest definition, with only the worker's name changed: a deleted worker's comes from
-- private.wage_record_names. The comment, revoke and grant are 1386's, restated.

create or replace function app.certified_payroll(p_project_id uuid, p_week_ending date, p_final boolean default false)
returns table (
  payroll_number integer,
  entry_number integer,
  last_name text,
  first_name text,
  middle_initial text,
  identifying_number text,
  apprentice text,
  labor_classification text,
  straight_minutes integer[],
  overtime_minutes integer[],
  total_minutes integer,
  currency_code text,
  straight_rate_minor bigint,
  overtime_rate_minor bigint,
  gross_project_minor bigint,
  gross_all_work_minor bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_person uuid := private.require_person();
  v_project app.projects;
  v_start date := p_week_ending - 6;
  v_number integer;
begin
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_project.id is null or not private.has_capability(v_project.org_id, 'crew.payroll.export') then
    raise exception using errcode = '42501', message = 'crew.payroll.export is required';
  end if;
  if not private.has_capability(v_project.org_id, 'data.restricted.read.payroll')
     or not private.has_capability(v_project.org_id, 'data.export.restricted') then
    perform private.refuse('export_restricted', 'A certified payroll carries Restricted pay rates and needs the restricted export capability.');
  end if;
  if private.session_aal() <> 'aal2' then
    perform private.refuse('step_up_required', 'Exporting Restricted columns needs step-up authentication.');
  end if;
  if not exists (select 1 from app.certified_payroll_projects c where c.project_id = p_project_id and c.deleted_at is null) then
    perform private.refuse('certified_payroll_header_missing', 'Enter the project''s contract and wage determination numbers before issuing a certified payroll.');
  end if;
  if p_week_ending is null then
    perform private.refuse('certified_payroll_week', 'Choose the week ending date.');
  end if;

  -- The submission: a week keeps its number when issued again.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('certified_payroll:' || p_project_id::text, 0));
  select s.payroll_number into v_number from app.certified_payroll_submissions s
  where s.project_id = p_project_id and s.week_ending = p_week_ending and s.deleted_at is null;
  if v_number is null then
    select coalesce(max(s.payroll_number), 0) + 1 into v_number from app.certified_payroll_submissions s
    where s.project_id = p_project_id and s.deleted_at is null;
    insert into app.certified_payroll_submissions (project_id, week_ending, payroll_number, final_submission, issued_by)
    values (p_project_id, p_week_ending, v_number, coalesce(p_final, false), v_person);
  else
    update app.certified_payroll_submissions s set final_submission = s.final_submission or coalesce(p_final, false),
      issued_by = v_person, issued_at = now()
    where s.project_id = p_project_id and s.week_ending = p_week_ending and s.deleted_at is null;
  end if;

  -- All of the week's approved work of everyone who worked on the project, on any of the org's projects.
  create temporary table if not exists pg_temp.work_minutes (
    membership_id uuid, role_code text, project_id uuid, jurisdiction_id text, subdivision_code text,
    week date, work_date date, clock_in timestamptz, minutes integer
  ) on commit drop;
  truncate pg_temp.work_minutes;

  insert into pg_temp.work_minutes
  select e.membership_id,
    coalesce(sh.role_code, (select pr.role_code from app.pay_rates pr
                            where pr.membership_id = e.membership_id and pr.effective_from <= p_week_ending and pr.deleted_at is null
                            order by pr.effective_from desc, pr.created_at desc limit 1)),
    p.id, p.jurisdiction_id, private.labor_subdivision(p.id), v_start,
    (e.clock_in at time zone p.time_zone)::date, e.clock_in,
    greatest(0, (extract(epoch from (e.clock_out - e.clock_in)) / 60)::integer - e.break_minutes)
  from app.time_entries e
  join app.projects p on p.id = e.project_id
  left join app.shifts sh on sh.id = e.shift_id
  where e.org_id = v_project.org_id and e.deleted_at is null and e.clock_out is not null and e.membership_id is not null
    and (e.clock_in at time zone p.time_zone)::date between v_start and p_week_ending
    and e.membership_id in (
      select e2.membership_id from app.time_entries e2 join app.projects p2 on p2.id = e2.project_id
      where e2.project_id = p_project_id and e2.deleted_at is null and e2.clock_out is not null
        and (e2.clock_in at time zone p2.time_zone)::date between v_start and p_week_ending)
    and exists (
      select 1 from app.timesheets t join app.timesheet_approvals a on a.timesheet_id = t.id and a.voided_at is null
      where t.membership_id = e.membership_id and t.project_id = e.project_id and t.deleted_at is null
        and t.timesheet_state = 'Approved' and e.clock_in >= private.project_day_start(t.project_id, t.period_start) and e.clock_in < private.project_day_start(t.project_id, t.period_end + 1));

  return query
  with split as (
    select s.*, (select pr.rate_minor from app.pay_rates pr
                 where pr.membership_id = s.membership_id and pr.role_code = s.role_code and pr.effective_from <= p_week_ending
                   and pr.deleted_at is null and pr.currency_code = v_project.currency
                 order by pr.effective_from desc, pr.created_at desc limit 1) as rate_minor
    from private.split_work_minutes() s
  ), earned as (
    select s.*, round(coalesce(s.rate_minor, 0) * (s.regular_minutes + s.ot_minutes * s.ot_multiplier + s.dt_minutes * s.dt_multiplier) / 60.0)::bigint as gross
    from split s
  ), all_work as (
    select e.membership_id, sum(e.gross)::bigint as gross from earned e group by 1
  ), project_rows as (
    select e.membership_id, e.role_code,
      array(select coalesce(sum(x.regular_minutes), 0)::integer from generate_series(0, 6) d
            left join earned x on x.membership_id = e.membership_id and x.role_code = e.role_code and x.project_id = p_project_id
              and x.work_date = v_start + d group by d order by d) as st,
      array(select coalesce(sum(x.ot_minutes + x.dt_minutes), 0)::integer from generate_series(0, 6) d
            left join earned x on x.membership_id = e.membership_id and x.role_code = e.role_code and x.project_id = p_project_id
              and x.work_date = v_start + d group by d order by d) as ot,
      sum(e.minutes)::integer as total, max(e.rate_minor) as rate, max(e.ot_multiplier) as ot_multiplier, sum(e.gross)::bigint as gross
    from earned e where e.project_id = p_project_id
    group by e.membership_id, e.role_code
  ), named as (
    select r.*, nm.full_name,
      coalesce(nullif(btrim(nm.family_name), ''), (regexp_match(btrim(nm.full_name), '(\S+)$'))[1]) as last_name,
      coalesce(nullif(btrim(nm.given_name), ''), (regexp_match(btrim(nm.full_name), '^(\S+)'))[1]) as first_name,
      case when nm.given_name is null and array_length(regexp_split_to_array(btrim(nm.full_name), '\s+'), 1) >= 3
           then left((regexp_split_to_array(btrim(nm.full_name), '\s+'))[2], 1) end as middle_initial,
      upper(left(replace(r.membership_id::text, '-', ''), 8)) as identifying_number,
      (select 'RA' || coalesce(' ' || ra.progression_level, '') from app.registered_apprentices ra
       where ra.membership_id = r.membership_id and ra.deleted_at is null and ra.valid_from <= p_week_ending
         and (ra.valid_to is null or ra.valid_to >= v_start) order by ra.valid_from desc limit 1) as apprentice,
      (select xr.job_title::text from xpms.role xr where xr.role_code = r.role_code) as classification
    from project_rows r
    join app.memberships m on m.id = r.membership_id
    join app.people pe on pe.id = m.person_id
    -- A worker who deleted their account keeps the name this org's wage records hold for them (6880).
    left join private.wage_record_names w on w.org_id = m.org_id and w.person_id = m.person_id
    cross join lateral (
      select case when pe.deleted_at is null then pe.full_name else w.full_name end as full_name,
             case when pe.deleted_at is null then pe.given_name else w.given_name end as given_name,
             case when pe.deleted_at is null then pe.family_name else w.family_name end as family_name
    ) nm
  )
  select v_number,
    dense_rank() over (order by n.last_name, n.first_name, n.membership_id)::integer,
    n.last_name, n.first_name, n.middle_initial, n.identifying_number, coalesce(n.apprentice, 'J'),
    coalesce(n.classification, n.role_code), n.st, n.ot, n.total, v_project.currency::text,
    n.rate, round(n.rate * n.ot_multiplier)::bigint, n.gross, w.gross
  from named n join all_work w on w.membership_id = n.membership_id
  order by 2, 8;

  perform private.write_audit_event(v_project.org_id, 'crew.certified_payroll_exported', 'app.certified_payroll_submissions', null,
    jsonb_build_object('project_id', p_project_id, 'week_ending', p_week_ending, 'payroll_number', v_number, 'classification', 'Restricted'));
end;
$$;

comment on function app.certified_payroll(uuid, date, boolean) is 'The WH-347 rows of a project for the week ending on the given date: per worker and labor classification, straight and overtime hours of each day (overtime split over all of the worker''s approved work that week), rates and gross pay on the project and for all work. A worker who deleted their account is named from the names the org''s wage records keep (private.wage_record_names, 6880). Numbers the week''s Certified Payroll No. (kept when issued again) and records the final-submission mark. A Restricted export: needs crew.payroll.export, data.restricted.read.payroll, data.export.restricted and step-up authentication, and is written to the audit log.';
revoke all on function app.certified_payroll(uuid, date, boolean) from public, anon;
grant execute on function app.certified_payroll(uuid, date, boolean) to authenticated, service_role;
