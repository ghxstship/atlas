-- pgTAP: migration 2901 (B1, RRR-225; ADR 0140 D1, D3 and D4). A plan's drawing is a Clean PNG, JPEG or PDF (with its own
-- PNG raster) on the plan, Public or Internal when set; image_uri follows it and the scale clears with it; a raised
-- classification later is allowed. Only a Draft plan takes layout writes, and shapes are valid plan-space geometry whose
-- lengths and areas the view computes from the calibration.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 2900_places_world.psql

select * from no_plan();

select pg_temp.as_user('dave');
select pg_temp.clean_file('png', 'app.site_plans', pg_temp.id('plan_a'), 'ground.png', 'image/png');
select pg_temp.clean_file('png2', 'app.site_plans', pg_temp.id('plan_a'), 'ground-v2.png', 'image/png');
select pg_temp.clean_file('pdf', 'app.site_plans', pg_temp.id('plan_a'), 'ground.pdf', 'application/pdf');
select pg_temp.clean_file('raster', 'app.site_plans', pg_temp.id('plan_a'), 'ground-page-2.png', 'image/png');
select pg_temp.clean_file('doc', 'app.site_plans', pg_temp.id('plan_a'), 'notes.txt', 'text/plain');
select pg_temp.clean_file('other', 'app.projects', pg_temp.id('prj_a'), 'elsewhere.png', 'image/png');
insert into world select 'pending', u.attachment_version_id from app.begin_attachment_upload('app.site_plans', pg_temp.id('plan_a'), 'up.png', 'image/png', 10) u;

-- Drawing refusals ---------------------------------------------------------------------------------------------------------
select throws_ok($$update app.site_plans set drawing_version_id = pg_temp.id('other'), image_width_px = 10, image_height_px = 10 where id = pg_temp.id('plan_a')$$,
  'XR001', 'site_plan_drawing_subject: A plan''s drawing is a file attached to the plan itself.', 'a file on another subject is refused');
select throws_ok($$update app.site_plans set drawing_version_id = pg_temp.id('pending'), image_width_px = 10, image_height_px = 10 where id = pg_temp.id('plan_a')$$,
  'XR001', null, 'an unscanned file is refused');
select throws_ok($$update app.site_plans set drawing_version_id = pg_temp.id('doc'), image_width_px = 10, image_height_px = 10 where id = pg_temp.id('plan_a')$$,
  'XR001', 'site_plan_drawing_type: A drawing is a PNG, JPEG or PDF file, and a PDF''s page is a PNG.', 'a wrong type is refused');
select throws_ok($$update app.site_plans set drawing_version_id = pg_temp.id('pdf'), drawing_page = 2, image_width_px = 10, image_height_px = 10 where id = pg_temp.id('plan_a')$$,
  'XR001', 'site_plan_raster_required: A PDF drawing needs the PNG of its page; upload both.', 'a PDF without its raster is refused');
select throws_ok($$update app.site_plans set drawing_version_id = pg_temp.id('pdf'), raster_version_id = pg_temp.id('pdf'), drawing_page = 2,
    image_width_px = 10, image_height_px = 10 where id = pg_temp.id('plan_a')$$, 'XR001', null, 'the raster is a PNG');
select throws_ok($$update app.site_plans set drawing_version_id = pg_temp.id('png'), raster_version_id = pg_temp.id('raster'),
    image_width_px = 10, image_height_px = 10 where id = pg_temp.id('plan_a')$$, 'XR001', null, 'an image drawing has no raster');
select throws_ok($$update app.site_plans set drawing_version_id = pg_temp.id('png') where id = pg_temp.id('plan_a')$$, '23514', null,
  'a drawing comes with its measured size');
update app.attachments set classification = 'Confidential' where id = (select attachment_id from app.attachment_versions where id = pg_temp.id('png2'));
select throws_ok($$update app.site_plans set drawing_version_id = pg_temp.id('png2'), image_width_px = 10, image_height_px = 10 where id = pg_temp.id('plan_a')$$,
  'XR001', 'site_plan_drawing_classification: A drawing must be Public or Internal. A Confidential or Restricted file stays an ordinary attachment.',
  'a Confidential file cannot become the drawing');

-- A PDF drawing ---------------------------------------------------------------------------------------------------------------
select lives_ok($$update app.site_plans set drawing_version_id = pg_temp.id('pdf'), raster_version_id = pg_temp.id('raster'), drawing_page = 2,
    image_width_px = 2000, image_height_px = 1000, image_uri = 'https://evil.test/x.png' where id = pg_temp.id('plan_a')$$, 'a PDF with its raster becomes the drawing');
select is((select image_uri from app.site_plans where id = pg_temp.id('plan_a')),
  'attachments/' || (select object_name from app.attachment_versions where id = pg_temp.id('pdf')), 'image_uri follows the drawing, whatever was sent');
select throws_ok($$update app.site_plans set image_width_px = 1999 where id = pg_temp.id('plan_a')$$, 'XR001',
  'site_plan_dimensions_fixed: A drawing''s size is measured when it is set and changes only with the drawing.', 'the size changes only with the drawing');

-- An image drawing, calibration and its reset -------------------------------------------------------------------------------
select lives_ok($$update app.site_plans set drawing_version_id = pg_temp.id('png'), raster_version_id = null, drawing_page = null,
    image_width_px = 2000, image_height_px = 1000 where id = pg_temp.id('plan_a')$$, 'a Clean PNG becomes the drawing');
update app.site_plans set calibration_ax = 0.1, calibration_ay = 0.5, calibration_bx = 0.6, calibration_by = 0.5, calibration_feet = 50
where id = pg_temp.id('plan_a');
select throws_ok($$update app.site_plans set calibration_feet = null where id = pg_temp.id('plan_a')$$, '23514', null, 'a calibration is whole or absent');
select throws_ok($$update app.site_plans set calibration_bx = 0.1 where id = pg_temp.id('plan_a')$$, '23514', null, 'its two points differ');
select lives_ok($$update app.site_plans set image_uri = 'https://evil.test/y.png' where id = pg_temp.id('plan_a')$$, 'a v1 write of image_uri is accepted');
select is((select image_uri from app.site_plans where id = pg_temp.id('plan_a')),
  'attachments/' || (select object_name from app.attachment_versions where id = pg_temp.id('png')), 'and ignored, so image_uri never drifts');

-- Shapes and the measurements ------------------------------------------------------------------------------------------------
insert into world values ('route', app.save_site_plan_shape(null, pg_temp.id('plan_a'), 'Route', 'Egress north', null, '[[0.1,0.1],[0.1,0.6]]'));
insert into world values ('area', app.save_site_plan_shape(null, pg_temp.id('plan_a'), 'Area', 'Pit', null, '[[0.1,0.2],[0.3,0.2],[0.3,0.6],[0.1,0.6]]'));
insert into world values ('label', app.save_site_plan_shape(null, pg_temp.id('plan_a'), 'Label', 'North', null, '[[0.5,0.05]]'));
select is((select round(length_ft, 1) from app.site_plan_shape_geometry where id = pg_temp.id('route')), 25.0,
  'the route (0.1, 0.1) to (0.1, 0.6) on 2000 x 1000 px calibrated 50 ft over (0.1, 0.5) to (0.6, 0.5) is 25 ft');
select is((select round(area_sq_ft, 1) from app.site_plan_shape_geometry where id = pg_temp.id('area')), 400.0, 'the square is 400 sq ft');
select is((select round(length_ft, 1) from app.site_plan_shape_geometry where id = pg_temp.id('area')), 80.0, 'with an 80 ft perimeter');
select is((select length_ft from app.site_plan_shape_geometry where id = pg_temp.id('label')), null, 'a label has no length');
select is((select tone::text from app.site_plan_shapes where id = pg_temp.id('route')), 'Info', 'a route takes the Info tone by default');
select is((select tone::text from app.site_plan_shapes where id = pg_temp.id('area')), 'Accent', 'an area takes Accent');
select throws_ok($$select app.save_site_plan_shape(null, pg_temp.id('plan_a'), 'Route', 'Out', null, '[[0.1,0.1],[1.2,0.6]]')$$, 'XR001', null,
  'a shape outside the drawing is refused');
select throws_ok($$select app.save_site_plan_shape(null, pg_temp.id('plan_a'), 'Area', 'Bow tie', null, '[[0.1,0.1],[0.3,0.3],[0.3,0.1],[0.1,0.3]]')$$,
  'XR001', null, 'a self-crossing area is refused');
select throws_ok($$select app.save_site_plan_shape(null, pg_temp.id('plan_a'), 'Route', 'Dot', null, '[[0.1,0.1],[0.1,0.1]]')$$, 'XR001', null,
  'a route without length is refused');
select throws_ok($$select app.save_site_plan_shape(null, pg_temp.id('plan_a'), 'Label', '', null, '[[0.1,0.1]]')$$, 'XR001', null,
  'every shape needs a label');
select throws_ok($$select app.save_site_plan_shape(null, pg_temp.id('plan_a'), 'Label', 'Two', null, '[[0.1,0.1],[0.2,0.2]]')$$, 'XR001', null,
  'a label sits at one point');
select throws_ok($$select app.save_site_plan_shape(null, pg_temp.id('plan_a'), 'Route', 'Bad', null, '[["a",1]]')$$, 'XR001', null,
  'points are pairs of numbers');
select throws_ok($$insert into app.site_plan_shapes (site_plan_id, kind, label, geometry) values (pg_temp.id('plan_a'), 'Route', 'Geo',
    extensions.st_setsrid(extensions.st_makeline(extensions.st_makepoint(0.1, 0.1), extensions.st_makepoint(0.2, 0.2)), 4326))$$,
  '23514', null, 'shapes are SRID 0 plan space, never WGS 84');

-- A new drawing clears the scale -----------------------------------------------------------------------------------------------
update app.attachments set classification = 'Internal' where id = (select attachment_id from app.attachment_versions where id = pg_temp.id('png2'));
update app.site_plans set drawing_version_id = pg_temp.id('png2'), image_width_px = 2000, image_height_px = 1000 where id = pg_temp.id('plan_a');
select is((select calibration_feet from app.site_plans where id = pg_temp.id('plan_a')), null, 'a new drawing of the same size clears the scale');
select is((select length_ft from app.site_plan_shape_geometry where id = pg_temp.id('route')), null, 'so lengths are null while uncalibrated');
update app.site_plans set calibration_ax = 0.1, calibration_ay = 0.5, calibration_bx = 0.6, calibration_by = 0.5, calibration_feet = 50
where id = pg_temp.id('plan_a');

-- A raised classification later is allowed (Section 8.6) ------------------------------------------------------------------------
select lives_ok($$update app.attachments set classification = 'Confidential' where id = (select attachment_id from app.attachment_versions where id = pg_temp.id('png2'))$$,
  'any reader may raise the drawing''s classification later');
select lives_ok($$update app.site_plans set title = 'Ground floor plan' where id = pg_temp.id('plan_a')$$, 'and the plan still renames');
update app.attachments set classification = 'Internal' where id = (select attachment_id from app.attachment_versions where id = pg_temp.id('png2'));

-- The layout lock ---------------------------------------------------------------------------------------------------------------
select app.transition_site_plan(pg_temp.id('plan_a'), 'Draft', 'Locked', 'Layout fixed.');
select throws_ok($$insert into app.site_plan_pins (site_plan_id, label, x_ratio, y_ratio) values (pg_temp.id('plan_a'), 'Late', 0.5, 0.5)$$, 'XR001',
  'site_plan_locked: This plan is locked or live. Unlock it to change its layout.', 'no pin is placed on a Locked plan');
select throws_ok($$update app.site_plan_pins set x_ratio = 0.4 where id = pg_temp.id('pin_a')$$, 'XR001', null, 'no pin moves');
select throws_ok($$update app.site_plan_pins set deleted_at = now() where id = pg_temp.id('pin_a')$$, 'XR001', null, 'no pin is archived');
select throws_ok($$select app.save_site_plan_shape(null, pg_temp.id('plan_a'), 'Label', 'Late', null, '[[0.4,0.4]]')$$, 'XR001', null, 'no shape is drawn');
select throws_ok($$select app.save_site_plan_shape(pg_temp.id('route'), pg_temp.id('plan_a'), 'Route', 'Moved', null, '[[0.2,0.1],[0.2,0.6]]')$$, 'XR001', null,
  'no shape is reshaped');
select throws_ok($$update app.site_plan_shapes set deleted_at = now() where id = pg_temp.id('route')$$, 'XR001', null, 'no shape is archived');
select throws_ok($$update app.site_plans set calibration_feet = 60 where id = pg_temp.id('plan_a')$$, 'XR001', null, 'the scale is fixed');
select throws_ok($$update app.site_plans set venue_id = null where id = pg_temp.id('plan_a')$$, 'XR001', null, 'and the venue');
select throws_ok($$update app.site_plans set drawing_version_id = pg_temp.id('png'), image_width_px = 2000, image_height_px = 1000 where id = pg_temp.id('plan_a')$$,
  'XR001', null, 'and the drawing');
select lives_ok($$update app.site_plans set title = 'Ground floor (locked)' where id = pg_temp.id('plan_a')$$, 'a Locked plan still renames');
select lives_ok($$select app.create_punch_item(pg_temp.id('prj_a'), 'Gate latch sticks', null, null, pg_temp.id('pin_a'))$$,
  'a punch item can still mark a pin of a Locked plan');
select app.transition_site_plan(pg_temp.id('plan_a'), 'Locked', 'Archived', 'Retired.');
select throws_ok($$update app.site_plans set title = 'Renamed' where id = pg_temp.id('plan_a')$$, 'XR001',
  'site_plan_archived: This plan is archived. Reopen it as a draft to rename it.', 'an Archived plan keeps its title');

-- Access ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select ok((select count(*) from app.site_plan_shape_geometry where site_plan_id = pg_temp.id('plan_a')) = 3, 'a Viewer reads the shapes');
select throws_ok($$select app.save_site_plan_shape(null, pg_temp.id('plan_b'), 'Label', 'X', null, '[[0.4,0.4]]')$$, null, null, 'but draws none');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.site_plan_shape_geometry), 0, 'another org reads no shapes');
select is((select count(*)::int from app.site_plan_shapes), 0, 'nor the table');
select pg_temp.as_platform();
select is(has_table_privilege('xos_backup', 'app.site_plan_shape_geometry', 'select'), false, 'the backup login cannot read the view');

select * from finish();
rollback;
