-- 1352_ownership_transfers.sql
-- A79 (RRR-124), finding A65-015, Section 14.7: "Ownership transfer: the new Owner must accept and pass MFA. The old
-- Owner becomes an Admin unless removed."
--   * app.ownership_transfers: an Owner offers the org to another active member, with step-up; the offer lasts 7
--     days. The member accepts with step-up (a second factor, so MFA) or declines; the Owner who offered, or any
--     Owner, may cancel; the hourly lifecycle job expires offers nobody answered.
--   * Acceptance runs in one transaction that keeps invariant 4 (the org keeps an Owner) at every step: the new Owner
--     gets the Owner role first, the old Owner gets Admin (unless they chose to leave), and only then does the old
--     Owner lose the Owner role; leaving ends their membership last. The org row is locked throughout, like every
--     Owner change (private.assert_other_owner).
--   * Every offer, answer and role change lands in the audit ledger (the audit trail on this table and on
--     membership_roles and memberships), and each side is told.

create table app.ownership_transfers (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  from_person_id uuid not null references app.people (id),
  to_person_id uuid not null references app.people (id),
  previous_owner_outcome text not null default 'admin',
  offered_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  declined_at timestamptz,
  canceled_at timestamptz,
  canceled_by uuid references app.people (id),
  expired_at timestamptz,
  constraint ownership_transfers_not_self check (from_person_id <> to_person_id),
  constraint ownership_transfers_outcome check (previous_owner_outcome in ('admin', 'leave')),
  constraint ownership_transfers_window check (expires_at = offered_at + interval '7 days'),
  constraint ownership_transfers_one_answer check (num_nonnulls(accepted_at, declined_at, canceled_at, expired_at) <= 1),
  constraint ownership_transfers_canceled check ((canceled_at is null) = (canceled_by is null))
);

call private.install_domain_table('app.ownership_transfers');
create unique index ownership_transfers_one_open on app.ownership_transfers (org_id)
  where accepted_at is null and declined_at is null and canceled_at is null and expired_at is null and deleted_at is null;
create index ownership_transfers_from_person_id_idx on app.ownership_transfers (from_person_id);
create index ownership_transfers_to_person_id_idx on app.ownership_transfers (to_person_id);
create index ownership_transfers_canceled_by_idx on app.ownership_transfers (canceled_by);

call private.describe('app.ownership_transfers', 'An Owner''s offer to hand the org to another member (Section 14.7). The member accepts with step-up (a second factor) within 7 days; the old Owner then becomes an Admin, or leaves if they chose to, and the org keeps an Owner at every step (invariant 4). Written only by the transfer RPCs; every change is audited.', array[
  'from_person_id', 'Owner who offered the org.',
  'to_person_id', 'Member the org is offered to; becomes an Owner on accepting.',
  'previous_owner_outcome', 'What happens to the Owner who offered on acceptance: admin (becomes an Admin) or leave (their membership ends).',
  'offered_at', 'When the offer was made.',
  'expires_at', 'When an unanswered offer lapses, 7 days after it was made.',
  'accepted_at', 'When the member accepted and became an Owner.',
  'declined_at', 'When the member declined.',
  'canceled_at', 'When an Owner withdrew the offer.',
  'canceled_by', 'Owner who withdrew it.',
  'expired_at', 'When the lifecycle job found the offer unanswered past its end.'
]);

call private.install_policies('app.ownership_transfers',
  $$org_id in (select private.orgs_with_capability('org.ownership.transfer'))
    or to_person_id = (select private.current_person_id())
    or from_person_id = (select private.current_person_id())$$);
call private.install_audit_trail('app.ownership_transfers');

create or replace function private.guard_ownership_transfer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id <> old.org_id or new.from_person_id <> old.from_person_id or new.to_person_id <> old.to_person_id
     or new.offered_at <> old.offered_at or new.expires_at <> old.expires_at
     or new.previous_owner_outcome <> old.previous_owner_outcome
     or num_nonnulls(old.accepted_at, old.declined_at, old.canceled_at, old.expired_at) > 0 then
    perform private.refuse('ownership_transfer_immutable', 'An ownership transfer keeps its parties and window, and is answered once.');
  end if;
  return new;
end;
$$;

comment on function private.guard_ownership_transfer() is 'Ownership transfers keep their org, parties, outcome and window, and take one answer.';
revoke all on function private.guard_ownership_transfer() from public, anon, authenticated;

create trigger t40_guard_ownership_transfer before update on app.ownership_transfers
  for each row execute function private.guard_ownership_transfer();

insert into private.notification_templates (kind, channel, category_code, email_template_code)
select k.kind, c.channel, 'account', case when c.channel = 'Email' then 'notification' end
from (values ('organization.ownership_offered'), ('organization.ownership_accepted'), ('organization.ownership_declined')) as k (kind)
cross join (values ('In App'::app.notification_channel), ('Email'), ('SMS'), ('Push')) as c (channel);

create or replace function private.open_membership(p_org_id uuid, p_person_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id from app.memberships m
  where m.org_id = p_org_id and m.person_id = p_person_id and m.deleted_at is null
    and m.valid_from <= now() and m.valid_to is null
  order by m.valid_from desc
  limit 1;
$$;

comment on function private.open_membership(uuid, uuid) is 'A person''s open-ended membership of an org, or null.';
revoke all on function private.open_membership(uuid, uuid) from public, anon, authenticated;

create or replace function private.expire_ownership_transfers(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update app.ownership_transfers t set expired_at = p_now
  where t.accepted_at is null and t.declined_at is null and t.canceled_at is null and t.expired_at is null
    and t.deleted_at is null and t.expires_at <= p_now;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function private.expire_ownership_transfers(timestamptz) is 'Ownership transfer step of the lifecycle job: marks offers unanswered past their 7 days as expired. Returns how many.';
revoke all on function private.expire_ownership_transfers(timestamptz) from public, anon, authenticated;

-- Offer, accept, decline, cancel ------------------------------------------------------------------------------------

create or replace function app.offer_ownership_transfer(p_org_id uuid, p_to_person_id uuid, p_previous_owner_outcome text default 'admin')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_id uuid;
begin
  if not private.has_capability(p_org_id, 'org.ownership.transfer') then
    raise exception using errcode = '42501', message = 'org.ownership.transfer is required';
  end if;
  perform private.require_step_up('transfer ownership');
  if v_person not in (select private.org_owner_ids(p_org_id)) then
    raise exception using errcode = '42501', message = 'only an Owner offers the org';
  end if;
  if p_previous_owner_outcome is null or p_previous_owner_outcome not in ('admin', 'leave') then
    perform private.refuse('ownership_transfer_outcome', 'Choose whether you become an Admin or leave the organization.');
  end if;
  if p_to_person_id is null or p_to_person_id = v_person then
    perform private.refuse('ownership_transfer_self', 'Offer the organization to another member.');
  end if;
  if private.open_membership(p_org_id, p_to_person_id) is null then
    perform private.refuse('ownership_transfer_not_member', 'Ownership goes only to an active member of the organization.');
  end if;
  if p_to_person_id in (select private.org_owner_ids(p_org_id)) then
    perform private.refuse('ownership_transfer_already_owner', 'That member is already an Owner.');
  end if;
  perform 1 from app.organizations o where o.id = p_org_id for update;
  perform private.expire_ownership_transfers(now());
  if exists (select 1 from app.ownership_transfers t
             where t.org_id = p_org_id and t.accepted_at is null and t.declined_at is null and t.canceled_at is null
               and t.expired_at is null and t.deleted_at is null) then
    perform private.refuse('ownership_transfer_open', 'An ownership offer is already open; cancel it before making another.');
  end if;
  insert into app.ownership_transfers (org_id, from_person_id, to_person_id, previous_owner_outcome, offered_at, expires_at)
  values (p_org_id, v_person, p_to_person_id, p_previous_owner_outcome, now(), now() + interval '7 days')
  returning id into v_id;
  perform private.notify(p_org_id, p_to_person_id, 'organization.ownership_offered', 'app.ownership_transfers', v_id, null,
    jsonb_build_object('expires_at', now() + interval '7 days'));
  return v_id;
end;
$$;

comment on function app.offer_ownership_transfer(uuid, uuid, text) is 'An Owner (org.ownership.transfer) with step-up offers the org to another active member who is not yet an Owner, choosing whether they become an Admin or leave on acceptance. One open offer per org; it lapses after 7 days. The member is told. Returns the transfer id.';
revoke all on function app.offer_ownership_transfer(uuid, uuid, text) from public, anon;
grant execute on function app.offer_ownership_transfer(uuid, uuid, text) to authenticated, service_role;

create or replace function app.accept_ownership_transfer(p_transfer_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_transfer app.ownership_transfers;
  v_new_membership uuid;
  v_old_membership uuid;
  v_owner uuid := private.system_role_id('owner');
  v_admin uuid := private.system_role_id('admin');
begin
  select * into v_transfer from app.ownership_transfers t where t.id = p_transfer_id and t.deleted_at is null for update;
  if v_transfer.id is null or v_transfer.to_person_id <> v_person then
    raise exception using errcode = '42501', message = 'ownership transfer not found';
  end if;
  if num_nonnulls(v_transfer.accepted_at, v_transfer.declined_at, v_transfer.canceled_at, v_transfer.expired_at) > 0 then
    perform private.refuse('ownership_transfer_closed', 'This ownership offer was already answered or withdrawn.');
  end if;
  if v_transfer.expires_at <= now() then
    perform private.refuse('ownership_transfer_expired', 'This ownership offer has lapsed; ask the Owner for a new one.');
  end if;
  perform private.require_step_up('accept ownership');
  perform 1 from app.organizations o where o.id = v_transfer.org_id for update;
  v_new_membership := private.open_membership(v_transfer.org_id, v_person);
  v_old_membership := private.open_membership(v_transfer.org_id, v_transfer.from_person_id);
  if v_new_membership is null then
    perform private.refuse('ownership_transfer_not_member', 'Ownership goes only to an active member of the organization.');
  end if;
  if v_old_membership is null or v_transfer.from_person_id not in (select private.org_owner_ids(v_transfer.org_id)) then
    perform private.refuse('ownership_transfer_stale', 'The member who offered the organization is no longer its Owner.');
  end if;

  perform private.begin_trusted_operation('membership_write');
  -- 1. The new Owner first, so the org never lacks one (invariant 4).
  insert into app.membership_roles (membership_id, role_id, granted_by)
  values (v_new_membership, v_owner, v_transfer.from_person_id);
  -- 2. The old Owner becomes an Admin while still holding the Owner role, so no seat changes hands.
  if v_transfer.previous_owner_outcome = 'admin'
     and not exists (select 1 from app.membership_roles mr where mr.membership_id = v_old_membership
                     and mr.role_id = v_admin and mr.deleted_at is null) then
    insert into app.membership_roles (membership_id, role_id, granted_by) values (v_old_membership, v_admin, v_person);
  end if;
  -- 3. Only now does the old Owner lose the Owner role; private.assert_other_owner sees the new Owner.
  update app.membership_roles set deleted_at = now()
  where membership_id = v_old_membership and role_id = v_owner and deleted_at is null;
  -- 4. Leaving ends the old Owner's membership last.
  if v_transfer.previous_owner_outcome = 'leave' then
    update app.memberships set valid_to = now() where id = v_old_membership;
  end if;
  perform private.end_trusted_operation('membership_write');

  update app.ownership_transfers set accepted_at = now() where id = v_transfer.id;
  perform private.notify(v_transfer.org_id, v_transfer.from_person_id, 'organization.ownership_accepted', 'app.ownership_transfers',
    v_transfer.id, null, '{}'::jsonb);
  return v_transfer.id;
end;
$$;

comment on function app.accept_ownership_transfer(uuid) is 'The member an org was offered to accepts with step-up (a second factor, Section 14.7) within 7 days: they become an Owner, then the old Owner becomes an Admin (or leaves, as they chose) and loses the Owner role, so the org keeps an Owner at every step (invariant 4). Refuses an answered, withdrawn or lapsed offer and one whose offering member is no longer an Owner. The old Owner is told. Returns the transfer id.';
revoke all on function app.accept_ownership_transfer(uuid) from public, anon;
grant execute on function app.accept_ownership_transfer(uuid) to authenticated, service_role;

create or replace function app.decline_ownership_transfer(p_transfer_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_transfer app.ownership_transfers;
begin
  select * into v_transfer from app.ownership_transfers t where t.id = p_transfer_id and t.deleted_at is null for update;
  if v_transfer.id is null or v_transfer.to_person_id <> v_person then
    raise exception using errcode = '42501', message = 'ownership transfer not found';
  end if;
  if num_nonnulls(v_transfer.accepted_at, v_transfer.declined_at, v_transfer.canceled_at, v_transfer.expired_at) > 0 then
    perform private.refuse('ownership_transfer_closed', 'This ownership offer was already answered or withdrawn.');
  end if;
  update app.ownership_transfers set declined_at = now() where id = v_transfer.id;
  perform private.notify(v_transfer.org_id, v_transfer.from_person_id, 'organization.ownership_declined', 'app.ownership_transfers',
    v_transfer.id, null, '{}'::jsonb);
  return v_transfer.id;
end;
$$;

comment on function app.decline_ownership_transfer(uuid) is 'The member an org was offered to declines; the Owner who offered is told. Returns the transfer id.';
revoke all on function app.decline_ownership_transfer(uuid) from public, anon;
grant execute on function app.decline_ownership_transfer(uuid) to authenticated, service_role;

create or replace function app.cancel_ownership_transfer(p_transfer_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_transfer app.ownership_transfers;
begin
  select * into v_transfer from app.ownership_transfers t where t.id = p_transfer_id and t.deleted_at is null for update;
  if v_transfer.id is null
     or not (v_transfer.from_person_id = v_person or private.has_capability(v_transfer.org_id, 'org.ownership.transfer')) then
    raise exception using errcode = '42501', message = 'ownership transfer not found';
  end if;
  if num_nonnulls(v_transfer.accepted_at, v_transfer.declined_at, v_transfer.canceled_at, v_transfer.expired_at) > 0 then
    perform private.refuse('ownership_transfer_closed', 'This ownership offer was already answered or withdrawn.');
  end if;
  update app.ownership_transfers set canceled_at = now(), canceled_by = v_person where id = v_transfer.id;
  return v_transfer.id;
end;
$$;

comment on function app.cancel_ownership_transfer(uuid) is 'Withdraws an open ownership offer: the Owner who made it or any Owner (org.ownership.transfer). Returns the transfer id.';
revoke all on function app.cancel_ownership_transfer(uuid) from public, anon;
grant execute on function app.cancel_ownership_transfer(uuid) to authenticated, service_role;

create or replace function private.run_org_lifecycle(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return private.run_trials(p_now) + private.expire_ownership_transfers(p_now)
    + private.schedule_deletions(p_now) + private.run_org_purges(5);
end;
$$;

comment on function private.run_org_lifecycle(timestamptz) is 'Hourly org lifecycle job (Section 14.7): trials, lapsed ownership offers, certificates for orgs due for deletion, then the purge of orgs whose storage objects the worker deleted. Returns the actions taken.';

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.ownership_transfers', 'Age', 'created_at', interval '7 years', 'Delete', 'Ownership changes are access changes kept as a compliance record (Section 8.4).');
