-- pgTAP: migration 2611 (R2), riders of an individual artist's engagement. The artist and their Advance representative
-- read a rider assigned to the engagement; another artist on the project and an unrelated person do not. A rider names
-- at most one party; only a live Artist engagement that names a person, of the rider's project, takes one, and a rider keeps
-- its engagement through a rename after it ends. Account riders still read for the account, and the view keeps its columns
-- with engagement_id appended.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

-- Fixture: a second artist on prj_a and one on prj_a2, an account rider of Lumen Artists ----------------------------------------
select pg_temp.new_user('lena', 'lena@performer.test', 'Lena Okafor');
select pg_temp.as_user('alice');
with x as (insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('lena'), 'Artist', '2000.50.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-02')
  returning id) insert into world select 'eng_lena_a', id from x;
with x as (insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a2'), pg_temp.id('lena'), 'Artist', '2000.50.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-12-12')
  returning id) insert into world select 'eng_lena_a2', id from x;
insert into world values ('cp_t_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_t')));
with r as (insert into app.riders (project_id, counterparty_id, title) values (pg_temp.id('prj_a'), pg_temp.id('cp_t_a'), 'Lumen Artists House Rider')
  returning id) insert into world select 'rider_account', id from r;
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_lena_a', 'Onboarding', 'Active');

-- Writing --------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select lives_ok(format($$with r as (insert into app.riders (project_id, engagement_id, title) values (%L, %L, 'Arturo Bell Technical Rider')
  returning id) insert into world select 'rider_art', id from r$$, pg_temp.id('prj_a'), pg_temp.id('eng_art_a')),
  'a rider belongs to an individual artist''s engagement');
select is((select count(*)::int from app.rider_lines where rider_id = pg_temp.id('rider_art')), 0, 'and starts with no lines');
insert into app.rider_lines (rider_id, description, quantity) values (pg_temp.id('rider_art'), 'Two wedge monitors', 2);
select throws_ok(format($$insert into app.riders (project_id, counterparty_id, engagement_id, title) values (%L, %L, %L, 'Both')$$,
    pg_temp.id('prj_a'), pg_temp.id('cp_t_a'), pg_temp.id('eng_art_a')),
  '23514', null, 'a rider never names both a counterparty and an engagement (riders_one_party)');
select throws_ok(format($$insert into app.riders (project_id, engagement_id, title) values (%L, %L, 'Crew Rider')$$,
    pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a')),
  'XR001', 'rider_engagement_artist: A rider belongs to a live Artist engagement that names a person.', 'a Crew engagement takes no rider');
select throws_ok(format($$insert into app.riders (project_id, engagement_id, title) values (%L, %L, 'Gala Rider')$$,
    pg_temp.id('prj_a'), pg_temp.id('eng_lena_a2')),
  'XR001', null, 'an engagement of another project is refused (same_project)');
select throws_ok(format($$update app.riders set engagement_id = %L where id = %L$$, pg_temp.id('eng_lena_a2'), pg_temp.id('rider_art')),
  'XR001', null, 'moving a rider to another project''s engagement is refused too');
select pg_temp.as_user('xavier');
select throws_ok(format($$insert into app.riders (project_id, engagement_id, title) values (%L, %L, 'Pier Rider')$$,
    pg_temp.id('prj_b'), pg_temp.id('eng_art_a')),
  'XR001', null, 'another org cannot use the engagement (invariant 1)');
select pg_temp.as_platform();

select pg_temp.as_user('alice');
with x as (insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('quinn'), 'Artist', '2000.50.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-03')
  returning id) insert into world select 'eng_quinn_a', id from x;
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_quinn_a', 'Onboarding', 'Canceled');
select pg_temp.as_user('alice');
select throws_ok(format($$insert into app.riders (project_id, engagement_id, title) values (%L, %L, 'Canceled Rider')$$,
    pg_temp.id('prj_a'), pg_temp.id('eng_quinn_a')),
  'XR001', 'rider_engagement_artist: A rider belongs to a live Artist engagement that names a person.', 'a Canceled engagement takes no rider');
select pg_temp.as_platform();

-- Reading --------------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('art', format('select 1 from api_external.riders where id = %L', pg_temp.id('rider_art'))), 1,
  'the artist reads the rider of their engagement');
select is(pg_temp.n('rita', format('select 1 from api_external.riders where id = %L', pg_temp.id('rider_art'))), 1,
  'and so does their Advance representative');
select is(pg_temp.n('art', format('select 1 from api_external.rider_lines where rider_id = %L', pg_temp.id('rider_art'))), 1,
  'the rider''s lines follow');
select is(pg_temp.n('lena', format('select 1 from api_external.riders where id = %L', pg_temp.id('rider_art'))), 0,
  'another artist on the project does not read it');
select is(pg_temp.n('ivy', 'select 1 from api_external.riders'), 0, 'an unrelated person reads no rider');
select is(pg_temp.n('victor', 'select 1 from api_external.riders'), 0, 'another account reads no rider');
select pg_temp.as_user('art');
select is((select account_id from api_external.riders where id = pg_temp.id('rider_art')), null::uuid, 'an engagement rider has no account');
select is((select engagement_id from api_external.riders where id = pg_temp.id('rider_art')), pg_temp.id('eng_art_a'), 'and names the engagement');
select pg_temp.as_platform();

select is(pg_temp.n('rita', format('select 1 from api_external.riders where id = %L', pg_temp.id('rider_account'))), 1,
  'account riders stay visible to the account');
select is(pg_temp.n('art', format('select 1 from api_external.riders where id = %L', pg_temp.id('rider_account'))), 0,
  'and an engagement''s principal does not read the account''s rider through the engagement');

select pg_temp.move_engagement('eng_art_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_art_a', 'Closing', 'Complete');
select is(pg_temp.n('art', format('select 1 from api_external.riders where id = %L', pg_temp.id('rider_art'))), 0,
  'Complete closes the engagement''s rider');

-- Atlas saves every field (updateRider lists engagement_id even when unchanged): a rename keeps the ended engagement, while
-- moving the rider to an engagement that is not live is still refused.
select pg_temp.as_user('alice');
select lives_ok(format($$update app.riders set title = 'Arturo Bell Rider', counterparty_id = null, engagement_id = %L where id = %L$$,
    pg_temp.id('eng_art_a'), pg_temp.id('rider_art')),
  'a rider whose engagement is Complete can still be renamed with the engagement kept');
select is((select engagement_id from app.riders where id = pg_temp.id('rider_art')), pg_temp.id('eng_art_a'), 'and keeps it');
select throws_ok(format($$update app.riders set engagement_id = %L where id = %L$$, pg_temp.id('eng_quinn_a'), pg_temp.id('rider_art')),
  'XR001', 'rider_engagement_artist: A rider belongs to a live Artist engagement that names a person.',
  'changing it to a Canceled engagement is refused');
select pg_temp.as_platform();

-- Catalog --------------------------------------------------------------------------------------------------------------------------
select is((select array_agg(column_name::text order by ordinal_position) from information_schema.columns
  where table_schema = 'api_external' and table_name = 'riders'),
  array['id', 'project_id', 'project_name', 'account_id', 'title', 'engagement_id'], 'riders keeps its columns, engagement_id last');
select ok(col_description('api_external.riders'::regclass,
  (select attnum from pg_attribute where attrelid = 'api_external.riders'::regclass and attname = 'engagement_id')) is not null,
  'the new view column is described');
select ok(col_description('app.riders'::regclass,
  (select attnum from pg_attribute where attrelid = 'app.riders'::regclass and attname = 'engagement_id')) is not null,
  'the new table column is described');
select ok((select encode(t.tgargs, 'escape') like '%app.counterparties%app.engagements%' from pg_trigger t
  where t.tgrelid = 'app.riders'::regclass and t.tgname = 't30_refuse_cross_org_reference'),
  'the cross-org reference guard checks the counterparty and the engagement');
select ok(has_table_privilege('authenticated', 'api_external.riders', 'select'), 'signed-in users read the view');
select ok(not has_table_privilege('anon', 'api_external.riders', 'select'), 'anon does not');

select * from finish();
rollback;
