-- pgTAP: contracts and riders into bookings (B15, RRR-239, migration 3042). A real Day Rate row books at Onboarding with no
-- fee; a temporary Flat Fee row proves a fee can be stored on one (canon has none, ADR 0154). A fee without payroll, a rate
-- card combination that does not exist, a missing start date, an Other document and a suggestion read for another project
-- are refused naming the line. One live engagement takes the documents and ignores the fee; two with none named are refused.
-- Riders need advancing.rider.write. A Restricted attachment needs data.export.restricted to download.
-- World: 0700_engagement_world (carol manager without payroll, alice owner with it; art Artist engaged on prj_a).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.document(p_key text, p_request text, p_type text, p_title text default 'Booking Agreement') returns uuid
language plpgsql as $$
declare v uuid;
begin
  v := app.ai_propose_suggestion(pg_temp.id(p_request), 'engagements.createFromContract', null, 'Book from the document.',
    jsonb_build_array(
      jsonb_build_object('field_path', 'document_type', 'value', p_type, 'confidence', 0.9),
      jsonb_build_object('field_path', 'title', 'value', p_title, 'confidence', 0.9),
      jsonb_build_object('field_path', 'act_name', 'value', 'The Midnight Owls', 'confidence', 0.9)));
  insert into world values (p_key, v);
  return v;
end $$;

create function pg_temp.request(p_key text, p_project text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  v := app.ai_begin_request(pg_temp.id('org_a'), 'extraction', 'claude-sonnet-5-5', 'app.projects', pg_temp.id(p_project));
  perform app.ai_complete_request(v, 'Answered', 'Read the contract.', 'Read 3 of 3 fields from one document.', 100, 40);
  insert into world values (p_key, v);
  return v;
end $$;

create function pg_temp.terms() returns jsonb
language sql stable as $$
  select jsonb_build_object('role_code', rc.role_code, 'worker_classification', rc.worker_classification, 'pay_basis', rc.pay_basis, 'arrangement', rc.arrangement)
  from xpms.rate_card rc join xpms.worker_classification wc on wc.code = rc.worker_classification
  where not wc.is_employee and rc.worker_classification = 'INDEPENDENT_CONTRACTOR' order by rc.rate_card_id limit 1
$$;

create function pg_temp.booking(p_suggestions text[], p_counterparty text, p_extra jsonb default '{}') returns jsonb
language sql stable as $$
  select jsonb_build_object('suggestion_ids', (select jsonb_agg(pg_temp.id(s)) from unnest(p_suggestions) s),
    'party', jsonb_build_object('counterparty_id', pg_temp.id(p_counterparty)), 'start_date', '2027-06-01')
    || pg_temp.terms() || p_extra
$$;

select pg_temp.as_user('bob');
insert into app.ai_settings (org_id, extraction_enabled) values (pg_temp.id('org_a'), true);
select pg_temp.as_user('alice');
insert into world values ('cp_owls', app.create_counterparty(pg_temp.id('org_a'), 'Midnight Owls Touring', null, null));
insert into world values ('cp_two', app.create_counterparty(pg_temp.id('org_a'), 'Two Bookings Touring', null, null));

select pg_temp.as_user('carol');
select pg_temp.request('r_carol', 'prj_a');
select pg_temp.document('c1', 'r_carol', 'Contract');
select pg_temp.document('c2', 'r_carol', 'Rider', 'Technical Rider');
select pg_temp.document('c3', 'r_carol', 'Other', 'Tour Poster');
select pg_temp.document('c4', 'r_carol', 'Contract');
select pg_temp.document('c5', 'r_carol', 'Contract');
select pg_temp.document('c6', 'r_carol', 'Contract');
select pg_temp.request('r_other', 'prj_a2');
select pg_temp.document('c_other', 'r_other', 'Contract');

-- Options -------------------------------------------------------------------------------------------------------------------
select ok(exists (select 1 from jsonb_array_elements(app.contract_intake_options(pg_temp.id('prj_a')) -> 'parties') p where p ->> 'name' = 'Midnight Owls Touring' and p ->> 'kind' = 'counterparty'), 'the org''s counterparties are offered');
select ok(not exists (select 1 from jsonb_array_elements(app.contract_intake_options(pg_temp.id('prj_a')) -> 'rate_cards') r where r ->> 'worker_classification' = 'EMPLOYEE'), 'employee rate cards are not');
select is((select jsonb_array_length(p -> 'engagement_ids') from jsonb_array_elements(app.contract_intake_options(pg_temp.id('prj_a')) -> 'parties') p where p ->> 'id' = pg_temp.id('art')::text), 1, 'a person''s live Artist engagement shows');
select pg_temp.as_user('gina');
select throws_ok($$select app.contract_intake_options((select id from world where key = 'prj_a'))$$, '42501', null, 'it needs engagement write');
select throws_ok($$select app.apply_contract_intake((select id from world where key = 'prj_a'), jsonb_build_array(pg_temp.booking(array['c1'], 'cp_owls')))$$, '42501', null, 'and so does applying');

-- Refusals ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$select app.apply_contract_intake((select id from world where key = 'prj_a'), jsonb_build_array(pg_temp.booking(array['c1'], 'cp_owls', jsonb_build_object('agreed_rate_minor', 150000, 'currency_code', 'USD'))))$$,
  'XR001', 'aurora_fee_restricted: Line 1: Only someone who may read pay sets a fee.', 'a fee without payroll is refused');
select throws_ok($$select app.apply_contract_intake((select id from world where key = 'prj_a'), jsonb_build_array(pg_temp.booking(array['c1'], 'cp_owls') - 'start_date'))$$,
  'XR001', 'aurora_intake_item_invalid: Line 1: It needs a start date.', 'a missing start date is refused');
select throws_ok($$select app.apply_contract_intake((select id from world where key = 'prj_a'), jsonb_build_array(pg_temp.booking(array['c3'], 'cp_owls')))$$,
  'XR001', 'aurora_intake_item_invalid: Line 1: Only a contract or a rider can be added.', 'an Other document cannot be applied');
select throws_ok($$select app.apply_contract_intake((select id from world where key = 'prj_a'), jsonb_build_array(pg_temp.booking(array['c_other'], 'cp_owls')))$$,
  'XR001', 'aurora_intake_item_invalid: Line 1: A document was not read for this project.', 'a document read for another project is refused');
select throws_ok($$select app.apply_contract_intake((select id from world where key = 'prj_a'), jsonb_build_array(pg_temp.booking(array['c1'], 'cp_owls', jsonb_build_object('pay_basis', 'Flat Fee'))))$$,
  '23503', null, 'a rate card combination that does not exist is refused');
select throws_ok($$select app.apply_contract_intake((select id from world where key = 'prj_a'), jsonb_build_array(pg_temp.booking(array['c1'], 'cp_owls'), pg_temp.booking(array['c1'], 'cp_two')))$$,
  'XR001', 'aurora_intake_item_invalid: Line 2: A document is listed twice.', 'a document named twice is refused');
select pg_temp.as_platform();
select is((select count(*)::int from app.engagements where counterparty_id in (pg_temp.id('cp_owls'), pg_temp.id('cp_two'))), 0, 'no refusal left an engagement');

-- Booking -------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
create temporary table booked as
  select app.apply_contract_intake(pg_temp.id('prj_a'), jsonb_build_array(pg_temp.booking(array['c1', 'c2'], 'cp_owls', jsonb_build_object('create_riders', true)))) as r;
grant select on booked to public;
select pg_temp.as_platform();
select is((select engagement_state::text from app.engagements where counterparty_id = pg_temp.id('cp_owls')), 'Onboarding', 'one Artist engagement at Onboarding');
select is((select role_type::text from app.engagements where counterparty_id = pg_temp.id('cp_owls')), 'Artist', 'of role type Artist');
select is((select agreed_rate_minor from app.engagements where counterparty_id = pg_temp.id('cp_owls')), null::bigint, 'with no fee');
select is((select count(*)::int from app.engagement_documents d join app.engagements e on e.id = d.engagement_id where e.counterparty_id = pg_temp.id('cp_owls') and d.document_kind = 'Agreement' and d.engagement_document_state = 'Proposed'), 1, 'the contract is a Proposed Agreement');
select is((select count(*)::int from app.engagement_documents d join app.engagements e on e.id = d.engagement_id where e.counterparty_id = pg_temp.id('cp_owls') and d.document_kind = 'Rider'), 1, 'the rider is a Rider document');
select is((select count(*)::int from app.riders where counterparty_id = pg_temp.id('cp_owls') and title = 'Technical Rider'), 1, 'and a rider row');
select is((select suggestion_state::text from app.ai_suggestions where id = pg_temp.id('c1')), 'Applied', 'the document ends Applied');
select is((select jsonb_array_length(r -> 'engagements' -> 0 -> 'documents') from booked), 2, 'it answers each document''s row');
select ok((select (r -> 'engagements' -> 0 -> 'documents' -> 0 ->> 'engagement_document_id') is not null from booked), 'so a file can attach to it');
select is((select suggestion_state::text from app.ai_suggestions where id = pg_temp.id('c4')), 'Proposed', 'other documents stay open');

-- One live engagement takes the documents and ignores the fee.
select pg_temp.as_user('carol');
create temporary table attached as
  select app.apply_contract_intake(pg_temp.id('prj_a'), jsonb_build_array(pg_temp.booking(array['c4'], 'cp_owls'))) as r;
grant select on attached to public;
select pg_temp.as_platform();
select is((select count(*)::int from app.engagements where counterparty_id = pg_temp.id('cp_owls')), 1, 'a live engagement gets no second one');
select is((select (r -> 'engagements' -> 0 ->> 'created')::boolean from attached), false, 'it says it attached');

-- Two live engagements with none named.
select pg_temp.as_user('carol');
select app.apply_contract_intake(pg_temp.id('prj_a'), jsonb_build_array(pg_temp.booking(array['c5'], 'cp_two')));
insert into app.engagements (project_id, counterparty_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  select pg_temp.id('prj_a'), pg_temp.id('cp_two'), 'Artist', t ->> 'role_code', t ->> 'worker_classification', t ->> 'pay_basis', t ->> 'arrangement', '2027-07-01' from pg_temp.terms() t;
select throws_ok($$select app.apply_contract_intake((select id from world where key = 'prj_a'), jsonb_build_array(pg_temp.booking(array['c6'], 'cp_two')))$$,
  'XR001', 'aurora_intake_item_invalid: Line 1: This party has more than one live Artist engagement here. Choose one.', 'two live engagements with none named are refused');
select throws_ok($$select app.apply_contract_intake((select id from world where key = 'prj_a'), jsonb_build_array(pg_temp.booking(array['c6'], 'cp_two', jsonb_build_object('engagement_id', (select id from world where key = 'eng_art_a')))))$$,
  'XR001', 'aurora_intake_item_invalid: Line 1: That engagement is not a live engagement of this party on this project.', 'another party''s engagement is refused');

-- A payroll reader stores a fee on a Flat Fee row, which canon does not hold yet (a canon decision, ADR 0154).
select pg_temp.as_platform();
insert into xpms.rate_card (rate_card_id, role_code, worker_classification, pay_basis, arrangement, overtime_rule_id, source_row, source_status, source_created_by, source_created_at, source_updated_at, flag, currency_code)
  select 'LRC-999', t ->> 'role_code', t ->> 'worker_classification', 'Flat Fee', t ->> 'arrangement', (select rc.overtime_rule_id from xpms.rate_card rc limit 1), 999999, 'Active', 'pgTAP', now(), now(), false, 'USD' from pg_temp.terms() t;
select pg_temp.as_user('alice');
select pg_temp.request('r_alice', 'prj_a');
select pg_temp.document('a1', 'r_alice', 'Contract');
insert into world values ('cp_flat', app.create_counterparty(pg_temp.id('org_a'), 'Flat Fee Touring', null, null));
select lives_ok($$select app.apply_contract_intake((select id from world where key = 'prj_a'), jsonb_build_array(pg_temp.booking(array['a1'], 'cp_flat', jsonb_build_object('pay_basis', 'Flat Fee', 'agreed_rate_minor', 5000000, 'currency_code', 'USD'))))$$,
  'a fee can be stored on a Flat Fee row');
select pg_temp.as_platform();
select is((select agreed_rate_minor from app.engagements where counterparty_id = pg_temp.id('cp_flat')), 5000000::bigint, 'and it is');

-- Riders need their capability.
select pg_temp.as_user('alice');
select pg_temp.document('a2', 'r_alice', 'Rider');
select pg_temp.as_platform();
create temp table held_rider_write on commit drop as
  with gone as (delete from app.role_capabilities where capability_code = 'advancing.rider.write' returning role_id, capability_code, reach)
  select * from gone;
select pg_temp.as_user('alice');
select throws_ok($$select app.apply_contract_intake((select id from world where key = 'prj_a'), jsonb_build_array(pg_temp.booking(array['a2'], 'cp_flat', jsonb_build_object('create_riders', true))))$$,
  '42501', null, 'adding a rider needs advancing.rider.write');
select is((app.aurora_intake_scope('contract', pg_temp.id('prj_a')) ->> 'can_write_riders')::boolean, false, 'and the scope says so');

-- A contract's file is Restricted, which a download refuses without data.export.restricted.
select pg_temp.as_platform();
create temp table restricted_file on commit drop as select d.id as document_id from app.engagement_documents d join app.engagements e on e.id = d.engagement_id where e.counterparty_id = pg_temp.id('cp_flat') and d.document_kind = 'Agreement';
grant select on restricted_file to public;
select pg_temp.as_user('carol');
create temp table ticket as select * from app.begin_attachment_upload('app.engagement_documents', (select document_id from restricted_file), 'contract.pdf', 'application/pdf', 1000);
grant select on ticket to public;
insert into storage.objects (bucket_id, name, metadata) select 'attachments', object_name, '{"size": 1000}' from ticket;
select app.complete_attachment_upload((select attachment_version_id from ticket), repeat('ab', 32));
select lives_ok($$update app.attachments set classification = 'Restricted' where id = (select attachment_id from ticket)$$, 'a reader raises the contract''s file to Restricted');
select pg_temp.as_platform();
select app.record_attachment_scan((select attachment_version_id from ticket), true);
select pg_temp.as_user('carol');
select throws_like($$select app.record_file_download((select attachment_version_id from ticket))$$, '%download_restricted%', 'a download without data.export.restricted is refused');

select * from finish();
rollback;
