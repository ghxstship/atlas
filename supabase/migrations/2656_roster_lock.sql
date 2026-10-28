-- 2656_roster_lock.sql
-- R5 Project facts, parity addition G-142 (RRR-184, competitor parity audit 2026-10-28; ADR 0101 amendment). A names
-- lock per engagement: outside teams name their crew before a deadline the producing org sets.
--
--   * app.engagements.roster_locks_at: after this instant the company side can no longer add, invite, edit Draft
--     entries or submit new names. NULL means no lock. Written only by app.set_roster_lock (t43 refuses the rest).
--   * t42_guard_roster_lock on app.engagement_roster_entries, after R4's t40: while locked it refuses roster_locked for
--     a new non-self entry (every creator goes through R4's private.insert_roster_entry, so R10 and R12 inherit it), a
--     Draft entry moving to Submitted, and a change of role or arrival on a non-self Draft entry. Returned entries stay
--     editable and resubmittable, and withdrawals, the person's answer, reviews, self entries, invitation claims and
--     soft deletes go through. Project facts (2655) are not affected.
--   * app.submit_roster, recreated from 2635: while locked it submits only Returned entries and leaves Drafts alone,
--     refusing roster_locked only when nothing Returned is left and a Draft would otherwise have been submitted.
--   * api_external.engagements, recreated from 1624, ends with roster_locks_at, so the engaged party reads the lock.
--   * Setting the lock needs advancing.packet.write on the project, the one capability the API action declares, so the
--     API gate is never stricter than the RPC (parity review correction 3).

alter table app.engagements add column roster_locks_at timestamptz;
comment on column app.engagements.roster_locks_at is 'Names lock (R5, G-142): after this instant the company side can no longer add, invite, edit Draft entries or submit new names on the roster. NULL means no lock. Set by the producing org through app.set_roster_lock.';

-- The column is written only by its RPC ---------------------------------------------------------------------------------

create or replace function private.guard_roster_lock_column()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.roster_locks_at is distinct from old.roster_locks_at and not private.in_trusted_operation('roster_lock') then
    perform private.refuse('roster_lock_rpc', 'Set the names lock with app.set_roster_lock.');
  end if;
  return new;
end;
$$;

comment on function private.guard_roster_lock_column() is 'Refuses roster_lock_rpc when app.engagements.roster_locks_at changes outside the roster_lock trusted operation of app.set_roster_lock.';
revoke all on function private.guard_roster_lock_column() from public, anon, authenticated;

create trigger t43_guard_roster_lock_column before update on app.engagements
  for each row execute function private.guard_roster_lock_column();

create or replace function private.roster_locked(p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select e.roster_locks_at is not null and e.roster_locks_at <= now()
    from app.engagements e where e.id = p_engagement_id), false);
$$;

comment on function private.roster_locked(uuid) is 'True once an engagement''s names lock (roster_locks_at) has passed (R5, G-142). R12''s slate seeding reads it too.';
revoke all on function private.roster_locked(uuid) from public, anon, authenticated;

-- Setting the lock ------------------------------------------------------------------------------------------------------

create or replace function app.set_roster_lock(p_engagement_id uuid, p_locks_at timestamptz)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_project_name text;
  v_manager uuid;
begin
  perform private.require_person();
  select * into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if v_engagement.id is null or not private.can_on_project(v_engagement.project_id, 'advancing.packet.write') then
    raise exception using errcode = '42501', message = 'advancing.packet.write is required on the engagement''s project';
  end if;
  if v_engagement.engagement_state not in ('Onboarding', 'Blocked', 'Active', 'Closing') then
    perform private.refuse('roster_lock_engagement_closed', 'Set a names lock while the engagement is onboarding, active or closing.');
  end if;
  if v_engagement.roster_locks_at is not distinct from p_locks_at then
    return;
  end if;
  perform private.begin_trusted_operation('roster_lock');
  update app.engagements set roster_locks_at = p_locks_at where id = v_engagement.id;
  perform private.end_trusted_operation('roster_lock');
  perform private.write_audit_event(v_engagement.org_id, 'engagement.roster_lock_changed', 'app.engagements', v_engagement.id,
    jsonb_build_object('locks_at', p_locks_at));
  select p.name into v_project_name from app.projects p where p.id = v_engagement.project_id;
  for v_manager in select private.roster_manager_ids(v_engagement.id) loop
    begin
      perform private.notify(v_engagement.org_id, v_manager, 'engagement.roster_lock_changed', 'engagements', v_engagement.id,
        v_engagement.project_id, jsonb_build_object('projectName', v_project_name,
          'locksAt', to_char(p_locks_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
    exception when others then
      raise warning 'engagement.roster_lock_changed was not sent to person % for engagement %: %', v_manager, v_engagement.id, sqlerrm;
    end;
  end loop;
end;
$$;

comment on function app.set_roster_lock(uuid, timestamptz) is 'The producing org sets an engagement''s names lock (R5, G-142): after p_locks_at the company side can no longer add, invite, edit Draft entries or submit new names. NULL clears the lock and a past instant locks at once. Needs advancing.packet.write on the project (else 42501), the capability the API action engagements.setRosterLock declares; refuses roster_lock_engagement_closed unless the engagement is Onboarding, Blocked, Active or Closing. Writes an audit event and sends engagement.roster_lock_changed to each roster manager; a failed notice is a warning.';
revoke all on function app.set_roster_lock(uuid, timestamptz) from public, anon;
grant execute on function app.set_roster_lock(uuid, timestamptz) to authenticated, service_role;

-- The lock on roster entries -------------------------------------------------------------------------------------------------

create or replace function private.guard_roster_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_self or not private.roster_locked(new.engagement_id) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    perform private.refuse('roster_locked', 'Names are locked on this engagement. Ask the producing organization to change the roster.');
  end if;
  if new.deleted_at is not null and old.deleted_at is null then
    return new;
  end if;
  if old.entry_state = 'Draft' and new.entry_state = 'Submitted' then
    perform private.refuse('roster_locked', 'Names are locked on this engagement. Ask the producing organization to change the roster.');
  end if;
  if old.entry_state = 'Draft' and new.entry_state = 'Draft'
     and (new.role_code is distinct from old.role_code or new.arrival_window is distinct from old.arrival_window
       or new.arrival_time_zone is distinct from old.arrival_time_zone) then
    perform private.refuse('roster_locked', 'Names are locked on this engagement. Ask the producing organization to change the roster.');
  end if;
  return new;
end;
$$;

comment on function private.guard_roster_lock() is 'Names lock (R5, G-142): once private.roster_locked, refuses roster_locked for a new non-self entry, a Draft entry moving to Submitted and a change of role or arrival on a non-self Draft entry. Returned entries, withdrawals, the person''s answer, reviews, self entries, invitation claims and soft deletes go through.';
revoke all on function private.guard_roster_lock() from public, anon, authenticated;

create trigger t42_guard_roster_lock before insert or update on app.engagement_roster_entries
  for each row execute function private.guard_roster_lock();

-- Submitting under a lock (recreated from 2635) ---------------------------------------------------------------------------------

create or replace function app.submit_roster(p_engagement_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_entry app.engagement_roster_entries;
  v_count integer := 0;
  v_locked boolean;
  v_drafts_held integer := 0;
begin
  perform private.require_person();
  select * into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  perform private.assert_roster_manager(v_engagement);
  v_locked := private.roster_locked(v_engagement.id);
  for v_entry in
    select * from app.engagement_roster_entries r
    where r.engagement_id = v_engagement.id and r.deleted_at is null and not r.is_self and r.person_id is not null
      and r.entry_state in ('Draft', 'Returned')
    order by r.created_at, r.id
    for update
  loop
    -- Under a names lock a Draft stays a Draft; a Returned entry is still resubmitted.
    if v_locked and v_entry.entry_state = 'Draft' then
      v_drafts_held := v_drafts_held + 1;
      continue;
    end if;
    perform private.transition_lifecycle('roster_entry', 'app.engagement_roster_entries', 'entry_state',
      'app.roster_entry_state_transitions', 'roster_entry_id', v_entry.id, v_entry.entry_state::text, 'Submitted', 'Submitted.');
    v_count := v_count + 1;
  end loop;
  if v_count = 0 and v_drafts_held > 0 then
    perform private.refuse('roster_locked', 'Names are locked on this engagement. Ask the producing organization to change the roster.');
  end if;
  if v_count = 0 then
    perform private.refuse('roster_empty_submit', 'Add or change someone on the roster before submitting it.');
  end if;
  return v_count;
end;
$$;

comment on function app.submit_roster(uuid) is 'A roster manager submits the roster: every non-self Draft or Returned entry naming a person moves to Submitted for the producing org to review (an unclaimed invitation stays Draft). Under a names lock (R5) only Returned entries move and Drafts stay; it refuses roster_locked when nothing Returned is left and a Draft was held back, and roster_empty_submit when there is nothing to submit. Returns how many were submitted.';
revoke all on function app.submit_roster(uuid) from public, anon;
grant execute on function app.submit_roster(uuid) to authenticated, service_role;

-- The engaged party reads the lock (recreated from 1624) ---------------------------------------------------------------------------

create or replace view api_external.engagements as
select e.id, e.org_id, o.name as org_name, e.project_id, p.name as project_name, e.role_type, e.role_code, r.job_title,
  e.person_id, c.organization_id as account_id, e.pay_basis, e.arrangement,
  case when 'money' = any (a.areas) then coalesce(e.agreed_rate_minor, ol.rate_minor, rc.standard_rate_minor) end as rate_minor,
  case when 'money' = any (a.areas) then
    case when e.agreed_rate_minor is not null then e.currency_code when ol.rate_minor is not null then ol.currency_code else rc.currency_code end
  end as rate_currency_code,
  e.start_date, e.end_date, e.engagement_state, a.areas, p.time_zone as project_time_zone, e.roster_locks_at
from app.engagements e
join app.organizations o on o.id = e.org_id
join app.projects p on p.id = e.project_id
left join xpms.role r on r.role_code = e.role_code
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

comment on column api_external.engagements.roster_locks_at is 'Names lock (R5): after this instant the company side can no longer add, invite, edit Draft entries or submit new names. NULL means no lock.';
