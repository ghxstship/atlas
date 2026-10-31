-- pgTAP: 2290, application question templates and opportunity defaults (A136, RRR-199, Section 4.5.6 item 27). A
-- marketplace manager keeps an org's reusable question sets and the defaults new opportunities start from; everyone
-- who creates postings reads them; nobody outside the org reads or writes them. Applying a template copies its
-- questions into a Draft opportunity, after the ones it has, as the opportunity's own rows.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(36);

create function pg_temp.questions(p_key text) returns text
language sql as $$
  select string_agg(q.sort_order || ':' || q.prompt || case when q.is_required then '*' else '' end, ' | ' order by q.sort_order)
  from app.opportunity_questions q where q.opportunity_id = pg_temp.id(p_key) and q.deleted_at is null
$$;
grant execute on function pg_temp.questions(text) to public;

select has_table('app', 'application_question_templates', 'question templates exist');
select has_table('app', 'application_template_questions', 'with their questions');
select has_table('app', 'opportunity_defaults', 'and an org''s opportunity defaults');

-- Templates ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with t as (insert into app.application_question_templates (org_id, name, description)
  values (pg_temp.id('org_a'), 'Crew Call Basics', 'Questions for every crew call.') returning id)
  insert into world select 'tpl_a', id from t;
select lives_ok($$insert into app.application_template_questions (application_question_template_id, prompt, sort_order, is_required)
  values (pg_temp.id('tpl_a'), 'Which shifts can you work?', 2, false),
         (pg_temp.id('tpl_a'), 'Do you hold a current rigging certification?', 1, true)$$,
  'a marketplace manager adds questions to a template');
select is((select org_id from app.application_template_questions where prompt = 'Which shifts can you work?'), pg_temp.id('org_a'),
  'a template question takes its template''s org');
select throws_ok($$insert into app.application_question_templates (org_id, name) values (pg_temp.id('org_a'), 'crew call basics')$$,
  '23505', null, 'template names are unique in the org ignoring case');
select throws_ok($$insert into app.application_template_questions (application_question_template_id, prompt, sort_order)
  values (pg_temp.id('tpl_a'), '   ', 3)$$, '23514', null, 'a question has text');

select pg_temp.as_user('dave');
select is((select count(*)::int from app.application_template_questions where application_question_template_id = pg_temp.id('tpl_a')), 2,
  'a member who reads postings reads the templates');
select throws_ok($$insert into app.application_question_templates (org_id, name) values (pg_temp.id('org_a'), 'Dave''s Set')$$,
  '42501', null, 'but only a marketplace manager writes them');

select pg_temp.as_user('xavier');
with t as (insert into app.application_question_templates (org_id, name) values (pg_temp.id('org_b'), 'Pier Crew') returning id)
  insert into world select 'tpl_b', id from t;
insert into app.application_template_questions (application_question_template_id, prompt, sort_order)
values (pg_temp.id('tpl_b'), 'Can you work nights on the pier?', 1);
select is((select count(*)::int from app.application_question_templates where org_id = pg_temp.id('org_a')), 0,
  'another org reads none of Northwind''s templates');
select throws_ok($$insert into app.application_template_questions (application_question_template_id, prompt, sort_order)
  values (pg_temp.id('tpl_a'), 'Planted question', 9)$$, '42501', null, 'nor adds questions to them');
select pg_temp.as_user('nina');
select is((select count(*)::int from app.application_question_templates), 0, 'a person with no org reads no templates');

-- Defaults -----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok($$insert into app.opportunity_defaults (org_id, visibility, rate_type, currency_code, application_window_days, application_question_template_id)
  values (pg_temp.id('org_a'), 'Pool', 'Day', 'USD', 14, pg_temp.id('tpl_a'))$$,
  'a marketplace manager sets the org''s opportunity defaults');
select throws_ok($$insert into app.opportunity_defaults (org_id) values (pg_temp.id('org_a'))$$,
  '23505', null, 'an org has one row of defaults');
select throws_ok($$update app.opportunity_defaults set application_window_days = 0 where org_id = pg_temp.id('org_a')$$,
  '23514', null, 'the application window is 1 to 365 days');
select pg_temp.as_platform();
select throws_ok($$update app.opportunity_defaults set application_question_template_id = pg_temp.id('tpl_b') where org_id = pg_temp.id('org_a')$$,
  'XR001', null, 'the default template is one of the org''s own');
select pg_temp.as_user('dave');
select is((select visibility::text || ' ' || rate_type::text || ' ' || application_window_days from app.opportunity_defaults), 'Pool Day 14',
  'a member who creates postings reads the defaults');
update app.opportunity_defaults set visibility = 'Public';
select pg_temp.as_user('xavier');
update app.opportunity_defaults set visibility = 'Public' where org_id = pg_temp.id('org_a');
select pg_temp.as_platform();
select is((select visibility::text from app.opportunity_defaults where org_id = pg_temp.id('org_a')), 'Pool',
  'and neither they nor another org change them');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.opportunity_defaults where org_id = pg_temp.id('org_a')), 0, 'another org reads none of them');

-- Applying a template ------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with o as (insert into app.opportunities (project_id, role_type, role_code, title, visibility, starts_on, ends_on)
  values (pg_temp.id('prj_a'), 'Crew', '5000.51.02', 'Summer Series Riggers', 'Pool', '2027-06-01', '2027-06-03') returning id)
  insert into world select 'opp', id from o;
select is(app.apply_question_template(pg_temp.id('opp'), pg_temp.id('tpl_a')), 2, 'applying a template copies its questions');
select is(pg_temp.questions('opp'),
  '1:Do you hold a current rigging certification?* | 2:Which shifts can you work?',
  'in the template''s order, with whether each is required');
insert into app.opportunity_questions (opportunity_id, prompt, sort_order) values (pg_temp.id('opp'), 'What is your day rate?', 7);
select is(app.apply_question_template(pg_temp.id('opp'), pg_temp.id('tpl_a')), 2, 'applying again adds the questions once more');
select is(pg_temp.questions('opp'),
  '1:Do you hold a current rigging certification?* | 2:Which shifts can you work? | 7:What is your day rate? | 8:Do you hold a current rigging certification?* | 9:Which shifts can you work?',
  'after the questions the opportunity already has');
update app.application_template_questions set prompt = 'Which days can you work?' where prompt = 'Which shifts can you work?';
select is((select count(*)::int from app.opportunity_questions where opportunity_id = pg_temp.id('opp') and prompt = 'Which shifts can you work?'), 2,
  'the copies are the opportunity''s own: editing the template changes no posting');

select throws_ok($$select app.apply_question_template(pg_temp.id('opp'), pg_temp.id('tpl_b'))$$,
  'XR001', 'question_template_not_found: This question template no longer exists or is not available to you.',
  'another org''s template is not applied');
select pg_temp.as_user('dave');
select throws_ok($$select app.apply_question_template(pg_temp.id('opp'), pg_temp.id('tpl_a'))$$,
  '42501', null, 'someone who cannot write the posting''s questions cannot apply a template to it');
select pg_temp.as_user('carol');
select app.transition_opportunity(pg_temp.id('opp'), 'Draft', 'Canceled', 'Posted by mistake.');
select throws_ok($$select app.apply_question_template(pg_temp.id('opp'), pg_temp.id('tpl_a'))$$,
  'XR001', 'question_template_not_draft: A question template applies to a Draft opportunity. Add questions one at a time instead.',
  'a template applies to a Draft opportunity only');

-- A coordinator who writes postings on one project, without reading postings org-wide, starts from the same defaults
-- and templates: the second branch of private.opportunity_template_reader_org_ids. frank is Field in Northwind, so he
-- holds no opportunities.posting capability until bob grants him posting.write on prj_a alone.
select pg_temp.as_user('frank');
select is((select count(*)::int from app.opportunity_defaults) + (select count(*)::int from app.application_question_templates), 0,
  'a field member who writes no postings reads neither the defaults nor the templates');
select pg_temp.as_user('bob');
insert into app.user_capability_grants (membership_id, capability_code, scope_kind, scope_id, reason)
values (pg_temp.id('frank@org_a'), 'opportunities.posting.write', 'project', pg_temp.id('prj_a'), 'Runs crew calls for the Summer Series.');
select pg_temp.as_user('frank');
select set_config('role', 'postgres', true); -- frank's claims, with the right to call the private helper
select ok(not private.has_capability(pg_temp.id('org_a'), 'opportunities.posting.read'),
  'with posting.write on one project, frank still does not read postings org-wide');
select pg_temp.as_user('frank');
select is((select visibility::text || ' ' || rate_type::text || ' ' || application_window_days from app.opportunity_defaults), 'Pool Day 14',
  'but he reads Northwind''s opportunity defaults');
select is((select string_agg(name, ', ' order by name) from app.application_question_templates), 'Crew Call Basics',
  'and its question templates, and none of another org''s');
select throws_ok($$insert into app.application_question_templates (org_id, name) values (pg_temp.id('org_a'), 'Frank''s Set')$$,
  '42501', null, 'writing them still takes the marketplace settings');
select pg_temp.as_user('carol');
with o as (insert into app.opportunities (project_id, role_type, role_code, title, visibility, starts_on, ends_on)
  values (pg_temp.id('prj_a'), 'Crew', '5000.51.02', 'Summer Series Stagehands', 'Pool', '2027-06-01', '2027-06-03') returning id)
  insert into world select 'opp_frank', id from o;
select pg_temp.as_user('frank');
select is(app.apply_question_template(pg_temp.id('opp_frank'), pg_temp.id('tpl_a')), 2,
  'he applies the template to a Draft opportunity on his project');
select pg_temp.as_platform();
select is(pg_temp.questions('opp_frank'),
  '1:Do you hold a current rigging certification?* | 2:Which days can you work?',
  'and the opportunity gets the template''s questions as they stand');
select pg_temp.as_user('carol');
update app.application_question_templates set deleted_at = now() where id = pg_temp.id('tpl_a');
select pg_temp.as_platform();
select ok(exists (select 1 from app.trash_items where subject_id = pg_temp.id('tpl_a')), 'a deleted template is in Trash');
select ok(not has_function_privilege('anon', 'app.apply_question_template(uuid, uuid)', 'EXECUTE'),
  'nobody signed out applies a template');

select * from finish();
rollback;
