-- pgTAP: earned media coverage and the measurement summary (A98, RRR-143, finding A65-030, migration 1551). Coverage is
-- dated on the project's calendar with one row per link; the summary compares each gate 1 objective with the figures in
-- the metric's base unit, converts mixed units exactly, totals measured figures only, keeps an unmeasured figure NULL
-- (never zero), decides an objective only when the missing figures cannot change it, and computes the earned media
-- figures from the coverage rows. Access follows the project (invariant 2).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

create temporary table days as
select private.project_today(pg_temp.id('prj_a')) as today, private.project_today(pg_temp.id('prj_a')) - 3 as earlier,
  private.project_today(pg_temp.id('prj_a')) - 4 as before;
grant select on days to public;

-- Coverage ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('erin');
select lives_ok($$insert into app.earned_media_items (project_id, title, outlet, medium, published_on, url, reach, tone)
  values ((select id from world where key = 'prj_a'), 'Summer Series opens on the pier', 'Miami Herald', 'Online', (select earlier from days),
    'https://news.example.test/summer-series', 120000, 'Positive')$$, 'an evidence writer records coverage');
select lives_ok($$insert into app.earned_media_items (project_id, title, outlet, medium, published_on, url, tone, source, source_reference)
  values ((select id from world where key = 'prj_a'), 'Weekend picks', 'WLRN', 'Broadcast', (select earlier from days),
    'https://radio.example.test/weekend', 'Neutral', 'Import', 'monitoring-export-0612.csv')$$,
  'coverage whose source reports no reach');
select lives_ok($$insert into app.earned_media_items (project_id, title, outlet, medium, published_on, reach)
  values ((select id from world where key = 'prj_a'), 'Opening night reel', '@northwindlive', 'Social', (select before from days), 5000)$$,
  'coverage without a link');
select is((select reach from app.earned_media_items where outlet = 'WLRN'), null::bigint, 'an unreported reach stays NULL');
select is((select tone from app.earned_media_items where outlet = '@northwindlive'), null::app.coverage_tone, 'an unrated tone stays NULL');
select is((select created_by from app.earned_media_items where outlet = 'WLRN'), pg_temp.id('erin'), 'who recorded it is kept');
select throws_ok($$insert into app.earned_media_items (project_id, title, outlet, medium, published_on, url)
  values ((select id from world where key = 'prj_a'), 'Same story', 'Miami Herald', 'Print', (select earlier from days), 'HTTPS://NEWS.EXAMPLE.TEST/summer-series')$$,
  '23505', null, 'one live row per link, ignoring case');
select throws_ok($$insert into app.earned_media_items (project_id, title, outlet, medium, published_on)
  values ((select id from world where key = 'prj_a'), 'Tomorrow''s paper', 'Miami Herald', 'Print', (select today + 1 from days))$$,
  'XR001', 'earned_media_in_future: Coverage runs on or before today on the project''s calendar.', 'coverage never runs after today');
select throws_ok($$insert into app.earned_media_items (project_id, title, outlet, medium, published_on, url)
  values ((select id from world where key = 'prj_a'), 'Bad link', 'Blog', 'Online', (select earlier from days), 'javascript:alert(1)')$$,
  '23514', null, 'a link is an http(s) URL');
select throws_ok($$insert into app.earned_media_items (project_id, title, outlet, medium, published_on, reach)
  values ((select id from world where key = 'prj_a'), 'Negative', 'Blog', 'Online', (select earlier from days), -1)$$,
  '23514', null, 'reach is never negative');
select lives_ok($$insert into app.earned_media_items (project_id, title, outlet, medium, published_on, reach)
  values ((select id from world where key = 'prj_a'), 'Withdrawn piece', 'Blog', 'Online', (select earlier from days), 900000)$$, 'a piece recorded in error');
select lives_ok($$update app.earned_media_items set deleted_at = now() where title = 'Withdrawn piece'$$, 'is withdrawn');
select throws_ok($$update app.earned_media_items set project_id = (select id from world where key = 'prj_a2') where outlet = 'WLRN'$$,
  'XR001', null, 'coverage stays with its project');

-- Objectives and figures ------------------------------------------------------------------------------------------------
insert into app.project_objectives (project_id, metric_code, direction, target_value, unit_code) values
  (pg_temp.id('prj_a'), 'attendance', 'At Least', 5000, 'count'),
  (pg_temp.id('prj_a'), 'waste_generated', 'At Most', 2, 't'),
  (pg_temp.id('prj_a'), 'water_used', 'At Most', 50, 'm3'),
  (pg_temp.id('prj_a'), 'positive_sentiment', 'At Least', 70, 'percent'),
  (pg_temp.id('prj_a'), 'earned_media_reach', 'At Least', 100000, 'count'),
  (pg_temp.id('prj_a'), 'earned_media_items', 'At Least', 5, 'count');
insert into app.project_measurements (project_id, metric_code, measured_on, value, unit_code) values
  (pg_temp.id('prj_a'), 'attendance', (select earlier from days), 1800, 'count'),
  (pg_temp.id('prj_a'), 'attendance', (select earlier from days), 2000, 'count'),
  (pg_temp.id('prj_a'), 'attendance', (select earlier from days), null, null),
  (pg_temp.id('prj_a'), 'waste_generated', (select earlier from days), 1500, 'kg'),
  (pg_temp.id('prj_a'), 'waste_generated', (select earlier from days), 1000, 'lb'),
  (pg_temp.id('prj_a'), 'energy_used', (select earlier from days), 0.9, 'mwh'),
  (pg_temp.id('prj_a'), 'positive_sentiment', (select before from days), 64, 'percent'),
  (pg_temp.id('prj_a'), 'positive_sentiment', (select earlier from days), 72, 'percent');

create function pg_temp.summary(p_metric text) returns app.project_measurement_summary
language sql stable as $$ select s.* from app.project_measurement_summary s where s.project_id = pg_temp.id('prj_a') and s.metric_code = p_metric $$;

select is((pg_temp.summary('attendance')).measured_base, 3800::numeric, 'attendance totals the measured shows');
select is((pg_temp.summary('attendance')).unmeasured_count, 1, 'with the unmeasured show counted beside it, not as zero');
select is((pg_temp.summary('attendance')).outcome, 'Incomplete', 'a shortfall with a show unmeasured leaves the objective undecided');
insert into app.project_measurements (project_id, metric_code, measured_on, value, unit_code)
values (pg_temp.id('prj_a'), 'attendance', (select earlier from days), 1500, 'count');
select is((pg_temp.summary('attendance')).outcome, 'Met', 'once the measured shows reach the target it is Met, whatever the unmeasured one held');

select is((pg_temp.summary('waste_generated')).measured_base, 1953.59237000::numeric, '1,500 kg and 1,000 lb total exactly 1,953.59237 kg');
select is((pg_temp.summary('waste_generated')).target_base, 2000::numeric, 'the 2 t target converts to 2,000 kg');
select is((pg_temp.summary('waste_generated')).outcome, 'Met', 'within an At Most target is Met');
insert into app.project_measurements (project_id, metric_code, measured_on, value, unit_code)
values (pg_temp.id('prj_a'), 'waste_generated', (select earlier from days), null, null);
select is((pg_temp.summary('waste_generated')).outcome, 'Incomplete', 'an unmeasured load leaves an At Most target undecided');
insert into app.project_measurements (project_id, metric_code, measured_on, value, unit_code)
values (pg_temp.id('prj_a'), 'waste_generated', (select earlier from days), 0.1, 'short_ton');
select is((pg_temp.summary('waste_generated')).outcome, 'Not Met', 'once the measured loads pass the target it is Not Met');

select is((pg_temp.summary('water_used')).measured_base, null::numeric, 'water with nothing measured totals NULL, never zero');
select is((pg_temp.summary('water_used')).measured_count, 0, 'with no measured figure');
select is((pg_temp.summary('water_used')).outcome, 'Unmeasured', 'and the objective reads Unmeasured');
select is((pg_temp.summary('water_used')).target_base, 50000::numeric, 'its 50 m3 target is 50,000 l');

select is((pg_temp.summary('energy_used')).measured_base, 900::numeric, 'a figure without an objective is still reported, 0.9 MWh as 900 kWh');
select is((pg_temp.summary('energy_used')).outcome, null, 'with no outcome');

select is((pg_temp.summary('positive_sentiment')).measured_base, 72::numeric, 'sentiment takes the latest measured figure');
select is((pg_temp.summary('positive_sentiment')).outcome, 'Met', 'and compares it with the target');

select is((pg_temp.summary('earned_media_items')).measured_base, 3::numeric, 'the coverage count comes from the live coverage rows');
select is((pg_temp.summary('earned_media_items')).outcome, 'Not Met', 'three pieces miss a target of five');
select is((pg_temp.summary('earned_media_reach')).measured_base, 125000::numeric, 'reach totals the pieces that report one');
select is((pg_temp.summary('earned_media_reach')).unmeasured_count, 1, 'the piece without a reach is counted as unmeasured');
select is((pg_temp.summary('earned_media_reach')).outcome, 'Met', 'and the reach objective is Met');

select is((select count(*)::int from app.project_measurement_summary where project_id = pg_temp.id('prj_a')), 7,
  'one row per metric with an objective or a figure');
update app.project_measurements set deleted_at = now() where metric_code = 'energy_used';
select is((select count(*)::int from app.project_measurement_summary where project_id = pg_temp.id('prj_a')), 6, 'withdrawn figures leave the summary');

-- Access ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is((select count(*)::int from app.earned_media_items where deleted_at is null), 3, 'a project member reads the live coverage');
select is((select count(*)::int from app.project_measurement_summary), 6, 'and the summary');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.earned_media_items), 0, 'a Viewer outside the project reads no coverage (invariant 2)');
select is((select count(*)::int from app.project_measurement_summary), 0, 'nor the summary');
select throws_ok($$insert into app.earned_media_items (project_id, title, outlet, medium, published_on)
  values ((select id from world where key = 'prj_a'), 'Viewer piece', 'Blog', 'Online', (select earlier from days))$$, '42501', null, 'nor records coverage');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.earned_media_items), 0, 'another org reads none');
select is((select count(*)::int from app.project_measurement_summary), 0, 'nor its summary');
select pg_temp.as_anon();
select throws_ok('select 1 from app.project_measurement_summary', '42501', null, 'anon reads no summary');

select * from finish();
rollback;
