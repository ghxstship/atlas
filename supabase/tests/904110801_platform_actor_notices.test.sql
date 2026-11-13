-- pgTAP: migration 904110801 (crawl 4.9, RRR-243). A platform decision reaches the tenant as the platform's:
--   * a rating dispute decided in the operator console tells the disputant and the org's rating answerers in GHXSTSHIP's
--     name, and no notification carries the operator's name or person id;
--   * private.notify records no actor person for an emitter that passes actorPlatform, names the platform when the
--     emitter names no one, and does not store the flag; every other emitter keeps the signed-in actor;
--   * every function that names the platform as the actor of a notice also passes actorPlatform, so a later emitter
--     cannot name the platform and still store the operator unnoticed.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create function pg_temp.as_op(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- World: carol (org_a) rates ivy after a finished engagement; ivy disputes it; tess, a Trust and Safety operator, decides.
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_ivy_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_ivy_a', 'Closing', 'Complete');
select pg_temp.as_user('carol');
with r as (insert into app.ratings (engagement_id, rater_side, score, comment) values (pg_temp.id('eng_ivy_a'), 'Organization', 2, 'Late to load-in twice.') returning id)
  insert into world select 'rate_ivy_a', id from r;
select pg_temp.as_user('ivy');
insert into app.ratings (engagement_id, rater_side, score) values (pg_temp.id('eng_ivy_a'), 'Party', 4);
insert into world select 'dispute_a', app.file_rating_dispute(pg_temp.id('rate_ivy_a'), 'False Statement', 'I was on time on both days.');

select pg_temp.as_platform();
select pg_temp.new_user('tess', 'tess@platform.test', 'Tess Morales');
select pg_temp.as_platform();
select private.grant_platform_operator('tess@platform.test', 'Trust and Safety', 'Moderation.');

select pg_temp.as_op('tess');
select lives_ok($$select app.console_decide_rating_dispute((select id from world where key = 'dispute_a'), 'Upheld', 'False Statement', 'Call sheets show you were on time.')$$,
  'the operator upholds the dispute');

select pg_temp.as_platform();
select cmp_ok((select count(*)::int from app.notifications where kind = 'rating_dispute.decided'), '>=', 2,
  'the person and the org''s rating answerers are told');
select is((select count(*)::int from app.notifications where kind = 'rating_dispute.decided' and actor_person_id is not null), 0,
  'no decision notice records the operator''s person id');
select is((select count(*)::int from app.notifications where kind = 'rating_dispute.decided'
  and message_args ->> 'actorName' is distinct from 'GHXSTSHIP'), 0, 'every one names the platform as the actor');
select is((select count(*)::int from app.notifications where kind = 'rating_dispute.decided' and message_args::text like '%Tess%'), 0,
  'none carries the operator''s name');
select is((select count(*)::int from app.notifications where kind = 'rating_dispute.decided' and message_args ? 'actorPlatform'), 0,
  'and the flag is not stored');

select pg_temp.as_user('ivy');
select is((select message_args ->> 'actorName' from app.notifications where kind = 'rating_dispute.decided'), 'GHXSTSHIP',
  'the disputant reads the platform''s name');
select is((select actor_person_id from app.notifications where kind = 'rating_dispute.decided'), null::uuid,
  'and no actor person');

-- private.notify on its own, as the database calls it with carol signed in -----------------------------------------------
select pg_temp.as_platform();
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('carol_user'), 'role', 'authenticated')::text, true);
create temporary table n (key text primary key, id uuid);
insert into n select 'platform', private.notify(pg_temp.id('org_a'), pg_temp.id('ivy'), 'rating_dispute.decided', null, null, null,
  jsonb_build_object('outcome', 'Upheld', 'actorPlatform', true));
insert into n select 'person', private.notify(pg_temp.id('org_a'), pg_temp.id('ivy'), 'rating_dispute.decided', null, null, null,
  jsonb_build_object('outcome', 'Upheld'));
select is((select actor_person_id from app.notifications where id = (select id from n where key = 'platform')), null::uuid,
  'an emitter acting for the platform records no actor person');
select is((select message_args ->> 'actorName' from app.notifications where id = (select id from n where key = 'platform')), 'GHXSTSHIP',
  'and reads as the platform when it names no one');
select is((select actor_person_id from app.notifications where id = (select id from n where key = 'person')), pg_temp.id('carol'),
  'any other emitter still records the signed-in actor');
select is((select message_args ->> 'actorName' from app.notifications where id = (select id from n where key = 'person')),
  (select full_name from app.people where id = pg_temp.id('carol')), 'by name');

-- Gate: naming the platform as the actor means acting for it -----------------------------------------------------------
select is_empty($$select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('app', 'private', 'xpms') and p.prosrc ~ '''actorName'', ''(XOS|GHXSTSHIP)'''
    and p.prosrc !~ '''actorPlatform'', true' and not (n.nspname = 'private' and p.proname = 'notify')$$,
  'every function that names the platform as a notice''s actor also passes actorPlatform');

select * from finish();
rollback;
