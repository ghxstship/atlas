-- 2901_site_plan_drawings_and_shapes.sql
-- B1 Places depth on image plans (RRR-225; gaps G-02 and G-15; ADR 0140 D1, D3 and D4).
--
--   * Drawings (D3): a stored drawing is a Clean PNG, JPEG or PDF version in the attachments bucket (0590) on the plan
--     itself, served by /files/{version} (A142), never fetched by URL. A PDF carries a PNG raster of its chosen page,
--     rendered in the uploader's browser and uploaded as a separate attachment on the plan (a new version of the PDF's
--     attachment would replace the PDF, 0590). Both must be Public or Internal when they are set; raising either later is
--     allowed (1380, Section 8.6), and readers then treat the plan as having no stored drawing. While a drawing is set,
--     image_uri is always 'attachments/' || its object name, whatever the caller sends, so it never drifts. The pixel
--     size is measured from the bytes by Atlas and changes only together with the drawing.
--   * Layout lock (D1): only a Draft plan takes layout writes, to the plan's venue, level, drawing and scale and to its
--     pins and shapes. Titles change in every state but Archived; comments are allowed in every state.
--   * Shapes (D4): routes, barriers, areas and labels in plan space, SRID 0 geometry in fractions of the drawing's width
--     and height (the pins' convention). Lengths and areas are computed in the drawing's pixel space and scaled by one
--     calibrated distance in feet, in app.site_plan_shape_geometry, never stored.

-- Drawing columns ----------------------------------------------------------------------------------------------------------

alter table app.site_plans
  add column drawing_version_id uuid references app.attachment_versions (id),
  add column raster_version_id uuid references app.attachment_versions (id),
  add column drawing_page smallint,
  add column image_width_px integer,
  add column image_height_px integer,
  add column calibration_ax numeric,
  add column calibration_ay numeric,
  add column calibration_bx numeric,
  add column calibration_by numeric,
  add column calibration_feet numeric,
  add constraint site_plans_drawing_page_positive check (drawing_page is null or drawing_page between 1 and 10000),
  add constraint site_plans_dimensions_range check (image_width_px between 1 and 20000 and image_height_px between 1 and 20000),
  add constraint site_plans_dimensions_with_drawing check (
    (drawing_version_id is null) = (image_width_px is null) and (drawing_version_id is null) = (image_height_px is null)),
  add constraint site_plans_raster_with_drawing check (raster_version_id is null or drawing_version_id is not null),
  add constraint site_plans_calibration_complete check (num_nulls(calibration_ax, calibration_ay, calibration_bx, calibration_by, calibration_feet) in (0, 5)),
  add constraint site_plans_calibration_range check (
    calibration_ax between 0 and 1 and calibration_ay between 0 and 1 and calibration_bx between 0 and 1 and calibration_by between 0 and 1
    and calibration_feet > 0),
  add constraint site_plans_calibration_points_differ check ((calibration_ax, calibration_ay) <> (calibration_bx, calibration_by)),
  add constraint site_plans_calibration_needs_drawing check (calibration_feet is null or drawing_version_id is not null);

create index site_plans_drawing_version_id_idx on app.site_plans (drawing_version_id);
create index site_plans_raster_version_id_idx on app.site_plans (raster_version_id);

comment on column app.site_plans.image_uri is 'Where the drawing is: ''attachments/'' and the object name of the stored drawing, set by private.guard_site_plan_layout whenever a drawing is set; ''attachments/pending'' for a plan created to receive an upload; otherwise a legacy web address or path, shown as before and never fetched by the server.';
comment on column app.site_plans.drawing_version_id is 'Stored drawing (ADR 0140 D3): a Clean PNG, JPEG or PDF version of an attachment on this plan, Public or Internal when set.';
comment on column app.site_plans.raster_version_id is 'For a PDF drawing, the PNG of its chosen page, rendered in the uploader''s browser and kept as its own attachment on this plan; not verified against the PDF. NULL for PNG and JPEG drawings.';
comment on column app.site_plans.drawing_page is 'For a PDF drawing, the 1-based page the raster shows; NULL for PNG and JPEG drawings.';
comment on column app.site_plans.image_width_px is 'Width in pixels of the drawing as shown (the raster for a PDF), measured from its bytes by Atlas when the drawing is set; changes only with the drawing.';
comment on column app.site_plans.image_height_px is 'Height in pixels of the drawing as shown, measured from its bytes by Atlas when the drawing is set; changes only with the drawing.';
comment on column app.site_plans.calibration_ax is 'Scale: first point of the known distance, across, 0 to 1 from the left.';
comment on column app.site_plans.calibration_ay is 'Scale: first point of the known distance, down, 0 to 1 from the top.';
comment on column app.site_plans.calibration_bx is 'Scale: second point of the known distance, across.';
comment on column app.site_plans.calibration_by is 'Scale: second point of the known distance, down.';
comment on column app.site_plans.calibration_feet is 'Scale: the real distance between the two points in feet. Cleared whenever the drawing changes; NULL while the plan is uncalibrated.';

-- The layout guard ---------------------------------------------------------------------------------------------------------

create or replace function private.check_site_plan_drawing_version(p_plan_id uuid, p_version_id uuid, p_types text[])
returns app.attachment_versions
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_version app.attachment_versions;
  v_attachment app.attachments;
begin
  select * into v_version from app.attachment_versions v where v.id = p_version_id and v.deleted_at is null;
  select * into v_attachment from app.attachments a where a.id = v_version.attachment_id and a.deleted_at is null;
  if v_version.id is null or v_attachment.id is null
     or v_attachment.subject_table <> 'app.site_plans' or v_attachment.subject_id <> p_plan_id then
    perform private.refuse('site_plan_drawing_subject', 'A plan''s drawing is a file attached to the plan itself.');
  end if;
  if v_version.scan_status <> 'Clean' then
    perform private.refuse('site_plan_drawing_scan', 'The drawing is still being checked for viruses, or failed the check. Use it once it is Clean.');
  end if;
  if not (v_version.content_type = any (p_types)) then
    perform private.refuse('site_plan_drawing_type', 'A drawing is a PNG, JPEG or PDF file, and a PDF''s page is a PNG.');
  end if;
  if v_attachment.classification not in ('Public', 'Internal') then
    perform private.refuse('site_plan_drawing_classification', 'A drawing must be Public or Internal. A Confidential or Restricted file stays an ordinary attachment.');
  end if;
  return v_version;
end;
$$;

comment on function private.check_site_plan_drawing_version(uuid, uuid, text[]) is 'A drawing or raster being set on a plan: a live version of a live attachment on the plan, Clean, of one of the given types, classified Public or Internal (site_plan_drawing_subject, site_plan_drawing_scan, site_plan_drawing_type, site_plan_drawing_classification). Returns the version.';
revoke all on function private.check_site_plan_drawing_version(uuid, uuid, text[]) from public, anon, authenticated;

create or replace function private.guard_site_plan_layout()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drawing app.attachment_versions;
  v_raster app.attachment_versions;
  v_drawing_changed boolean;
begin
  v_drawing_changed := tg_op = 'INSERT'
    or (new.drawing_version_id, new.raster_version_id, new.drawing_page)
       is distinct from (old.drawing_version_id, old.raster_version_id, old.drawing_page);

  if new.drawing_version_id is null then
    if tg_op = 'UPDATE' and old.drawing_version_id is not null then
      -- Removing the drawing leaves a plan waiting for one.
      new.raster_version_id := null;
      new.drawing_page := null;
      new.image_width_px := null;
      new.image_height_px := null;
      new.image_uri := 'attachments/pending';
    end if;
  else
    if v_drawing_changed then
      v_drawing := private.check_site_plan_drawing_version(new.id, new.drawing_version_id,
        array['image/png', 'image/jpeg', 'application/pdf']);
      if v_drawing.content_type = 'application/pdf' then
        if new.raster_version_id is null then
          perform private.refuse('site_plan_raster_required', 'A PDF drawing needs the PNG of its page; upload both.');
        end if;
        if new.drawing_page is null then
          perform private.refuse('site_plan_drawing_page', 'Choose the page of the PDF that is the drawing.');
        end if;
        v_raster := private.check_site_plan_drawing_version(new.id, new.raster_version_id, array['image/png']);
        if v_raster.attachment_id = v_drawing.attachment_id then
          perform private.refuse('site_plan_raster_attachment', 'The page image is its own file on the plan, not a new version of the PDF.');
        end if;
      elsif new.raster_version_id is not null or new.drawing_page is not null then
        perform private.refuse('site_plan_drawing_page', 'A PNG or JPEG drawing has no page and no page image.');
      end if;
    else
      select * into v_drawing from app.attachment_versions v where v.id = new.drawing_version_id;
    end if;
    -- The drawing's object name is the plan's image_uri whatever the caller sent (ADR 0140 D3).
    new.image_uri := 'attachments/' || v_drawing.object_name;
  end if;

  if tg_op = 'UPDATE' then
    if new.drawing_version_id is distinct from old.drawing_version_id then
      -- A new drawing, even one of the same size, is not the same scale.
      new.calibration_ax := null;
      new.calibration_ay := null;
      new.calibration_bx := null;
      new.calibration_by := null;
      new.calibration_feet := null;
    elsif (new.image_width_px, new.image_height_px) is distinct from (old.image_width_px, old.image_height_px) then
      perform private.refuse('site_plan_dimensions_fixed', 'A drawing''s size is measured when it is set and changes only with the drawing.');
    end if;
    if old.plan_state = 'Archived' and new.title is distinct from old.title then
      perform private.refuse('site_plan_archived', 'This plan is archived. Reopen it as a draft to rename it.');
    end if;
    if old.plan_state <> 'Draft' and (
      new.venue_id, new.venue_level_id, new.image_uri, new.drawing_version_id, new.raster_version_id, new.drawing_page,
      new.image_width_px, new.image_height_px,
      new.calibration_ax, new.calibration_ay, new.calibration_bx, new.calibration_by, new.calibration_feet)
      is distinct from (
      old.venue_id, old.venue_level_id, old.image_uri, old.drawing_version_id, old.raster_version_id, old.drawing_page,
      old.image_width_px, old.image_height_px,
      old.calibration_ax, old.calibration_ay, old.calibration_bx, old.calibration_by, old.calibration_feet) then
      perform private.refuse('site_plan_locked', 'This plan is locked or live. Unlock it to change its layout.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_site_plan_layout() is 'Before insert or update on site plans (ADR 0140 D1, D3): a drawing or raster being set is checked (private.check_site_plan_drawing_version; a PDF needs a PNG raster of its own and a page), image_uri follows the drawing''s object name, a new drawing clears the scale, the size changes only with the drawing (site_plan_dimensions_fixed), an Archived plan keeps its title (site_plan_archived), and only a Draft plan changes its venue, level, drawing, size or scale (site_plan_locked).';
revoke all on function private.guard_site_plan_layout() from public, anon, authenticated;
create trigger t43_guard_site_plan_layout before insert or update on app.site_plans
  for each row execute function private.guard_site_plan_layout();

-- Shapes -------------------------------------------------------------------------------------------------------------------

create type app.site_plan_shape_kind as enum ('Route', 'Barrier', 'Area', 'Label');
comment on type app.site_plan_shape_kind is 'What a shape on a site plan is (ADR 0140 D4): a Route or a Barrier line, an Area polygon, or a Label at a point.';

create type app.site_plan_shape_tone as enum ('Accent', 'Info', 'Success', 'Warning', 'Danger', 'Neutral');
comment on type app.site_plan_shape_tone is 'Color role a shape is drawn in, from the design tokens; every tone keeps 3:1 contrast on the drawing frame.';

insert into private.domain_event_types (code, subject, description) values
  ('site_plan_shape.drawn', 'site_plan_shapes', 'A route, barrier, area or label was drawn on a site plan.'),
  ('site_plan_shape.changed', 'site_plan_shapes', 'A shape on a site plan was reshaped, renamed or recolored.')
on conflict (code) do nothing;

create table app.site_plan_shapes (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  site_plan_id uuid not null references app.site_plans (id),
  kind app.site_plan_shape_kind not null,
  label text not null,
  tone app.site_plan_shape_tone not null,
  geometry extensions.geometry not null,
  deleted_at timestamptz,
  constraint site_plan_shapes_label_length check (char_length(btrim(label)) between 1 and 200 and label = btrim(label)),
  constraint site_plan_shapes_srid check (extensions.st_srid(geometry) = 0),
  constraint site_plan_shapes_in_frame check (
    case when extensions.st_srid(geometry) = 0 then extensions.st_coveredby(geometry, extensions.st_makeenvelope(0, 0, 1, 1, 0)) else false end),
  constraint site_plan_shapes_kind_geometry check (case kind
    when 'Route' then extensions.geometrytype(geometry) = 'LINESTRING' and extensions.st_npoints(geometry) between 2 and 500
      and extensions.st_length(geometry) > 0
    when 'Barrier' then extensions.geometrytype(geometry) = 'LINESTRING' and extensions.st_npoints(geometry) between 2 and 500
      and extensions.st_length(geometry) > 0
    when 'Area' then extensions.geometrytype(geometry) = 'POLYGON' and extensions.st_nrings(geometry) = 1
      and extensions.st_npoints(geometry) between 4 and 501 and extensions.st_isvalid(geometry) and extensions.st_area(geometry) > 0
    else extensions.geometrytype(geometry) = 'POINT' end)
);

create index site_plan_shapes_site_plan_id_idx on app.site_plan_shapes (site_plan_id);

call private.install_child_table('app.site_plan_shapes', 'app.site_plans', 'site_plan_id', 'places.venue.read', 'places.site_plan.write');
call private.describe('app.site_plan_shapes', 'Shapes drawn on a site plan (G-15, ADR 0140 D4): routes, barriers, areas and labels in plan space. Lengths and areas are computed in app.site_plan_shape_geometry, never stored.', array[
  'site_plan_id', 'Site plan the shape is on. Never changes.',
  'kind', 'Route, Barrier, Area or Label.',
  'label', 'What the shape is called in the legend and in Trash; 1 to 200 characters.',
  'tone', 'Color role it is drawn in; defaults by kind (Route Info, Barrier Danger, Area Accent, Label Neutral).',
  'geometry', 'SRID 0 geometry in fractions of the drawing''s width (x, 0 to 1 from the left) and height (y, 0 to 1 from the top): a line of 2 to 500 points for a Route or Barrier, a simple polygon of 3 to 500 vertices for an Area, a point for a Label.'
]);
call private.install_default_retention('app.site_plan_shapes');
call private.install_audit_trail('app.site_plan_shapes');

create or replace function private.guard_site_plan_shape()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.site_plan_id <> old.site_plan_id then
    perform private.refuse('site_plan_shape_plan_immutable', 'A shape stays on its plan.');
  end if;
  if new.tone is null then
    new.tone := case new.kind when 'Route' then 'Info' when 'Barrier' then 'Danger' when 'Area' then 'Accent' else 'Neutral' end;
  end if;
  return new;
end;
$$;
comment on function private.guard_site_plan_shape() is 'Site plan shapes stay on their plan and take the tone of their kind when none is given.';
revoke all on function private.guard_site_plan_shape() from public, anon, authenticated;
create trigger t40_guard_site_plan_shape before insert or update on app.site_plan_shapes
  for each row execute function private.guard_site_plan_shape();

create trigger t90_emit_site_plan_shape_drawn after insert on app.site_plan_shapes
  for each row execute function private.emit_row_event('site_plan_shape.drawn', '-', 'site_plan_id', 'kind', 'label');
create trigger t90_emit_site_plan_shape_changed after update on app.site_plan_shapes
  for each row when (old.deleted_at is not distinct from new.deleted_at
    and ((old.label, old.tone, old.kind) is distinct from (new.label, new.tone, new.kind) or not extensions.st_equals(old.geometry, new.geometry)))
  execute function private.emit_row_event('site_plan_shape.changed', '-', 'site_plan_id', 'kind', 'label');

-- Layout lock on pins and shapes ---------------------------------------------------------------------------------------------

create or replace function private.guard_site_plan_layout_child()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from app.site_plans p where p.id = new.site_plan_id and p.plan_state <> 'Draft')
     or (tg_op = 'UPDATE' and exists (select 1 from app.site_plans p where p.id = old.site_plan_id and p.plan_state <> 'Draft')) then
    perform private.refuse('site_plan_locked', 'This plan is locked or live. Unlock it to change its layout.');
  end if;
  return new;
end;
$$;
comment on function private.guard_site_plan_layout_child() is 'Before insert or update on site plan pins and shapes: only a Draft plan takes them, archiving included (site_plan_locked, ADR 0140 D1). Records that point at a pin, such as punch items, are not layout writes.';
revoke all on function private.guard_site_plan_layout_child() from public, anon, authenticated;
create trigger t44_guard_site_plan_pin_layout before insert or update on app.site_plan_pins
  for each row execute function private.guard_site_plan_layout_child();
create trigger t44_guard_site_plan_shape_layout before insert or update on app.site_plan_shapes
  for each row execute function private.guard_site_plan_layout_child();

-- Shape writes ---------------------------------------------------------------------------------------------------------------

create or replace function app.save_site_plan_shape(
  p_id uuid,
  p_site_plan_id uuid,
  p_kind app.site_plan_shape_kind,
  p_label text,
  p_tone app.site_plan_shape_tone,
  p_points jsonb
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_points extensions.geometry[] := '{}';
  v_point jsonb;
  v_geometry extensions.geometry;
  v_id uuid;
begin
  if p_points is null or jsonb_typeof(p_points) <> 'array' or jsonb_array_length(p_points) = 0 or jsonb_array_length(p_points) > 500 then
    raise exception using errcode = 'XR001', hint = 'site_plan_shape_geometry',
        message = 'site_plan_shape_geometry: Give the shape 1 to 500 points as pairs of across and down.';
  end if;
  for v_point in select e from jsonb_array_elements(p_points) e loop
    if jsonb_typeof(v_point) <> 'array' or jsonb_array_length(v_point) <> 2
       or jsonb_typeof(v_point -> 0) <> 'number' or jsonb_typeof(v_point -> 1) <> 'number' then
      raise exception using errcode = 'XR001', hint = 'site_plan_shape_geometry',
        message = 'site_plan_shape_geometry: Each point is a pair of numbers, across and down, from 0 to 1.';
    end if;
    v_points := v_points || extensions.st_makepoint((v_point ->> 0)::double precision, (v_point ->> 1)::double precision);
  end loop;
  if p_kind = 'Label' then
    if cardinality(v_points) <> 1 then
      raise exception using errcode = 'XR001', hint = 'site_plan_shape_geometry',
        message = 'site_plan_shape_geometry: A label sits at one point.';
    end if;
    v_geometry := v_points[1];
  elsif p_kind = 'Area' then
    if cardinality(v_points) < 3 then
      raise exception using errcode = 'XR001', hint = 'site_plan_shape_geometry',
        message = 'site_plan_shape_geometry: An area has at least three corners.';
    end if;
    if not extensions.st_equals(v_points[1], v_points[cardinality(v_points)]) then
      v_points := v_points || v_points[1];
    end if;
    if cardinality(v_points) < 4 then
      raise exception using errcode = 'XR001', hint = 'site_plan_shape_geometry',
        message = 'site_plan_shape_geometry: An area has at least three corners.';
    end if;
    v_geometry := extensions.st_makepolygon(extensions.st_makeline(v_points));
  else
    if cardinality(v_points) < 2 then
      raise exception using errcode = 'XR001', hint = 'site_plan_shape_geometry',
        message = 'site_plan_shape_geometry: A route or barrier has at least two points.';
    end if;
    v_geometry := extensions.st_makeline(v_points);
  end if;
  v_geometry := extensions.st_setsrid(v_geometry, 0);
  begin
    if p_id is null then
      insert into app.site_plan_shapes (site_plan_id, kind, label, tone, geometry)
      values (p_site_plan_id, p_kind, btrim(coalesce(p_label, '')), p_tone, v_geometry)
      returning id into v_id;
    else
      update app.site_plan_shapes s
      set kind = p_kind, label = btrim(coalesce(p_label, '')), tone = coalesce(p_tone, s.tone), geometry = v_geometry
      where s.id = p_id and s.site_plan_id = p_site_plan_id and s.deleted_at is null
      returning s.id into v_id;
      if v_id is null then
        raise exception using errcode = '42501', message = 'site plan shape not found';
      end if;
    end if;
  exception when check_violation then
    raise exception using errcode = 'XR001', hint = 'site_plan_shape_geometry',
        message = 'site_plan_shape_geometry: The shape needs a label and must lie inside the drawing: a line with length, or an area that does not cross itself.';
  end;
  return v_id;
end;
$$;

comment on function app.save_site_plan_shape(uuid, uuid, app.site_plan_shape_kind, text, app.site_plan_shape_tone, jsonb) is 'Draws (p_id null) or reshapes a shape on a site plan from a JSON list of [across, down] points from 0 to 1, closing an area''s ring. Runs as the caller, so the plan''s write policy and the layout lock decide; as an invoker it raises its refusal (SQLSTATE XR001, rule site_plan_shape_geometry) itself rather than through private.refuse. Returns the shape id.';
revoke all on function app.save_site_plan_shape(uuid, uuid, app.site_plan_shape_kind, text, app.site_plan_shape_tone, jsonb) from public, anon;
grant execute on function app.save_site_plan_shape(uuid, uuid, app.site_plan_shape_kind, text, app.site_plan_shape_tone, jsonb) to authenticated, service_role;

-- Measured shapes --------------------------------------------------------------------------------------------------------------

create view app.site_plan_shape_geometry with (security_invoker = true) as
select s.id, s.site_plan_id, s.kind, s.label, s.tone,
  (extensions.st_asgeojson(s.geometry)::jsonb) -> 'coordinates' as points_geojson,
  case
    when m.feet_per_px is null or s.kind = 'Label' then null
    when s.kind = 'Area' then extensions.st_perimeter(m.scaled) * m.feet_per_px
    else extensions.st_length(m.scaled) * m.feet_per_px
  end::numeric as length_ft,
  case when m.feet_per_px is not null and s.kind = 'Area' then extensions.st_area(m.scaled) * m.feet_per_px * m.feet_per_px end::numeric as area_sq_ft
from app.site_plan_shapes s
join app.site_plans p on p.id = s.site_plan_id
cross join lateral (
  select extensions.st_scale(s.geometry, p.image_width_px, p.image_height_px) as scaled,
    case when p.calibration_feet is not null and p.image_width_px is not null then
      p.calibration_feet::double precision / sqrt(
        power((p.calibration_bx - p.calibration_ax)::double precision * p.image_width_px, 2)
        + power((p.calibration_by - p.calibration_ay)::double precision * p.image_height_px, 2))
    end as feet_per_px
) m
where s.deleted_at is null;

call private.describe('app.site_plan_shape_geometry', 'Live shapes of each site plan with their measurements (ADR 0140 D4): the shape is scaled to the drawing''s pixels and measured with the plan''s calibration (feet per pixel is the calibrated distance in feet over its length in pixels). Computed, never stored; runs as the reader.', array[
  'id', 'Shape.',
  'site_plan_id', 'Site plan.',
  'kind', 'Route, Barrier, Area or Label.',
  'label', 'Shape label.',
  'tone', 'Color role.',
  'points_geojson', 'GeoJSON coordinates of the shape in plan space: a point, a list of points, or a list of rings.',
  'length_ft', 'Length of a route or barrier, or perimeter of an area, in feet; NULL for a label and while the plan is uncalibrated.',
  'area_sq_ft', 'Area of an area shape in square feet; NULL for other kinds and while the plan is uncalibrated.'
]);
revoke all on app.site_plan_shape_geometry from public, anon;
grant select on app.site_plan_shape_geometry to authenticated, service_role;
revoke select on app.site_plan_shape_geometry from xos_backup;
