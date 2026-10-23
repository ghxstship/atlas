-- 1550_project_measurements.sql
-- A98 (range 1550 to 1559, RRR-143), finding A65-030, Section 4.10 ("Sustainability: waste, energy, water and transport
-- figures are captured per project where measured, and reported against the Bible sustainability tags. An unmeasured
-- figure stays NULL and shows as Unmeasured, never zero." and "Gate 8 measurement: audience, earned media and sentiment
-- figures are entered or imported against the objectives recorded at gate 1"), canon criteria G1.OBJECTIVES_STATED and
-- G8.MEASUREMENT_REPORTED (Bible tab 06). ADR 0054.
--   * private.measurement_units, surfaced as app.measurement_units: the units a figure is entered in, each with its
--     dimension and its exact factor to the dimension's base unit (kg, l, kWh, kg CO2e, count, percent), and the unit a
--     report shows the dimension in for metric and for imperial readers (the locale.units setting)
--   * private.measurement_metrics, surfaced as app.measurement_metrics: the figures a project measures. Canon's metric
--     table (xpms.dim_metric, Bible tab 16) holds code-derived and modeled reference values, not these figures, and
--     owner decision 25 adds no row to a Bible list; so each metric is defined here and names the canon metric that
--     benchmarks it where canon states one
--   * private.measurement_metric_tags, surfaced as app.measurement_metric_tags: the Bible sustainability tags
--     (xpms.dim_tag, tab 09) each sustainability figure is reported against
--   * app.project_objectives: the target per metric recorded at gate 1. Evidence writers draft them while gate 1 is open;
--     once the gate is passed only a gate approver (projects.gate.transition) sets, changes or withdraws one. Every
--     change lands in the audit ledger
--   * app.project_measurements: one figure per metric, day and source. The value is NULL when the figure was not
--     measured, which reports show as Unmeasured, never as zero. A correction of the value, unit or day needs a reason
--     and is written, with the figure before and after, to app.project_measurement_corrections, as is a withdrawal or
--     restore
-- Read with projects.gate.read on the project (invariant 2); written with projects.gate.evidence.write, as the
-- attendance figures of 0636 are.

-- Enums ------------------------------------------------------------------------------------------------------------

create type app.measurement_source as enum ('Manual', 'Import', 'Integration');
comment on type app.measurement_source is 'How a figure reached XOS: typed by a person (Manual), from a file (Import) or from a connected service (Integration).';

create type app.objective_direction as enum ('At Least', 'At Most');
comment on type app.objective_direction is 'Whether an objective is met by reaching its target (At Least, such as attendance) or by staying within it (At Most, such as waste).';

create type app.measurement_correction_kind as enum ('Corrected', 'Withdrawn', 'Restored');
comment on type app.measurement_correction_kind is 'What changed a recorded figure: its value, unit or day was corrected, or the figure was withdrawn or restored.';

-- Units --------------------------------------------------------------------------------------------------------------

create table private.measurement_units (
  unit_code text primary key,
  dimension text not null,
  factor_to_base numeric not null,
  unit_system text not null,
  is_display boolean not null default false,
  ordinal integer not null unique,
  constraint measurement_units_code_format check (unit_code ~ '^[a-z][a-z0-9_]*$'),
  constraint measurement_units_dimension check (dimension in ('Mass', 'Volume', 'Energy', 'Emissions', 'Count', 'Percent')),
  constraint measurement_units_factor check (factor_to_base > 0),
  constraint measurement_units_system check (unit_system in ('Metric', 'Imperial', 'Either')),
  constraint measurement_units_ordinal check (ordinal > 0),
  constraint measurement_units_unit_dimension_key unique (unit_code, dimension)
);

create unique index measurement_units_display_key on private.measurement_units (dimension, unit_system) where is_display;

comment on table private.measurement_units is 'Units a project figure or objective is entered in (A65-030). Factors are exact, so a figure converts to its base unit without rounding.';
comment on column private.measurement_units.unit_code is 'Unit code, such as kg, lb or kwh; its label comes from the message catalog.';
comment on column private.measurement_units.dimension is 'What the unit measures: Mass, Volume, Energy, Emissions, Count or Percent. Figures convert only within a dimension.';
comment on column private.measurement_units.factor_to_base is 'Base units in one of this unit: 0.45359237 kg in a pound, 3.785411784 l in a US gallon. The base unit has factor 1.';
comment on column private.measurement_units.unit_system is 'Metric, Imperial, or Either for units both systems use (kWh, kg CO2e, count, percent).';
comment on column private.measurement_units.is_display is 'True for the unit reports show the dimension in for readers of its system (the locale.units setting); one per dimension and system.';
comment on column private.measurement_units.ordinal is 'Display order.';

insert into private.measurement_units (unit_code, dimension, factor_to_base, unit_system, is_display, ordinal) values
  ('kg', 'Mass', 1, 'Metric', true, 1),
  ('t', 'Mass', 1000, 'Metric', false, 2),
  ('lb', 'Mass', 0.45359237, 'Imperial', true, 3),
  ('short_ton', 'Mass', 907.18474, 'Imperial', false, 4),
  ('l', 'Volume', 1, 'Metric', true, 5),
  ('m3', 'Volume', 1000, 'Metric', false, 6),
  ('gal', 'Volume', 3.785411784, 'Imperial', true, 7),
  ('kwh', 'Energy', 1, 'Either', true, 8),
  ('mwh', 'Energy', 1000, 'Either', false, 9),
  ('kg_co2e', 'Emissions', 1, 'Either', true, 10),
  ('t_co2e', 'Emissions', 1000, 'Either', false, 11),
  ('count', 'Count', 1, 'Either', true, 12),
  ('percent', 'Percent', 1, 'Either', true, 13);

alter table private.measurement_units enable row level security;
revoke all on private.measurement_units from public, anon, authenticated;
grant select on private.measurement_units to service_role;

create view app.measurement_units as
select u.unit_code, u.dimension, u.factor_to_base, u.unit_system, u.is_display, u.ordinal
from private.measurement_units u;

call private.describe('app.measurement_units', 'Units a project figure or objective is entered in, with the exact factor to the base unit of their dimension and the unit reports show each dimension in for metric and imperial readers.', array[
  'unit_code', 'Unit code.',
  'dimension', 'Mass, Volume, Energy, Emissions, Count or Percent.',
  'factor_to_base', 'Base units in one of this unit.',
  'unit_system', 'Metric, Imperial or Either.',
  'is_display', 'True for the unit reports show the dimension in for readers of its system.',
  'ordinal', 'Display order.'
]);

revoke all on app.measurement_units from public, anon;
grant select on app.measurement_units to authenticated, service_role;

-- Metrics ------------------------------------------------------------------------------------------------------------

create table private.measurement_metrics (
  metric_code text primary key,
  family text not null,
  dimension text not null,
  base_unit_code text not null,
  aggregation text not null,
  is_derived boolean not null default false,
  lower_bound numeric,
  upper_bound numeric,
  canon_domain xpms.canon_code,
  canon_item xpms.canon_text,
  ordinal integer not null unique,
  constraint measurement_metrics_code_format check (metric_code ~ '^[a-z][a-z0-9_]*$'),
  constraint measurement_metrics_family check (family in ('Sustainability', 'Audience', 'Earned Media', 'Sentiment')),
  constraint measurement_metrics_aggregation check (aggregation in ('Sum', 'Latest')),
  constraint measurement_metrics_bounds check (lower_bound is null or upper_bound is null or lower_bound <= upper_bound),
  constraint measurement_metrics_canon_pair check ((canon_domain is null) = (canon_item is null)),
  constraint measurement_metrics_ordinal check (ordinal > 0),
  constraint measurement_metrics_base_unit_fkey foreign key (base_unit_code, dimension)
    references private.measurement_units (unit_code, dimension),
  constraint measurement_metrics_canon_fkey foreign key (canon_domain, canon_item) references xpms.dim_metric (domain, item)
);

create index measurement_metrics_base_unit_idx on private.measurement_metrics (base_unit_code, dimension);
create index measurement_metrics_canon_idx on private.measurement_metrics (canon_domain, canon_item);

comment on table private.measurement_metrics is 'Figures a project measures (Section 4.10, A65-030): sustainability, audience, earned media and sentiment. Canon (xpms.dim_metric) holds reference values, not these figures, so each is defined here and names the canon metric that benchmarks it where canon states one (ADR 0054).';
comment on column private.measurement_metrics.metric_code is 'Metric code, such as waste_generated; its label comes from the message catalog.';
comment on column private.measurement_metrics.family is 'Sustainability, Audience, Earned Media or Sentiment.';
comment on column private.measurement_metrics.dimension is 'Dimension of the figure; it is entered in any unit of this dimension.';
comment on column private.measurement_metrics.base_unit_code is 'Unit with factor 1 in the dimension; totals and comparisons are computed in it.';
comment on column private.measurement_metrics.aggregation is 'How a project''s figures combine: Sum (each day or show adds to the total) or Latest (the most recent measured figure stands).';
comment on column private.measurement_metrics.is_derived is 'True when the figure is computed from records rather than entered: earned media figures come from app.earned_media_items.';
comment on column private.measurement_metrics.lower_bound is 'Lowest figure accepted, in the base unit; NULL for none.';
comment on column private.measurement_metrics.upper_bound is 'Highest figure accepted, in the base unit; NULL for none.';
comment on column private.measurement_metrics.canon_domain is 'Domain of the canon metric (xpms.dim_metric) that benchmarks the figure, when canon states one.';
comment on column private.measurement_metrics.canon_item is 'Item of the canon metric that benchmarks the figure, when canon states one.';
comment on column private.measurement_metrics.ordinal is 'Display order.';

insert into private.measurement_metrics (metric_code, family, dimension, base_unit_code, aggregation, is_derived, lower_bound, upper_bound, canon_domain, canon_item, ordinal) values
  ('waste_generated', 'Sustainability', 'Mass', 'kg', 'Sum', false, 0, null, 'site_services', 'Waste lbs per guest per day', 1),
  ('waste_diverted', 'Sustainability', 'Mass', 'kg', 'Sum', false, 0, null, null, null, 2),
  ('energy_used', 'Sustainability', 'Energy', 'kwh', 'Sum', false, 0, null, null, null, 3),
  ('water_used', 'Sustainability', 'Volume', 'l', 'Sum', false, 0, null, 'site_services', 'Potable water gal/person/day', 4),
  ('transport_emissions', 'Sustainability', 'Emissions', 'kg_co2e', 'Sum', false, 0, null, null, null, 5),
  ('attendance', 'Audience', 'Count', 'count', 'Sum', false, 0, null, null, null, 6),
  ('online_audience', 'Audience', 'Count', 'count', 'Sum', false, 0, null, null, null, 7),
  ('earned_media_items', 'Earned Media', 'Count', 'count', 'Sum', true, 0, null, null, null, 8),
  ('earned_media_reach', 'Earned Media', 'Count', 'count', 'Sum', true, 0, null, null, null, 9),
  ('positive_sentiment', 'Sentiment', 'Percent', 'percent', 'Latest', false, 0, 100, null, null, 10);

alter table private.measurement_metrics enable row level security;
revoke all on private.measurement_metrics from public, anon, authenticated;
grant select on private.measurement_metrics to service_role;

create view app.measurement_metrics as
select m.metric_code, m.family, m.dimension, m.base_unit_code, m.aggregation, m.is_derived, m.lower_bound, m.upper_bound,
  m.canon_domain, m.canon_item, d.value_numeric as canon_value_numeric, d.value_text as canon_value_text,
  d.qualifier as canon_qualifier, m.ordinal
from private.measurement_metrics m
left join xpms.dim_metric d on d.domain = m.canon_domain and d.item = m.canon_item;

call private.describe('app.measurement_metrics', 'Figures a project measures against its gate 1 objectives (Section 4.10): sustainability, audience, earned media and sentiment, with the canon benchmark where canon states one.', array[
  'metric_code', 'Metric code.',
  'family', 'Sustainability, Audience, Earned Media or Sentiment.',
  'dimension', 'Dimension of the figure.',
  'base_unit_code', 'Unit totals and comparisons are computed in.',
  'aggregation', 'Sum or Latest.',
  'is_derived', 'True when the figure is computed from coverage records rather than entered.',
  'lower_bound', 'Lowest figure accepted, in the base unit.',
  'upper_bound', 'Highest figure accepted, in the base unit.',
  'canon_domain', 'Domain of the benchmarking canon metric.',
  'canon_item', 'Item of the benchmarking canon metric.',
  'canon_value_numeric', 'The canon benchmark as a number, when canon states one.',
  'canon_value_text', 'The canon benchmark in words, when canon states it so.',
  'canon_qualifier', 'Qualifier of the canon benchmark, such as MODELED event avg.',
  'ordinal', 'Display order.'
]);

revoke all on app.measurement_metrics from public, anon;
grant select on app.measurement_metrics to authenticated, service_role;

-- Sustainability tags ------------------------------------------------------------------------------------------------

create table private.measurement_metric_tags (
  metric_code text not null references private.measurement_metrics (metric_code),
  tag_id xpms.canon_code not null references xpms.dim_tag (tag_id),
  primary key (metric_code, tag_id)
);

create index measurement_metric_tags_tag_idx on private.measurement_metric_tags (tag_id);

comment on table private.measurement_metric_tags is 'The Bible sustainability tags (Bible tab 09) a sustainability figure is reported against (Section 4.10): what the figure evidences about the tagged items of a project.';
comment on column private.measurement_metric_tags.metric_code is 'Sustainability metric.';
comment on column private.measurement_metric_tags.tag_id is 'Sustainability tag the figure is reported against.';

insert into private.measurement_metric_tags (metric_code, tag_id) values
  ('waste_generated', 'TAG-005'), ('waste_generated', 'TAG-009'), ('waste_generated', 'TAG-014'), ('waste_generated', 'TAG-020'),
  ('waste_diverted', 'TAG-005'), ('waste_diverted', 'TAG-009'), ('waste_diverted', 'TAG-020'), ('waste_diverted', 'TAG-024'),
  ('waste_diverted', 'TAG-025'),
  ('energy_used', 'TAG-001'), ('energy_used', 'TAG-015'), ('energy_used', 'TAG-027'), ('energy_used', 'TAG-032'),
  ('energy_used', 'TAG-037'),
  ('transport_emissions', 'TAG-001'), ('transport_emissions', 'TAG-029'), ('transport_emissions', 'TAG-030');

alter table private.measurement_metric_tags enable row level security;
revoke all on private.measurement_metric_tags from public, anon, authenticated;
grant select on private.measurement_metric_tags to service_role;

create view app.measurement_metric_tags as
select t.metric_code, t.tag_id, d.tag
from private.measurement_metric_tags t
join xpms.dim_tag d on d.tag_id = t.tag_id;

call private.describe('app.measurement_metric_tags', 'The Bible sustainability tags each sustainability figure is reported against (Section 4.10).', array[
  'metric_code', 'Sustainability metric.',
  'tag_id', 'Canon tag code, TAG-nnn.',
  'tag', 'Tag value as written in canon, such as REUSABLE.'
]);

revoke all on app.measurement_metric_tags from public, anon;
grant select on app.measurement_metric_tags to authenticated, service_role;

-- Figure checks ------------------------------------------------------------------------------------------------------

create or replace function private.assert_measurement_figure(p_metric_code text, p_unit_code text, p_value numeric)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_metric private.measurement_metrics;
  v_unit private.measurement_units;
  v_base numeric;
begin
  select * into v_metric from private.measurement_metrics m where m.metric_code = p_metric_code;
  if p_unit_code is not null then
    select * into v_unit from private.measurement_units u where u.unit_code = p_unit_code;
    if v_unit.dimension is distinct from v_metric.dimension then
      perform private.refuse('measurement_unit_dimension',
        format('%s is not a unit of %s; use a %s unit.', p_unit_code, p_metric_code, lower(v_metric.dimension)));
    end if;
  end if;
  if p_value is null then
    return;
  end if;
  if p_unit_code is null then
    perform private.refuse('measurement_unit_required', 'A measured figure names its unit.');
  end if;
  v_base := p_value * v_unit.factor_to_base;
  if (v_metric.lower_bound is not null and v_base < v_metric.lower_bound)
     or (v_metric.upper_bound is not null and v_base > v_metric.upper_bound) then
    perform private.refuse('measurement_out_of_range',
      format('%s takes figures from %s to %s %s.', p_metric_code, coalesce(v_metric.lower_bound::text, 'any'),
        coalesce(v_metric.upper_bound::text, 'any'), v_metric.base_unit_code));
  end if;
  if v_metric.dimension = 'Count' and v_base <> trunc(v_base) then
    perform private.refuse('measurement_whole_count', 'A count is a whole number.');
  end if;
end;
$$;

comment on function private.assert_measurement_figure(text, text, numeric) is 'Refuses a figure or target whose unit is of another dimension than its metric, a measured value without a unit, a value outside the metric''s bounds (compared in the base unit) and a fractional count. A NULL value (Unmeasured) passes.';

revoke all on function private.assert_measurement_figure(text, text, numeric) from public, anon, authenticated;

create or replace function private.project_gate_passed(p_project_id uuid, p_gate integer)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.project_phase_transitions t where t.project_id = p_project_id and t.gate = p_gate);
$$;

comment on function private.project_gate_passed(uuid, integer) is 'True once the project has passed the gate (app.project_phase_transitions, written only by app.pass_gate).';

revoke all on function private.project_gate_passed(uuid, integer) from public, anon, authenticated;

-- Objectives ---------------------------------------------------------------------------------------------------------

create table app.project_objectives (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  metric_code text not null references private.measurement_metrics (metric_code),
  direction app.objective_direction not null,
  target_value numeric not null,
  unit_code text not null references private.measurement_units (unit_code),
  note text,
  constraint project_objectives_note_length check (note is null or char_length(btrim(note)) between 1 and 2000)
);

call private.install_domain_table('app.project_objectives', 'app.projects', 'project_id');

create unique index project_objectives_metric_key on app.project_objectives (project_id, metric_code) where deleted_at is null;
create index project_objectives_metric_code_idx on app.project_objectives (metric_code);
create index project_objectives_unit_code_idx on app.project_objectives (unit_code);

call private.describe('app.project_objectives', 'Measurable objectives of a project, recorded at gate 1 (canon criterion G1.OBJECTIVES_STATED): one target per metric, which gate 8 measures against (G8.MEASUREMENT_REPORTED). Drafted while gate 1 is open; once it is passed only a gate approver changes them, and every change lands in the audit ledger.', array[
  'project_id', 'Project the objective is for.',
  'metric_code', 'Metric the objective sets a target for (app.measurement_metrics); one live objective per metric.',
  'direction', 'At Least (met by reaching the target) or At Most (met by staying within it).',
  'target_value', 'Target figure, in unit_code.',
  'unit_code', 'Unit of the target, of the metric''s dimension; reports convert it.',
  'note', 'Why the target was chosen or how it is measured.'
]);

create or replace function private.guard_project_objective()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.project_id <> old.project_id or new.metric_code <> old.metric_code) then
    perform private.refuse('project_objective_immutable', 'An objective keeps its project and metric; withdraw it and set another.');
  end if;
  perform private.assert_measurement_figure(new.metric_code, new.unit_code, new.target_value);
  if private.project_gate_passed(new.project_id, 1) and not private.can_on_project(new.project_id, 'projects.gate.transition') then
    perform private.refuse('project_objectives_locked',
      'Gate 1 has been passed: only a gate approver sets, changes or withdraws the objectives it recorded.');
  end if;
  return new;
end;
$$;

comment on function private.guard_project_objective() is 'Objectives keep their project and metric, take a unit of the metric''s dimension and a target within its bounds, and after gate 1 change only by a holder of projects.gate.transition on the project.';

revoke all on function private.guard_project_objective() from public, anon, authenticated;

create trigger t40_guard_project_objective before insert or update on app.project_objectives
  for each row execute function private.guard_project_objective();

call private.install_policies('app.project_objectives',
  $$project_id in (select private.project_ids_with('projects.gate.read'))$$,
  $$project_id in (select private.project_ids_with('projects.gate.evidence.write'))$$);
call private.install_audit_trail('app.project_objectives');
call private.install_default_retention('app.project_objectives');

-- Measurements -------------------------------------------------------------------------------------------------------

create table app.project_measurements (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  metric_code text not null references private.measurement_metrics (metric_code),
  measured_on date not null,
  value numeric,
  unit_code text references private.measurement_units (unit_code),
  source app.measurement_source not null default 'Manual',
  source_reference text,
  source_uri text,
  note text,
  correction_reason text,
  constraint project_measurements_unit_given check (value is null or unit_code is not null),
  constraint project_measurements_source_reference_length check (source_reference is null or char_length(btrim(source_reference)) between 1 and 300),
  constraint project_measurements_source_uri_format check (source_uri is null or (char_length(source_uri) <= 2000 and source_uri ~* '^(https?://|urn:)\S+$')),
  constraint project_measurements_note_length check (note is null or char_length(btrim(note)) between 1 and 2000),
  constraint project_measurements_correction_reason_length check (correction_reason is null or char_length(btrim(correction_reason)) between 1 and 500)
);

call private.install_domain_table('app.project_measurements', 'app.projects', 'project_id');

create index project_measurements_project_metric_idx on app.project_measurements (project_id, metric_code, measured_on);
create index project_measurements_metric_code_idx on app.project_measurements (metric_code);
create index project_measurements_unit_code_idx on app.project_measurements (unit_code);

call private.describe('app.project_measurements', 'Figures measured on a project (Section 4.10): waste, energy, water and transport, audience and sentiment, each per metric, day and source. A NULL value is a figure that was not measured and reports show it as Unmeasured, never as zero. Corrections of the value, unit or day need a reason and are written to app.project_measurement_corrections. Who recorded a figure and when are created_by and created_at.', array[
  'project_id', 'Project measured.',
  'metric_code', 'Metric measured (app.measurement_metrics); earned media figures are not entered here but come from app.earned_media_items.',
  'measured_on', 'Day the figure covers, on the project''s calendar (private.project_today when not given); never after today there.',
  'value', 'The figure in unit_code; NULL when it was not measured (Unmeasured), never zero for a missing figure.',
  'unit_code', 'Unit of the figure, of the metric''s dimension; required when value is set.',
  'source', 'Manual, Import or Integration.',
  'source_reference', 'What the figure came from, such as a hauler''s invoice, a meter reading or a file name.',
  'source_uri', 'Link to the source, an http(s) URL or a URN.',
  'note', 'Note on the figure.',
  'correction_reason', 'Why a correction is made: required when the value, unit or day changes, written to the correction ledger with the change, and never stored on the row.'
]);

create table app.project_measurement_corrections (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_measurement_id uuid not null references app.project_measurements (id),
  correction_kind app.measurement_correction_kind not null,
  previous_value numeric,
  previous_unit_code text references private.measurement_units (unit_code),
  previous_measured_on date not null,
  value numeric,
  unit_code text references private.measurement_units (unit_code),
  measured_on date not null,
  reason text,
  constraint project_measurement_corrections_reason check (correction_kind <> 'Corrected' or reason is not null),
  constraint project_measurement_corrections_reason_length check (reason is null or char_length(btrim(reason)) between 1 and 500)
);

create index project_measurement_corrections_measurement_idx on app.project_measurement_corrections (project_measurement_id);
create index project_measurement_corrections_previous_unit_idx on app.project_measurement_corrections (previous_unit_code);
create index project_measurement_corrections_unit_idx on app.project_measurement_corrections (unit_code);

call private.install_domain_table('app.project_measurement_corrections', 'app.project_measurements', 'project_measurement_id', '{}', true);
call private.describe('app.project_measurement_corrections', 'Append-only ledger of every correction, withdrawal and restore of a recorded figure, with the figure before and after and the reason. Who made the change and when are created_by and created_at. Written only by the measurement guard.', array[
  'project_measurement_id', 'Figure that changed.',
  'correction_kind', 'Corrected, Withdrawn or Restored.',
  'previous_value', 'Value before the change; NULL when it was Unmeasured.',
  'previous_unit_code', 'Unit before the change.',
  'previous_measured_on', 'Day before the change.',
  'value', 'Value after the change; NULL when Unmeasured.',
  'unit_code', 'Unit after the change.',
  'measured_on', 'Day after the change.',
  'reason', 'Why the figure changed; required for a correction.'
]);

call private.install_policies('app.project_measurement_corrections',
  $$project_measurement_id in (select m.id from app.project_measurements m
     where m.project_id in (select private.project_ids_with('projects.gate.read')))$$);

create or replace function private.guard_project_measurement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := nullif(btrim(new.correction_reason), '');
  v_today date;
begin
  if tg_op = 'INSERT' then
    if exists (select 1 from private.measurement_metrics m where m.metric_code = new.metric_code and m.is_derived) then
      perform private.refuse('measurement_metric_derived',
        format('%s is computed from the earned media coverage records; add coverage instead.', new.metric_code));
    end if;
    v_today := private.project_today(new.project_id);
    new.measured_on := coalesce(new.measured_on, v_today);
    if new.measured_on > v_today then
      perform private.refuse('measurement_in_future', 'A figure is measured on or before today on the project''s calendar.');
    end if;
    perform private.assert_measurement_figure(new.metric_code, new.unit_code, new.value);
    new.correction_reason := null;
    return new;
  end if;

  if new.project_id <> old.project_id or new.metric_code <> old.metric_code or new.source <> old.source then
    perform private.refuse('project_measurement_immutable',
      'A figure keeps its project, metric and source; withdraw it and record another.');
  end if;
  if new.value is distinct from old.value or new.unit_code is distinct from old.unit_code or new.measured_on <> old.measured_on then
    if v_reason is null then
      perform private.refuse('measurement_correction_reason', 'Say why the figure is corrected.');
    end if;
    if new.measured_on > private.project_today(new.project_id) then
      perform private.refuse('measurement_in_future', 'A figure is measured on or before today on the project''s calendar.');
    end if;
    perform private.assert_measurement_figure(new.metric_code, new.unit_code, new.value);
    insert into app.project_measurement_corrections (project_measurement_id, correction_kind, previous_value, previous_unit_code,
      previous_measured_on, value, unit_code, measured_on, reason)
    values (new.id, 'Corrected', old.value, old.unit_code, old.measured_on, new.value, new.unit_code, new.measured_on, v_reason);
  end if;
  if new.deleted_at is distinct from old.deleted_at then
    insert into app.project_measurement_corrections (project_measurement_id, correction_kind, previous_value, previous_unit_code,
      previous_measured_on, value, unit_code, measured_on, reason)
    values (new.id, case when new.deleted_at is null then 'Restored' else 'Withdrawn' end::app.measurement_correction_kind,
      old.value, old.unit_code, old.measured_on, new.value, new.unit_code, new.measured_on, v_reason);
  end if;
  new.correction_reason := null;
  return new;
end;
$$;

comment on function private.guard_project_measurement() is 'Figures: earned media metrics are never entered by hand, the day defaults to and never passes today on the project''s calendar, units and bounds follow the metric, and project, metric and source never change. A change of the value, unit or day needs correction_reason and, like a withdrawal or restore, is written to app.project_measurement_corrections; the reason is never stored on the row.';

revoke all on function private.guard_project_measurement() from public, anon, authenticated;

create trigger t40_guard_project_measurement before insert or update on app.project_measurements
  for each row execute function private.guard_project_measurement();

call private.install_policies('app.project_measurements',
  $$project_id in (select private.project_ids_with('projects.gate.read'))$$,
  $$project_id in (select private.project_ids_with('projects.gate.evidence.write'))$$);
call private.install_audit_trail('app.project_measurements');
call private.install_default_retention('app.project_measurements');
call private.install_default_retention('app.project_measurement_corrections');
