-- 1322_scheduling_settings.sql
-- A76 Settings enforcement (RRR-121, A65-001, WP1): the three Scheduling settings (Section 4.5.6 item 25, Section
-- 11.13 "open shifts that people claim (first come, or approval)", journey 66) take effect in the swap and claim
-- RPCs. Each resolves for the shift's project (project, workspace, org, default, with the org lock).
--
--   * scheduling.allow_swaps (default on): while off, asking to swap a shift is refused (swap_not_allowed).
--   * scheduling.swap_requires_approval (default on): while on, a supervisor approves every swap
--     (app.decide_shift_swap, as before). While off, the person the shift is offered to accepts it with
--     app.accept_shift_swap and the swap takes effect at once.
--   * scheduling.open_shift_claiming (default approval):
--       first-come  app.claim_open_shift gives the shift to the first member who claims it (as before).
--       approval    a claim waits in app.shift_claims until someone with crew.shift.write approves or rejects it
--                   (app.decide_shift_claim); approving one claim supersedes the others.
--       seniority   claims wait the same way, and the shift goes to the most senior claimant (the earliest
--                   active membership in the org, then the earliest claim): app.award_open_shift picks them,
--                   and app.decide_shift_claim refuses to approve anyone else (shift_claim_not_most_senior).
--     A claimant withdraws a waiting claim with app.withdraw_shift_claim. Nobody approves their own claim
--     (sod_shift_claim_self).

-- Swaps ----------------------------------------------------------------------------------------------------------

create or replace function private.guard_shift_swap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if (select s.membership_id from app.shifts s where s.id = new.shift_id) is distinct from new.requested_by_membership_id then
      perform private.refuse('swap_not_on_shift', 'Only the person on a shift asks to swap it.');
    end if;
    if not coalesce(private.project_setting_boolean((select s.project_id from app.shifts s where s.id = new.shift_id), 'scheduling.allow_swaps'), true) then
      perform private.refuse('swap_not_allowed', 'This project does not allow shift swaps.');
    end if;
  elsif new.shift_id <> old.shift_id or new.requested_by_membership_id <> old.requested_by_membership_id
        or new.proposed_membership_id <> old.proposed_membership_id then
    perform private.refuse('swap_immutable', 'A swap keeps its shift and people; cancel it and ask again.');
  end if;
  return new;
end;
$$;

comment on function private.guard_shift_swap() is 'Shift swaps are asked for by the person on the shift, only while the project allows swaps (scheduling.allow_swaps, 1322), and never change parties.';

create or replace function app.accept_shift_swap(p_shift_swap_id uuid, p_reason text default 'Accepted by the person taking the shift.')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_swap app.shift_swaps;
  v_shift app.shifts;
  v_entry uuid;
begin
  perform private.require_person();
  select * into v_swap from app.shift_swaps s where s.id = p_shift_swap_id and s.deleted_at is null for update;
  if v_swap.id is null or v_swap.proposed_membership_id not in (select private.my_membership_ids()) then
    raise exception using errcode = '42501', message = 'only the person a swap offers the shift to accepts it';
  end if;
  select * into v_shift from app.shifts s where s.id = v_swap.shift_id for update;
  if coalesce(private.project_setting_boolean(v_shift.project_id, 'scheduling.swap_requires_approval'), true) then
    perform private.refuse('swap_needs_approval', 'A supervisor approves swaps on this project.');
  end if;
  v_entry := private.transition_lifecycle('swap', 'app.shift_swaps', 'swap_state', 'app.swap_state_transitions',
    'shift_swap_id', p_shift_swap_id, 'Proposed', 'Approved', p_reason);
  if v_shift.membership_id is distinct from v_swap.requested_by_membership_id then
    perform private.refuse('swap_stale', 'The shift changed hands since the swap was asked for.');
  end if;
  perform private.begin_trusted_operation('swap_transition');
  update app.shifts set membership_id = v_swap.proposed_membership_id where id = v_shift.id;
  perform private.end_trusted_operation('swap_transition');
  return v_entry;
end;
$$;

comment on function app.accept_shift_swap(uuid, text) is 'The person a swap offers the shift to accepts it, on a project where swaps need no approval (scheduling.swap_requires_approval off, 1322): the swap is Approved and the shift is theirs. Refused with swap_needs_approval while approval is required. Returns the ledger entry id.';

-- Open shift claims -----------------------------------------------------------------------------------------------

create type app.shift_claim_state as enum ('Requested', 'Approved', 'Rejected', 'Withdrawn', 'Superseded');
comment on type app.shift_claim_state is 'An open shift claim waiting on the org''s claiming rule (scheduling.open_shift_claiming): Requested until approved, rejected or withdrawn; Superseded when the shift went to another claimant.';

insert into private.separation_of_duties_rules (code, enforced_on, description) values
  ('sod_shift_claim_self', 'Open shift claims', 'A person cannot approve their own claim on an open shift.');

create table app.shift_claims (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  shift_id uuid not null references app.shifts (id),
  membership_id uuid not null references app.memberships (id),
  claim_state app.shift_claim_state not null default 'Requested',
  decided_by uuid references app.people (id),
  decided_at timestamptz,
  reason text,
  constraint shift_claims_decided check ((claim_state in ('Approved', 'Rejected')) = (decided_by is not null and decided_at is not null)),
  constraint shift_claims_reason_length check (reason is null or char_length(btrim(reason)) between 1 and 500)
);

create index shift_claims_shift_id_idx on app.shift_claims (shift_id);
create index shift_claims_project_id_idx on app.shift_claims (project_id);
create index shift_claims_membership_id_idx on app.shift_claims (membership_id);
create index shift_claims_decided_by_idx on app.shift_claims (decided_by);

call private.install_domain_table('app.shift_claims', 'app.shifts', 'shift_id',
  array['app.memberships', 'membership_id', 'app.projects', 'project_id']);
create unique index shift_claims_one_waiting on app.shift_claims (shift_id, membership_id) where claim_state = 'Requested' and deleted_at is null;
call private.describe('app.shift_claims', 'Claims on open shifts that wait for a decision under the org''s claiming rule (scheduling.open_shift_claiming approval or seniority, Section 4.5.6 item 25). Written only through app.claim_open_shift, app.decide_shift_claim, app.award_open_shift and app.withdraw_shift_claim.', array[
  'project_id', 'Project of the shift.',
  'shift_id', 'Open shift claimed.',
  'membership_id', 'Membership of the person claiming it.',
  'claim_state', 'Requested, Approved, Rejected, Withdrawn or Superseded.',
  'decided_by', 'Person who approved or rejected the claim.',
  'decided_at', 'When the claim was approved or rejected.',
  'reason', 'Why it was rejected, withdrawn or superseded, or the approver''s note.'
]);
call private.install_policies('app.shift_claims',
  $$membership_id in (select private.my_membership_ids()) or project_id in (select private.project_ids_with('crew.shift.write'))$$);
call private.install_default_retention('app.shift_claims');
call private.install_audit_trail('app.shift_claims');

-- The claiming rule of a shift's project and the most senior claimant.
create or replace function private.shift_claiming_rule(p_shift_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.project_setting_text(s.project_id, 'scheduling.open_shift_claiming'), 'approval')
  from app.shifts s where s.id = p_shift_id;
$$;

comment on function private.shift_claiming_rule(uuid) is 'scheduling.open_shift_claiming as it applies to a shift''s project: first-come, approval or seniority.';
revoke all on function private.shift_claiming_rule(uuid) from public, anon, authenticated;

create or replace function private.most_senior_claim(p_shift_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from app.shift_claims c join app.memberships m on m.id = c.membership_id
  where c.shift_id = p_shift_id and c.claim_state = 'Requested' and c.deleted_at is null
  order by m.valid_from, c.created_at, c.id
  limit 1;
$$;

comment on function private.most_senior_claim(uuid) is 'The waiting claim on a shift whose claimant holds the earliest membership in the org, then the earliest claim (seniority rule).';
revoke all on function private.most_senior_claim(uuid) from public, anon, authenticated;

create or replace function private.assert_claimable(p_shift app.shifts, p_person uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_shift.membership_id is not null then
    perform private.refuse('shift_already_claimed', 'Someone already holds this shift.');
  end if;
  if p_shift.shift_state <> 'Published' then
    perform private.refuse('shift_not_published', 'Only a published open shift can be claimed.');
  end if;
  if exists (
    select 1 from app.shifts s join app.memberships m on m.id = s.membership_id
    where m.person_id = p_person and s.org_id = p_shift.org_id and s.deleted_at is null and s.shift_state <> 'Canceled'
      and tstzrange(s.starts_at, s.ends_at) && tstzrange(p_shift.starts_at, p_shift.ends_at)) then
    perform private.refuse('shift_double_booked', 'You already hold a shift that overlaps this one.');
  end if;
end;
$$;

comment on function private.assert_claimable(app.shifts, uuid) is 'Refuses a claim on a shift someone holds, a shift that is not Published, or one overlapping another shift the person holds.';
revoke all on function private.assert_claimable(app.shifts, uuid) from public, anon, authenticated;

-- Gives a shift to a member who claimed it: the same trusted reassignment the first-come claim uses.
create or replace function private.give_claimed_shift(p_shift_id uuid, p_membership_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.begin_trusted_operation('shift_claim');
  update app.shifts set membership_id = p_membership_id where id = p_shift_id;
  perform private.end_trusted_operation('shift_claim');
  return private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions',
    'shift_id', p_shift_id, 'Published', 'Accepted', p_reason);
end;
$$;

comment on function private.give_claimed_shift(uuid, uuid, text) is 'Assigns an open shift to a claimant and moves it from Published to Accepted. Callers check the claim first.';
revoke all on function private.give_claimed_shift(uuid, uuid, text) from public, anon, authenticated;

create or replace function app.claim_open_shift(p_shift_id uuid, p_reason text default 'Claimed from open shifts.')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shift app.shifts;
  v_membership uuid;
  v_person uuid := private.require_person();
  v_claim uuid;
begin
  select * into v_shift from app.shifts s where s.id = p_shift_id and s.deleted_at is null for update;
  if v_shift.id is null then
    raise exception using errcode = '42501', message = 'shift not found';
  end if;
  select m.id into v_membership from app.memberships m
  where m.id in (select private.my_membership_ids()) and m.org_id = v_shift.org_id
  limit 1;
  if v_membership is null or private.capability_reach(v_shift.org_id, 'crew.shift.read') is null then
    raise exception using errcode = '42501', message = 'crew.shift.read is required to claim a shift';
  end if;
  perform private.assert_claimable(v_shift, v_person);
  if private.shift_claiming_rule(p_shift_id) = 'first-come' then
    return private.give_claimed_shift(p_shift_id, v_membership, p_reason);
  end if;
  if exists (select 1 from app.shift_claims c where c.shift_id = p_shift_id and c.membership_id = v_membership
             and c.claim_state = 'Requested' and c.deleted_at is null) then
    perform private.refuse('shift_claim_waiting', 'You already claimed this shift; a supervisor decides.');
  end if;
  insert into app.shift_claims (project_id, shift_id, membership_id) values (v_shift.project_id, p_shift_id, v_membership)
  returning id into v_claim;
  return v_claim;
end;
$$;

comment on function app.claim_open_shift(uuid, text) is 'A member of the org claims a Published open shift (journey 66) under the project''s claiming rule (scheduling.open_shift_claiming, 1322): first-come gives them the shift at once, Accepted, and returns the ledger entry id; approval and seniority record a waiting claim in app.shift_claims and return its id. Refused when the shift is already held, not published, overlaps another shift the person holds, or already carries their waiting claim.';

create or replace function app.decide_shift_claim(p_shift_claim_id uuid, p_approved boolean, p_reason text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_claim app.shift_claims;
  v_shift app.shifts;
begin
  select * into v_claim from app.shift_claims c where c.id = p_shift_claim_id and c.deleted_at is null for update;
  if v_claim.id is null or not private.can_on_project(v_claim.project_id, 'crew.shift.write') then
    raise exception using errcode = '42501', message = 'crew.shift.write is required on the project';
  end if;
  perform private.assert_separation('sod_shift_claim_self', v_person,
    (select m.person_id from app.memberships m where m.id = v_claim.membership_id));
  if v_claim.claim_state <> 'Requested' then
    perform private.refuse('shift_claim_decided', format('This claim is %s; only a waiting claim is decided.', v_claim.claim_state));
  end if;
  if not coalesce(p_approved, false) then
    if p_reason is null or char_length(btrim(p_reason)) = 0 then
      perform private.refuse('shift_claim_reason', 'Say why the claim is rejected.');
    end if;
    update app.shift_claims set claim_state = 'Rejected', decided_by = v_person, decided_at = now(), reason = btrim(p_reason)
    where id = v_claim.id;
    return v_claim.id;
  end if;
  select * into v_shift from app.shifts s where s.id = v_claim.shift_id and s.deleted_at is null for update;
  perform private.assert_claimable(v_shift, (select m.person_id from app.memberships m where m.id = v_claim.membership_id));
  if private.shift_claiming_rule(v_claim.shift_id) = 'seniority' and private.most_senior_claim(v_claim.shift_id) <> v_claim.id then
    perform private.refuse('shift_claim_not_most_senior', 'Under the seniority rule the shift goes to the most senior claimant.');
  end if;
  perform private.give_claimed_shift(v_claim.shift_id, v_claim.membership_id, coalesce(nullif(btrim(p_reason), ''), 'Claim approved.'));
  update app.shift_claims set claim_state = 'Approved', decided_by = v_person, decided_at = now(), reason = nullif(btrim(p_reason), '')
  where id = v_claim.id;
  update app.shift_claims set claim_state = 'Superseded', reason = 'The shift went to another claimant.'
  where shift_id = v_claim.shift_id and id <> v_claim.id and claim_state = 'Requested' and deleted_at is null;
  return v_claim.id;
end;
$$;

comment on function app.decide_shift_claim(uuid, boolean, text) is 'Approves or rejects a waiting open shift claim (crew.shift.write on the project, never one''s own claim, sod_shift_claim_self). Approval gives the claimant the shift, Accepted, and supersedes the other waiting claims; under the seniority rule only the most senior claimant can be approved. A rejection needs a reason. Returns the claim id.';

create or replace function app.award_open_shift(p_shift_id uuid, p_reason text default 'Awarded by seniority.')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claim uuid;
begin
  perform private.require_person();
  if not exists (select 1 from app.shifts s where s.id = p_shift_id and private.can_on_project(s.project_id, 'crew.shift.write')) then
    raise exception using errcode = '42501', message = 'crew.shift.write is required on the project';
  end if;
  v_claim := private.most_senior_claim(p_shift_id);
  if v_claim is null then
    perform private.refuse('shift_claim_none', 'Nobody is waiting on this shift.');
  end if;
  return app.decide_shift_claim(v_claim, true, p_reason);
end;
$$;

comment on function app.award_open_shift(uuid, text) is 'Gives an open shift to its most senior waiting claimant (scheduling.open_shift_claiming seniority, 1322) through app.decide_shift_claim. Returns the approved claim id.';

create or replace function app.withdraw_shift_claim(p_shift_claim_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claim app.shift_claims;
begin
  perform private.require_person();
  select * into v_claim from app.shift_claims c where c.id = p_shift_claim_id and c.deleted_at is null for update;
  if v_claim.id is null or v_claim.membership_id not in (select private.my_membership_ids()) then
    raise exception using errcode = '42501', message = 'only the claimant withdraws a claim';
  end if;
  if v_claim.claim_state <> 'Requested' then
    perform private.refuse('shift_claim_decided', format('This claim is %s; only a waiting claim is withdrawn.', v_claim.claim_state));
  end if;
  update app.shift_claims set claim_state = 'Withdrawn', reason = 'Withdrawn by the claimant.' where id = v_claim.id;
  return v_claim.id;
end;
$$;

comment on function app.withdraw_shift_claim(uuid) is 'The claimant withdraws their waiting claim on an open shift. Returns the claim id.';

revoke all on function app.accept_shift_swap(uuid, text) from public, anon;
revoke all on function app.decide_shift_claim(uuid, boolean, text) from public, anon;
revoke all on function app.award_open_shift(uuid, text) from public, anon;
revoke all on function app.withdraw_shift_claim(uuid) from public, anon;
grant execute on function app.accept_shift_swap(uuid, text) to authenticated, service_role;
grant execute on function app.decide_shift_claim(uuid, boolean, text) to authenticated, service_role;
grant execute on function app.award_open_shift(uuid, text) to authenticated, service_role;
grant execute on function app.withdraw_shift_claim(uuid) to authenticated, service_role;
