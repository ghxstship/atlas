-- pgTAP: A43 (RRR-87), migration 1125, finding A38-006. Pay-transparency rules ship with the platform: twelve US
-- jurisdictions, each marked for counsel review; a rule covers its code and every jurisdiction beneath it, the
-- latest rule in force wins, remote roles follow rules that cover them, and publishing a Contractor, Crew or Staff
-- posting without a pay range where a rule applies is refused with XR001.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(18);

-- Canon has no US state below Florida yet; these two rows stand in for it inside this transaction only.
insert into xpms.jurisdiction (jurisdiction_id, ordinal, level, parent, status)
select 'US-CA', max(ordinal) + 1, 'region', 'US', 'declared-unpopulated' from xpms.jurisdiction;
insert into xpms.jurisdiction (jurisdiction_id, ordinal, level, parent, status)
select 'US-CA-LOS-ANGELES', max(ordinal) + 1, 'ahj', 'US-CA', 'declared-unpopulated' from xpms.jurisdiction;

create function pg_temp.opp(p_key text, p_role text, p_jurisdiction text, p_remote boolean, p_min bigint, p_max bigint) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.opportunities (project_id, role_type, role_code, title, visibility, rate_type, pay_min_minor, pay_max_minor,
    currency_code, deadline_at, starts_on, ends_on, requisition_id, jurisdiction_id, is_remote)
  values (pg_temp.id('prj_a'), p_role::app.external_role_type, case when p_role = 'Crew' then '5000.51.02' end,
    'Rigging Crew ' || p_key, 'Invited', case when p_min is not null then 'Day'::app.rate_type end, p_min, p_max,
    case when p_min is not null then 'USD' end, now() + interval '7 days', '2027-06-01', '2027-06-03',
    case when p_role = 'Crew' then pg_temp.id('requisition_a') end, p_jurisdiction, p_remote)
  returning id into v;
  insert into world values (p_key, v);
  return v;
end $$;
grant execute on function pg_temp.opp(text, text, text, boolean, bigint, bigint) to public;

create function pg_temp.publish(p_key text) returns void
language plpgsql as $$
begin
  perform app.transition_opportunity(pg_temp.id(p_key), 'Draft', 'Pending Approval', 'Ready for approval.');
  perform app.transition_opportunity(pg_temp.id(p_key), 'Pending Approval', 'Published', 'Approved.');
end $$;
grant execute on function pg_temp.publish(text) to public;

-- Seed ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select string_agg(jurisdiction_id, ',' order by jurisdiction_id) from app.pay_transparency_rules where jurisdiction_id like 'US-%'),
  'US-CA,US-CO,US-DC,US-HI,US-IL,US-MA,US-MD,US-MN,US-NJ,US-NY,US-VT,US-WA', 'the twelve US jurisdictions ship');
select ok((select bool_and(needs_counsel_review) from app.pay_transparency_rules where jurisdiction_id like 'US-%'),
  'every seeded rule is marked for counsel review');
select ok((select bool_and(char_length(citation) > 0 and requires_pay_range) from app.pay_transparency_rules where jurisdiction_id like 'US-%'),
  'each names its citation and requires a range');
select is((select applies_to_remote from app.pay_transparency_rules where jurisdiction_id = 'US-HI'), false, 'Hawaii''s rule is recorded as on-site only');

-- Publishing -----------------------------------------------------------------------------------------------------------
select pg_temp.opp('ca_nopay', 'Crew', 'US-CA-LOS-ANGELES', false, null, null);
select throws_ok($$select pg_temp.publish('ca_nopay')$$, 'XR001',
  'pay_range_required: A pay range is required to publish work in US-CA-LOS-ANGELES.',
  'a Crew posting beneath a covered jurisdiction cannot publish without a pay range');
select pg_temp.opp('ca_pay', 'Crew', 'US-CA-LOS-ANGELES', false, 80000, 95000);
select lives_ok($$select pg_temp.publish('ca_pay')$$, 'with a pay range it publishes');
select throws_ok(format($$update app.opportunities set is_remote = true where id = '%s'$$, pg_temp.id('ca_pay')), 'XR001', null,
  'remote work is fixed once published');
select pg_temp.opp('ca_vendor', 'Vendor', 'US-CA', false, null, null);
select lives_ok($$select pg_temp.publish('ca_vendor')$$, 'a Vendor posting is not a pay transparency posting (ADR 0019)');
select pg_temp.opp('fl_onsite', 'Crew', 'US-FL-MIAMI-DADE', false, null, null);
select lives_ok($$select pg_temp.publish('fl_onsite')$$, 'on site in an uncovered jurisdiction, no range is required');
select pg_temp.opp('fl_remote', 'Crew', 'US-FL-MIAMI-DADE', true, null, null);
select throws_ok($$select pg_temp.publish('fl_remote')$$, 'XR001', null,
  'a remote role is covered by the rules of its country that cover remote roles');

-- Matching ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is(private.pay_range_required('US-CA'), true, 'a rule covers its own code');
select is(private.pay_range_required('US-CAX'), false, 'and never a code that only starts with the same letters');
select is(private.pay_range_required('US-FL', false), false, 'an uncovered state on site needs no range');
insert into private.pay_transparency_rules (jurisdiction_id, requires_pay_range, effective_from, citation)
values ('US-TX', true, current_date + 30, 'Fictional Future Statute 2.1');
select is(private.pay_range_required('US-TX'), false, 'a rule not yet in force does not apply');
insert into private.pay_transparency_rules (jurisdiction_id, requires_pay_range, effective_from, citation)
values ('US-CO', false, current_date - 1, 'Fictional Repeal 3.1');
select is(private.pay_range_required('US-CO'), false, 'the latest rule in force for a code wins');
select throws_ok($$insert into private.pay_transparency_rules (jurisdiction_id, requires_pay_range, effective_from, citation) values ('california', true, current_date, 'Bad.')$$,
  '23514', null, 'a rule is keyed by a jurisdiction code');
select pg_temp.as_anon();
select throws_ok('select 1 from app.pay_transparency_rules', '42501', null, 'anon deny');
select pg_temp.as_user('xavier');
select ok((select count(*) from app.pay_transparency_rules) >= 12, 'platform reference data reads the same for every tenant');
select pg_temp.as_platform();

select * from finish();
rollback;
