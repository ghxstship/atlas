-- pgTAP: migration 6521 (B10, G-129), registration pages. A page needs a live Talent pool of its org and a slug unique per
-- org, the slug and minimum age are fixed after Draft, questions change only in Draft, an A136 template applies under its
-- reader rule, the lifecycle refuses moves back to Draft, and the public read never names the pool.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.refusal(p_sql text) returns text
language plpgsql as $$
declare
  v_hint text;
begin
  execute p_sql;
  return null;
exception when sqlstate 'XR001' then
  get stacked diagnostics v_hint = pg_exception_hint;
  return v_hint;
end $$;
grant execute on function pg_temp.refusal(text) to public;

select pg_temp.as_user('carol');
with p as (insert into app.talent_pools (org_id, name, pool_kind) values (pg_temp.id('org_a'), 'Stagehands', 'Talent') returning id) insert into world select 'pool', id from p;
with p as (insert into app.talent_pools (org_id, name, pool_kind) values (pg_temp.id('org_a'), 'Audio Vendors', 'Vendor') returning id) insert into world select 'vpool', id from p;
select pg_temp.as_user('xavier');
with p as (insert into app.talent_pools (org_id, name, pool_kind) values (pg_temp.id('org_b'), 'Harbor Crew', 'Talent') returning id) insert into world select 'pool_b', id from p;

-- Pages ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is(pg_temp.refusal(format($$insert into app.registration_pages (org_id, slug, title, talent_pool_id) values ('%s', 'x', 'X', '%s')$$, pg_temp.id('org_a'), pg_temp.id('vpool'))),
  'registration_page_pool', 'a Vendor pool is refused');
select throws_ok(format($$insert into app.registration_pages (org_id, slug, title, talent_pool_id) values ('%s', 'x', 'X', '%s')$$, pg_temp.id('org_a'), pg_temp.id('pool_b')),
  null, null, 'another org''s pool is refused');
with p as (insert into app.registration_pages (org_id, slug, title, intro, talent_pool_id, minimum_age)
  values (pg_temp.id('org_a'), 'summer-crew', 'Summer Crew', 'Work the summer series.', pg_temp.id('pool'), 18) returning id) insert into world select 'page', id from p;
select throws_ok(format($$insert into app.registration_pages (org_id, slug, title, talent_pool_id) values ('%s', 'summer-crew', 'Other', '%s')$$, pg_temp.id('org_a'), pg_temp.id('pool')),
  '23505', null, 'a slug is unique per org among live pages');
select throws_ok(format($$insert into app.registration_pages (org_id, slug, title, talent_pool_id, minimum_age) values ('%s', 'young', 'Young', '%s', 17)$$, pg_temp.id('org_a'), pg_temp.id('pool')),
  '23514', null, 'the minimum age is at least 18');

-- Questions while Draft ------------------------------------------------------------------------------------------------------------
with q as (insert into app.registration_page_questions (registration_page_id, prompt, sort_order, is_required)
  values (pg_temp.id('page'), 'Which skills do you bring?', 1, true) returning id) insert into world select 'q1', id from q;
with t as (insert into app.application_question_templates (org_id, name) values (pg_temp.id('org_a'), 'Crew basics') returning id) insert into world select 'tmpl', id from t;
insert into app.application_template_questions (application_question_template_id, prompt, sort_order, is_required)
values (pg_temp.id('tmpl'), 'Do you hold a forklift ticket?', 1, false), (pg_temp.id('tmpl'), 'Which nights can you work?', 2, true);
select is(app.apply_registration_question_template(pg_temp.id('page'), pg_temp.id('tmpl')), 2, 'a question template copies its questions into a Draft page');
select results_eq(format($$select prompt, sort_order from app.registration_page_questions where registration_page_id = '%s' order by sort_order$$, pg_temp.id('page')),
  $$values ('Which skills do you bring?'::text, 1), ('Do you hold a forklift ticket?'::text, 2), ('Which nights can you work?'::text, 3)$$, 'after the questions it has, in the template''s order');
select pg_temp.as_user('xavier');
with t as (insert into app.application_question_templates (org_id, name) values (pg_temp.id('org_b'), 'Harbor') returning id) insert into world select 'tmpl_b', id from t;
select pg_temp.as_user('carol');
select is(pg_temp.refusal(format($$select app.apply_registration_question_template('%s', '%s')$$, pg_temp.id('page'), pg_temp.id('tmpl_b'))),
  'question_template_not_found', 'another org''s template is refused');
select pg_temp.as_user('gina');
select throws_ok(format($$select app.apply_registration_question_template('%s', '%s')$$, pg_temp.id('page'), pg_temp.id('tmpl')), '42501', null, 'applying needs opportunities.pool.write');

-- The public read before opening ------------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select is((select r.reason from api_public.registration_page('northwind-live', 'summer-crew') r), 'registration_page_closed', 'a Draft page reads closed');
select is((select r.reason from api_public.registration_page('northwind-live', 'no-such-page') r), 'registration_page_closed', 'a missing page reads the same');

-- Opening ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok(format($$select app.transition_registration_page('%s', 'Draft', 'Open')$$, pg_temp.id('page')), '42501', null, 'opening needs opportunities.pool.write');
select pg_temp.as_user('carol');
select app.transition_registration_page(pg_temp.id('page'), 'Draft', 'Open');
select is(pg_temp.refusal(format($$update app.registration_pages set slug = 'other' where id = '%s'$$, pg_temp.id('page'))), 'registration_page_slug_fixed', 'the slug is fixed after Draft');
select is(pg_temp.refusal(format($$update app.registration_pages set minimum_age = 21 where id = '%s'$$, pg_temp.id('page'))), 'registration_page_minimum_age_fixed', 'the minimum age is fixed after Draft');
select is(pg_temp.refusal(format($$insert into app.registration_page_questions (registration_page_id, prompt, sort_order) values ('%s', 'Late?', 9)$$, pg_temp.id('page'))),
  'registration_page_not_draft', 'questions are refused once it opened');
select is(pg_temp.refusal(format($$select app.apply_registration_question_template('%s', '%s')$$, pg_temp.id('page'), pg_temp.id('tmpl'))),
  'registration_page_not_draft', 'and a template');
select throws_ok(format($$select app.transition_registration_page('%s', 'Open', 'Draft')$$, pg_temp.id('page')),
  'XR001', 'registration_page_transition_not_allowed: A registration page cannot move from Open to Draft.', 'a page never goes back to Draft');

-- The public read when Open --------------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select results_eq($$select org_name, title, intro, minimum_age::int, prompt, is_required from api_public.registration_page('northwind-live', 'summer-crew') order by sort_order$$,
  $$values ('Northwind Live'::text, 'Summer Crew'::text, 'Work the summer series.'::text, 18, null::text, null::boolean)$$,
  'anon reads only the copy of an Open page: the questions are for a signed-in person');
select is((select r.org_id from api_public.registration_page('northwind-live', 'summer-crew') r limit 1), pg_temp.id('org_a'), 'with the org id for the brand scope check');
select is((select count(*)::int from pg_catalog.pg_proc p, unnest(p.proallargtypes, p.proargmodes, p.proargnames) as a (t, m, n)
    where p.oid = 'api_public.registration_page'::regproc and a.m = 't' and a.n like '%pool%'), 0, 'and never the pool');

-- Do Not Engage, a dead pool and a read-only org all read closed ----------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.pool_members (talent_pool_id, person_id, standing, reason, review_on)
values (pg_temp.id('pool'), pg_temp.id('quinn'), 'Do Not Engage', 'Missed two calls without notice.', '2027-12-31');
select pg_temp.as_user('quinn');
select is((select r.reason from api_public.registration_page('northwind-live', 'summer-crew') r), 'registration_page_closed', 'a signed-in Do Not Engage caller reads it closed');
select pg_temp.as_platform();
insert into app.org_cancellations (org_id, reason, canceled_at, read_only_until, purge_after)
values (pg_temp.id('org_a'), 'Fixture.', now(), now() + interval '30 days', now() + interval '90 days');
select pg_temp.as_anon();
select is((select r.reason from api_public.registration_page('northwind-live', 'summer-crew') r), 'registration_page_closed', 'a read-only org reads closed');
select pg_temp.as_platform();
update app.org_cancellations set reactivated_at = now(), reactivated_by = pg_temp.id('alice') where org_id = pg_temp.id('org_a');
update app.talent_pools set deleted_at = now() where id = pg_temp.id('pool');
select pg_temp.as_anon();
select is((select r.reason from api_public.registration_page('northwind-live', 'summer-crew') r), 'registration_page_closed', 'a deleted pool reads closed');
select pg_temp.as_user('carol');
select app.transition_registration_page(pg_temp.id('page'), 'Open', 'Closed');
select pg_temp.as_anon();
select is((select r.reason from api_public.registration_page('northwind-live', 'summer-crew') r), 'registration_page_closed', 'and a Closed page reads closed');

select * from finish();
rollback;
