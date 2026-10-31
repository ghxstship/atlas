-- 2631_account_engagement_assignments.sql
-- R4 Crew roster core (RRR-182, ADR 0101 decision 1; owner decision 6 of 2026-10-28). An Account Member reaches only
-- the engagements their account's Owner or Admin assigns them (Section 4.5.8, prompt line 944).
--
--   * app.account_engagement_assignments: one live row per engagement and account membership, with the duty Advancing
--     Lead (manages the roster and the advance without being on it) or Member. org_id is the account, from the
--     membership; the engagement belongs to the producing org, so it is not a same-org reference. A soft delete is the
--     revocation.
--   * private.guard_account_engagement_assignment: the engagement is the account's (its counterparty's organization),
--     the membership is live, active and confirmed, and neither key moves.
--   * app.assign_engagement_member and app.unassign_engagement_member, for the account's Owner and Admin, never to
--     themselves. private.my_engagement_duties(engagement) is the caller's live duties there, which 2632 and the
--     engagement principal read.
--   * api_external.account_engagement_assignments for the account's Owners and Admins, and the caller's own rows.
--   * Sync scopes refresh for the member on every change, so Compass follows the assignment.

create type app.account_engagement_duty as enum ('Advancing Lead', 'Member');
comment on type app.account_engagement_duty is 'What an account member does on an engagement their account supplies (ADR 0101): Advancing Lead manages the roster and the advance; Member works it.';

create table app.account_engagement_assignments (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  engagement_id uuid not null references app.engagements (id),
  account_membership_id uuid not null references app.account_memberships (id),
  duty app.account_engagement_duty not null,
  granted_by uuid references app.people (id),
  deleted_at timestamptz
);

create index account_engagement_assignments_engagement_id_idx on app.account_engagement_assignments (engagement_id);
create index account_engagement_assignments_membership_idx on app.account_engagement_assignments (account_membership_id);
create index account_engagement_assignments_granted_by_idx on app.account_engagement_assignments (granted_by);
create unique index account_engagement_assignments_live_key on app.account_engagement_assignments (engagement_id, account_membership_id)
  where deleted_at is null;

-- engagement_id is not a reference check: the engagement belongs to the producing org, the row to the account.
call private.install_domain_table('app.account_engagement_assignments', 'app.account_memberships', 'account_membership_id');
call private.describe('app.account_engagement_assignments', 'An account member assigned to an engagement their external account supplies (ADR 0101, owner decision 6): an Account Member reaches only the engagements assigned to them. Written only by app.assign_engagement_member and app.unassign_engagement_member; a soft delete revokes it.', array[
  'org_id', 'The external account, derived from the membership.',
  'engagement_id', 'Engagement of the producing org that the account supplies.',
  'account_membership_id', 'Confirmed, active membership of the assigned person in the account.',
  'duty', 'Advancing Lead or Member.',
  'granted_by', 'Account Owner or Admin who assigned.'
]);

create or replace function private.guard_account_engagement_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.engagement_id <> old.engagement_id or new.account_membership_id <> old.account_membership_id) then
    perform private.refuse('assignment_immutable', 'An assignment keeps its engagement and member; remove it and assign again.');
  end if;
  if new.deleted_at is not null then
    return new;
  end if;
  if not exists (
    select 1 from app.engagements e join app.counterparties c on c.id = e.counterparty_id
    where e.id = new.engagement_id and e.deleted_at is null and c.organization_id = new.org_id) then
    perform private.refuse('assignment_account_mismatch', 'An account assigns its members only to engagements it supplies.');
  end if;
  if not exists (
    select 1 from app.account_memberships m
    where m.id = new.account_membership_id and m.deleted_at is null and m.accepted_at is not null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
    perform private.refuse('account_membership_unconfirmed', 'Only a member who confirmed their active membership is assigned.');
  end if;
  return new;
end;
$$;

comment on function private.guard_account_engagement_assignment() is 'Account engagement assignments: the engagement is supplied by the account (its counterparty''s organization), the membership is live, active and confirmed, and the engagement and membership never change.';
revoke all on function private.guard_account_engagement_assignment() from public, anon, authenticated;

create trigger t40_guard_account_engagement_assignment before insert or update on app.account_engagement_assignments
  for each row execute function private.guard_account_engagement_assignment();

call private.install_policies('app.account_engagement_assignments',
  $$account_membership_id in (select private.my_account_membership_ids())
    or engagement_id in (select e.id from app.engagements e where e.project_id in (select private.project_ids_with('opportunities.engagement.read')))$$);
revoke insert, update on app.account_engagement_assignments from authenticated;
call private.install_default_retention('app.account_engagement_assignments');
call private.install_audit_trail('app.account_engagement_assignments');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('account_engagement_assignments', 'An assignment is access: a removed assignment is granted again, never restored from Trash.')
on conflict (table_name) do nothing;

-- The caller's duties (column values in, ADR 0016 item 14) -----------------------------------------------------------------

create or replace function private.my_engagement_duties(p_engagement_id uuid)
returns setof app.account_engagement_duty
language sql
stable
security definer
set search_path = ''
as $$
  select distinct a.duty
  from app.account_engagement_assignments a
  join app.account_memberships m on m.id = a.account_membership_id
  join app.engagements e on e.id = a.engagement_id
  join app.counterparties c on c.id = e.counterparty_id and c.organization_id = m.org_id
  where a.engagement_id = p_engagement_id and a.deleted_at is null
    and m.person_id = private.current_person_id() and m.deleted_at is null and m.accepted_at is not null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now());
$$;

comment on function private.my_engagement_duties(uuid) is 'Section 8.7 (R4): the signed-in person''s live duties on an engagement, through their active, confirmed membership in the account that supplies it; empty when none.';
revoke all on function private.my_engagement_duties(uuid) from public, anon;
grant execute on function private.my_engagement_duties(uuid) to authenticated, service_role;

-- RPCs ------------------------------------------------------------------------------------------------------------------

create or replace function app.assign_engagement_member(
  p_engagement_id uuid,
  p_account_membership_id uuid,
  p_duty app.account_engagement_duty
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_account uuid;
  v_member app.account_memberships;
  v_id uuid;
begin
  select c.organization_id into v_account from app.engagements e join app.counterparties c on c.id = e.counterparty_id
  where e.id = p_engagement_id and e.deleted_at is null;
  if v_account is null then
    raise exception using errcode = '42501', message = 'engagement not found';
  end if;
  perform private.assert_account_admin(v_account);
  select * into v_member from app.account_memberships m where m.id = p_account_membership_id and m.deleted_at is null;
  if v_member.id is null then
    perform private.refuse('account_membership_unconfirmed', 'Only a member who confirmed their active membership is assigned.');
  end if;
  if v_member.person_id = v_me then
    perform private.refuse('sod_self_grant', 'A person cannot grant themselves a role or capability.');
  end if;
  if p_duty is null then
    perform private.refuse('assignment_duty_required', 'Choose Advancing Lead or Member.');
  end if;
  select a.id into v_id from app.account_engagement_assignments a
  where a.engagement_id = p_engagement_id and a.account_membership_id = p_account_membership_id and a.deleted_at is null
  for update;
  if v_id is not null then
    update app.account_engagement_assignments set duty = p_duty, granted_by = v_me where id = v_id and duty <> p_duty;
    return v_id;
  end if;
  insert into app.account_engagement_assignments (engagement_id, account_membership_id, duty, granted_by)
  values (p_engagement_id, p_account_membership_id, p_duty, v_me)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.assign_engagement_member(uuid, uuid, app.account_engagement_duty) is 'An Account Owner or Admin of the account that supplies an engagement assigns one of its confirmed members to it as Advancing Lead or Member, never themselves (sod_self_grant); a live assignment of the same member changes duty. Returns the assignment id.';

create or replace function app.unassign_engagement_member(p_assignment_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row app.account_engagement_assignments;
begin
  perform private.require_person();
  select * into v_row from app.account_engagement_assignments a where a.id = p_assignment_id and a.deleted_at is null;
  if v_row.id is null then
    raise exception using errcode = '42501', message = 'assignment not found';
  end if;
  perform private.assert_account_admin(v_row.org_id);
  update app.account_engagement_assignments set deleted_at = now() where id = v_row.id;
end;
$$;

comment on function app.unassign_engagement_member(uuid) is 'An Account Owner or Admin removes an assignment (soft delete); the member reaches the engagement no more unless another relationship opens it.';

-- View ------------------------------------------------------------------------------------------------------------------

create view api_external.account_engagement_assignments as
select a.id, a.engagement_id, a.account_membership_id, m.person_id, p.full_name, a.duty
from app.account_engagement_assignments a
join app.account_memberships m on m.id = a.account_membership_id
join app.people p on p.id = m.person_id
where a.deleted_at is null
  and (a.org_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))
    or a.account_membership_id in (select private.my_account_membership_ids()));

call private.describe('api_external.account_engagement_assignments', 'Live engagement assignments of the accounts where the caller is an Account Owner or Admin, and the caller''s own (R4, owner decision 6).', array[
  'id', 'Assignment.', 'engagement_id', 'Engagement.', 'account_membership_id', 'Account membership assigned.',
  'person_id', 'Assigned person.', 'full_name', 'Name.', 'duty', 'Advancing Lead or Member.']);

revoke all on api_external.account_engagement_assignments from public, anon;
grant select on api_external.account_engagement_assignments to authenticated, service_role;

-- Sync scopes (0942) ------------------------------------------------------------------------------------------------------

create or replace function private.sync_scope_account_assignment_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership uuid := case when tg_op = 'DELETE' then old.account_membership_id else new.account_membership_id end;
begin
  perform private.refresh_sync_scopes_of_people(array(select m.person_id from app.account_memberships m where m.id = v_membership));
  return null;
end;
$$;

comment on function private.sync_scope_account_assignment_trigger() is 'After an account engagement assignment changes: refreshes the assigned person''s sync scopes, so Compass follows what they reach.';
revoke all on function private.sync_scope_account_assignment_trigger() from public, anon, authenticated;

create trigger t96_sync_scopes after insert or update or delete on app.account_engagement_assignments
  for each row execute function private.sync_scope_account_assignment_trigger();

-- Privileges --------------------------------------------------------------------------------------------------------------

revoke all on function app.assign_engagement_member(uuid, uuid, app.account_engagement_duty) from public, anon;
revoke all on function app.unassign_engagement_member(uuid) from public, anon;
grant execute on function app.assign_engagement_member(uuid, uuid, app.account_engagement_duty) to authenticated, service_role;
grant execute on function app.unassign_engagement_member(uuid) to authenticated, service_role;

select private.sync_trash_tables();
