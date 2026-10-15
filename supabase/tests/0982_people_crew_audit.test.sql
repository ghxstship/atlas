-- pgTAP: A13 late slot 0982. People and Crew changes land in the audit ledger with the actor, and the
-- diff never carries a Restricted pay rate.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(6);

select pg_temp.as_user('carol');
with x as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '0000.50.01', '2027-06-01 12:00+00', '2027-06-01 20:00+00', 'America/New_York') returning id)
  insert into world select 'sh', id from x;
update app.shifts set ends_at = '2027-06-01 21:00+00' where id = pg_temp.id('sh');
with x as (insert into app.rate_cards (org_id, name, currency_code, effective_from) values (pg_temp.id('org_a'), '2027 Crew Rates', 'USD', '2027-01-01') returning id)
  insert into world select 'rc', id from x;
with x as (insert into app.rate_card_lines (rate_card_id, role_code, worker_classification, pay_basis, arrangement, overtime_rule_id, rate_minor)
  values (pg_temp.id('rc'), '0000.50.01', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Retainer', 'OTR-002', 85000) returning id)
  insert into world select 'rcl', id from x;
update app.rate_card_lines set rate_minor = 90000, overtime_rule_id = 'OTR-001' where id = pg_temp.id('rcl');
select pg_temp.as_platform();

select ok(exists (select 1 from app.audit_events where subject_id = pg_temp.id('sh') and action = 'shifts.insert'), 'a new shift is audited');
select ok(exists (select 1 from app.audit_events where subject_id = pg_temp.id('sh') and action = 'shifts.update'
  and diff -> 'new' ? 'ends_at'), 'a shift edit is audited with its diff');
select is((select actor_person_id from app.audit_events where subject_id = pg_temp.id('sh') and action = 'shifts.update' limit 1),
  pg_temp.id('carol'), 'the audit names the person who changed it');
select ok(exists (select 1 from app.audit_events where subject_id = pg_temp.id('rcl') and action = 'rate_card_lines.update'), 'a rate card line edit is audited');
select ok(not exists (select 1 from app.audit_events where subject_id = pg_temp.id('rcl')
  and (diff -> 'new' ? 'rate_minor' or diff -> 'old' ? 'rate_minor')), 'the Restricted rate never enters the audit diff');
select ok((select count(*) from pg_trigger where tgname = 't85_audit_trail'
  and tgrelid::regclass::text in ('app.requisitions', 'app.role_assignments', 'app.agreements', 'app.payroll_runs', 'app.time_off_requests')) = 5,
  'People and payroll tables carry the audit trail');

select * from finish();
rollback;
