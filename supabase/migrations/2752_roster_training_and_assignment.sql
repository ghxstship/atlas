-- 2752_roster_training_and_assignment.sql
-- R12 Agency staff on shifts (RRR-190; ADR 0101 R12 amendment; journey 42: slate, award, assign staff, training
-- acknowledgments before positions). Owner decisions 0/1 and 6: the person accepts their roster entry, acknowledges
-- training and records time; the agency assigns; the production allocates slots and verifies.
--
--   * app.roster_training_records: one acknowledgment per roster entry and onboarding requirement (0730), with the
--     production's verification. Read by project readers with opportunities.engagement.read and by the entry's person;
--     written only by the RPCs below.
--   * private.roster_training_requirement_ids(entry): the org's live, blocking Training and Acknowledgment requirements
--     for the Staff role type (or every role type) that apply to the entry's engagement, by 0730's jurisdiction rule
--     (private.engagement_requirement_ids). private.roster_training_due(entry) is those not yet satisfied:
--     acknowledged and either verified automatically or verified Passed.
--   * app.roster_training_summary(entries): due and awaiting-verification counts per entry, for the shift editor and the
--     Positions tab, to the entry's readers, its lead and its person.
--   * app.acknowledge_roster_training: only the entry's person, while the onboarding area of the entry is open.
--     app.verify_roster_training: opportunities.onboarding.write on the project, never by the entry's person
--     (sod_roster_training).
--   * app.assign_roster_shift and app.unassign_roster_shift: the agency's lead while the engagement's operational area
--     is open, or a holder of crew.shift.write on the project, puts an accepted, trained roster entry on a slot of its
--     engagement (or moves a shift between entries of it) and takes it back off. Under the trusted operation
--     roster_shift_assignment the shift's engagement_id gives way to roster_entry_id; an Accepted shift returns to
--     Published first, so the new person accepts it.
--   * app.accept_engaged_shift (1000) also accepts a Published shift of the caller's operational roster entry.
--   * Slate seeding: a Staff company engagement created from an agency's application (0720 application_id) seeds a
--     Draft roster entry, through R4's private.insert_roster_entry, for each slate person who has confirmed their
--     membership of the agency's account; app.accept_account_membership (2630) seeds the rest as they confirm, and
--     skips, without failing, an engagement whose names lock (R5's private.roster_locked) has passed. The role comes
--     from the engagement: a slate's opportunity position names no role. The person still accepts, and the agency
--     still submits.
--   * api_external.my_roster_training: the training due on the caller's own roster entries (onboarding area) and, for
--     the agency's leads, on every entry of their rosters.
-- Nothing is copied, so no denormalization register row: the requirement's name and kind are read through it.

-- Training records -----------------------------------------------------------------------------------------------------------

create table app.roster_training_records (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  roster_entry_id uuid not null references app.engagement_roster_entries (id),
  onboarding_requirement_id uuid not null references app.onboarding_requirements (id),
  acknowledged_at timestamptz not null default now(),
  verified_by uuid references app.people (id),
  verified_at timestamptz,
  verification_outcome app.verification_outcome,
  deleted_at timestamptz,
  constraint roster_training_records_verification check (num_nulls(verified_by, verified_at, verification_outcome) in (0, 3))
);

create index roster_training_records_roster_entry_id_idx on app.roster_training_records (roster_entry_id);
create index roster_training_records_requirement_idx on app.roster_training_records (onboarding_requirement_id);
create index roster_training_records_verified_by_idx on app.roster_training_records (verified_by);
create unique index roster_training_records_key on app.roster_training_records (roster_entry_id, onboarding_requirement_id)
  where deleted_at is null;

call private.install_domain_table('app.roster_training_records', 'app.engagement_roster_entries', 'roster_entry_id',
  array['app.onboarding_requirements', 'onboarding_requirement_id']);
call private.describe('app.roster_training_records', 'An agency staff member''s acknowledgment of a training or acknowledgment requirement on their roster entry, and the production''s verification of it (R12, journey 42). Written only by app.acknowledge_roster_training and app.verify_roster_training; an agency places the person on shifts once nothing is due.', array[
  'org_id', 'Producing org, derived from the roster entry.',
  'roster_entry_id', 'Roster entry the person acknowledged on.',
  'onboarding_requirement_id', 'Training or acknowledgment requirement acknowledged.',
  'acknowledged_at', 'When the person last acknowledged it.',
  'verified_by', 'Who verified it for the production; NULL until verified.',
  'verified_at', 'When it was verified; NULL until verified.',
  'verification_outcome', 'Passed or Failed; NULL until verified. A requirement verified automatically needs only the acknowledgment.'
]);

call private.install_policies('app.roster_training_records',
  $$roster_entry_id in (select r.id from app.engagement_roster_entries r join app.engagements e on e.id = r.engagement_id
      where e.project_id in (select private.project_ids_with('opportunities.engagement.read')))
    or roster_entry_id in (select private.my_roster_entry_ids('roster'))$$);
revoke insert, update on app.roster_training_records from authenticated;
call private.install_default_retention('app.roster_training_records');
call private.install_audit_trail('app.roster_training_records');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('roster_training_records', 'A training acknowledgment is acknowledged again or verified, never deleted by hand.')
on conflict (table_name) do nothing;

select private.sync_trash_tables();

insert into private.separation_of_duties_rules (code, enforced_on, description) values
  ('sod_roster_training', 'Roster training records', 'A person cannot verify their own training on a roster entry.')
on conflict (code) do nothing;

-- What is due ------------------------------------------------------------------------------------------------------------------

create or replace function private.roster_training_requirement_ids(p_roster_entry_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select q.id
  from app.engagement_roster_entries r
  join app.onboarding_requirements q on q.id in (select private.engagement_requirement_ids(r.engagement_id))
  where r.id = p_roster_entry_id and r.deleted_at is null
    and q.deleted_at is null and q.item_kind in ('Training', 'Acknowledgment') and q.is_blocking
    and (q.role_type is null or q.role_type = 'Staff');
$$;

comment on function private.roster_training_requirement_ids(uuid) is 'R12: the training a roster entry''s person acknowledges before placement: the org''s live, blocking Training and Acknowledgment requirements for the Staff role type or every role type that apply to the entry''s engagement by 0730''s jurisdiction rule (private.engagement_requirement_ids).';
revoke all on function private.roster_training_requirement_ids(uuid) from public, anon;
-- Function calls inside a view run with the caller's execute privilege, so signed-in users need this.
grant execute on function private.roster_training_requirement_ids(uuid) to authenticated, service_role;

create or replace function private.roster_training_satisfied(p_roster_entry_id uuid, p_requirement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.roster_training_records t
    join app.onboarding_requirements q on q.id = t.onboarding_requirement_id
    where t.roster_entry_id = p_roster_entry_id and t.onboarding_requirement_id = p_requirement_id and t.deleted_at is null
      and (q.verification_method = 'Automatic' or t.verification_outcome = 'Passed'));
$$;

comment on function private.roster_training_satisfied(uuid, uuid) is 'R12: true when a roster entry''s person acknowledged a requirement and it needs no reviewer (Automatic) or the production verified it Passed.';
revoke all on function private.roster_training_satisfied(uuid, uuid) from public, anon;
-- Function calls inside a view run with the caller's execute privilege, so signed-in users need this.
grant execute on function private.roster_training_satisfied(uuid, uuid) to authenticated, service_role;

create or replace function private.roster_training_due(p_roster_entry_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select q.id from private.roster_training_requirement_ids(p_roster_entry_id) q (id)
  where not private.roster_training_satisfied(p_roster_entry_id, q.id);
$$;

comment on function private.roster_training_due(uuid) is 'R12: the requirements of private.roster_training_requirement_ids a roster entry has not satisfied yet. app.assign_roster_shift refuses roster_training_incomplete while any is left.';
revoke all on function private.roster_training_due(uuid) from public, anon, authenticated;

create or replace function app.roster_training_summary(p_roster_entry_ids uuid[])
returns table (roster_entry_id uuid, due_count integer, awaiting_verification integer)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id,
    (select count(*)::integer from private.roster_training_due(r.id)),
    (select count(*)::integer from private.roster_training_due(r.id) d (id)
     join app.roster_training_records t on t.roster_entry_id = r.id and t.onboarding_requirement_id = d.id
       and t.deleted_at is null and t.verification_outcome is null)
  from app.engagement_roster_entries r
  join app.engagements e on e.id = r.engagement_id
  where r.id = any (p_roster_entry_ids) and r.deleted_at is null
    and (e.project_id in (select private.project_ids_with('opportunities.engagement.read'))
      or e.project_id in (select private.project_ids_with('advancing.packet.read'))
      or private.roster_entry_lead(r.id)
      or r.id in (select private.my_roster_entry_ids('onboarding')));
$$;

comment on function app.roster_training_summary(uuid[]) is 'R12: for each roster entry the caller may read (opportunities.engagement.read or advancing.packet.read on its project, the agency''s lead, or the entry''s person), how many training requirements are still due and how many of those wait only on the production''s verification. Atlas''s shift editor and Gateway''s Positions tab show it beside each person; entries the caller may not read are left out.';

-- Acknowledging and verifying --------------------------------------------------------------------------------------------------

create or replace function app.acknowledge_roster_training(p_roster_entry_id uuid, p_requirement_id uuid)
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
  if p_roster_entry_id is null or p_roster_entry_id not in (select private.my_roster_entry_ids('onboarding'))
     or private.roster_entry_person(p_roster_entry_id) is distinct from v_person then
    raise exception using errcode = '42501', message = 'only the person on the roster entry acknowledges its training';
  end if;
  if p_requirement_id is null or p_requirement_id not in (select private.roster_training_due(p_roster_entry_id)) then
    perform private.refuse('roster_training_not_due', 'This training is not due on your roster entry.');
  end if;
  update app.roster_training_records
  set acknowledged_at = now(), verified_by = null, verified_at = null, verification_outcome = null
  where roster_entry_id = p_roster_entry_id and onboarding_requirement_id = p_requirement_id and deleted_at is null
  returning id into v_id;
  if v_id is null then
    insert into app.roster_training_records (roster_entry_id, onboarding_requirement_id)
    values (p_roster_entry_id, p_requirement_id)
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

comment on function app.acknowledge_roster_training(uuid, uuid) is 'The person on a roster entry acknowledges a training or acknowledgment requirement due on it while its onboarding area is open (R12); acknowledging again after a failed verification clears that verification. Refuses roster_training_not_due. Returns the record id.';

create or replace function app.verify_roster_training(p_record_id uuid, p_outcome app.verification_outcome)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_record app.roster_training_records;
  v_project uuid;
begin
  select * into v_record from app.roster_training_records t where t.id = p_record_id and t.deleted_at is null for update;
  select e.project_id into v_project from app.engagement_roster_entries r join app.engagements e on e.id = r.engagement_id
  where r.id = v_record.roster_entry_id;
  if v_record.id is null or not private.can_on_project(v_project, 'opportunities.onboarding.write') then
    raise exception using errcode = '42501', message = 'opportunities.onboarding.write is required on the project';
  end if;
  if p_outcome is null then
    perform private.refuse('roster_training_outcome', 'Record Passed or Failed.');
  end if;
  perform private.assert_separation('sod_roster_training', v_person, private.roster_entry_person(v_record.roster_entry_id));
  update app.roster_training_records
  set verified_by = v_person, verified_at = now(), verification_outcome = p_outcome
  where id = v_record.id;
  return v_record.id;
end;
$$;

comment on function app.verify_roster_training(uuid, app.verification_outcome) is 'The production records whether an agency staff member''s training acknowledgment passed (R12): opportunities.onboarding.write on the project, never by the person on the entry (sod_roster_training). Returns the record id.';

-- Placing agency staff on shifts ---------------------------------------------------------------------------------------------------

create or replace function private.can_place_roster_staff(p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_manage_roster(p_engagement_id) and 'operational' in (select private.engagement_scope(p_engagement_id));
$$;

comment on function private.can_place_roster_staff(uuid) is 'R12: true when the signed-in person leads the engagement''s roster (R4''s private.can_manage_roster) while its operational area is open to them, so they may place its roster staff on its slots.';
revoke all on function private.can_place_roster_staff(uuid) from public, anon;
-- Function calls inside a view run with the caller's execute privilege, so signed-in users need this.
grant execute on function private.can_place_roster_staff(uuid) to authenticated, service_role;

create or replace function app.assign_roster_shift(p_shift_id uuid, p_roster_entry_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_shift app.shifts;
  v_entry app.engagement_roster_entries;
  v_holder_engagement uuid;
  v_worker uuid;
begin
  select * into v_shift from app.shifts s where s.id = p_shift_id and s.deleted_at is null for update;
  select * into v_entry from app.engagement_roster_entries r where r.id = p_roster_entry_id and r.deleted_at is null;
  if v_shift.id is null or v_entry.id is null
     or not (private.can_place_roster_staff(v_entry.engagement_id) or private.can_on_project(v_shift.project_id, 'crew.shift.write')) then
    raise exception using errcode = '42501', message = 'the agency''s lead or crew.shift.write on the project places roster staff on shifts';
  end if;
  v_holder_engagement := coalesce(
    case when private.is_agency_slot_engagement(v_shift.engagement_id) then v_shift.engagement_id end,
    (select r.engagement_id from app.engagement_roster_entries r where r.id = v_shift.roster_entry_id));
  if v_holder_engagement is null then
    perform private.refuse('roster_shift_not_agency_slot', 'Only an agency slot, or a shift held by the agency''s roster, takes agency staff.');
  end if;
  if v_holder_engagement <> v_entry.engagement_id then
    perform private.refuse('roster_entry_other_engagement', 'This shift belongs to another engagement''s roster.');
  end if;
  if v_shift.shift_state = 'Canceled' or v_shift.ends_at <= now() then
    perform private.refuse('roster_shift_closed', 'This shift is canceled or already over.');
  end if;
  if v_entry.entry_state <> 'Accepted' or v_entry.person_response <> 'Accepted' then
    perform private.refuse('roster_entry_not_accepted', 'Place a person once the production accepted their roster entry and they accepted it too.');
  end if;
  if exists (select 1 from private.roster_training_due(v_entry.id)) then
    perform private.refuse('roster_training_incomplete', 'This person has training to acknowledge, or to be verified, before their first shift.');
  end if;
  v_worker := private.roster_entry_person(v_entry.id);
  if exists (
    select 1 from app.shifts s
    where s.id <> v_shift.id and s.org_id = v_shift.org_id and s.deleted_at is null and s.shift_state <> 'Canceled'
      and private.shift_worker_person_id(s.membership_id, s.engagement_id, s.roster_entry_id) = v_worker
      and tstzrange(s.starts_at, s.ends_at) && tstzrange(v_shift.starts_at, v_shift.ends_at)) then
    perform private.refuse('roster_shift_overlap', 'This person already holds a shift that overlaps this one.');
  end if;
  if v_shift.roster_entry_id is not distinct from v_entry.id then
    return v_shift.id;
  end if;
  perform private.begin_trusted_operation('roster_shift_assignment');
  if v_shift.shift_state = 'Accepted' then
    perform private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions',
      'shift_id', v_shift.id, 'Accepted', 'Published', 'Reassigned; the new person accepts the shift.');
  end if;
  update app.shifts set roster_entry_id = v_entry.id, engagement_id = null where id = v_shift.id;
  perform private.end_trusted_operation('roster_shift_assignment');
  return v_shift.id;
end;
$$;

comment on function app.assign_roster_shift(uuid, uuid) is 'Places an agency staff member on a shift (R12): the agency''s lead while the engagement''s operational area is open, or crew.shift.write on the project. The shift is a slot of the entry''s engagement or held by another entry of it (roster_shift_not_agency_slot, roster_entry_other_engagement), not canceled or over (roster_shift_closed); the entry and the person accepted (roster_entry_not_accepted), nothing is due in training (roster_training_incomplete), and the person holds no overlapping shift (roster_shift_overlap). The shift then names the entry instead of the engagement; an Accepted shift returns to Published for the new person to accept. Returns the shift id.';

create or replace function app.unassign_roster_shift(p_shift_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_shift app.shifts;
  v_engagement uuid;
begin
  select * into v_shift from app.shifts s where s.id = p_shift_id and s.deleted_at is null for update;
  v_engagement := coalesce((select r.engagement_id from app.engagement_roster_entries r where r.id = v_shift.roster_entry_id),
    case when private.is_agency_slot_engagement(v_shift.engagement_id) then v_shift.engagement_id end);
  if v_shift.id is null
     or not ((v_engagement is not null and private.can_place_roster_staff(v_engagement))
             or private.can_on_project(v_shift.project_id, 'crew.shift.write')) then
    raise exception using errcode = '42501', message = 'the agency''s lead or crew.shift.write on the project takes roster staff off shifts';
  end if;
  if v_shift.roster_entry_id is null then
    perform private.refuse('roster_shift_not_assigned', 'No one from an agency''s roster holds this shift.');
  end if;
  if v_shift.shift_state = 'Canceled' then
    perform private.refuse('roster_shift_closed', 'This shift is canceled or already over.');
  end if;
  perform private.begin_trusted_operation('roster_shift_assignment');
  if v_shift.shift_state = 'Accepted' then
    perform private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions',
      'shift_id', v_shift.id, 'Accepted', 'Published', coalesce(nullif(btrim(p_reason), ''), 'Taken off the shift.'));
  end if;
  update app.shifts set engagement_id = v_engagement, roster_entry_id = null where id = v_shift.id;
  perform private.end_trusted_operation('roster_shift_assignment');
  return v_shift.id;
end;
$$;

comment on function app.unassign_roster_shift(uuid, text) is 'Takes an agency staff member off a shift (R12), by the same callers as app.assign_roster_shift: the shift becomes the engagement''s agency slot again, and an Accepted shift returns to Published with the reason. Refuses roster_shift_not_assigned and, on a canceled shift, roster_shift_closed. Returns the shift id.';

-- Accepting a shift (latest: 1000) -----------------------------------------------------------------------------------------------------

create or replace function app.accept_engaged_shift(p_shift_id uuid, p_reason text default 'Accepted.')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shift app.shifts;
  v_person uuid;
begin
  v_person := private.require_person();
  select s.* into v_shift from app.shifts s where s.id = p_shift_id and s.deleted_at is null for update;
  if v_shift.id is null or not (
    (v_shift.engagement_id is not null
     and (select e.person_id from app.engagements e where e.id = v_shift.engagement_id) is not distinct from v_person
     and v_shift.engagement_id in (select private.my_engagement_ids('operational')))
    or (v_shift.roster_entry_id is not null
        and private.roster_entry_person(v_shift.roster_entry_id) is not distinct from v_person
        and v_shift.roster_entry_id in (select private.my_roster_entry_ids('operational')))) then
    raise exception using errcode = '42501', message = 'only the engaged person assigned accepts a shift';
  end if;
  return private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions',
    'shift_id', p_shift_id, 'Published', 'Accepted', p_reason);
end;
$$;

comment on function app.accept_engaged_shift(uuid, text) is 'The engaged person assigned to a Published shift through their engagement, or the agency staff member placed on it through their roster entry (R12), accepts it while the operational area is open (the external half of A13''s app.accept_shift). Returns the ledger entry id.';

-- Slate seeding ------------------------------------------------------------------------------------------------------------------------

create or replace function private.seed_slate_entries(p_engagement_id uuid, p_person_id uuid default null)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_account uuid;
  v_person uuid;
  v_seeded integer := 0;
begin
  select * into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if v_engagement.id is null or v_engagement.role_type <> 'Staff' or v_engagement.application_id is null
     or v_engagement.person_id is not null or v_engagement.counterparty_id is null
     or v_engagement.engagement_state not in ('Onboarding', 'Blocked', 'Active', 'Closing')
     or private.roster_locked(v_engagement.id) then
    return 0;
  end if;
  select c.organization_id into v_account from app.counterparties c where c.id = v_engagement.counterparty_id;
  for v_person in
    select distinct s.person_id from app.agency_slates s
    where s.application_id = v_engagement.application_id and s.deleted_at is null
      and (p_person_id is null or s.person_id = p_person_id)
      and exists (select 1 from app.account_memberships m
                  where m.org_id = v_account and m.person_id = s.person_id and m.deleted_at is null and m.accepted_at is not null
                    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
      and not exists (select 1 from app.engagement_roster_entries r
                      where r.engagement_id = v_engagement.id and r.person_id = s.person_id
                        and r.deleted_at is null and r.entry_state <> 'Withdrawn')
  loop
    perform private.insert_roster_entry(v_engagement.id, v_person, v_engagement.role_code, null, null, null, false);
    v_seeded := v_seeded + 1;
  end loop;
  return v_seeded;
end;
$$;

comment on function private.seed_slate_entries(uuid, uuid) is 'R12: seeds a Draft roster entry on a Staff company engagement made from an agency''s application for each slate person (or the one given) who has confirmed an active membership of the agency''s account and is not on the roster yet, through R4''s private.insert_roster_entry with the engagement''s role. Skips, without failing, an engagement that is closed or whose names lock has passed (R5''s private.roster_locked). Returns how many it seeded.';
revoke all on function private.seed_slate_entries(uuid, uuid) from public, anon, authenticated;

create or replace function private.seed_roster_from_slate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.seed_slate_entries(new.id);
  return null;
end;
$$;

comment on function private.seed_roster_from_slate() is 'After a Staff company engagement is created from an agency''s application, seeds the roster from its slate (private.seed_slate_entries, R12).';
revoke all on function private.seed_roster_from_slate() from public, anon, authenticated;

create trigger t92_seed_roster_from_slate after insert on app.engagements
  for each row when (new.role_type = 'Staff' and new.application_id is not null and new.person_id is null and new.counterparty_id is not null)
  execute function private.seed_roster_from_slate();

-- Confirming an account membership (latest: 2630) ----------------------------------------------------------------------------------------

create or replace function app.accept_account_membership(p_account_membership_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_member app.account_memberships;
  v_engagement uuid;
begin
  select * into v_member from app.account_memberships m
  where m.id = p_account_membership_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now());
  if v_member.id is null or v_member.person_id <> v_me then
    perform private.refuse('account_membership_not_yours', 'Only the person a live account membership names confirms it.');
  end if;
  update app.account_memberships set accepted_at = now() where id = v_member.id and accepted_at is null;
  for v_engagement in
    select e.id from app.engagements e
    join app.counterparties c on c.id = e.counterparty_id and c.organization_id = v_member.org_id
    join app.applications a on a.id = e.application_id and a.applicant_organization_id = v_member.org_id
    where e.deleted_at is null and e.role_type = 'Staff' and e.person_id is null
      and exists (select 1 from app.agency_slates s where s.application_id = a.id and s.person_id = v_me and s.deleted_at is null)
  loop
    perform private.seed_slate_entries(v_engagement, v_me);
  end loop;
end;
$$;

comment on function app.accept_account_membership(uuid) is 'The person a live, active account membership names confirms it (ADR 0101 decision 2); confirming again changes nothing. Confirming also seeds their Draft roster entries on the Staff engagements the account won with them on its slate (R12), except where the names lock has passed. Declining is app.end_account_membership.';

-- What the person and the agency read ------------------------------------------------------------------------------------------------------

create view api_external.my_roster_training as
select r.id as roster_entry_id, q.id as onboarding_requirement_id, q.name, q.item_kind, t.acknowledged_at, t.verification_outcome,
  private.roster_training_satisfied(r.id, q.id) as is_satisfied
from app.engagement_roster_entries r
cross join lateral private.roster_training_requirement_ids(r.id) as req (id)
join app.onboarding_requirements q on q.id = req.id
left join app.roster_training_records t on t.roster_entry_id = r.id and t.onboarding_requirement_id = q.id and t.deleted_at is null
where r.deleted_at is null and r.entry_state <> 'Withdrawn'
  and (r.id in (select private.my_roster_entry_ids('onboarding')) or private.roster_entry_lead(r.id));

call private.describe('api_external.my_roster_training', 'Training an agency staff member acknowledges before their first shift (R12, journey 42): for the caller''s own roster entries while the onboarding area is open, and for every entry on the rosters the caller leads. Acknowledged through app.acknowledge_roster_training.', array[
  'roster_entry_id', 'Roster entry.', 'onboarding_requirement_id', 'Requirement.', 'name', 'Requirement name.',
  'item_kind', 'Training or Acknowledgment.', 'acknowledged_at', 'When the person last acknowledged it; NULL until then.',
  'verification_outcome', 'Passed or Failed once the production verified it; NULL until then.',
  'is_satisfied', 'True once nothing more is needed: acknowledged, and verified Passed unless verified automatically.']);

-- Privileges ---------------------------------------------------------------------------------------------------------------------------------

revoke all on api_external.my_roster_training from public, anon;
grant select on api_external.my_roster_training to authenticated, service_role;

revoke all on function app.roster_training_summary(uuid[]) from public, anon;
revoke all on function app.acknowledge_roster_training(uuid, uuid) from public, anon;
revoke all on function app.verify_roster_training(uuid, app.verification_outcome) from public, anon;
revoke all on function app.assign_roster_shift(uuid, uuid) from public, anon;
revoke all on function app.unassign_roster_shift(uuid, text) from public, anon;
grant execute on function app.roster_training_summary(uuid[]) to authenticated, service_role;
grant execute on function app.acknowledge_roster_training(uuid, uuid) to authenticated, service_role;
grant execute on function app.verify_roster_training(uuid, app.verification_outcome) to authenticated, service_role;
grant execute on function app.assign_roster_shift(uuid, uuid) to authenticated, service_role;
grant execute on function app.unassign_roster_shift(uuid, text) to authenticated, service_role;
