-- pgTAP: migration 2656 (R5, G-142), the names lock. Setting it needs advancing.packet.write on the project and an open
-- engagement; the column changes only through the RPC; each set notifies every roster manager and is audited. Once
-- locked the company side cannot add, invite, replace, submit a Draft or edit a Draft; a Returned entry is still edited
-- and resubmitted (a roster holding both resubmits the Returned entry and leaves the Draft), withdrawals, the person's
-- answer, self entry edits, a new engaged person's self entry and project facts go on; clearing the lock opens names
-- again. The engaged party reads the lock in api_external.engagements.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql

select no_plan();

create function pg_temp.lock(p_who text, p_at timestamptz) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(p_who);
  perform app.set_roster_lock(pg_temp.id('eng_vendor_a'), p_at);
  perform pg_temp.as_platform();
end $$;

create function pg_temp.state(p_key text) returns text
language sql as $$ select r.entry_state::text from app.engagement_roster_entries r where r.id = pg_temp.id(p_key) $$;

select has_column('app', 'engagements', 'roster_locks_at', 'engagements carry the names lock');
select is((select column_name::text from information_schema.columns
  where table_schema = 'api_external' and table_name = 'engagements' order by ordinal_position desc limit 1),
  'roster_locks_at', 'api_external.engagements ends with roster_locks_at');

-- Who sets it ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('hops');
select throws_ok(format($$select app.set_roster_lock(%L, now())$$, pg_temp.id('eng_vendor_a')), '42501', null,
  'hospitality alone cannot set a names lock');
select pg_temp.as_user('victor');
select throws_ok(format($$select app.set_roster_lock(%L, now())$$, pg_temp.id('eng_vendor_a')), '42501', null, 'nor can the company');
select pg_temp.as_platform();
select throws_ok(format($$update app.engagements set roster_locks_at = now() where id = %L$$, pg_temp.id('eng_vendor_a')), 'XR001',
  'roster_lock_rpc: Set the names lock with app.set_roster_lock.', 'the column changes only through the RPC');

-- Before the lock: bob returns mo's entry, una stays a Draft
select pg_temp.as_user('bob');
select app.review_roster_entry(pg_temp.id('e_mo'), 'Returned', 'Add the arrival for the load-in.');
select pg_temp.as_platform();

select pg_temp.lock('alice', now() + interval '3 days');
select ok((select roster_locks_at is not null from app.engagements where id = pg_temp.id('eng_vendor_a')), 'a future lock is recorded');
select pg_temp.as_user('victor');
select lives_ok(format($$select app.update_roster_entry(%L, '9000.50.02', '2027-06-01 08:00+00', '2027-06-01 10:00+00', 'America/New_York')$$,
  pg_temp.id('e_una')), 'a future lock does not lock yet');
select pg_temp.as_platform();
select is((select count(*)::int from app.notifications where kind = 'engagement.roster_lock_changed'
  and subject_id = pg_temp.id('eng_vendor_a')), (select count(*)::int from private.roster_manager_ids(pg_temp.id('eng_vendor_a'))),
  'each set queues one notice per roster manager');
select ok((select count(*) from private.roster_manager_ids(pg_temp.id('eng_vendor_a'))) >= 2, 'the Owner and the Advancing Lead among them');
select is((select count(*)::int from app.audit_events where action = 'engagement.roster_lock_changed'
  and subject_id = pg_temp.id('eng_vendor_a')), 1, 'and writes an audit event');

select pg_temp.lock('alice', now() - interval '1 minute');
select is((select count(*)::int from app.audit_events where action = 'engagement.roster_lock_changed'
  and subject_id = pg_temp.id('eng_vendor_a')), 2, 'a past instant locks at once, audited again');
select pg_temp.as_user('sam');
select isnt((select roster_locks_at from api_external.engagements where id = pg_temp.id('eng_vendor_a')), null,
  'the engaged person reads the lock');
select pg_temp.as_user('victor');
select isnt((select roster_locks_at from api_external.engagements where id = pg_temp.id('eng_vendor_a')), null, 'and so does the company');

-- After the lock: the company names no one new ---------------------------------------------------------------------------
select throws_ok(format($$select app.add_roster_entry(%L, %L)$$, pg_temp.id('eng_vendor_a'), pg_temp.id('pia')), 'XR001',
  'roster_locked: Names are locked on this engagement. Ask the producing organization to change the roster.', 'add_roster_entry is refused');
select throws_ok(format($$select app.invite_to_roster(%L, 'new.tech@bayside-audio.test')$$, pg_temp.id('eng_vendor_a')), 'XR001',
  'roster_locked: Names are locked on this engagement. Ask the producing organization to change the roster.', 'so is invite_to_roster');
select throws_ok(format($$select app.update_roster_entry(%L, '9000.50.02', null, null, null)$$, pg_temp.id('e_una')), 'XR001',
  'roster_locked: Names are locked on this engagement. Ask the producing organization to change the roster.', 'and editing a Draft');

-- A Returned entry is still edited and resubmitted; the Draft stays
select lives_ok(format($$select app.update_roster_entry(%L, '9000.50.02', '2027-06-01 08:00+00', '2027-06-01 10:00+00', 'America/New_York')$$,
  pg_temp.id('e_mo')), 'the Returned entry is edited');
select is(app.submit_roster(pg_temp.id('eng_vendor_a')), 1, 'submit_roster resubmits only the Returned entry');
select pg_temp.as_platform();
select is(pg_temp.state('e_mo'), 'Submitted', 'mo is Submitted again');
select is(pg_temp.state('e_una'), 'Draft', 'una stays a Draft');
select pg_temp.as_user('victor');
select throws_ok(format($$select app.submit_roster(%L)$$, pg_temp.id('eng_vendor_a')), 'XR001',
  'roster_locked: Names are locked on this engagement. Ask the producing organization to change the roster.',
  'submit_roster with only a Draft left is refused');
select pg_temp.as_platform();

-- What goes on under the lock
select pg_temp.as_user('una');
select lives_ok(format($$select app.respond_roster_entry(%L, 'Accepted')$$, pg_temp.id('e_una')), 'the person still answers');
select pg_temp.as_user('sam');
select lives_ok(format($$select app.update_roster_entry(%L, null, '2027-06-01 08:00+00', '2027-06-01 09:00+00', 'America/New_York')$$,
  pg_temp.id('self_sam')), 'the engaged person still edits the self entry');
select pg_temp.as_user('kai');
select lives_ok(format($$select app.save_roster_travel_request(%L, 'MIA', 'MIA', '2027-06-01', '2027-06-04')$$, pg_temp.id('e_kai')),
  'project facts are not locked');
select pg_temp.as_user('victor');
select lives_ok(format($$select app.withdraw_roster_entry(%L, 'Not needed.')$$, pg_temp.id('e_una')), 'a withdrawal goes through');
select throws_ok(format($$select app.add_roster_entry(%L, %L, null, null, null, null, %L)$$, pg_temp.id('eng_vendor_a'), pg_temp.id('pia'),
  pg_temp.id('e_una')), 'XR001',
  'roster_locked: Names are locked on this engagement. Ask the producing organization to change the roster.', 'a replacement is refused');
select pg_temp.as_platform();

-- A new engaged person's self entry is still created under a lock (R4's t81 inserts it, and t42 lets a self entry through)
select pg_temp.as_user('alice');
with x as (insert into app.engagements (project_id, counterparty_id, role_type, role_code, worker_classification, pay_basis,
    arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_v_a'), 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement',
    '2027-06-01') returning id)
insert into world select 'eng_vendor_a2', id from x;
select app.set_roster_lock(pg_temp.id('eng_vendor_a2'), now() - interval '1 minute');
select is(pg_temp.self_entry('eng_vendor_a2'), null, 'an engagement without a person has no self entry');
select lives_ok(format($$update app.engagements set person_id = %L where id = %L$$, pg_temp.id('pia'), pg_temp.id('eng_vendor_a2')),
  'naming the engaged person under a lock goes through');
select pg_temp.as_platform();
select isnt(pg_temp.self_entry('eng_vendor_a2'), null, 'and their self entry is created');
select ok(private.roster_locked(pg_temp.id('eng_vendor_a2')), 'while the lock holds');

-- Clearing the lock
select pg_temp.lock('alice', null);
select pg_temp.as_user('victor');
select lives_ok(format($$select app.add_roster_entry(%L, %L)$$, pg_temp.id('eng_vendor_a'), pg_temp.id('pia')), 'clearing the lock opens names');
select pg_temp.as_platform();
select is((select count(*)::int from app.notifications where kind = 'engagement.roster_lock_changed'
  and subject_id = pg_temp.id('eng_vendor_a') and recipient_person_id = pg_temp.id('victor')), 3, 'every change is announced');

-- Closed engagements
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');
select pg_temp.as_user('alice');
select throws_ok(format($$select app.set_roster_lock(%L, now())$$, pg_temp.id('eng_vendor_a')), 'XR001',
  'roster_lock_engagement_closed: Set a names lock while the engagement is onboarding, active or closing.',
  'roster_lock_engagement_closed after Complete');
select pg_temp.as_platform();

select * from finish();
rollback;
