-- pgTAP: contract and rider intake (B15, RRR-239, migration 3042). Party candidates: the org's counterparties, the
-- people it holds and the project's booked Artist engagements, never someone outside the org. Applying: a new Artist
-- engagement per act (a person, an account, or both), riders for the engagement of a person and for the account of an
-- account-only act, their lines, an existing engagement taking riders; the fee only for a payroll reader; refusals
-- (no party, a fee without payroll, the engagement plan limit) leave no engagement, rider or Applied suggestion.
-- World: 0700_engagement_world (carol manager without payroll, alice owner with it; ivy Crew and art Artist engaged on
-- prj_a, sam supplied by Bayside Audio cp_v_a, quinn engaged by org_b only).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.hint_of(p_sql text) returns text
language plpgsql as $$
declare v text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v = pg_exception_hint;
  return v;
end $$;

create function pg_temp.propose(p_key text, p_request text, p_operation text, p_fields jsonb) returns uuid
language plpgsql as $$
declare v uuid;
begin
  v := app.ai_propose_suggestion(pg_temp.id(p_request), p_operation, null, 'Proposed from the contract.', p_fields);
  insert into world values (p_key, v);
  return v;
end $$;

create function pg_temp.contract(p_key text, p_request text, p_fee jsonb) returns uuid
language sql as $$
  select pg_temp.propose(p_key, p_request, 'aurora.applyContracts', jsonb_build_array(
    jsonb_build_object('field_path', 'act_name', 'value', 'The Midnight Owls', 'confidence', 0.9),
    jsonb_build_object('field_path', 'contracting_party', 'value', 'Owl Touring LLC', 'confidence', 0.8),
    jsonb_build_object('field_path', 'start_date', 'value', '2027-06-04', 'confidence', 0.9, 'source_excerpt', 'June 4, 2027'),
    jsonb_build_object('field_path', 'end_date', 'value', '2027-06-06', 'confidence', 0.9, 'source_excerpt', 'through June 6, 2027'),
    p_fee,
    jsonb_build_object('field_path', 'currency_code', 'value', 'USD', 'confidence', 0.9)))
$$;

create function pg_temp.terms(p_party jsonb) returns jsonb
language sql as $$
  select p_party || '{"role_code": "2000.50.02", "worker_classification": "INDEPENDENT_CONTRACTOR", "pay_basis": "Day Rate", "arrangement": "Per Engagement"}'
$$;

create function pg_temp.counts() returns text
language sql stable as $$
  select (select count(*) from app.engagements where project_id = pg_temp.id('prj_a'))::text || ' engagements, '
    || (select count(*) from app.riders where project_id = pg_temp.id('prj_a'))::text || ' riders, '
    || (select count(*) from app.ai_suggestions s join app.ai_requests r on r.id = s.request_id
        where r.subject_id = pg_temp.id('b_c') and s.suggestion_state = 'Applied')::text || ' applied'
$$;

select pg_temp.as_user('bob');
insert into app.ai_settings (org_id, extraction_enabled) values (pg_temp.id('org_a'), true);
select pg_temp.as_user('carol');
insert into world values ('b_c', app.start_ai_intake(pg_temp.id('prj_a'), 'Contracts and Riders', 3));
insert into world values ('r_c', app.ai_begin_request(pg_temp.id('org_a'), 'extraction', 'claude-sonnet-5-5', 'app.ai_intake_batches', pg_temp.id('b_c')));
select app.ai_complete_request(pg_temp.id('r_c'), 'Answered', 'Read the contracts.', 'Read.', 100, 40);
select pg_temp.contract('c1', 'r_c', '{"field_path": "fee_minor", "refusal": "NO_ANSWER", "missing": "Fees are read only by someone who may see pay rates."}');
select pg_temp.contract('c2', 'r_c', '{"field_path": "fee_minor", "refusal": "NO_ANSWER", "missing": "Fees are read only by someone who may see pay rates."}');
select pg_temp.contract('c3', 'r_c', '{"field_path": "fee_minor", "refusal": "NO_ANSWER", "missing": "Fees are read only by someone who may see pay rates."}');
select pg_temp.propose('h1', 'r_c', 'riders.create', '[{"field_path": "act_name", "value": "Midnight Owls", "confidence": 0.9},
  {"field_path": "title", "value": "Technical Rider", "confidence": 0.9}]');
select pg_temp.propose('h2', 'r_c', 'riders.create', '[{"field_path": "title", "value": "Hospitality Rider", "confidence": 0.9}]');
select pg_temp.propose('h3', 'r_c', 'riders.create', '[{"field_path": "title", "value": "Stage Plot", "confidence": 0.9}]');
select pg_temp.propose('l1', 'r_c', 'riderLines.create', '[{"field_path": "description", "value": "Two wedge monitors", "confidence": 0.9},
  {"field_path": "quantity", "value": 2, "confidence": 0.9, "source_excerpt": "2 x wedge monitors"}]');
select pg_temp.propose('l2', 'r_c', 'riderLines.create', '[{"field_path": "description", "value": "Bottled water", "confidence": 0.9},
  {"field_path": "quantity", "refusal": "NO_ANSWER", "missing": "No quantity is stated."}]');
select pg_temp.propose('l3', 'r_c', 'riderLines.create', '[{"field_path": "description", "value": "Towels", "confidence": 0.9}]');

-- Party candidates --------------------------------------------------------------------------------------------------------
select set_eq($$select name_index, candidate_kind, candidate_id, already_booked from app.intake_party_candidates((select id from world where key = 'b_c'),
    array['ARTURO BELL', 'The Bayside Audio', 'Ivy Marchetti', 'Quinn Ashby'])$$,
  $$values (1, 'person', (select id from world where key = 'art'), true), (1, 'engagement', (select id from world where key = 'eng_art_a'), true),
    (2, 'counterparty', (select id from world where key = 'cp_v_a'), false), (3, 'person', (select id from world where key = 'ivy'), false)$$,
  'an act already booked is marked, accounts and held people match, and nobody outside the org is offered');
select pg_temp.as_user('dave');
select throws_ok($$select * from app.intake_party_candidates((select id from world where key = 'b_c'), array['Arturo Bell'])$$,
  '42501', null, 'someone else is refused');

-- Refusals leave nothing behind -----------------------------------------------------------------------------------------------
select pg_temp.as_platform();
create temporary table before as select pg_temp.counts() as c;
grant select on before to public;
select pg_temp.as_user('carol');
select throws_ok($$select app.apply_contract_intake((select id from world where key = 'b_c'), jsonb_build_array(jsonb_build_object(
    'act_name', 'The Midnight Owls', 'engagement', jsonb_build_object('mode', 'new', 'contract_suggestion_id', (select id from world where key = 'c1'),
      'values', pg_temp.terms('{}')))))$$,
  'XR001', 'intake_group_party: Act 1 needs a party: a person, an account, or both.', 'an act without a party is refused');
select throws_ok($$select app.apply_contract_intake((select id from world where key = 'b_c'), jsonb_build_array(jsonb_build_object(
    'act_name', 'Quinn', 'engagement', jsonb_build_object('mode', 'new', 'values', pg_temp.terms(jsonb_build_object('person_id', (select id from world where key = 'quinn'),
      'start_date', '2027-06-04'))))))$$,
  'XR001', 'intake_group_party: Act 1: the person is not one of the org''s people.', 'a person outside the org is refused');
select throws_ok($$select app.apply_contract_intake((select id from world where key = 'b_c'), jsonb_build_array(jsonb_build_object(
    'act_name', 'The Midnight Owls', 'engagement', jsonb_build_object('mode', 'new', 'contract_suggestion_id', (select id from world where key = 'c1'),
      'values', pg_temp.terms(jsonb_build_object('person_id', (select id from world where key = 'ivy'), 'agreed_rate_minor', 750000))))))$$,
  'XR001', 'intake_fee_restricted: Act 1: only someone who may see pay rates sets a fee.', 'a fee from a caller without payroll is refused');
select pg_temp.as_platform();
update private.plan_limits set limit_value = (select count(*) from app.engagements e where e.org_id = pg_temp.id('org_a')
  and e.deleted_at is null and e.created_at >= date_trunc('month', now()))
where plan_code = 'team' and limit_code = 'active_external_engagements_per_month';
select pg_temp.as_user('carol');
select is(pg_temp.hint_of($$select app.apply_contract_intake((select id from world where key = 'b_c'), jsonb_build_array(jsonb_build_object(
    'act_name', 'The Midnight Owls', 'engagement', jsonb_build_object('mode', 'existing', 'engagement_id', (select id from world where key = 'eng_art_a')),
    'riders', jsonb_build_array(jsonb_build_object('header_suggestion_id', (select id from world where key = 'h3')))),
  jsonb_build_object('act_name', 'Ivy', 'engagement', jsonb_build_object('mode', 'new', 'contract_suggestion_id', (select id from world where key = 'c1'),
      'values', pg_temp.terms(jsonb_build_object('person_id', (select id from world where key = 'ivy')))))))$$),
  'plan_limit_exceeded', 'the engagement plan limit refuses, keeping its rule');
select pg_temp.as_platform();
update private.plan_limits set limit_value = null where plan_code = 'team' and limit_code = 'active_external_engagements_per_month';
select is(pg_temp.counts(), (select c from before), 'no refusal left an engagement, a rider or an Applied suggestion');

-- Applying ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
create temporary table applied as
select app.apply_contract_intake(pg_temp.id('b_c'), jsonb_build_array(
  jsonb_build_object('act_name', 'Ivy Marchetti', 'engagement', jsonb_build_object('mode', 'new', 'contract_suggestion_id', pg_temp.id('c1'),
      'values', pg_temp.terms(jsonb_build_object('person_id', pg_temp.id('ivy')))),
    'riders', jsonb_build_array(jsonb_build_object('header_suggestion_id', pg_temp.id('h1'),
      'line_suggestion_ids', jsonb_build_array(pg_temp.id('l1'), pg_temp.id('l2')),
      'line_values', jsonb_build_object(pg_temp.id('l2')::text, jsonb_build_object('quantity', 24))))),
  jsonb_build_object('act_name', 'Bayside Audio', 'engagement', jsonb_build_object('mode', 'new', 'contract_suggestion_id', pg_temp.id('c2'),
      'values', pg_temp.terms(jsonb_build_object('counterparty_id', pg_temp.id('cp_v_a')))),
    'riders', jsonb_build_array(jsonb_build_object('header_suggestion_id', pg_temp.id('h2'), 'title', 'Bayside Hospitality Rider'))),
  jsonb_build_object('act_name', 'Arturo Bell', 'engagement', jsonb_build_object('mode', 'existing', 'engagement_id', pg_temp.id('eng_art_a')),
    'riders', jsonb_build_array(jsonb_build_object('header_suggestion_id', pg_temp.id('h3')))),
  jsonb_build_object('act_name', 'Sam Kowalski', 'engagement', jsonb_build_object('mode', 'new',
      'values', pg_temp.terms(jsonb_build_object('person_id', pg_temp.id('sam'), 'counterparty_id', pg_temp.id('cp_v_a'), 'start_date', '2027-06-04'))))
  )) as result;
select is((select (result ->> 'engagements')::int from applied), 3, 'three new acts are booked');
select is((select (result ->> 'riders')::int from applied), 3, 'three riders are written');
select is((select (result ->> 'rider_lines')::int from applied), 2, 'with the two kept lines');
select is((select (result ->> 'rejected')::int from applied), 2, 'the unused contract and line are rejected');

select pg_temp.as_platform();
select results_eq($$select e.role_type::text, e.role_code, e.worker_classification, e.start_date, e.end_date, e.agreed_rate_minor, e.currency_code::text,
    e.engagement_state::text
  from app.engagements e where e.id = (select (x ->> 'id')::uuid from applied, jsonb_array_elements(result -> 'applied') x
    where x ->> 'suggestion_id' = (select id from world where key = 'c1')::text)$$,
  $$values ('Artist', '2000.50.02', 'INDEPENDENT_CONTRACTOR', '2027-06-04'::date, '2027-06-06'::date, null::bigint, 'USD', 'Onboarding')$$,
  'a new act is an Artist engagement at Onboarding with the person''s terms and the contract''s dates, without a fee it could not read');
select results_eq($$select r.engagement_id is not null, r.counterparty_id, r.title from app.riders r where r.title = 'Technical Rider'$$,
  $$values (true, null::uuid, 'Technical Rider')$$, 'a person''s rider is attached to the engagement');
select results_eq($$select r.engagement_id, r.counterparty_id from app.riders r where r.title = 'Bayside Hospitality Rider'$$,
  $$values (null::uuid, (select id from world where key = 'cp_v_a'))$$, 'an account''s rider is attached to the account, with the person''s title');
select results_eq($$select r.engagement_id from app.riders r where r.title = 'Stage Plot'$$,
  $$values ((select id from world where key = 'eng_art_a'))$$, 'an act already booked takes its rider and no new engagement');
select results_eq($$select l.description, l.quantity from app.rider_lines l join app.riders r on r.id = l.rider_id
    where r.title = 'Technical Rider' order by l.description$$,
  $$values ('Bottled water', 24::numeric), ('Two wedge monitors', 2::numeric)$$, 'rider lines keep the read and the person''s values');
select is((select count(*)::int from app.engagements where person_id = pg_temp.id('sam') and counterparty_id = pg_temp.id('cp_v_a') and role_type = 'Artist'),
  1, 'an act with both a person and an account is booked');
select is((select suggestion_state::text from app.ai_suggestions where id = pg_temp.id('c3')), 'Rejected', 'a contract left out is Rejected');
select is((select suggestion_state::text from app.ai_suggestions where id = pg_temp.id('h3')), 'Applied', 'a kept rider header is Applied');
select isnt((select closed_at from app.ai_intake_batches where id = pg_temp.id('b_c')), null, 'the batch is closed');

-- A payroll reader books the fee ------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into world values ('b_fee', app.start_ai_intake(pg_temp.id('prj_a'), 'Contracts and Riders', 1));
insert into world values ('r_fee', app.ai_begin_request(pg_temp.id('org_a'), 'extraction', 'claude-sonnet-5-5', 'app.ai_intake_batches', pg_temp.id('b_fee')));
select app.ai_complete_request(pg_temp.id('r_fee'), 'Answered', 'Read the contract.', 'Read.', 100, 40);
select pg_temp.contract('c_fee', 'r_fee', '{"field_path": "fee_minor", "value": 750000, "confidence": 0.9, "source_excerpt": "[Restricted]"}');
select lives_ok($$select app.apply_contract_intake((select id from world where key = 'b_fee'), jsonb_build_array(jsonb_build_object(
    'act_name', 'The Midnight Owls', 'engagement', jsonb_build_object('mode', 'new', 'contract_suggestion_id', (select id from world where key = 'c_fee'),
      'values', pg_temp.terms(jsonb_build_object('person_id', (select id from world where key = 'ivy')))))))$$,
  'a payroll reader books the act');
select pg_temp.as_platform();
select is((select e.agreed_rate_minor from app.engagements e join app.ai_suggestions s on s.applied_id = e.id where s.id = pg_temp.id('c_fee')),
  750000::bigint, 'with the proposed fee as the agreed rate');

select ok(not has_function_privilege('anon', 'app.apply_contract_intake(uuid, jsonb)', 'execute'), 'anon cannot apply');
select ok(not has_function_privilege('authenticated', 'private.intake_suggestion(uuid, uuid, text)', 'execute'), 'the lookup is private');

select * from finish();
rollback;
