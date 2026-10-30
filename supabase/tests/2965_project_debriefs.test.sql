-- pgTAP: migration 2965 (B7, RRR-231, ADR 0146 decisions 5 and 6; G-267), project debriefs. One live debrief per
-- project; points with an owner for Actions only; the management summary's read gate; the Aurora request guard (another
-- person, project, feature or an unanswered request) and the flag that outlives the request; the stamps; complete and
-- reopen and the lock they set on points and the summary, a restore from Trash included; the direct writes refused;
-- app.my_capabilities_on_project with the two wrap-up reads; and Trash.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update on k to public;

-- Aurora requests: dave's answered wrap-up summary of NWL, and the ones the guard refuses.
select pg_temp.as_platform();
insert into app.ai_requests (id, org_id, person_id, feature, model, subject_table, subject_id, outcome, completed_at)
select gen_random_uuid(), pg_temp.id('org_a'), pg_temp.id(v.who), v.feature::app.ai_feature, 'claude-sonnet-5-5', 'app.projects',
  pg_temp.id(v.project), v.outcome::app.ai_request_outcome, now()
from (values ('dave', 'summaries', 'prj_a', 'Answered'), ('erin', 'summaries', 'prj_a', 'Answered'), ('dave', 'summaries', 'prj_a2', 'Answered'),
  ('dave', 'drafting', 'prj_a', 'Answered'), ('dave', 'summaries', 'prj_a', 'No Answer')) v (who, feature, project, outcome);
insert into k (key, id) select case
    when r.person_id = pg_temp.id('erin') then 'req_erin'
    when r.subject_id = pg_temp.id('prj_a2') then 'req_other_project'
    when r.feature = 'drafting' then 'req_drafting'
    when r.outcome = 'No Answer' then 'req_no_answer'
    else 'req' end, r.id
from app.ai_requests r where r.org_id = pg_temp.id('org_a') and r.model = 'claude-sonnet-5-5';

-- The debrief -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into k (key, id) select 'debrief', app.save_project_debrief(pg_temp.id('prj_a'));
select is(app.save_project_debrief(pg_temp.id('prj_a')), (select id from k where key = 'debrief'), 'a project has one live debrief');
select is((select count(*)::int from app.project_debrief_summaries), 0, 'saving without a summary writes none');
select throws_ok(format($$insert into app.project_debriefs (project_id) values (%L)$$, pg_temp.id('prj_a2')), '42501', null,
  'a debrief is never inserted directly');
select throws_ok(format($$update app.project_debriefs set completed_at = now() where id = %L$$, (select id from k where key = 'debrief')), '42501', null,
  'nor completed directly');
select pg_temp.as_user('gina');
select throws_ok(format($$select app.save_project_debrief(%L)$$, pg_temp.id('prj_a')), '42501', 'project not found',
  'a reader without projects.project.write cannot start one');

-- Points ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into app.project_debrief_items (debrief_id, area, item_kind, body)
values ((select id from k where key = 'debrief'), 'Schedule', 'Went Well', 'Load-in finished an hour early.');
insert into app.project_debrief_items (debrief_id, area, item_kind, body, owner_membership_id)
values ((select id from k where key = 'debrief'), 'Safety', 'Action', 'Add a second spotter on the truss.', pg_temp.id('erin@org_a'));
select is((select array_agg(position order by position) from app.project_debrief_items where debrief_id = (select id from k where key = 'debrief')),
  array[1, 2], 'a point without a position takes the next one');
select is((select org_id from app.project_debrief_items limit 1), pg_temp.id('org_a'), 'a point takes its debrief''s org');
select throws_ok(format($$insert into app.project_debrief_items (debrief_id, area, item_kind, body, owner_membership_id) values (%L, 'Crew', 'To Improve', 'Earlier call.', %L)$$,
  (select id from k where key = 'debrief'), pg_temp.id('erin@org_a')), '23514', null, 'only an Action has an owner');
select throws_ok(format($$insert into app.project_debrief_items (debrief_id, area, item_kind, body) values (%L, 'Crew', 'To Improve', repeat('x', 2001))$$,
  (select id from k where key = 'debrief')), '23514', null, 'a point has at most 2000 characters');
select throws_ok(format($$insert into app.project_debrief_items (debrief_id, area, item_kind, body, owner_membership_id) values (%L, 'Crew', 'Action', 'Call it.', %L)$$,
  (select id from k where key = 'debrief'), pg_temp.id('xavier@org_b')), 'XR001', null, 'an Action''s owner is a member of the org');

-- The management summary ------------------------------------------------------------------------------------------------------------
select throws_ok(format($$select app.save_project_debrief(%L, 'Delivered on budget.', %L)$$, pg_temp.id('prj_a'), (select id from k where key = 'req_erin')),
  'XR001', 'debrief_ai_request: Save a summary Aurora drafted for this project at your request.', 'another person''s request is refused');
select throws_ok(format($$select app.save_project_debrief(%L, 'Delivered on budget.', %L)$$, pg_temp.id('prj_a'), (select id from k where key = 'req_other_project')),
  'XR001', null, 'another project''s request is refused');
select throws_ok(format($$select app.save_project_debrief(%L, 'Delivered on budget.', %L)$$, pg_temp.id('prj_a'), (select id from k where key = 'req_drafting')),
  'XR001', null, 'another feature''s request is refused');
select throws_ok(format($$select app.save_project_debrief(%L, 'Delivered on budget.', %L)$$, pg_temp.id('prj_a'), (select id from k where key = 'req_no_answer')),
  'XR001', null, 'a request Aurora did not answer is refused');
select throws_ok(format($$select app.save_project_debrief(%L, repeat('x', 4001))$$, pg_temp.id('prj_a')),
  'XR001', 'debrief_summary: Write a management summary of up to 4000 characters.', 'a summary has at most 4000 characters');
select lives_ok(format($$select app.save_project_debrief(%L, '  Delivered on budget; attendance 9,800. ', %L)$$, pg_temp.id('prj_a'), (select id from k where key = 'req')),
  'a reviewed Aurora draft is saved with its request');
select is((select row(management_summary, management_summary_ai_request_id, ai_drafted, summary_by)::text from app.project_debrief_summaries),
  row('Delivered on budget; attendance 9,800.', (select id from k where key = 'req'), true, pg_temp.id('dave'))::text,
  'it is linked to the request, flagged, and stamped with its reviewer');
select throws_ok(format($$update app.project_debrief_summaries set management_summary = 'Edited' where debrief_id = %L$$, (select id from k where key = 'debrief')),
  '42501', null, 'a summary is never edited directly');

-- The read gate: dave reads every source of the summary; erin (no budget or ledger) does not.
select is((select count(*)::int from app.project_debrief_summaries), 1, 'a reader of budget, gates, incidents and the ledger reads the summary');
select pg_temp.as_user('erin');
select is((select count(*)::int from app.project_debriefs), 1, 'a project reader reads the debrief');
select is((select count(*)::int from app.project_debrief_items), 2, 'and its points');
select is((select count(*)::int from app.project_debrief_summaries), 0, 'but not a summary drafted from budget facts they cannot read');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.project_debriefs), 0, 'another org reads no debrief');

-- The flag outlives the request row (purged by age, 0650), and a save without a request clears it.
select pg_temp.as_platform();
delete from app.ai_requests where id = (select id from k where key = 'req');
select is((select row(management_summary_ai_request_id, ai_drafted)::text from app.project_debrief_summaries),
  row(null::uuid, true)::text, 'purging the request clears the link and keeps the Aurora flag');
select pg_temp.as_user('dave');
select app.save_project_debrief(pg_temp.id('prj_a'), 'Delivered on budget; attendance 9,800 and two incidents.');
select is((select row(management_summary_ai_request_id, ai_drafted)::text from app.project_debrief_summaries where deleted_at is null),
  row(null::uuid, false)::text, 'a summary saved without a request is the saver''s own writing');

-- Complete and reopen ---------------------------------------------------------------------------------------------------------------
select lives_ok(format($$select app.complete_project_debrief(%L)$$, (select id from k where key = 'debrief')), 'a writer completes the debrief');
select is((select row(completed_by, completed_at is not null)::text from app.project_debriefs where id = (select id from k where key = 'debrief')),
  row(pg_temp.id('dave'), true)::text, 'completion is stamped with who and when');
select throws_ok(format($$select app.complete_project_debrief(%L)$$, (select id from k where key = 'debrief')),
  'XR001', 'debrief_completed: This debrief is already completed.', 'and stamped once');
select throws_ok(format($$insert into app.project_debrief_items (debrief_id, area, item_kind, body) values (%L, 'Other', 'To Improve', 'Late.')$$,
  (select id from k where key = 'debrief')), 'XR001', 'debrief_completed: This debrief is completed. Reopen it to change its points.', 'a completed debrief takes no new point');
select throws_ok(format($$update app.project_debrief_items set body = 'Changed' where debrief_id = %L$$, (select id from k where key = 'debrief')),
  'XR001', null, 'nor a changed one');
select throws_ok(format($$update app.project_debrief_items set deleted_at = now() where debrief_id = %L$$, (select id from k where key = 'debrief')),
  'XR001', null, 'nor a deleted one');
select throws_ok(format($$select app.save_project_debrief(%L, 'After the fact.')$$, pg_temp.id('prj_a')),
  'XR001', 'debrief_completed: This debrief is completed. Reopen it to change its summary.', 'nor a new summary');
select lives_ok(format($$select app.reopen_project_debrief(%L)$$, (select id from k where key = 'debrief')), 'a writer reopens it');
select is((select completed_at from app.project_debriefs where id = (select id from k where key = 'debrief')), null::timestamptz, 'which clears completion');
select pg_temp.as_platform();
select ok((select count(*) from app.audit_events e where e.subject_table = 'app.project_debriefs'
  and e.subject_id = (select id from k where key = 'debrief')) >= 3, 'the audit trail records the start, the completion and the reopening');
select pg_temp.as_user('dave');

-- A deleted point is in Trash, and never comes back under a completed debrief.
update app.project_debrief_items set deleted_at = now() where position = 1 and debrief_id = (select id from k where key = 'debrief');
select is((select title from app.trash_items where subject_table = 'project_debrief_items'), 'Load-in finished an hour early.', 'a deleted point is in Trash, titled by its text');
select app.complete_project_debrief((select id from k where key = 'debrief'));
select throws_ok(format($$select app.restore_trash_item('project_debrief_items', %L)$$, (select subject_id from app.trash_items where subject_table = 'project_debrief_items')),
  'XR001', null, 'a point is not restored under a completed debrief');
select app.reopen_project_debrief((select id from k where key = 'debrief'));
select is(app.restore_trash_item('project_debrief_items', (select subject_id from app.trash_items where subject_table = 'project_debrief_items')), 1,
  'once reopened it is');

-- Which wrap-up sections a reader gets ----------------------------------------------------------------------------------------------
select is(app.my_capabilities_on_project(pg_temp.id('prj_a'), array['finance.budget.read', 'projects.gate.read', 'safety.incident.read']),
  array['finance.budget.read', 'projects.gate.read', 'safety.incident.read'], 'a holder gets the two new reads with the safety read');
select ok('credentials.credential.read' = any (app.my_capabilities_on_project(pg_temp.id('prj_a'), array['credentials.credential.read', 'org.members.manage'])),
  'credentials codes are still answered');
select is(app.my_capabilities_on_project(pg_temp.id('prj_a'), array['org.members.manage', 'finance.journal.read']), '{}'::text[],
  'other codes, the ledger included, are still not');
select pg_temp.as_user('erin');
select is(app.my_capabilities_on_project(pg_temp.id('prj_a'), array['finance.budget.read', 'projects.gate.read']), array['projects.gate.read'],
  'only to holders: a collaborator reads gates, not budgets');
select pg_temp.as_user('xavier');
select is(app.my_capabilities_on_project(pg_temp.id('prj_a'), array['finance.budget.read', 'projects.gate.read']), '{}'::text[], 'another org gets none');

-- Trash (ADR 0110) --------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select ok(exists (select 1 from private.trash_tables where table_name = 'project_debrief_items' and title_column = 'body'), 'points are in Trash, titled by body');
select ok(exists (select 1 from private.trash_excluded_tables where table_name = 'project_debriefs'), 'a debrief is kept out of Trash');
select ok((select count(*) from private.retention_policies where table_name in ('app.project_debriefs', 'app.project_debrief_items', 'app.project_debrief_summaries')) = 3,
  'every debrief table carries a retention policy');
select is(private.sync_trash_tables(), 0, 'the sync has nothing left to add (2390)');

select * from finish();
rollback;
