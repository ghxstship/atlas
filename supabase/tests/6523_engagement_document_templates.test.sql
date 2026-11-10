-- pgTAP: migration 6523 (B10, G-130), engagement document templates. Merge fields come from the closed list, three kinds
-- only, the rate never reaches a title, used wording is fixed, nothing is seeded, and the read and write rules.
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

select is((select count(*)::int from app.engagement_document_templates t where t.org_id = pg_temp.id('org_a')), 0, 'no template is seeded in an org');

select pg_temp.as_user('carol');
select is(pg_temp.refusal(format($$insert into app.engagement_document_templates (org_id, name, document_kind, title_template, body_template) values ('%s', 'T', 'Agreement', 'Title', 'Pay {{engagement.bonus}}')$$, pg_temp.id('org_a'))),
  'document_template_fields', 'an unknown merge field is refused');
select is(pg_temp.refusal(format($$insert into app.engagement_document_templates (org_id, name, document_kind, title_template, body_template) values ('%s', 'T', 'Rider', 'Title', 'Body')$$, pg_temp.id('org_a'))),
  'document_template_kind', 'a kind outside the three is refused');
select is(pg_temp.refusal(format($$insert into app.engagement_document_templates (org_id, name, document_kind, title_template, body_template) values ('%s', 'T', 'Agreement', 'Rate {{engagement.rate}}', 'Body')$$, pg_temp.id('org_a'))),
  'document_template_rate_title', 'a title never uses the rate');
with t as (insert into app.engagement_document_templates (org_id, name, document_kind, title_template, body_template)
  values (pg_temp.id('org_a'), 'Crew Agreement', 'Agreement', 'Agreement for {{party.name}}', 'You earn {{ engagement.rate }} on {{project.name}}.') returning id) insert into world select 'tmpl', id from t;
select pg_temp.as_platform();
select ok(private.engagement_document_uses_rate('{{ engagement.rate }}'), 'a body with the rate field uses the rate, spaces and all');
select ok(not private.engagement_document_uses_rate('{{project.name}}'), 'a body without it does not');
select pg_temp.as_user('carol');
select throws_ok(format($$insert into app.engagement_document_templates (org_id, name, document_kind, title_template, body_template) values ('%s', 'crew agreement', 'Agreement', 'Title', 'Body')$$, pg_temp.id('org_a')),
  '23505', null, 'a name is unique per org, ignoring case');

-- Used wording is fixed ----------------------------------------------------------------------------------------------------------
select lives_ok(format($$update app.engagement_document_templates set body_template = 'You earn {{engagement.rate}}.' where id = '%s'$$, pg_temp.id('tmpl')), 'an unused template can change');
select pg_temp.as_platform();
insert into app.engagement_document_batches (project_id, engagement_document_template_id) values (pg_temp.id('prj_a'), pg_temp.id('tmpl'));
select pg_temp.as_user('carol');
select is(pg_temp.refusal(format($$update app.engagement_document_templates set body_template = 'No rate here.' where id = '%s'$$, pg_temp.id('tmpl'))), 'document_template_in_use', 'a used body is fixed');
select is(pg_temp.refusal(format($$update app.engagement_document_templates set title_template = 'Other' where id = '%s'$$, pg_temp.id('tmpl'))), 'document_template_in_use', 'and a used title');
select lives_ok(format($$update app.engagement_document_templates set name = 'Crew Agreement v1' where id = '%s'$$, pg_temp.id('tmpl')), 'its name still can');

-- Read and write rules ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.engagement_document_templates t where t.id = pg_temp.id('tmpl')), 0, 'another org reads nothing');
select pg_temp.as_user('dave');
select ok(exists (select 1 from app.engagement_document_templates t where t.id = pg_temp.id('tmpl')), 'a project coordinator reads the org''s templates');
select throws_ok(format($$insert into app.engagement_document_templates (org_id, name, document_kind, title_template, body_template) values ('%s', 'Mine', 'Agreement', 'T', 'B')$$, pg_temp.id('org_a')),
  '42501', null, 'writes take opportunities.engagement.write org-wide');

select * from finish();
rollback;
