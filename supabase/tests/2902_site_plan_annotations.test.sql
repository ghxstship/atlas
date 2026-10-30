-- pgTAP: migration 2902 (B1, RRR-225; ADR 0140 D5). Pins and shapes take comment threads in every plan state; mentions on
-- them reach only people who can open the plan's project (a project member or an org-wide overseer); a note at a point is
-- an anchored thread on the plan in one canonical form, and a reply to a resolved one reopens it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 2900_places_world.psql

select * from no_plan();

select is((select count(*)::int from app.comment_subjects where table_name in ('app.site_plan_pins', 'app.site_plan_shapes')), 2,
  'pins and shapes are comment subjects');
select is((private.subject_row('app.site_plan_pins', pg_temp.id('pin_a')) ->> 'project_id')::uuid, pg_temp.id('prj_a'),
  'a pin carries its plan''s project');
select is(private.subject_row('app.site_plan_pins', pg_temp.id('pin_a')) ->> 'title', 'Main gate', 'and its label as title');
select is((private.subject_row('app.projects', pg_temp.id('prj_a')) ->> 'project_id')::uuid, pg_temp.id('prj_a'),
  'a project subject still carries its own id');

select pg_temp.as_platform();
update app.site_plans set image_uri = 'https://example.test/ground.png' where id = pg_temp.id('plan_a');
select pg_temp.as_user('dave');
insert into world values ('shape', app.save_site_plan_shape(null, pg_temp.id('plan_a'), 'Barrier', 'Crowd fence', null, '[[0.2,0.2],[0.4,0.2]]'));
select app.transition_site_plan(pg_temp.id('plan_a'), 'Draft', 'Locked', 'Layout fixed.');

-- Comments on a Locked plan's pin and shape ---------------------------------------------------------------------------------
insert into world values ('c1', app.post_comment('app.site_plan_pins', pg_temp.id('pin_a'), 'Gate opens inward.', array[pg_temp.id('erin')]));
select ok(pg_temp.id('c1') is not null, 'a comment is posted on a pin of a Locked plan');
select pg_temp.as_platform();
select ok(exists (select 1 from app.notifications where recipient_person_id = pg_temp.id('erin') and kind = 'mention.created'
  and subject_table = 'app.site_plan_pins' and project_id = pg_temp.id('prj_a')), 'a project member is notified, with the project set');
select pg_temp.as_user('dave');
select throws_ok($$select app.post_comment('app.site_plan_pins', pg_temp.id('pin_a'), 'FYI', array[pg_temp.id('mia')])$$, 'XR001',
  'comment_mention_no_access: Only people who can open the subject can be mentioned.', 'an org member who is not on the project cannot be mentioned');
select lives_ok($$select app.post_comment('app.site_plan_pins', pg_temp.id('pin_a'), 'Heads up', array[pg_temp.id('bob')])$$,
  'an org-wide overseer of every project can be');
select lives_ok($$select app.post_comment('app.site_plan_shapes', pg_temp.id('shape'), 'Needs two more panels.')$$, 'a shape takes comments');
select pg_temp.as_user('erin');
select lives_ok($$select app.post_comment('app.site_plan_pins', pg_temp.id('pin_a'), 'Agreed.')$$, 'a reply joins the pin''s thread');
select is((select count(*)::int from app.comments c join app.comment_threads t on t.id = c.comment_thread_id
  where t.subject_table = 'app.site_plan_pins' and t.subject_id = pg_temp.id('pin_a')), 3, 'one thread holds the replies');
update app.comment_threads set resolved_at = now() where subject_table = 'app.site_plan_pins' and subject_id = pg_temp.id('pin_a');
select isnt((select resolved_at from app.comment_threads where subject_table = 'app.site_plan_pins' and subject_id = pg_temp.id('pin_a')), null,
  'a participant resolves it');

-- Point notes -------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select lives_ok($$select app.post_comment('app.site_plans', pg_temp.id('plan_a'), 'Power drop here?', '{}', 'point:0.4200,0.1000')$$,
  'a note at a point is an anchored thread on the plan');
select throws_ok($$select app.post_comment('app.site_plans', pg_temp.id('plan_a'), 'x', '{}', 'point:0.42,0.1')$$, 'XR001', null,
  'an anchor has exactly four decimals');
select throws_ok($$select app.post_comment('app.site_plans', pg_temp.id('plan_a'), 'x', '{}', 'point:1.2000,0.1000')$$, 'XR001', null,
  'and stays within the drawing');
select throws_ok($$select app.post_comment('app.site_plans', pg_temp.id('plan_a'), 'x', '{}', 'field:title')$$, 'XR001',
  'site_plan_anchor: A note on a plan is anchored at a point written point:<across>,<down>, each 0.0000 to 1.0000.', 'other anchors are refused');
select lives_ok($$select app.post_comment('app.site_plans', pg_temp.id('plan_a'), 'Main thread still works.')$$, 'the plan''s main thread is unanchored');
update app.comment_threads set resolved_at = now() where subject_table = 'app.site_plans' and anchor = 'point:0.4200,0.1000';
select pg_temp.as_user('erin');
select app.post_comment('app.site_plans', pg_temp.id('plan_a'), 'Still open?', '{}', 'point:0.4200,0.1000');
select is((select count(*)::int || ' ' || (bool_and(resolved_at is null))::text from app.comment_threads
  where subject_table = 'app.site_plans' and anchor = 'point:0.4200,0.1000'), '1 true', 'a reply to a resolved point note reopens the one thread');

-- Access -------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('xavier');
select throws_ok($$select app.post_comment('app.site_plan_pins', pg_temp.id('pin_a'), 'Hi')$$, '42501', null, 'another org cannot comment on the pin');

select * from finish();
rollback;
