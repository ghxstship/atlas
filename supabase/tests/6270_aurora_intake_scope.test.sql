-- pgTAP: Aurora intake scope and Restricted fees (B15, RRR-239, migration 6270; ADR 0154 D2). The scope needs each kind's
-- capability on the project with membership in its org; a fee and its currency are stored only for a payroll reader, whom
-- the read policy alone lets read them; other audit readers read the suggestion and not its fee.
-- World: 0700_engagement_world (alice owner with payroll, bob admin with audit.log.read and no payroll, carol manager
-- without payroll, gina viewer).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

select pg_temp.as_user('bob');
insert into app.ai_settings (org_id, extraction_enabled) values (pg_temp.id('org_a'), true);

-- Scope ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select is((app.aurora_intake_scope('contract', pg_temp.id('prj_a')) ->> 'fee_visible')::boolean, true, 'a payroll reader is asked for a fee');
select is((app.aurora_intake_scope('contract', pg_temp.id('prj_a')) ->> 'can_write_riders')::boolean, true, 'and may add riders');
select is((app.aurora_intake_scope('itinerary', pg_temp.id('prj_a')) ->> 'project_id')::uuid, pg_temp.id('prj_a'), 'an itinerary answers the project');
select is((app.aurora_intake_scope('governance', pg_temp.id('prj_a')) ->> 'project_id')::uuid, pg_temp.id('prj_a'), 'a governance draft answers the project');
select pg_temp.as_user('carol');
select is((app.aurora_intake_scope('contract', pg_temp.id('prj_a')) ->> 'fee_visible')::boolean, false, 'a manager without payroll is not');
select pg_temp.as_user('gina');
select throws_ok($$select app.aurora_intake_scope('itinerary', (select id from world where key = 'prj_a'))$$, '42501', null, 'a viewer cannot read itineraries in');
select throws_ok($$select app.aurora_intake_scope('contract', (select id from world where key = 'prj_a'))$$, '42501', null, 'nor contracts');
select throws_ok($$select app.aurora_intake_scope('governance', (select id from world where key = 'prj_a'))$$, '42501', null, 'nor draft governance documents');
select pg_temp.as_user('alice');
select throws_ok($$select app.aurora_intake_scope('itinerary', (select id from world where key = 'prj_b'))$$, '42501', null, 'another org''s project is refused');
select throws_ok($$select app.aurora_intake_scope('nothing', (select id from world where key = 'prj_a'))$$, 'XR001', 'aurora_intake_kind: Aurora has no intake of this kind.', 'an unknown kind is refused');

-- Fees ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into world values ('r_alice', app.ai_begin_request(pg_temp.id('org_a'), 'extraction', 'claude-sonnet-5-5', 'app.projects', pg_temp.id('prj_a')));
select app.ai_complete_request(pg_temp.id('r_alice'), 'Answered', 'Read the contract.', 'Read 3 of 3 fields from one document.', 100, 40);
insert into world values ('s_fee', app.ai_propose_suggestion(pg_temp.id('r_alice'), 'engagements.createFromContract', null, 'Book from the contract.',
  '[{"field_path": "act_name", "value": "The Midnight Owls", "confidence": 0.9},
    {"field_path": "agreed_rate_minor", "value": 750000, "confidence": 0.9, "source_excerpt": "Guarantee: USD 7,500"},
    {"field_path": "agreed_rate_currency_code", "value": "USD", "confidence": 0.9, "source_excerpt": "Guarantee: USD 7,500"}]'));
select is(pg_temp.n('alice', 'select 1 from app.ai_suggestion_fields where suggestion_id = (select id from world where key = ''s_fee'')'), 3, 'the payroll reader reads the fee and its currency');
select is(pg_temp.n('bob', 'select 1 from app.ai_suggestions where id = (select id from world where key = ''s_fee'')'), 1, 'an audit reader without payroll reads the suggestion');
select is(pg_temp.n('bob', 'select 1 from app.ai_suggestion_fields where suggestion_id = (select id from world where key = ''s_fee'')'), 1, 'and no fee row');
select is(pg_temp.n('bob', 'select 1 from app.ai_suggestion_fields where suggestion_id = (select id from world where key = ''s_fee'') and field_path like ''agreed_rate%'''), 0, 'neither the fee nor its currency');

select pg_temp.as_user('carol');
insert into world values ('r_carol', app.ai_begin_request(pg_temp.id('org_a'), 'extraction', 'claude-sonnet-5-5', 'app.projects', pg_temp.id('prj_a')));
select app.ai_complete_request(pg_temp.id('r_carol'), 'Answered', 'Read the contract.', 'Read 1 of 1 fields from one document.', 100, 40);
select throws_ok($$select app.ai_propose_suggestion((select id from world where key = 'r_carol'), 'engagements.createFromContract', null, 'Book.',
  '[{"field_path": "agreed_rate_minor", "value": 750000, "confidence": 0.9}]')$$,
  'XR001', 'ai_field_restricted: A fee is proposed only to someone who may read pay.', 'the trigger refuses a fee without payroll');
select throws_ok($$select app.ai_propose_suggestion((select id from world where key = 'r_carol'), 'engagements.createFromContract', null, 'Book.',
  '[{"field_path": "agreed_rate_currency_code", "value": "USD", "confidence": 0.9}]')$$,
  'XR001', 'ai_field_restricted: A fee is proposed only to someone who may read pay.', 'and its currency');

select * from finish();
rollback;
