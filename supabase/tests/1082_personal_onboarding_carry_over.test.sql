-- pgTAP: personal onboarding steps carry over by person only (A38, RRR-82, journey 42). Two people the
-- same company supplies (Bayside Audio's sam and fiona, Staff on prj_a): sam's verified acknowledgment
-- never satisfies fiona's, so fiona cannot go Active; the company's verified tax form still carries over
-- to every engagement of the company; and sam's own acknowledgment carries over to sam's next engagement.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(9);

create function pg_temp.item(p_engagement text, p_requirement text) returns uuid
language sql stable as $$
  select i.id from app.onboarding_items i
  where i.engagement_id = pg_temp.id(p_engagement) and i.onboarding_requirement_id = pg_temp.id(p_requirement)
$$;
grant execute on function pg_temp.item(text, text) to public;

select pg_temp.as_user('carol');
with r as (insert into app.onboarding_requirements (org_id, name, item_kind, role_type, verification_method)
  values (pg_temp.id('org_a'), 'Gate Safety Briefing', 'Acknowledgment', 'Staff', 'Reviewer') returning id)
  insert into world select 'req_ack', id from r;
with r as (insert into app.onboarding_requirements (org_id, name, item_kind, role_type, verification_method)
  values (pg_temp.id('org_a'), 'Company W-9', 'Tax Form', 'Staff', 'Reviewer') returning id)
  insert into world select 'req_tax', id from r;

select pg_temp.as_platform();
with e as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification,
    pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('sam'), pg_temp.id('cp_v_a'), 'Staff', '5000.51.02', 'INDEPENDENT_CONTRACTOR',
    'Day Rate', 'Per Engagement', '2027-06-01') returning id)
  insert into world select 'eng_sam_staff', id from e;
with e as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification,
    pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('fiona'), pg_temp.id('cp_v_a'), 'Staff', '5000.51.02', 'INDEPENDENT_CONTRACTOR',
    'Day Rate', 'Per Engagement', '2027-06-01') returning id)
  insert into world select 'eng_fiona_staff', id from e;

-- sam acknowledges; carol verifies sam's acknowledgment and the company's tax form on sam's engagement.
select pg_temp.as_user('sam');
select lives_ok($$select app.submit_onboarding_item(pg_temp.item('eng_sam_staff', 'req_ack'))$$,
  'the staff member acknowledges without a file');
select pg_temp.as_user('carol');
insert into app.onboarding_verifications (onboarding_item_id, outcome) values (pg_temp.item('eng_sam_staff', 'req_ack'), 'Passed');
insert into app.onboarding_verifications (onboarding_item_id, outcome) values (pg_temp.item('eng_sam_staff', 'req_tax'), 'Passed');
select pg_temp.as_platform();

select ok(private.requirement_satisfied(pg_temp.id('eng_sam_staff'), pg_temp.id('req_ack')), 'sam''s acknowledgment satisfies sam''s step');
select ok(not private.requirement_satisfied(pg_temp.id('eng_fiona_staff'), pg_temp.id('req_ack')),
  'a colleague''s acknowledgment never satisfies fiona''s personal step');
select ok(private.requirement_satisfied(pg_temp.id('eng_fiona_staff'), pg_temp.id('req_tax')),
  'the company''s verified tax form carries over to every engagement of the company');
select is((select satisfied from api_external.onboarding_items where 1 = 0), null, 'the external view still reads');

select pg_temp.as_user('carol');
select throws_ok($$select app.transition_engagement(pg_temp.id('eng_fiona_staff'), 'Onboarding', 'Active', 'Go.')$$,
  'XR001', 'onboarding_incomplete: Every blocking onboarding item must pass before the engagement is Active; open: Gate Safety Briefing.',
  'fiona cannot go Active on a colleague''s acknowledgment');
select lives_ok($$select app.transition_engagement(pg_temp.id('eng_sam_staff'), 'Onboarding', 'Active', 'Go.')$$,
  'sam goes Active with both steps verified');

-- sam's next engagement with the org inherits sam's acknowledgment.
select pg_temp.as_platform();
with e as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification,
    pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('sam'), pg_temp.id('cp_v_a'), 'Staff', '5000.51.02', 'INDEPENDENT_CONTRACTOR',
    'Day Rate', 'Per Engagement', '2027-07-01') returning id)
  insert into world select 'eng_sam_staff2', id from e;
select ok(private.requirement_satisfied(pg_temp.id('eng_sam_staff2'), pg_temp.id('req_ack')),
  'a personal step carries over to the same person''s next engagement');
select ok(not exists (select 1 from private.engagement_open_blocking_requirements(pg_temp.id('eng_sam_staff2'))),
  'so sam''s next engagement has no open blocking step');

select * from finish();
rollback;
