-- pgTAP: migration 2655 (R5), who enters and reads project facts and how they leave. The person writes what is offered,
-- with every refusal; the company writes only while advancing.company_may_submit_project_facts is on (a locked org value
-- wins), notifies the person each time and never overwrites what the person entered; reads follow standing (a duty
-- Member only their own entry, Account Finance nothing, the Advancing Lead and an artist's Advance representative all,
-- producers the kinds their capabilities cover and never a Draft) and every company or producer read of a value is
-- logged, producer reads also audited; suggestions; exits erase; expiry follows keep_days and legal holds.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql

select no_plan();

create function pg_temp.facts(p_who text, p_entry text) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_who);
  v := app.roster_project_facts(pg_temp.id(p_entry));
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.travel(p_entry text) returns text
language sql as $$
  select format($q$select app.save_roster_travel_request(%L, 'MIA', 'MIA', '2027-06-01', '2027-06-04', 'Aisle', null, true, false, null)$q$,
    pg_temp.id(p_entry))
$$;

create function pg_temp.uniform(p_entry text) returns text
language sql as $$
  select format($q$select app.save_roster_uniform_sizes(%L, 'M', 'L', 'M', null, null, 32::smallint, 30::smallint, 10.5, 'US Men')$q$,
    pg_temp.id(p_entry))
$$;

create function pg_temp.vehicle(p_entry text, p_make text default 'Ford') returns text
language sql as $$
  select format($q$select app.save_roster_vehicle(%L, %L, 'Transit', 'White', 'ABC1234', 'US-FL')$q$, pg_temp.id(p_entry), p_make)
$$;

create function pg_temp.offer(p_offering text, p_value text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user('alice');
  perform app.set_setting(pg_temp.id('org_a'), 'offerings.' || p_offering, 'Organization', null, p_value);
  perform pg_temp.as_platform();
end $$;

-- The audit ledger is append-only, so counts start after a mark (pg_temp.mark_audits).
create temporary table audit_seen (id uuid primary key);
create function pg_temp.mark_audits() returns void
language sql as $$ insert into audit_seen select a.id from app.audit_events a on conflict do nothing $$;
create function pg_temp.audits(p_entry text) returns integer
language sql as $$
  select count(*)::int from app.audit_events a where a.action = 'project_facts.viewed' and a.subject_id = pg_temp.id(p_entry)
    and a.id not in (select x.id from audit_seen x)
$$;

-- Person writes ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('kai');
select lives_ok(pg_temp.travel('e_kai'), 'kai saves travel while it is offered');
select lives_ok(pg_temp.uniform('e_kai'), 'and uniform sizes');
select lives_ok(pg_temp.vehicle('e_kai'), 'and a vehicle');
select throws_ok(format($$select app.save_roster_travel_request(%L, 'XQZ', null, null, null)$$, pg_temp.id('e_kai')), 'XR001',
  'airport_unknown: Choose an airport from the list.', 'airport_unknown');
select throws_ok(format($$select app.save_roster_travel_request(%L, null, null, '2027-06-05', '2027-06-01')$$, pg_temp.id('e_kai')), 'XR001',
  'travel_dates_order: The day you travel home comes on or after the day you arrive.', 'travel_dates_order');
select throws_ok(format($$select app.save_roster_travel_request(%L, ' ', null, null, null)$$, pg_temp.id('e_kai')), 'XR001',
  'project_fact_empty: Give at least an airport or a date.', 'project_fact_empty');
select throws_ok(format($$select app.save_roster_uniform_sizes(%L, null, null, null, null, null, null, null, null, null)$$, pg_temp.id('e_kai')),
  'XR001', 'project_fact_empty: Give at least one size.', 'project_fact_empty for sizes');
select throws_ok(format($$select app.save_roster_uniform_sizes(%L, 'M', null, null, null, null, null, null, 10.3, 'EU')$$, pg_temp.id('e_kai')),
  'XR001', 'shoe_size_format: A shoe size runs from 1 to 20 in half sizes.', 'shoe_size_format');
select throws_ok(format($$select app.save_roster_vehicle(%L, 'Ford', 'Transit', null, 'ABC12345678', 'US-FL')$$, pg_temp.id('e_kai')),
  'XR001', 'plate_format: A plate is 1 to 10 letters and digits.', 'plate_format');
select throws_ok(format($$select app.save_roster_vehicle(%L, 'Ford', 'Transit', null, 'ABC1234', 'Florida')$$, pg_temp.id('e_kai')),
  'XR001', 'plate_region_format: Give the region as a code such as US-FL, or the country code alone.', 'plate_region_format');
select pg_temp.as_platform();

select pg_temp.offer('travel', 'not-offered');
select pg_temp.offer('uniforms', 'not-offered');
select pg_temp.offer('parking', 'not-offered');
select pg_temp.offer('lodging', 'not-offered');
select pg_temp.as_user('kai');
select throws_ok(pg_temp.travel('e_kai'), 'XR001', 'offering_not_offered: Travel is not offered on this engagement''s project.',
  'offering_not_offered for travel');
select throws_ok(pg_temp.uniform('e_kai'), 'XR001', 'offering_not_offered: Uniforms is not offered on this engagement''s project.',
  'for uniforms');
select throws_ok(pg_temp.vehicle('e_kai'), 'XR001', 'offering_not_offered: Parking is not offered on this engagement''s project.',
  'and for parking');
select pg_temp.as_platform();
select pg_temp.offer('travel', 'provided');
select pg_temp.as_user('kai');
select throws_ok(format($$select app.save_roster_travel_request(%L, 'MIA', null, null, null, null, null, false, true)$$, pg_temp.id('e_kai')),
  'XR001', 'offering_not_offered: Lodging is not offered on this engagement''s project.', 'lodging is not asked while it is off');
select lives_ok(pg_temp.travel('e_kai'), 'travel without lodging still saves');
select pg_temp.as_platform();
select pg_temp.offer('uniforms', 'provided');
select pg_temp.offer('parking', 'provided');
select pg_temp.offer('lodging', 'provided');

-- Read-only org: saves refused, the person's clear still works
insert into app.org_cancellations (org_id, reason, canceled_at, read_only_until, purge_after)
values (pg_temp.id('org_a'), 'Fixture cancellation.', now(), now() + interval '30 days', now() + interval '90 days');
select pg_temp.as_user('kai');
select throws_ok(pg_temp.vehicle('e_kai'), 'XR001',
  'org_read_only: This organization is canceled and read-only, so nothing more is entered for it.', 'org_read_only refuses a save');
select lives_ok(format($$select app.clear_roster_project_fact(%L, 'Vehicle')$$, pg_temp.id('e_kai')), 'while the person still clears');
select pg_temp.as_platform();
update app.org_cancellations set reactivated_at = now(), reactivated_by = pg_temp.id('alice') where org_id = pg_temp.id('org_a');
select pg_temp.as_user('kai');
select lives_ok(pg_temp.vehicle('e_kai'), 'the vehicle is entered again once the org is reactivated');
select pg_temp.as_platform();

-- Company writes -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select throws_ok(pg_temp.vehicle('e_mo'), 'XR001',
  'project_fact_company_write_off: This project asks each person to enter their own details.', 'the company waits for the setting');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'advancing.company_may_submit_project_facts', 'Project', pg_temp.id('prj_a'), null, true);
select pg_temp.as_user('victor');
select lives_ok(pg_temp.vehicle('e_mo'), 'the Account Owner enters mo''s vehicle once the project allows it');
select pg_temp.as_platform();
select is(pg_temp.notified('mo', 'roster_entry.project_facts_entered', 'e_mo'), 1, 'mo is notified');
select pg_temp.as_user('pia');
select lives_ok(pg_temp.vehicle('e_mo', 'Toyota'), 'the Advancing Lead corrects it');
select pg_temp.as_platform();
select is(pg_temp.notified('mo', 'roster_entry.project_facts_entered', 'e_mo'), 2, 'each company write queues one notification');
select is((pg_temp.facts('mo', 'e_mo') -> 'entered_by_person' ->> 'vehicle')::boolean, false, 'the company entered it');
select pg_temp.as_user('mo');
select lives_ok(pg_temp.vehicle('e_mo', 'Honda'), 'mo overwrites the company row');
select pg_temp.as_platform();
select is((pg_temp.facts('mo', 'e_mo') -> 'entered_by_person' ->> 'vehicle')::boolean, true, 'and it turns the person''s');
select is((pg_temp.facts('mo', 'e_mo') -> 'vehicle' ->> 'make'), 'Honda', 'with mo''s value');
select pg_temp.as_user('victor');
select throws_ok(pg_temp.vehicle('e_mo'), 'XR001',
  'project_fact_person_entered: The person entered these details themselves, so only they change them.', 'the company stops there');
select throws_ok(format($$select app.clear_roster_project_fact(%L, 'Vehicle')$$, pg_temp.id('e_mo')), 'XR001',
  'project_fact_person_entered: The person entered these details themselves, so only they change them.', 'and cannot clear it');
select throws_ok(pg_temp.vehicle('e_kai'), 'XR001',
  'project_fact_person_entered: The person entered these details themselves, so only they change them.', 'nor kai''s');
select lives_ok(pg_temp.uniform('e_mo'), 'the company still enters a kind mo has not');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'advancing.company_may_submit_project_facts', 'Organization', null, null, false, null, true);
select pg_temp.as_user('victor');
select throws_ok(pg_temp.travel('e_mo'), 'XR001',
  'project_fact_company_write_off: This project asks each person to enter their own details.', 'a locked org value overrides the project');
select pg_temp.as_user('fiona');
select throws_ok(pg_temp.travel('e_mo'), 'XR001',
  'project_fact_not_yours: Only the person on the roster entry, or the company that rosters them, enters these details.',
  'Account Finance has no standing');
select pg_temp.as_platform();

-- Reads ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('mo');
select is((app.roster_project_facts(pg_temp.id('e_mo')) ->> 'standing'), 'Person', 'a duty Member reads their own entry');
select throws_ok(format($$select app.roster_project_facts(%L)$$, pg_temp.id('e_kai')), '42501', 'the roster entry is not readable',
  'and not another');
select pg_temp.as_user('fiona');
select throws_ok(format($$select app.roster_project_facts(%L)$$, pg_temp.id('e_kai')), '42501', 'the roster entry is not readable',
  'Account Finance reads nothing');
select pg_temp.as_platform();
select is(pg_temp.facts('pia', 'e_kai') ->> 'standing', 'Company', 'the Advancing Lead reads kai''s entry');
select is(pg_temp.facts('pia', 'e_kai') -> 'vehicle' ->> 'plate', 'ABC1234', 'with every kind');
select is(pg_temp.facts('pia', 'e_una') ->> 'standing', 'Company', 'and the Draft entry');

select pg_temp.as_user('art');
select lives_ok(pg_temp.travel('self_art'), 'the artist saves travel on their own entry');
select pg_temp.as_platform();
select is(pg_temp.facts('rita', 'self_art') ->> 'standing', 'Company', 'the artist''s Advance representative reads it');
select is(pg_temp.facts('rita', 'self_art') -> 'travel' ->> 'inbound_airport_code', 'MIA', 'values included');

select is(pg_temp.facts('hops', 'e_kai') -> 'readable', '["Travel"]'::jsonb, 'hospitality reads Travel only');
select ok(pg_temp.facts('hops', 'e_kai') -> 'travel' <> 'null'::jsonb and pg_temp.facts('hops', 'e_kai') -> 'vehicle' = 'null'::jsonb,
  'the other kinds come back null');
select is(pg_temp.facts('creds', 'e_kai') -> 'readable', '["Vehicle"]'::jsonb, 'credentials reads Vehicle only');
select is(pg_temp.facts('shifts', 'e_kai') -> 'readable', '["Uniform"]'::jsonb, 'crew.shift.write reads Uniform');
select ok(pg_temp.facts('carol', 'e_kai') -> 'readable' ? 'Uniform', 'opportunities.engagement.read reads Uniform');
select pg_temp.as_user('hops');
select throws_ok(format($$select app.roster_project_facts(%L)$$, pg_temp.id('e_una')), '42501', 'the roster entry is not readable',
  'a Draft entry is not the producer''s to read');
select pg_temp.as_platform();

-- Logging
delete from app.work_detail_events where action = 'project_facts.viewed';
select pg_temp.mark_audits();
select pg_temp.facts('pia', 'e_kai');
select pg_temp.facts('pia', 'e_kai');
select is(pg_temp.events('kai', 'project_facts.viewed'), 2, 'two company reads log twice');
select is((select org_id from app.work_detail_events where person_id = pg_temp.id('kai') and action = 'project_facts.viewed' limit 1),
  pg_temp.id('acct_v'), 'under the supplying account');
select is((select fact_kinds from app.work_detail_events where person_id = pg_temp.id('kai') and action = 'project_facts.viewed' limit 1),
  array['Travel', 'Uniform', 'Vehicle']::app.project_fact_kind[], 'with the kinds read');
select is(pg_temp.audits('e_kai'), 0, 'company reads write no audit event');
select pg_temp.facts('hops', 'e_kai');
select pg_temp.facts('hops', 'e_kai');
select is(pg_temp.events('kai', 'project_facts.viewed'), 4, 'two producer reads log twice more');
select is(pg_temp.audits('e_kai'), 2, 'and write two audit events');
select is((select fact_kinds from app.work_detail_events where person_id = pg_temp.id('kai') and action = 'project_facts.viewed'
  and org_id = pg_temp.id('org_a') limit 1), array['Travel']::app.project_fact_kind[], 'naming only what the producer read');
select pg_temp.facts('kai', 'e_kai');
select pg_temp.as_user('pia');
select count(*) from app.roster_project_fact_status(pg_temp.id('eng_vendor_a'));
select pg_temp.as_platform();
select is(pg_temp.events('kai', 'project_facts.viewed'), 4, 'the person''s own read and the status read log nothing');

select pg_temp.as_user('pia');
select is((select count(*)::int from app.roster_project_fact_status(pg_temp.id('eng_vendor_a'))), 4,
  'the status lists every live entry the reader has standing on');
select is((select has_vehicle from app.roster_project_fact_status(pg_temp.id('eng_vendor_a')) where roster_entry_id = pg_temp.id('e_kai')),
  true, 'with presence flags');
select pg_temp.as_platform();
delete from app.work_detail_events where action = 'project_facts.viewed';
select pg_temp.as_user('pia');
select is((select count(*)::int from app.roster_project_facts_for_engagement(pg_temp.id('eng_vendor_a'))), 4,
  'the bulk read returns the same entries');
select pg_temp.as_platform();
select is((select count(*)::int from app.work_detail_events where action = 'project_facts.viewed' and org_id = pg_temp.id('acct_v')), 2,
  'logging once per entry returned with a value (kai and mo)');
select pg_temp.as_user('mo');
select is((select count(*)::int from app.roster_project_fact_status(pg_temp.id('eng_vendor_a'))), 1, 'a duty Member sees only their own row');
select pg_temp.as_platform();

-- Suggestions ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('kai');
select is(app.my_previous_roster_facts('Vehicle') ->> 'plate', 'ABC1234', 'kai''s last vehicle is offered as a pre-fill');
select ok(not (app.my_previous_roster_facts('Vehicle') ? 'id'), 'without the row id');
select pg_temp.as_user('ivy');
select is(app.my_previous_roster_facts('Vehicle'), null, 'nothing for someone else');
select pg_temp.as_platform();

-- Exits -----------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('una');
select lives_ok(pg_temp.vehicle('e_una'), 'una enters a vehicle on her Draft entry');
select app.respond_roster_entry(pg_temp.id('e_una'), 'Declined');
select throws_ok(pg_temp.vehicle('e_una'), 'XR001', 'roster_entry_declined: This roster entry was declined.', 'roster_entry_declined');
select pg_temp.as_platform();
select is((select count(*)::int from app.roster_vehicles where roster_entry_id = pg_temp.id('e_una')), 0, 'a declined entry''s facts are erased');
select is(pg_temp.events('una', 'project_facts.erased'), 1, 'and the erasure logged');

select pg_temp.as_user('victor');
select app.withdraw_roster_entry(pg_temp.id('e_mo'), 'Not travelling after all.');
select pg_temp.as_user('mo');
select throws_ok(pg_temp.vehicle('e_mo'), 'XR001', 'roster_entry_withdrawn: This roster entry was withdrawn.', 'roster_entry_withdrawn');
select pg_temp.as_platform();
select is((select count(*)::int from app.roster_vehicles where roster_entry_id = pg_temp.id('e_mo'))
  + (select count(*)::int from app.roster_uniform_sizes where roster_entry_id = pg_temp.id('e_mo')), 0, 'a withdrawn entry''s facts are erased');
select is(pg_temp.events('mo', 'project_facts.erased'), 1, 'and the erasure logged');

select pg_temp.as_user('ivy');
select lives_ok(pg_temp.travel('self_ivy'), 'ivy saves travel on her own crew entry');
select pg_temp.as_platform();
update app.people set deleted_at = now() where id = pg_temp.id('ivy');
select is((select count(*)::int from app.roster_travel_requests where roster_entry_id = pg_temp.id('self_ivy')), 0,
  'deleting the account erases the facts');
select is(pg_temp.events('ivy', 'project_facts.erased'), 1, 'and logs it');
update app.people set deleted_at = null where id = pg_temp.id('ivy');

-- Expiry ------------------------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from cron.job where jobname = 'xos_expire_roster_project_facts'), 1, 'the nightly job is scheduled');
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');
select pg_temp.as_user('kai');
select throws_ok(pg_temp.vehicle('e_kai'), 'XR001',
  'project_fact_closed: This engagement is complete or canceled, so its project details are closed.', 'project_fact_closed');
select pg_temp.as_platform();

select pg_temp.backdate_close('eng_vendor_a', interval '89 days');
select private.expire_roster_project_facts();
select is((select count(*)::int from app.roster_travel_requests where roster_entry_id = pg_temp.id('e_kai')), 1, '89 days keeps them');
select pg_temp.backdate_close('eng_vendor_a', interval '91 days');
select ok(private.expire_roster_project_facts() >= 3, '91 days deletes them');
select is((select count(*)::int from app.roster_travel_requests where roster_entry_id = pg_temp.id('e_kai'))
  + (select count(*)::int from app.roster_uniform_sizes where roster_entry_id = pg_temp.id('e_kai'))
  + (select count(*)::int from app.roster_vehicles where roster_entry_id = pg_temp.id('e_kai')), 0, 'every kind of kai''s');
select is(pg_temp.events('kai', 'project_facts.expired'), 1, 'one project_facts.expired event for the entry');
select is((select fact_kinds from app.work_detail_events where person_id = pg_temp.id('kai') and action = 'project_facts.expired'),
  array['Travel', 'Uniform', 'Vehicle']::app.project_fact_kind[], 'naming the kinds deleted');
select ok(exists (select 1 from private.retention_runs where table_name = 'app.roster_travel_requests' and action = 'purge' and rows_affected >= 1),
  'retention_runs records the count');
select pg_temp.as_user('kai');
select is(app.my_previous_roster_facts('Vehicle'), null, 'and the suggestion is gone after expiry');
select pg_temp.as_platform();

-- keep_days 30 with 31 days, and a legal hold
select pg_temp.as_user('art');
select lives_ok(pg_temp.vehicle('self_art'), 'the artist enters a vehicle');
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Canceled');
select pg_temp.backdate_close('eng_art_a', interval '31 days');
select private.expire_roster_project_facts();
select is((select count(*)::int from app.roster_vehicles where roster_entry_id = pg_temp.id('self_art')), 1, '31 days keeps them at the default');
insert into app.legal_holds (org_id, table_name, matter) values (pg_temp.id('org_a'), 'app.roster_vehicles', 'Fixture hold.');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'advancing.project_facts.keep_days', 'Organization', null, null, null, 30);
select pg_temp.as_platform();
select private.expire_roster_project_facts();
select is((select count(*)::int from app.roster_vehicles where roster_entry_id = pg_temp.id('self_art')), 1, 'an active legal hold on the table keeps them');
select is((select count(*)::int from app.roster_travel_requests where roster_entry_id = pg_temp.id('self_art')), 0,
  'while keep_days 30 with 31 days deletes the tables not held');
update app.legal_holds set released_at = now() where org_id = pg_temp.id('org_a');
select private.expire_roster_project_facts();
select is((select count(*)::int from app.roster_vehicles where roster_entry_id = pg_temp.id('self_art')), 0, 'and the release lets them go');

select * from finish();
rollback;
