-- pgTAP: 2160, Gateway bulk actions on the person's own rows (A122, RRR-166, Section 11.7). Submitting timesheets, and
-- recalling them as the undo of a submit; signing documents; withdrawing applications. Each through 1451's driver: one
-- transaction, all or nothing, a preview that changes nothing, compare-and-set, the person's reach checked on every
-- row as the single action checks it, and refusals that name the row and its rule.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(44);

create temporary table answer (r jsonb);
grant all on answer to public;

create function pg_temp.rows(p_keys text[], p_field text, p_value text) returns jsonb
language sql as $$
  select jsonb_agg(jsonb_build_object('id', pg_temp.id(k), 'set', jsonb_build_object(p_field, p_value))) from unnest(p_keys) k;
$$;

create function pg_temp.bulk(p_resource text, p_rows jsonb, p_preview boolean default false) returns jsonb
language plpgsql as $$
begin
  return case p_resource
    when 'my_timesheets' then app.bulk_update_my_timesheets(p_rows, p_preview)
    when 'my_engagement_documents' then app.bulk_update_my_engagement_documents(p_rows, p_preview)
    when 'my_applications' then app.bulk_update_my_applications(p_rows, p_preview)
  end;
end $$;

create function pg_temp.refusal(p_who text, p_resource text, p_rows jsonb) returns text
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_who);
  v := pg_temp.bulk(p_resource, p_rows);
  perform pg_temp.as_platform();
  return v -> 'refused' -> 0 ->> 'rule';
end $$;

create function pg_temp.sheet(p_key text) returns text
language sql as $$ select timesheet_state::text from app.timesheets where id = pg_temp.id(p_key) $$;
create function pg_temp.doc(p_key text) returns text
language sql as $$ select engagement_document_state::text from app.engagement_documents where id = pg_temp.id(p_key) $$;
create function pg_temp.application(p_key text) returns text
language sql as $$ select application_state::text from app.applications where id = pg_temp.id(p_key) $$;

-- Fixtures ----------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_quinn_b', 'Onboarding', 'Active');
select pg_temp.as_user('carol');
with t as (insert into app.timesheets (project_id, engagement_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '2027-06-01', '2027-06-07') returning id) insert into world select 'ts1', id from t;
with t as (insert into app.timesheets (project_id, engagement_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '2027-06-08', '2027-06-14') returning id) insert into world select 'ts2', id from t;
with t as (insert into app.timesheets (project_id, engagement_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '2027-06-15', '2027-06-21') returning id) insert into world select 'ts3', id from t;
with d as (insert into app.engagement_documents (engagement_id, document_kind, title)
  values (pg_temp.id('eng_ivy_a'), 'Agreement', 'Crew Agreement') returning id) insert into world select 'd1', id from d;
with d as (insert into app.engagement_documents (engagement_id, document_kind, title)
  values (pg_temp.id('eng_ivy_a'), 'Non-Disclosure Agreement', 'Show NDA') returning id) insert into world select 'd2', id from d;
with d as (insert into app.engagement_documents (engagement_id, document_kind, title)
  values (pg_temp.id('eng_ivy_a'), 'Agreement', 'Draft Rider') returning id) insert into world select 'd3', id from d;
with d as (insert into app.engagement_documents (engagement_id, document_kind, title)
  values (pg_temp.id('eng_vendor_a'), 'Agreement', 'Audio Services Agreement') returning id) insert into world select 'd_v', id from d;
with d as (insert into app.engagement_documents (engagement_id, document_kind, title)
  values (pg_temp.id('eng_art_a'), 'Agreement', 'Headline Performance Agreement') returning id) insert into world select 'd_art', id from d;
with o as (insert into app.opportunities (project_id, role_type, role_code, title, visibility, starts_on, ends_on, requisition_id)
  values (pg_temp.id('prj_a'), 'Crew', '5000.51.02', 'Summer Series Riggers', 'Invited', '2027-06-01', '2027-06-03', pg_temp.id('requisition_a'))
  returning id) insert into world select 'opp1', id from o;
with o as (insert into app.opportunities (project_id, role_type, role_code, title, visibility, starts_on, ends_on, requisition_id)
  values (pg_temp.id('prj_a'), 'Crew', '5000.51.02', 'Summer Series Spotlights', 'Invited', '2027-06-04', '2027-06-05', pg_temp.id('requisition_a'))
  returning id) insert into world select 'opp2', id from o;
with o as (insert into app.opportunities (project_id, role_type, role_code, title, visibility, starts_on, ends_on, requisition_id)
  values (pg_temp.id('prj_a'), 'Crew', '5000.51.02', 'Summer Series Deck Hands', 'Invited', '2027-06-06', '2027-06-07', pg_temp.id('requisition_a'))
  returning id) insert into world select 'opp3', id from o;
insert into app.opportunity_invitations (opportunity_id, person_id)
select pg_temp.id(k), pg_temp.id('ivy') from unnest(array['opp1', 'opp2', 'opp3']) k;
select app.transition_opportunity(pg_temp.id(k), 'Draft', 'Pending Approval', 'Ready.') from unnest(array['opp1', 'opp2', 'opp3']) k;
select app.transition_opportunity(pg_temp.id(k), 'Pending Approval', 'Published', 'Approved.') from unnest(array['opp1', 'opp2', 'opp3']) k;
select pg_temp.as_user('xavier');
with t as (insert into app.timesheets (project_id, engagement_id, period_start, period_end)
  values (pg_temp.id('prj_b'), pg_temp.id('eng_quinn_b'), '2027-07-01', '2027-07-07') returning id) insert into world select 'ts_q', id from t;
with d as (insert into app.engagement_documents (engagement_id, document_kind, title)
  values (pg_temp.id('eng_quinn_b'), 'Agreement', 'Pier Nights Crew Agreement') returning id) insert into world select 'd_q', id from d;
select pg_temp.as_user('ivy');
with a as (insert into app.applications (opportunity_id, applicant_person_id, availability_confirmed)
  values (pg_temp.id('opp1'), pg_temp.id('ivy'), true) returning id) insert into world select 'a1', id from a;
with a as (insert into app.applications (opportunity_id, applicant_person_id, availability_confirmed)
  values (pg_temp.id('opp2'), pg_temp.id('ivy'), true) returning id) insert into world select 'a2', id from a;
with a as (insert into app.applications (opportunity_id, applicant_person_id, availability_confirmed)
  values (pg_temp.id('opp3'), pg_temp.id('ivy'), true) returning id) insert into world select 'a3', id from a;
select pg_temp.as_platform();
select private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state',
  'app.engagement_document_state_transitions', 'engagement_document_id', pg_temp.id(k), 'Proposed', 'Sent', 'Sent for signature.')
from unnest(array['d1', 'd2', 'd_v', 'd_art', 'd_q']) k;
select private.transition_lifecycle('application', 'app.applications', 'application_state', 'app.application_state_transitions',
  'application_id', pg_temp.id('a2'), s.f, s.t, 'Fixture move.')
from (values (1, 'Submitted', 'In Review'), (2, 'In Review', 'Offered')) s (n, f, t) order by s.n;

-- The resources -------------------------------------------------------------------------------------------------------
select is(
  (select array_agg(resource || ' ' || table_name || ' ' || row_function order by resource) from private.bulk_resources
   where resource like 'my\_%'),
  array['my_applications app.applications private.bulk_my_applications_row',
        'my_engagement_documents app.engagement_documents private.bulk_my_engagement_documents_row',
        'my_timesheets app.timesheets private.bulk_my_timesheets_row'],
  'the person''s timesheets, documents and applications change in bulk through 1451''s driver');
select ok(
  (select bool_and(has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
   from unnest(array['app.bulk_update_my_timesheets(jsonb, boolean, text)'::regprocedure,
                     'app.bulk_update_my_engagement_documents(jsonb, boolean, text)'::regprocedure,
                     'app.bulk_update_my_applications(jsonb, boolean, text)'::regprocedure]) f),
  'signed-in people call the bulk actions; anonymous callers cannot');
select ok(
  (select bool_and(p.prosecdef and not has_function_privilege('authenticated', p.oid, 'execute'))
   from pg_proc p where p.oid in ('private.bulk_my_timesheets_row(uuid, jsonb, jsonb, text)'::regprocedure,
     'private.bulk_my_engagement_documents_row(uuid, jsonb, jsonb, text)'::regprocedure,
     'private.bulk_my_applications_row(uuid, jsonb, jsonb, text)'::regprocedure)),
  'the row functions run with owner rights and only through the driver');
select pg_temp.as_anon();
select throws_ok($$select app.bulk_update_my_timesheets('[]'::jsonb)$$, '42501', null, 'anon cannot call a Gateway bulk action');
select pg_temp.as_platform();

-- Timesheets: submit, preview, undo by recall, redo ----------------------------------------------------------------------
select pg_temp.as_user('ivy');
insert into answer select pg_temp.bulk('my_timesheets', pg_temp.rows(array['ts1', 'ts2'], 'timesheet_state', 'Submitted'), true);
select is((select (r ->> 'changed')::int from answer), 2, 'a preview counts the timesheets a submit would change');
select is((select r ->> 'committed' from answer), 'false', 'and commits nothing');
select is(pg_temp.sheet('ts1'), 'Proposed', 'so the timesheet is still a draft');

delete from answer;
insert into answer select pg_temp.bulk('my_timesheets', pg_temp.rows(array['ts1', 'ts2'], 'timesheet_state', 'Submitted'));
select is((select r ->> 'committed' from answer), 'true', 'the engaged person submits two of their own timesheets in one call');
select is(pg_temp.sheet('ts1') || ' ' || pg_temp.sheet('ts2'), 'Submitted Submitted', 'both are submitted');
select is((select submitted_by from app.timesheets where id = pg_temp.id('ts1')), pg_temp.id('ivy'),
  'through app.submit_timesheet, which records the submitter');
select is((select r -> 'inverse' -> 0 -> 'set' ->> 'timesheet_state' from answer), 'Proposed', 'the inverse of a submit is a recall to draft');
select is((select r -> 'inverse' -> 0 -> 'expect' ->> 'timesheet_state' from answer), 'Submitted', 'expecting the timesheet still submitted');

select is(
  (select r ->> 'committed' from (select pg_temp.bulk('my_timesheets', (select r -> 'inverse' from answer)) r) x),
  'true', 'sending the inverse back undoes the submit');
select is(pg_temp.sheet('ts1') || ' ' || pg_temp.sheet('ts2'), 'Proposed Proposed', 'both timesheets are drafts again');
select is((select count(*)::int from app.timesheet_state_transitions where timesheet_id = pg_temp.id('ts1')
           and from_state = 'Submitted' and to_state = 'Proposed' and reason = 'Recalled from Gateway.'), 1,
  'the recall is in the timesheet''s ledger');
select is(
  (select r ->> 'committed' from (select pg_temp.bulk('my_timesheets',
    (select jsonb_agg(jsonb_build_object('id', i -> 'id', 'set', i -> 'expect', 'expect', i -> 'set')) from answer, jsonb_array_elements(r -> 'inverse') i)) r) x),
  'true', 'and redo submits them again');
select pg_temp.as_platform();

select pg_temp.as_user('carol');
select app.decide_timesheet(pg_temp.id('ts2'), 'Rejected', 'Missing the Friday call.');
select pg_temp.as_user('ivy');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('my_timesheets', (select r -> 'inverse' from answer)) r) x),
  'bulk_stale', 'once an approver decided, the undo is refused, never silently overwriting the decision');
select is(pg_temp.sheet('ts1'), 'Submitted', 'and nothing changed: the other row of the call stays submitted');

delete from answer;
insert into answer select pg_temp.bulk('my_timesheets', pg_temp.rows(array['ts2'], 'timesheet_state', 'Submitted'));
select is(pg_temp.sheet('ts2'), 'Submitted', 'a rejected timesheet is submitted again');
select is((select r -> 'inverse' -> 0 -> 'set' ->> 'timesheet_state' from answer), 'Proposed',
  'and its undo recalls it to draft, not back to the approver''s Rejected');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('my_timesheets', pg_temp.rows(array['ts1'], 'timesheet_state', 'Approved')) r) x),
  'bulk_field_not_editable', 'a person never approves their own timesheet in bulk');
select pg_temp.as_platform();

select pg_temp.as_user('carol');
select app.submit_timesheet(pg_temp.id('ts3'), 'Submitted for Ivy.');
select pg_temp.as_platform();
select is(pg_temp.refusal('ivy', 'my_timesheets', pg_temp.rows(array['ts3'], 'timesheet_state', 'Proposed')), 'timesheet_recall_not_submitter',
  'only the person who submitted a timesheet recalls it');
select is(pg_temp.refusal('quinn', 'my_timesheets', pg_temp.rows(array['ts1'], 'timesheet_state', 'Proposed')), 'bulk_row_not_found',
  'another freelancer''s timesheets read as not found');
select is(pg_temp.refusal('ivy', 'my_timesheets', pg_temp.rows(array['ts_q'], 'timesheet_state', 'Submitted')), 'bulk_row_not_found',
  'and so do theirs to Ivy');
select is(pg_temp.refusal('carol', 'my_timesheets', pg_temp.rows(array['ts1'], 'timesheet_state', 'Proposed')), 'bulk_row_not_found',
  'an org member uses Atlas, not the engaged person''s own actions');

-- Documents: sign in bulk; a signature is final ------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select is(
  (select r ->> 'changed' from (select pg_temp.bulk('my_engagement_documents', pg_temp.rows(array['d1', 'd2'], 'engagement_document_state', 'Signed'), true) r) x),
  '2', 'a preview counts the documents a signature would change');
select is(pg_temp.doc('d1'), 'Sent', 'and signs nothing');
delete from answer;
insert into answer select pg_temp.bulk('my_engagement_documents', pg_temp.rows(array['d1', 'd2'], 'engagement_document_state', 'Signed'));
select is((select r ->> 'committed' from answer), 'true', 'the engaged person signs two documents in one call');
select is(pg_temp.doc('d1') || ' ' || pg_temp.doc('d2'), 'Signed Signed', 'both are signed');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('my_engagement_documents', (select r -> 'inverse' from answer)) r) x),
  'bulk_field_not_editable', 'a signature cannot be undone');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('my_engagement_documents', pg_temp.rows(array['d3'], 'engagement_document_state', 'Signed')) r) x),
  'document_not_awaiting_signature', 'a document not sent for signature cannot be signed');
select pg_temp.as_platform();
select is(
  (select (diff ->> 'rows')::int from app.audit_events where org_id = pg_temp.id('org_a') and action = 'my_engagement_documents.bulk_update'
   and actor_person_id = pg_temp.id('ivy')),
  2, 'the org''s audit ledger records the bulk signature once, by Ivy, with its row count');
select is(pg_temp.refusal('fiona', 'my_engagement_documents', pg_temp.rows(array['d_v'], 'engagement_document_state', 'Signed')), null,
  'the engaged account''s Finance member signs its documents, in bulk as on their own');
select is(pg_temp.doc('d_v'), 'Signed', 'so the account''s agreement is signed');
select is(pg_temp.refusal('rita', 'my_engagement_documents', pg_temp.rows(array['d_art'], 'engagement_document_state', 'Signed')), null,
  'and an artist''s representative with the Documents scope signs the artist''s');
select is(pg_temp.refusal('ivy', 'my_engagement_documents', pg_temp.rows(array['d_q'], 'engagement_document_state', 'Signed')), 'bulk_row_not_found',
  'another freelancer''s documents read as not found');

-- Applications: withdraw in bulk; offers are answered on their own -------------------------------------------------------------
select pg_temp.as_user('ivy');
delete from answer;
insert into answer select pg_temp.bulk('my_applications', pg_temp.rows(array['a1', 'a2'], 'application_state', 'Withdrawn'));
select is((select r ->> 'committed' from answer), 'false', 'a selection holding an offered application withdraws nothing');
select is((select r -> 'refused' -> 0 ->> 'id' from answer), pg_temp.id('a2')::text, 'the refusal names the offered application');
select is((select r -> 'refused' -> 0 ->> 'rule' from answer), 'application_offered', 'whose offer is answered on its own');
select is(pg_temp.application('a1'), 'Submitted', 'so the other application is still open');
select is(
  (select r ->> 'committed' from (select pg_temp.bulk('my_applications', pg_temp.rows(array['a1', 'a3'], 'application_state', 'Withdrawn')) r) x),
  'true', 'without it, two applications are withdrawn in one call');
select is(pg_temp.application('a1') || ' ' || pg_temp.application('a3'), 'Withdrawn Withdrawn', 'both are withdrawn');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('my_applications', pg_temp.rows(array['a2'], 'application_state', 'Accepted')) r) x),
  'bulk_field_not_editable', 'accepting an offer is never a bulk action');
select pg_temp.as_platform();
select is(pg_temp.refusal('quinn', 'my_applications', pg_temp.rows(array['a2'], 'application_state', 'Withdrawn')), 'bulk_row_not_found',
  'another person''s applications read as not found');

select * from finish();
rollback;
