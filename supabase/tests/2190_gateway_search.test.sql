-- pgTAP: migration 2190, Gateway search (A126, RRR-171, Section 11.10 item 1, trace S11.10-02, ADR 0088). The search
-- is the signed-in person's own: their engagements, the documents and threads of those engagements, the org-level
-- conversations they are the party of, and opportunities they applied to or that are open to them in an org they work
-- with. Another party, an org member with no external relationship, anon and an org they have no relationship with
-- get nothing; a custom domain's org keeps its own rows only; words, phrases, exclusions and types narrow it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(23);

-- The results a person gets, as type:title, sorted.
create function pg_temp.found(p_who text, p_query jsonb, p_org text default null) returns text
language plpgsql as $$
declare
  v text;
begin
  perform pg_temp.as_user(p_who);
  select string_agg(g.result_type || ':' || coalesce(g.title, g.detail), ',' order by g.result_type, coalesce(g.title, g.detail)) into v
  from app.gateway_search(p_query, case when p_org is null then null else pg_temp.id(p_org) end, 25) g;
  perform pg_temp.as_platform();
  return coalesce(v, '');
end $$;

-- World: ivy works for org_a (prj_a) and org_b (prj_b); quinn for org_b only. Each has an agreement and a thread; org_a
-- also talks to ivy in an org-level conversation and posts a Public opportunity. ------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_ivy_b', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_quinn_b', 'Onboarding', 'Active');

select pg_temp.as_user('alice');
insert into app.engagement_documents (engagement_id, document_kind, title) values (pg_temp.id('eng_ivy_a'), 'Agreement', 'Pier Rigging Agreement');
with t as (insert into app.engagement_threads (engagement_id, subject) values (pg_temp.id('eng_ivy_a'), 'Load In Plan') returning id)
  insert into world select 'thread_ivy', id from t;
insert into app.engagement_messages (engagement_thread_id, body) values
  (pg_temp.id('thread_ivy'), 'Bring the chain motors to the pier gate.'),
  (pg_temp.id('thread_ivy'), 'Pier parking is on the north lot.');
-- Northwind lists itself publicly (gateway.marketplace_visibility, 1327), so its Public opportunity reaches quinn's marketplace.
select app.set_setting(pg_temp.id('org_a'), 'gateway.marketplace_visibility', 'Organization', pg_temp.id('org_a'), p_value_text => 'public');
select pg_temp.as_user('carol');
select app.start_party_thread(pg_temp.id('org_a'), pg_temp.id('ivy'), null, 'Autumn Series', 'Are you free for the autumn rigging calls?');
insert into app.opportunities (project_id, role_type, role_code, title, description, visibility, rate_type, pay_min_minor, pay_max_minor,
  currency_code, deadline_at, starts_on, ends_on, requisition_id)
values (pg_temp.id('prj_a'), 'Crew', '5000.51.02', 'Rigging Lead Crew Call', 'Lead the flying crew for the season.', 'Public', 'Day',
  80000, 95000, 'USD', now() + interval '7 days', '2027-06-01', '2027-06-03', pg_temp.id('requisition_a'))
returning id \gset opp_
select app.transition_opportunity(:'opp_id', 'Draft', 'Pending Approval', 'Ready for approval.');
select app.transition_opportunity(:'opp_id', 'Pending Approval', 'Published', 'Approved.');

select pg_temp.as_user('xavier');
insert into app.engagement_documents (engagement_id, document_kind, title) values (pg_temp.id('eng_quinn_b'), 'Agreement', 'Harbor Rigging Agreement');
with t as (insert into app.engagement_threads (engagement_id, subject) values (pg_temp.id('eng_quinn_b'), 'Rigging Notes') returning id)
  insert into world select 'thread_quinn', id from t;
insert into app.engagement_messages (engagement_thread_id, body) values (pg_temp.id('thread_quinn'), 'Chain motors arrive at noon.');
select pg_temp.as_platform();

-- Shape and grants ------------------------------------------------------------------------------------------------------
select ok((select prosecdef from pg_proc where oid = 'app.gateway_search(jsonb, uuid, integer)'::regprocedure),
  'app.gateway_search is SECURITY DEFINER: external parties read these rows only through Section 8.7 projections');
select ok(not has_function_privilege('anon', 'app.gateway_search(jsonb, uuid, integer)', 'EXECUTE'), 'anon cannot run the search');
select pg_temp.as_anon();
select throws_ok($$select * from app.gateway_search('{"terms": ["rigging"]}')$$, '42501', null, 'anon is refused');
select pg_temp.as_platform();
select is((select count(*)::int from app.gateway_search('{"terms": ["rigging"]}')), 0, 'no signed-in person, no results');

-- The person's own rows -------------------------------------------------------------------------------------------------
select is(pg_temp.found('ivy', '{"terms": ["rigging"]}'),
  'document:Pier Rigging Agreement,message:Autumn Series,opportunity:Rigging Lead Crew Call',
  'ivy finds her agreement, her conversation with org_a and org_a''s open opportunity, never quinn''s agreement or thread');
select pg_temp.as_user('quinn');
select ok(exists (select 1 from api_external.opportunities o where o.id = :'opp_id'::uuid),
  'org_a''s Public opportunity is open to quinn in the marketplace');
select pg_temp.as_platform();
select is(pg_temp.found('quinn', '{"terms": ["rigging"]}'),
  'document:Harbor Rigging Agreement,message:Rigging Notes',
  'quinn finds his own, and no opportunity of org_a, an org he has no relationship with');
select is(pg_temp.found('quinn', '{"terms": ["chain"]}'), 'message:Rigging Notes', 'denial: ivy''s message about chain motors stays hers');
select is(pg_temp.found('alice', '{"terms": ["rigging"]}'), '',
  'an org Admin with no external relationship gets nothing here: staff search the org in Atlas');
select is(pg_temp.found('victor', '{"terms": ["rigging"]}'), 'opportunity:Rigging Lead Crew Call',
  'victor''s account supplies org_a, so he finds its open opportunity and none of ivy''s documents or conversations');

-- Messages ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select is((select detail from app.gateway_search('{"terms": ["chain", "motors"]}') where result_type = 'message'),
  'Bring the chain motors to the pier gate.', 'a message result carries the message that matched');
select is((select result_id from app.gateway_search('{"terms": ["chain"]}') where result_type = 'message'),
  pg_temp.id('thread_ivy'), 'and opens its thread');
select is((select count(*)::int from app.gateway_search('{"terms": ["pier"]}') where result_type = 'message'), 1,
  'a thread whose two messages match is one result');
select is((select kind from app.gateway_search('{"terms": ["autumn"]}') where result_type = 'message'), 'party',
  'an org-level conversation is found too, and says so');
select pg_temp.as_platform();

-- Engagements and documents -------------------------------------------------------------------------------------------------
select is(pg_temp.found('ivy', '{"terms": ["summer"]}'), 'engagement:' || (select job_title from xpms.role where role_code = '5000.51.02'),
  'an engagement is found by its project''s name');
select pg_temp.as_user('ivy');
select is((select parent_id from app.gateway_search('{"terms": ["agreement"]}') where result_type = 'document'),
  pg_temp.id('eng_ivy_a'), 'a document names its engagement, where Gateway opens it');
select pg_temp.as_platform();

-- The request's grammar --------------------------------------------------------------------------------------------------
select is(pg_temp.found('ivy', '{"terms": ["agree"]}'), 'document:Pier Rigging Agreement', 'each word is also a prefix');
select is(pg_temp.found('ivy', '{"phrases": ["pier gate"]}'), 'message:Load In Plan', 'a quoted phrase matches in order');
select is(pg_temp.found('ivy', '{"terms": ["rigging"], "exclude_terms": ["autumn"]}'),
  'document:Pier Rigging Agreement,opportunity:Rigging Lead Crew Call', 'an excluded word drops what holds it');
select is(pg_temp.found('ivy', '{"terms": ["rigging"], "types": ["document"]}'), 'document:Pier Rigging Agreement', 'a type narrows it');
select is(pg_temp.found('ivy', '{}'), '', 'a request with no words returns nothing');
select is(pg_temp.found('ivy', '{"terms": ["''):*|!"]}'), '', 'punctuation never reaches the tsquery syntax');

-- A custom domain keeps its org's rows only --------------------------------------------------------------------------------
select is(pg_temp.found('ivy', '{"terms": ["rigging"]}', 'org_b'), '', 'on org_b''s domain, org_a''s rows never show');

select * from finish();
rollback;
