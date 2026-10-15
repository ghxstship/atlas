-- pgTAP: A07 project currency and description (0401, late slot 0950). The currency comes from the
-- caller, else the jurisdiction's country, else the org base currency setting; a project always has
-- one. Descriptions are checked; edits to both emit project.updated.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(12);

select has_column('app', 'projects', 'currency', 'projects carry a base currency');
select has_column('app', 'projects', 'description', 'projects carry a description');
select col_not_null('app', 'projects', 'currency', 'every project has a currency');
select has_index('app', 'projects', 'projects_currency_idx', 'the currency foreign key is indexed');

select is((select currency::text from app.projects where id = pg_temp.id('prj_a')), 'USD',
  'a Miami-Dade project takes the US dollar from its jurisdiction');
select is((select currency::text from app.projects where id = pg_temp.id('prj_a2')), 'USD',
  'a project without a jurisdiction takes the org base currency default');

select pg_temp.as_user('alice');
select lives_ok($$select app.set_setting((select id from world where key = 'org_a'), 'org.base_currency',
  'Organization', (select id from world where key = 'org_a'), 'EUR')$$, 'the owner sets the org base currency to euros');
select lives_ok($$insert into world values ('prj_eur', app.create_project((select id from world where key = 'org_a'),
  'EUA', 'Euro Showcase', 'Europe/Paris'))$$, 'a project is created without a currency or jurisdiction');
select is((select currency::text from app.projects where id = pg_temp.id('prj_eur')), 'EUR',
  'it takes the org base currency setting');
select lives_ok($$insert into world values ('prj_gbp', app.create_project((select id from world where key = 'org_a'),
  'GBA', 'London Showcase', 'Europe/London', p_currency_code => 'gbp', p_description => 'A one-night showcase.'))$$,
  'a project is created with a given currency and description');
select is((select currency::text || ' ' || description from app.projects where id = pg_temp.id('prj_gbp')),
  'GBP A one-night showcase.', 'the given currency wins and the description is stored');
select throws_ok($$update app.projects set description = ' ' where id = (select id from world where key = 'prj_gbp')$$,
  '23514', null, 'a blank description is refused');
select pg_temp.as_platform();

select * from finish();
rollback;
