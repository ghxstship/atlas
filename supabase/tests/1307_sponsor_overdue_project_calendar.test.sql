-- pgTAP: 1307 (A71, RRR-116). A sponsor entitlement is overdue once its due date has passed on the project's
-- calendar. prj_a takes a zone whose date differs from UTC's right now, as in 1305, so the view's is_overdue tells
-- the project's calendar from the database's UTC date at any time of day.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(6);

create temporary table clock as
  select s.zone, (now() at time zone s.zone)::date as local_on, (now() at time zone 'UTC')::date as utc_on
  from (select case when extract(hour from now() at time zone 'UTC') >= 12 then 'Pacific/Kiritimati' else 'Etc/GMT+12' end as zone) s;
grant select on clock to public;
create function pg_temp.zone() returns text language sql stable as $$ select zone from clock $$;
create function pg_temp.local_on() returns date language sql stable as $$ select local_on from clock $$;
create function pg_temp.utc_on() returns date language sql stable as $$ select utc_on from clock $$;

select isnt(pg_temp.local_on(), pg_temp.utc_on(), 'the suite''s zone is on another date than UTC right now');
update app.projects set time_zone = pg_temp.zone() where id = pg_temp.id('prj_a');

select pg_temp.new_user('sol', 'sol@brightwave-drinks.test', 'Sol Ferreira');
select pg_temp.as_user('sol');
insert into world values ('acct_s', app.create_external_account('Brightwave Drinks', 'brightwave-drinks'));
select pg_temp.as_user('alice');
insert into world values ('cp_s_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_s')));
with e as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('sol'), pg_temp.id('cp_s_a'), 'Sponsor', '2027-06-01') returning id) insert into world select 'eng_sponsor', id from e;
insert into app.sponsor_entitlements (project_id, counterparty_id, description, quantity, due_on) values
  (pg_temp.id('prj_a'), pg_temp.id('cp_s_a'), 'Due yesterday', 1, pg_temp.local_on() - 1),
  (pg_temp.id('prj_a'), pg_temp.id('cp_s_a'), 'Due today', 1, pg_temp.local_on()),
  (pg_temp.id('prj_a'), pg_temp.id('cp_s_a'), 'Due tomorrow', 1, pg_temp.local_on() + 1);
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_sponsor', 'Onboarding', 'Active');

select pg_temp.as_user('sol');
select is((select count(*)::int from api_external.sponsor_entitlements), 3, 'the sponsor reads its three entitlements');
select is((select is_overdue from api_external.sponsor_entitlements where description = 'Due yesterday'), true,
  'due yesterday on the project''s calendar is overdue');
select is((select is_overdue from api_external.sponsor_entitlements where description = 'Due today'), false,
  'due today on the project''s calendar is not overdue yet');
select is((select is_overdue from api_external.sponsor_entitlements where description = 'Due tomorrow'), false, 'nor is tomorrow''s');
select pg_temp.as_platform();
update app.sponsor_entitlements set fulfilled_at = now() where description = 'Due yesterday';
select pg_temp.as_user('sol');
select is((select is_overdue from api_external.sponsor_entitlements where description = 'Due yesterday'), false,
  'a delivered entitlement is never overdue');
select pg_temp.as_platform();

select * from finish();
rollback;
