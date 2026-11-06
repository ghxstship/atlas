-- pgTAP: migration 2980 (B9, RRR-233, ADR 0148), the offer half of app.shift_responses. Publishing a shift to a
-- member asks them once; accepting answers Accepted; app.decline_shift answers Declined with the reason; a writer's
-- reassignment while Published withdraws the ask and asks the new person; a first-come claim and an approved claim
-- ask nobody; an agency slot asks nobody until the agency places someone; assign_roster_shift on a Published and an
-- Accepted shift, unassign_roster_shift, swaps, cancel and delete keep the invariant: a live shift has a Waiting Offer
-- exactly when it is Published with a worker person. Shift readers and the person asked read the rows; nobody writes
-- them directly.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2750_agency_world.psql

select no_plan();

-- Asks of one shift as name:answer, sorted by name and answer (every ask of a transaction shares its asked_at).
create function pg_temp.offers(p_shift text) returns text
language sql security definer as $$
  select coalesce(string_agg(p.full_name || ':' || r.answer, ',' order by p.full_name, r.answer::text), '')
  from app.shift_responses r join app.people p on p.id = r.person_id
  where r.shift_id = pg_temp.id(p_shift) and r.ask_kind = 'Offer' and r.deleted_at is null
$$;
grant execute on function pg_temp.offers(text) to public;

-- The invariant over every live shift of the suite: Waiting Offer if and only if Published with a worker person.
create function pg_temp.invariant_breaks() returns bigint
language sql security definer as $$
  select count(*) from app.shifts s
  where s.deleted_at is null and s.project_id = pg_temp.id('prj_a')
    and (s.shift_state = 'Published'
         and private.shift_worker_person_id(s.membership_id, s.engagement_id, s.roster_entry_id) is not null)
     <> exists (select 1 from app.shift_responses r where r.shift_id = s.id and r.ask_kind = 'Offer'
                and r.answer = 'Waiting' and r.deleted_at is null)
$$;
grant execute on function pg_temp.invariant_breaks() to public;

create function pg_temp.member_shift(p_key text, p_membership text, p_days integer) returns void
language plpgsql as $$
declare
  v_id uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id(p_membership), '0000.50.01', now() + make_interval(days => p_days),
          now() + make_interval(days => p_days, hours => 8), 'America/New_York')
  returning id into v_id;
  perform pg_temp.as_platform();
  insert into world values (p_key, v_id);
end $$;

select is(pg_temp.invariant_breaks(), 0::bigint, 'the world''s shifts already hold the invariant (the backfill asked their workers)');

-- Publish, accept -------------------------------------------------------------------------------------------------------------
select pg_temp.member_shift('m1', 'frank@org_a', 10);
select is(pg_temp.offers('m1'), '', 'a Draft shift asks nobody');
select pg_temp.as_user('carol');
select app.publish_shifts(array[pg_temp.id('m1')]);
select is(pg_temp.offers('m1'), 'Frank Adeyemi:Waiting', 'publishing a shift to a member asks them once');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.shift_responses where shift_id = pg_temp.id('m1')), 1, 'the person asked reads their ask');
select throws_ok(format($$insert into app.shift_responses (project_id, shift_id, person_id, ask_kind) values (%L, %L, %L, 'Offer')$$,
  pg_temp.id('prj_a'), pg_temp.id('m1'), pg_temp.id('frank')), '42501', null, 'nobody writes an ask directly');
select app.accept_shift(pg_temp.id('m1'));
select is(pg_temp.offers('m1'), 'Frank Adeyemi:Accepted', 'accepting answers the offer Accepted');

-- transition_shift back and forth
select pg_temp.as_user('carol');
select app.transition_shift(pg_temp.id('m1'), 'Accepted', 'Published', 'Times moved; please accept again.');
select is(pg_temp.offers('m1'), 'Frank Adeyemi:Accepted,Frank Adeyemi:Waiting', 'a writer returning it to Published asks again');
select app.transition_shift(pg_temp.id('m1'), 'Published', 'Draft', 'Back to planning.');
select is(pg_temp.offers('m1'), 'Frank Adeyemi:Accepted,Frank Adeyemi:Withdrawn', 'back to Draft withdraws the waiting ask');

-- Decline ----------------------------------------------------------------------------------------------------------------------
select pg_temp.member_shift('m2', 'frank@org_a', 11);
select pg_temp.as_user('carol');
select app.publish_shifts(array[pg_temp.id('m2')]);
select pg_temp.as_user('frank');
select app.decline_shift(pg_temp.id('m2'), 'Booked elsewhere.');
select is(pg_temp.offers('m2'), 'Frank Adeyemi:Declined', 'declining answers the offer Declined, never Withdrawn');
select pg_temp.as_platform();
select is((select reason from app.shift_responses where shift_id = pg_temp.id('m2')), 'Booked elsewhere.', 'with the reason given');

-- Writer reassignment through t87 ------------------------------------------------------------------------------------------------
select pg_temp.member_shift('m3', 'frank@org_a', 12);
select pg_temp.as_user('carol');
select app.publish_shifts(array[pg_temp.id('m3')]);
update app.shifts set membership_id = pg_temp.id('mia@org_a') where id = pg_temp.id('m3');
select is(pg_temp.offers('m3'), 'Frank Adeyemi:Withdrawn,Mia Takahashi:Waiting', 'reassigning while Published withdraws the ask and asks the new person');
select pg_temp.as_user('mia');
select app.accept_shift(pg_temp.id('m3'));
select pg_temp.as_user('carol');
update app.shifts set membership_id = pg_temp.id('frank@org_a') where id = pg_temp.id('m3');
select is(pg_temp.offers('m3'), 'Frank Adeyemi:Waiting,Frank Adeyemi:Withdrawn,Mia Takahashi:Accepted',
  'reassigning an Accepted shift returns it to Published (t87) and asks the new person');

-- Claims ask nobody --------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.shifts (project_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), '0000.50.01', now() + interval '13 days', now() + interval '13 days 8 hours', 'America/New_York') returning id)
insert into world select 'open_fc', id from x;
with x as (insert into app.shifts (project_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), '0000.50.01', now() + interval '14 days', now() + interval '14 days 8 hours', 'America/New_York') returning id)
insert into world select 'open_ap', id from x;
select app.publish_shifts(array[pg_temp.id('open_fc'), pg_temp.id('open_ap')]);
select is(pg_temp.offers('open_fc'), '', 'an open shift asks nobody');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.open_shift_claiming', 'Organization', pg_temp.id('org_a'), p_value_text => 'first-come');
select pg_temp.as_user('frank');
select app.claim_open_shift(pg_temp.id('open_fc'));
select is(pg_temp.offers('open_fc'), '', 'a first-come claim asks nobody: the claimant is Accepted at once');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.open_shift_claiming', 'Organization', pg_temp.id('org_a'), p_value_text => 'approval');
select pg_temp.as_user('mia');
insert into world select 'claim_ap', app.claim_open_shift(pg_temp.id('open_ap'));
select pg_temp.as_user('carol');
select app.decide_shift_claim(pg_temp.id('claim_ap'), true, 'Mia knows the venue.');
select is(pg_temp.offers('open_ap'), '', 'an approved claim asks nobody either');

-- Swaps --------------------------------------------------------------------------------------------------------------------------------
select pg_temp.member_shift('m4', 'frank@org_a', 15);
select pg_temp.as_user('carol');
select app.publish_shifts(array[pg_temp.id('m4')]);
select pg_temp.as_user('frank');
select app.accept_shift(pg_temp.id('m4'));
with x as (insert into app.shift_swaps (shift_id, requested_by_membership_id, proposed_membership_id)
  values (pg_temp.id('m4'), pg_temp.id('frank@org_a'), pg_temp.id('mia@org_a')) returning id)
insert into world select 'swap_m4', id from x;
select pg_temp.as_user('alice');
select app.decide_shift_swap(pg_temp.id('swap_m4'), 'Approved', 'Covered.');
select is(pg_temp.offers('m4'), 'Frank Adeyemi:Accepted', 'an approved swap keeps the shift Accepted and asks nobody');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.swap_requires_approval', 'Organization', pg_temp.id('org_a'), p_value_boolean => false);
select pg_temp.member_shift('m5', 'mia@org_a', 16);
select pg_temp.as_user('carol');
select app.publish_shifts(array[pg_temp.id('m5')]);
select pg_temp.as_user('mia');
select app.accept_shift(pg_temp.id('m5'));
with x as (insert into app.shift_swaps (shift_id, requested_by_membership_id, proposed_membership_id)
  values (pg_temp.id('m5'), pg_temp.id('mia@org_a'), pg_temp.id('frank@org_a')) returning id)
insert into world select 'swap_m5', id from x;
select pg_temp.as_user('frank');
select app.accept_shift_swap(pg_temp.id('swap_m5'));
select is(pg_temp.offers('m5'), 'Mia Takahashi:Accepted', 'a swap accepted by the person offered it asks nobody');

-- Agency slots and the roster (R12) ----------------------------------------------------------------------------------------------------
select is(pg_temp.offers('slot_1'), '', 'an agency slot names nobody and asks nobody');
select pg_temp.as_user('olga');
select app.assign_roster_shift(pg_temp.id('slot_1'), pg_temp.id('e_stella'));
select like(pg_temp.offers('slot_1'), '%:Waiting', 'placing a person on a Published slot asks them');
select pg_temp.as_user('stella');
select app.accept_engaged_shift(pg_temp.id('slot_1'));
select like(pg_temp.offers('slot_1'), '%:Accepted', 'the roster person accepts through accept_engaged_shift');
select pg_temp.as_user('olga');
select app.assign_roster_shift(pg_temp.id('slot_1'), pg_temp.id('e_theo'));
select is((select count(*)::int from app.shift_responses where shift_id = pg_temp.id('slot_1') and answer = 'Withdrawn'), 0,
  'moving an Accepted roster shift to another entry leaves no stray Withdrawn offer for the first person');
select is((select count(*)::int from app.shift_responses where shift_id = pg_temp.id('slot_1') and answer = 'Waiting'), 1,
  'and asks the new person once');
select app.unassign_roster_shift(pg_temp.id('slot_1'), 'Taken off.');
select is((select count(*)::int from app.shift_responses where shift_id = pg_temp.id('slot_1') and answer = 'Waiting'), 0,
  'taking them off withdraws the waiting ask; the slot asks nobody');

-- Cancel and delete ---------------------------------------------------------------------------------------------------------------------
select pg_temp.member_shift('m6', 'frank@org_a', 17);
select pg_temp.member_shift('m7', 'frank@org_a', 18);
select pg_temp.as_user('carol');
select app.publish_shifts(array[pg_temp.id('m6'), pg_temp.id('m7')]);
select app.transition_shift(pg_temp.id('m6'), 'Published', 'Canceled', 'Show moved.');
update app.shifts set deleted_at = now() where id = pg_temp.id('m7');
select is(pg_temp.offers('m6') || ' ' || pg_temp.offers('m7'), 'Frank Adeyemi:Withdrawn Frank Adeyemi:Withdrawn',
  'a cancel and a soft delete withdraw the waiting ask');

select is(pg_temp.invariant_breaks(), 0::bigint, 'after every path, a live shift waits on an answer exactly when it is Published to a person');

select pg_temp.as_user('xavier');
select is((select count(*)::int from app.shift_responses), 0, 'another org reads none of these asks');

select * from finish();
rollback;
