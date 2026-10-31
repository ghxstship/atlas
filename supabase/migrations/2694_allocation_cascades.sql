-- 2694_allocation_cascades.sql
-- R7 Allocations, Atlas side (RRR-187, ADR 0104). What ends with an engagement or a roster entry:
--
--   * When an engagement reaches Complete or Canceled, private.close_engagement_allocations revokes every live
--     credential issued under it, parking passes included (prompt line 1758), and withdraws its Requested and
--     Approved allocations and those of its roster entries (cause Engagement Ended), releasing their holds. Custody
--     stays out and shows as outstanding in the status view until it is checked in.
--   * When a roster entry is withdrawn, removed or declined by the person, private.withdraw_entry_allocations
--     withdraws its allocations (cause Entry Removed), releases their holds and revokes the credentials issued under
--     them.
--   * Both send one allocation.withdrawn per affected person. Neither needs the closer to hold
--     credentials.credential.revoke: private.guard_credential (from its one definition, 0352) skips that check inside
--     the trusted operations engagement_close and roster_entry_close.

-- Revocation inside a cascade (from 0352) --------------------------------------------------------------------------------------

create or replace function private.guard_credential()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.issued_by := private.current_person_id();
    end if;
    if new.issued_by = new.holder_person_id then
      perform private.refuse('credential_self_issue', 'A person never issues their own credential or certification.');
    end if;
    new.credential_number := 'CR-' || lpad(private.next_sequence(new.org_id, 'credential')::text, 6, '0');
    new.revoked_at := null;
    new.revoked_by := null;
    return new;
  end if;
  if new.holder_person_id <> old.holder_person_id or new.issued_by is distinct from old.issued_by
     or new.credential_number <> old.credential_number or new.credential_category_id <> old.credential_category_id then
    perform private.refuse('credential_immutable', 'A credential keeps its holder, issuer, number and category.');
  end if;
  if old.revoked_at is not null and (new.revoked_at is distinct from old.revoked_at) then
    perform private.refuse('credential_revoked', 'A revoked credential stays revoked; issue a new one.');
  end if;
  if new.revoked_at is not null and old.revoked_at is null then
    if private.in_trusted_operation('engagement_close') or private.in_trusted_operation('roster_entry_close') then
      -- A cascade revokes for the person who closed the engagement or the entry; when no one is signed in, the
      -- cascade names who it revokes for.
      new.revoked_at := now();
      new.revoked_by := coalesce(private.current_person_id(), new.revoked_by);
      return new;
    end if;
    if auth.uid() is not null and not private.can_on_project(
        (select c.project_id from app.credential_categories c where c.id = new.credential_category_id), 'credentials.credential.revoke') then
      raise exception using errcode = '42501', message = 'credentials.credential.revoke is required';
    end if;
    new.revoked_at := now();
    new.revoked_by := private.current_person_id();
  end if;
  return new;
end;
$$;
comment on function private.guard_credential() is 'Credentials: issuer from the session and never the holder (invariant 21), number from the org sequence, fixed identity, revocation needs credentials.credential.revoke and is final. Inside the trusted operations engagement_close and roster_entry_close (R7) the cascade revokes without the capability, for the signed-in person or the person the cascade names.';
revoke all on function private.guard_credential() from public, anon, authenticated;

-- Withdrawing in a cascade -------------------------------------------------------------------------------------------------------

create or replace function private.cascade_withdraw_allocation(p_allocation app.advance_allocations, p_cause app.allocation_withdraw_cause,
  p_release app.reservation_release_reason, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.release_allocation_holds(p_allocation.id, p_release);
  perform private.withdraw_allocation_row(p_allocation.id, p_allocation.allocation_state, p_cause, p_reason);
  return coalesce(private.allocation_person(p_allocation), private.allocation_requester(p_allocation.id));
end;
$$;
comment on function private.cascade_withdraw_allocation(app.advance_allocations, app.allocation_withdraw_cause, app.reservation_release_reason, text) is 'One allocation withdrawn by a cascade: its holds released with the reason, the state Withdrawn with the cause; returns the person to tell (the holder, else the requester of a pool).';
revoke all on function private.cascade_withdraw_allocation(app.advance_allocations, app.allocation_withdraw_cause, app.reservation_release_reason, text) from public, anon, authenticated;

create or replace function private.close_engagement_allocations(p_engagement_id uuid, p_actor uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_allocation app.advance_allocations;
  v_people uuid[] := '{}';
  v_ids uuid[] := '{}';
  v_count integer := 0;
  v_i integer;
begin
  perform private.begin_trusted_operation('engagement_close');
  update app.credentials set revoked_at = now(), revoked_by = p_actor
  where engagement_id = p_engagement_id and revoked_at is null and deleted_at is null
    and coalesce(private.current_person_id(), p_actor) is not null;
  perform private.end_trusted_operation('engagement_close');

  for v_allocation in
    select a.* from app.advance_allocations a
    where a.deleted_at is null and a.allocation_state in ('Requested', 'Approved')
      and (a.engagement_id = p_engagement_id
        or a.roster_entry_id in (select r.id from app.engagement_roster_entries r where r.engagement_id = p_engagement_id))
    order by a.created_at, a.id
    for update
  loop
    v_people := v_people || private.cascade_withdraw_allocation(v_allocation, 'Engagement Ended', 'Engagement Ended', 'The engagement ended.');
    v_ids := v_ids || v_allocation.id;
    v_count := v_count + 1;
  end loop;
  -- One notification per affected person, about the first of their allocations.
  for v_i in select min(i) from generate_subscripts(v_people, 1) i where v_people[i] is not null group by v_people[i] loop
    perform private.notify_allocation(v_ids[v_i], 'allocation.withdrawn', array[v_people[v_i]],
      jsonb_build_object('cause', 'engagement_ended'));
  end loop;
  return v_count;
end;
$$;
comment on function private.close_engagement_allocations(uuid, uuid) is 'When an engagement ends (R7): inside engagement_close revokes every live credential issued under it, parking passes included, for the person who closed it; withdraws its Requested and Approved allocations and those of its roster entries (cause Engagement Ended, holds released Engagement Ended); sends one allocation.withdrawn per affected person. Custody stays out and reads as outstanding. Returns the number withdrawn.';
revoke all on function private.close_engagement_allocations(uuid, uuid) from public, anon, authenticated;

create or replace function private.withdraw_entry_allocations(p_roster_entry_id uuid, p_actor uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_allocation app.advance_allocations;
  v_first uuid;
  v_person uuid;
  v_count integer := 0;
begin
  perform private.begin_trusted_operation('roster_entry_close');
  update app.credentials set revoked_at = now(), revoked_by = p_actor
  where allocation_id in (select a.id from app.advance_allocations a where a.roster_entry_id = p_roster_entry_id)
    and revoked_at is null and deleted_at is null and coalesce(private.current_person_id(), p_actor) is not null;
  perform private.end_trusted_operation('roster_entry_close');

  for v_allocation in
    select a.* from app.advance_allocations a
    where a.roster_entry_id = p_roster_entry_id and a.deleted_at is null and a.allocation_state in ('Requested', 'Approved')
    order by a.created_at, a.id
    for update
  loop
    v_person := private.cascade_withdraw_allocation(v_allocation, 'Entry Removed', 'Entry Removed', 'The person left the roster.');
    v_first := coalesce(v_first, v_allocation.id);
    v_count := v_count + 1;
  end loop;
  if v_first is not null then
    perform private.notify_allocation(v_first, 'allocation.withdrawn', array[v_person], jsonb_build_object('cause', 'entry_removed'));
  end if;
  return v_count;
end;
$$;
comment on function private.withdraw_entry_allocations(uuid, uuid) is 'When a roster entry is withdrawn, removed or declined (R7): inside roster_entry_close revokes the credentials issued under its allocations, for the person who closed it; withdraws its Requested and Approved allocations (cause Entry Removed, holds released Entry Removed); sends allocation.withdrawn to the person once. Returns the number withdrawn.';
revoke all on function private.withdraw_entry_allocations(uuid, uuid) from public, anon, authenticated;

-- Triggers --------------------------------------------------------------------------------------------------------------------------

create or replace function private.on_engagement_closed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := coalesce(private.current_person_id(), new.created_by,
    (select e.updated_by from app.engagements e where e.id = new.engagement_id));
begin
  perform private.close_engagement_allocations(new.engagement_id, v_actor);
  return null;
end;
$$;
comment on function private.on_engagement_closed() is 'After an engagement moves to Complete or Canceled: closes its allocations and revokes its credentials (private.close_engagement_allocations) for the person who moved it.';
revoke all on function private.on_engagement_closed() from public, anon, authenticated;
create trigger t96_close_engagement_allocations after insert on app.engagement_state_transitions
  for each row when (new.to_state in ('Complete', 'Canceled')) execute function private.on_engagement_closed();

create or replace function private.on_roster_entry_closed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry uuid;
  v_actor uuid := private.current_person_id();
begin
  if tg_table_name = 'roster_entry_state_transitions' then
    v_entry := new.roster_entry_id;
    v_actor := coalesce(v_actor, new.created_by);
  else
    v_entry := new.id;
    v_actor := coalesce(v_actor, new.updated_by);
  end if;
  perform private.withdraw_entry_allocations(v_entry, v_actor);
  return null;
end;
$$;
comment on function private.on_roster_entry_closed() is 'After a roster entry moves to Withdrawn, is soft-deleted or is declined by the person: withdraws its allocations and revokes their credentials (private.withdraw_entry_allocations).';
revoke all on function private.on_roster_entry_closed() from public, anon, authenticated;
create trigger t96_withdraw_entry_allocations after insert on app.roster_entry_state_transitions
  for each row when (new.to_state = 'Withdrawn') execute function private.on_roster_entry_closed();
create trigger t96_withdraw_entry_allocations_removed after update of deleted_at on app.engagement_roster_entries
  for each row when (old.deleted_at is null and new.deleted_at is not null) execute function private.on_roster_entry_closed();
create trigger t96_withdraw_entry_allocations_declined after update of person_response on app.engagement_roster_entries
  for each row when (new.person_response = 'Declined' and old.person_response <> 'Declined') execute function private.on_roster_entry_closed();
