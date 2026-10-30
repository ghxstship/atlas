-- pgTAP: migration 2253, putting a member on an open shift from the drag board (A132, RRR-194, ADR 0063).
-- A planner assigns an open shift nobody holds; a filled shift is refused (shift_already_filled); a shift with a
-- waiting claim under the 1322 approval rule is refused (shift_claims_waiting) and the claim stays for the planner
-- to decide; once the claim is withdrawn the planner assigns. Only shift writers call it, only for active members of
-- the shift's org, and anon cannot.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(12);

create function pg_temp.open_shift(p_key text, p_day text) returns void
language plpgsql as $$
declare
  v_id uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.shifts (project_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), '0000.50.01', (p_day || ' 12:00+00')::timestamptz, (p_day || ' 20:00+00')::timestamptz, 'America/New_York')
  returning id into v_id;
  insert into world values (p_key, v_id);
  perform app.publish_shifts(array[v_id]);
end $$;

select pg_temp.open_shift('open_a', '2027-08-01');
select pg_temp.open_shift('open_b', '2027-08-02');

-- An open shift nobody claimed ------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is(app.assign_open_shift(pg_temp.id('open_a'), pg_temp.id('frank@org_a')), pg_temp.id('open_a'),
  'a planner puts a member on an open shift');
select results_eq($$select membership_id, shift_state::text from app.shifts where id = (select id from world where key = 'open_a')$$,
  $$values ((select id from world where key = 'frank@org_a'), 'Published'::text)$$,
  'the shift is theirs, Published for them to accept');
select throws_ok($$select app.assign_open_shift((select id from world where key = 'open_a'), (select id from world where key = 'mia@org_a'))$$,
  'XR001', 'shift_already_filled: Someone was put on this shift since the schedule was read.',
  'a shift someone holds is refused');

-- A waiting claim under the approval rule (1322) -----------------------------------------------------------------------
select pg_temp.as_user('mia');
select lives_ok($$select app.claim_open_shift((select id from world where key = 'open_b'))$$, 'a member claims the other shift');
select pg_temp.as_user('carol');
select throws_ok($$select app.assign_open_shift((select id from world where key = 'open_b'), (select id from world where key = 'frank@org_a'))$$,
  'XR001', 'shift_claims_waiting: Members claimed this shift; approve or reject their claims on the shift.',
  'a shift with a waiting claim is refused');
select results_eq($$select s.membership_id, c.claim_state::text from app.shifts s join app.shift_claims c on c.shift_id = s.id
    where s.id = (select id from world where key = 'open_b')$$,
  $$values (null::uuid, 'Requested'::text)$$,
  'so the shift stays open and the claim waits for the planner to decide');
select pg_temp.as_user('mia');
select lives_ok($$select app.withdraw_shift_claim((select c.id from app.shift_claims c where c.shift_id = (select id from world where key = 'open_b')))$$,
  'the claimant withdraws');
select pg_temp.as_user('carol');
select lives_ok($$select app.assign_open_shift((select id from world where key = 'open_b'), (select id from world where key = 'frank@org_a'))$$,
  'with no claim waiting, the planner assigns the shift');

-- Who may call it ------------------------------------------------------------------------------------------------------
select pg_temp.open_shift('open_c', '2027-08-03');
select pg_temp.as_user('carol');
select throws_ok($$select app.assign_open_shift((select id from world where key = 'open_c'), (select id from world where key = 'xavier@org_b'))$$,
  '42501', null, 'only an active member of the shift''s org is put on it');
select pg_temp.as_user('gina');
select throws_ok($$select app.assign_open_shift((select id from world where key = 'open_c'), (select id from world where key = 'frank@org_a'))$$,
  '42501', null, 'a viewer cannot assign shifts');
select pg_temp.as_user('xavier');
select throws_ok($$select app.assign_open_shift((select id from world where key = 'open_c'), (select id from world where key = 'xavier@org_b'))$$,
  '42501', null, 'another org''s owner cannot assign this org''s shifts');
select pg_temp.as_anon();
select throws_ok($$select app.assign_open_shift((select id from world where key = 'open_c'), (select id from world where key = 'frank@org_a'))$$,
  '42501', null, 'anon cannot call it');

select * from finish();
rollback;
