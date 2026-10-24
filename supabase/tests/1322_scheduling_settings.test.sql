-- pgTAP: migration 1322, the Scheduling settings take effect in the claim and swap RPCs (A76, RRR-121, A65-001).
-- scheduling.open_shift_claiming: approval (the default) records a waiting claim that a supervisor approves or
-- rejects, approval supersedes the other claims, nobody approves their own claim, claimants withdraw; seniority
-- gives the shift to the earliest membership; first-come gives it at once. scheduling.allow_swaps refuses swap
-- requests while off. scheduling.swap_requires_approval lets the person offered the shift accept it only while off.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(28);

create temporary table c (key text primary key, id uuid);
grant select, insert on c to public;

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

select pg_temp.open_shift('open_a', '2027-07-01');
select pg_temp.open_shift('open_b', '2027-07-02');
select pg_temp.open_shift('open_c', '2027-07-03');

-- Approval (default) -------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is(private.shift_claiming_rule(pg_temp.id('open_a')), 'approval', 'claims wait for approval by default');
select pg_temp.as_user('frank');
insert into c select 'frank_a', app.claim_open_shift(pg_temp.id('open_a'));
select results_eq($$select claim_state::text, membership_id from app.shift_claims where id = (select id from c where key = 'frank_a')$$,
  $$values ('Requested'::text, (select id from world where key = 'frank@org_a'))$$, 'a claim under the approval rule waits as Requested');
select results_eq($$select membership_id, shift_state::text from app.shifts where id = (select id from world where key = 'open_a')$$,
  $$values (null::uuid, 'Published'::text)$$, 'and the shift stays open');
select throws_ok($$select app.claim_open_shift((select id from world where key = 'open_a'))$$,
  'XR001', 'shift_claim_waiting: You already claimed this shift; a supervisor decides.', 'one waiting claim per person and shift');
select pg_temp.as_user('mia');
insert into c select 'mia_a', app.claim_open_shift(pg_temp.id('open_a'));
select is((select count(*)::int from app.shift_claims where shift_id = pg_temp.id('open_a')), 1, 'a claimant sees only their own claim');
select throws_ok($$select app.decide_shift_claim((select id from c where key = 'frank_a'), true)$$,
  '42501', null, 'a claimant cannot decide claims');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.shift_claims where shift_id = pg_temp.id('open_a')), 2, 'a shift writer sees every claim on the project');
select throws_ok($$select app.decide_shift_claim((select id from c where key = 'frank_a'), false)$$,
  'XR001', 'shift_claim_reason: Say why the claim is rejected.', 'a rejection needs a reason');
select lives_ok($$select app.decide_shift_claim((select id from c where key = 'mia_a'), true, 'Mia has the forklift card.')$$,
  'a shift writer approves a claim');
select results_eq($$select membership_id, shift_state::text from app.shifts where id = (select id from world where key = 'open_a')$$,
  $$values ((select id from world where key = 'mia@org_a'), 'Accepted'::text)$$, 'approval gives the claimant the shift, Accepted');
select results_eq($$select claim_state::text from app.shift_claims where shift_id = (select id from world where key = 'open_a') order by claim_state::text$$,
  $$values ('Approved'::text), ('Superseded'::text)$$, 'and supersedes the other waiting claim');
select throws_ok($$select app.decide_shift_claim((select id from c where key = 'frank_a'), true)$$,
  'XR001', 'shift_claim_decided: This claim is Superseded; only a waiting claim is decided.', 'a decided claim is not decided again');

-- Own claims, rejection, withdrawal
select pg_temp.as_user('carol');
insert into c select 'carol_b', app.claim_open_shift(pg_temp.id('open_b'));
select throws_ok($$select app.decide_shift_claim((select id from c where key = 'carol_b'), true)$$,
  'XR001', null, 'nobody approves their own claim (sod_shift_claim_self)');
select pg_temp.as_user('alice');
select lives_ok($$select app.decide_shift_claim((select id from c where key = 'carol_b'), false, 'Carol is on the office rota that day.')$$,
  'another shift writer rejects it with a reason');
select is((select claim_state::text from app.shift_claims where id = (select id from c where key = 'carol_b')), 'Rejected', 'the claim is Rejected');
select pg_temp.as_user('frank');
insert into c select 'frank_b', app.claim_open_shift(pg_temp.id('open_b'));
select pg_temp.as_user('erin');
select throws_ok($$select app.withdraw_shift_claim((select id from c where key = 'frank_b'))$$, '42501', null, 'only the claimant withdraws');
select pg_temp.as_user('frank');
select lives_ok($$select app.withdraw_shift_claim((select id from c where key = 'frank_b'))$$, 'the claimant withdraws a waiting claim');
select is((select claim_state::text from app.shift_claims where id = (select id from c where key = 'frank_b')), 'Withdrawn', 'the claim is Withdrawn');

-- Seniority --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.open_shift_claiming', 'Organization', pg_temp.id('org_a'), p_value_text => 'seniority');
select pg_temp.as_platform();
update app.memberships set valid_from = now() - interval '3 years' where id = pg_temp.id('mia@org_a');
update app.memberships set valid_from = now() - interval '1 year' where id = pg_temp.id('frank@org_a');
select pg_temp.as_user('frank');
insert into c select 'frank_c', app.claim_open_shift(pg_temp.id('open_c'));
select pg_temp.as_user('mia');
insert into c select 'mia_c', app.claim_open_shift(pg_temp.id('open_c'));
select pg_temp.as_user('carol');
select throws_ok($$select app.decide_shift_claim((select id from c where key = 'frank_c'), true)$$,
  'XR001', 'shift_claim_not_most_senior: Under the seniority rule the shift goes to the most senior claimant.',
  'under seniority, the first claimant is not approved over a more senior one');
select is(app.award_open_shift(pg_temp.id('open_c')), (select id from c where key = 'mia_c'), 'awarding picks the most senior claimant');
select is((select membership_id from app.shifts where id = pg_temp.id('open_c')), pg_temp.id('mia@org_a'), 'who now holds the shift');

-- First-come for one project ------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.open_shift_claiming', 'Project', pg_temp.id('prj_a'), p_value_text => 'first-come');
select pg_temp.open_shift('open_d', '2027-07-04');
select pg_temp.as_user('frank');
select lives_ok($$select app.claim_open_shift((select id from world where key = 'open_d'))$$, 'under first-come for the project, a claim');
select results_eq($$select membership_id, shift_state::text from app.shifts where id = (select id from world where key = 'open_d')$$,
  $$values ((select id from world where key = 'frank@org_a'), 'Accepted'::text)$$, 'gives the shift at once');

-- Swaps -----------------------------------------------------------------------------------------------------------------
-- frank holds open_d; he offers it to mia.
select pg_temp.as_user('frank');
with x as (insert into app.shift_swaps (shift_id, requested_by_membership_id, proposed_membership_id)
  values (pg_temp.id('open_d'), pg_temp.id('frank@org_a'), pg_temp.id('mia@org_a')) returning id)
insert into c select 'swap1', id from x;
select pg_temp.as_user('mia');
select throws_ok($$select app.accept_shift_swap((select id from c where key = 'swap1'))$$,
  'XR001', 'swap_needs_approval: A supervisor approves swaps on this project.', 'while swaps need approval (the default), the other person cannot accept');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.swap_requires_approval', 'Organization', pg_temp.id('org_a'), p_value_boolean => false);
select pg_temp.as_user('frank');
select throws_ok($$select app.accept_shift_swap((select id from c where key = 'swap1'))$$,
  '42501', null, 'the requester cannot accept their own offer');
select pg_temp.as_user('mia');
select lives_ok($$select app.accept_shift_swap((select id from c where key = 'swap1'))$$, 'without approval, the person offered the shift accepts it');
select results_eq($$select s.membership_id, w.swap_state::text from app.shifts s join app.shift_swaps w on w.shift_id = s.id where w.id = (select id from c where key = 'swap1')$$,
  $$values ((select id from world where key = 'mia@org_a'), 'Approved'::text)$$, 'the swap takes effect at once');

select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.allow_swaps', 'Organization', pg_temp.id('org_a'), p_value_boolean => false);
select pg_temp.as_user('mia');
select throws_ok($$insert into app.shift_swaps (shift_id, requested_by_membership_id, proposed_membership_id)
  values ((select id from world where key = 'open_d'), (select id from world where key = 'mia@org_a'), (select id from world where key = 'frank@org_a'))$$,
  'XR001', 'swap_not_allowed: This project does not allow shift swaps.', 'with swaps off, asking to swap is refused');

select * from finish();
rollback;
