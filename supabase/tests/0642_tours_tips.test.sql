-- pgTAP: guided tour progress and tip dismissals (A31, Section 11.16).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(16);

-- Tours -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select lives_ok($$insert into app.tour_progress (membership_id, tour_key) values (pg_temp.id('dave@org_a'), 'module.crew')$$,
  'offering a tour records it');
select is((select org_id from app.tour_progress where tour_key = 'module.crew'), pg_temp.id('org_a'), 'the org comes from the membership');
select throws_ok($$insert into app.tour_progress (membership_id, tour_key) values (pg_temp.id('dave@org_a'), 'module.crew')$$,
  '23505', null, 'a tour is offered once per member');
select throws_ok($$insert into app.tour_progress (membership_id, tour_key) values (pg_temp.id('erin@org_a'), 'module.crew')$$,
  '42501', null, 'nobody records progress for someone else');
select throws_ok($$insert into app.tour_progress (membership_id, tour_key) values (pg_temp.id('dave@org_a'), 'Module Crew')$$,
  '23514', null, 'tour keys follow the help content format');
select lives_ok($$update app.tour_progress set tour_state = 'Started', step = 2 where tour_key = 'module.crew'$$, 'starting a tour moves its step');
select lives_ok($$update app.tour_progress set tour_state = 'Completed', step = 5 where tour_key = 'module.crew'$$, 'a tour completes');
select throws_ok($$update app.tour_progress set step = 1 where tour_key = 'module.crew'$$,
  'XR001', null, 'a completed tour keeps its last step');
select throws_ok($$update app.tour_progress set tour_state = 'Offered' where tour_key = 'module.crew'$$,
  'XR001', null, 'a tour is never offered again');
select lives_ok($$update app.tour_progress set tour_state = 'Started', step = 0 where tour_key = 'module.crew'$$, 'a tour is replayed from Help');
select throws_ok($$update app.tour_progress set tour_key = 'module.assets' where tour_key = 'module.crew'$$,
  'XR001', null, 'progress keeps its tour');

-- Tips --------------------------------------------------------------------------------------------------------
select lives_ok($$insert into app.tip_dismissals (membership_id, tip_key) values (pg_temp.id('dave@org_a'), 'gates')$$, 'a tip is dismissed');
select throws_ok($$insert into app.tip_dismissals (membership_id, tip_key) values (pg_temp.id('dave@org_a'), 'gates')$$,
  '23505', null, 'a tip is dismissed once');
update app.tip_dismissals set deleted_at = now() where tip_key = 'gates';
select throws_ok($$update app.tip_dismissals set deleted_at = null where tip_key = 'gates'$$,
  'XR001', null, 'a reset dismissal is never revived');

select pg_temp.as_user('erin');
select is((select count(*)::integer from app.tour_progress) + (select count(*)::integer from app.tip_dismissals), 0,
  'progress is private to its member');

select pg_temp.as_anon();
select throws_ok($$select count(*) from app.tour_progress$$, '42501', null, 'anon reads no tour progress');

select * from finish();
rollback;
