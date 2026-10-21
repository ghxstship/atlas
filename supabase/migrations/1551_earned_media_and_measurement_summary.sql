-- 1551_earned_media_and_measurement_summary.sql
-- A98 (range 1550 to 1559, RRR-143), finding A65-030, Section 4.10 ("Gate 8 measurement: audience, earned media and
-- sentiment figures are entered or imported against the objectives recorded at gate 1"), canon criterion
-- G8.MEASUREMENT_REPORTED and the Item Catalog's Earned Media & Coverage Report (3000.03.01-XPMS-004: coverage
-- "sourced and dated"). ADR 0054.
--   * app.earned_media_items: the home of earned media figures, one row per piece of coverage with its outlet, medium,
--     date, link, reach and tone. Reach is NULL when the source does not report it, which reports show as Unmeasured;
--     a tone is NULL until someone rates it. The earned media metrics of 1550 (earned_media_items and
--     earned_media_reach) are computed from these rows, never typed in
--   * app.project_measurement_summary: per project and metric, the gate 1 objective against the figures measured, in
--     the metric's base unit. Totals are over measured figures only, with the unmeasured count beside them; a metric
--     with no measured figure has a NULL total (Unmeasured), never zero. The outcome is Met, Not Met, Incomplete (a
--     total with unmeasured figures that cannot yet decide the objective) or Unmeasured

-- Earned media -------------------------------------------------------------------------------------------------------

create type app.coverage_medium as enum ('Online', 'Print', 'Broadcast', 'Podcast', 'Social');
comment on type app.coverage_medium is 'Where a piece of earned media coverage ran.';

create type app.coverage_tone as enum ('Positive', 'Neutral', 'Negative');
comment on type app.coverage_tone is 'Sentiment of a piece of coverage toward the project.';

create table app.earned_media_items (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  title text not null,
  outlet text not null,
  medium app.coverage_medium not null,
  published_on date not null,
  url text,
  reach bigint,
  tone app.coverage_tone,
  source app.measurement_source not null default 'Manual',
  source_reference text,
  note text,
  constraint earned_media_items_title_length check (char_length(btrim(title)) between 1 and 300),
  constraint earned_media_items_outlet_length check (char_length(btrim(outlet)) between 1 and 200),
  constraint earned_media_items_url_format check (url is null or (char_length(url) <= 2000 and url ~* '^https?://\S+$')),
  constraint earned_media_items_reach check (reach is null or reach >= 0),
  constraint earned_media_items_source_reference_length check (source_reference is null or char_length(btrim(source_reference)) between 1 and 300),
  constraint earned_media_items_note_length check (note is null or char_length(btrim(note)) between 1 and 2000)
);

call private.install_domain_table('app.earned_media_items', 'app.projects', 'project_id');

create index earned_media_items_project_idx on app.earned_media_items (project_id, published_on);
create unique index earned_media_items_url_key on app.earned_media_items (project_id, lower(url)) where url is not null and deleted_at is null;

call private.describe('app.earned_media_items', 'Earned media coverage of a project (gate 8, G8.MEASUREMENT_REPORTED): one row per piece of coverage, sourced and dated, with its link, reach and tone. The earned media figures of the measurement report are computed from these rows. A reach the source does not report is NULL and shows as Unmeasured; who recorded the row and when are created_by and created_at.', array[
  'project_id', 'Project covered.',
  'title', 'Headline or title of the coverage.',
  'outlet', 'Publication, station, channel or account that ran it.',
  'medium', 'Online, Print, Broadcast, Podcast or Social.',
  'published_on', 'Day it ran, on the project''s calendar; never after today there.',
  'url', 'Link to the coverage; one live row per link in a project.',
  'reach', 'Audience the outlet reports for the piece (readers, viewers, listeners or impressions); NULL when unreported (Unmeasured).',
  'tone', 'Positive, Neutral or Negative; NULL until rated.',
  'source', 'Manual, Import (such as a media monitoring export) or Integration.',
  'source_reference', 'What the row came from, such as a monitoring export file.',
  'note', 'Note on the coverage.'
]);

create or replace function private.guard_earned_media_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.project_id <> old.project_id then
    perform private.refuse('earned_media_item_immutable', 'Coverage stays with its project.');
  end if;
  if new.published_on > private.project_today(new.project_id) then
    perform private.refuse('earned_media_in_future', 'Coverage runs on or before today on the project''s calendar.');
  end if;
  return new;
end;
$$;

comment on function private.guard_earned_media_item() is 'Coverage stays with its project and never runs after today on the project''s calendar.';

revoke all on function private.guard_earned_media_item() from public, anon, authenticated;

create trigger t40_guard_earned_media_item before insert or update of project_id, published_on on app.earned_media_items
  for each row execute function private.guard_earned_media_item();

call private.install_policies('app.earned_media_items',
  $$project_id in (select private.project_ids_with('projects.gate.read'))$$,
  $$project_id in (select private.project_ids_with('projects.gate.evidence.write'))$$);
call private.install_audit_trail('app.earned_media_items');
call private.install_default_retention('app.earned_media_items');

-- Objectives against measurements ----------------------------------------------------------------------------------------

create view app.project_measurement_summary with (security_invoker = true) as
with recorded as (
  select m.org_id, m.project_id, m.metric_code,
    count(*) filter (where m.value is not null) as measured_count,
    count(*) filter (where m.value is null) as unmeasured_count,
    sum(m.value * u.factor_to_base) as measured_sum,
    (array_agg(m.value * u.factor_to_base order by m.measured_on desc, m.created_at desc, m.id desc)
      filter (where m.value is not null))[1] as measured_latest,
    max(m.measured_on) filter (where m.value is not null) as last_measured_on
  from app.project_measurements m
  left join app.measurement_units u on u.unit_code = m.unit_code
  where m.deleted_at is null
  group by m.org_id, m.project_id, m.metric_code
),
coverage as (
  select e.org_id, e.project_id, 'earned_media_items'::text as metric_code,
    count(*) as measured_count, 0::bigint as unmeasured_count, count(*)::numeric as measured_sum,
    null::numeric as measured_latest, max(e.published_on) as last_measured_on
  from app.earned_media_items e
  where e.deleted_at is null
  group by e.org_id, e.project_id
  union all
  select e.org_id, e.project_id, 'earned_media_reach',
    count(*) filter (where e.reach is not null), count(*) filter (where e.reach is null), sum(e.reach)::numeric,
    null::numeric, max(e.published_on) filter (where e.reach is not null)
  from app.earned_media_items e
  where e.deleted_at is null
  group by e.org_id, e.project_id
),
figures as (
  select * from recorded
  union all
  select * from coverage
),
paired as (
  select coalesce(o.org_id, f.org_id) as org_id, coalesce(o.project_id, f.project_id) as project_id,
    coalesce(o.metric_code, f.metric_code) as metric_code,
    o.id as objective_id, o.direction, o.target_value, o.unit_code as target_unit_code,
    o.target_value * ou.factor_to_base as target_base,
    coalesce(f.measured_count, 0)::integer as measured_count,
    coalesce(f.unmeasured_count, 0)::integer as unmeasured_count,
    f.measured_sum, f.measured_latest, f.last_measured_on
  from (select * from app.project_objectives where deleted_at is null) o
  full join figures f on f.project_id = o.project_id and f.metric_code = o.metric_code
  left join app.measurement_units ou on ou.unit_code = o.unit_code
)
select p.org_id, p.project_id, p.metric_code, mm.family, mm.dimension, mm.base_unit_code, mm.aggregation,
  p.objective_id, p.direction, p.target_value, p.target_unit_code, p.target_base,
  p.measured_count, p.unmeasured_count,
  case when p.measured_count = 0 then null
       when mm.aggregation = 'Latest' then p.measured_latest
       else p.measured_sum end as measured_base,
  p.last_measured_on,
  case
    when p.objective_id is null then null
    when p.measured_count = 0 then 'Unmeasured'
    when mm.aggregation = 'Latest' then
      case when (p.direction = 'At Least' and p.measured_latest >= p.target_base)
             or (p.direction = 'At Most' and p.measured_latest <= p.target_base) then 'Met' else 'Not Met' end
    when p.direction = 'At Least' then
      case when p.measured_sum >= p.target_base then 'Met' when p.unmeasured_count > 0 then 'Incomplete' else 'Not Met' end
    else
      case when p.measured_sum > p.target_base then 'Not Met' when p.unmeasured_count > 0 then 'Incomplete' else 'Met' end
  end as outcome
from paired p
join app.measurement_metrics mm on mm.metric_code = p.metric_code;

call private.describe('app.project_measurement_summary', 'Gate 8 measurement against the gate 1 objectives (Section 4.10), per project and metric, in the metric''s base unit: the objective, the figures measured and the outcome. Totals are over measured figures only, with the unmeasured count beside them; with no measured figure the total is NULL (Unmeasured), never zero. Earned media figures are computed from the coverage records. Readable where the project''s figures are.', array[
  'org_id', 'Org.',
  'project_id', 'Project.',
  'metric_code', 'Metric.',
  'family', 'Sustainability, Audience, Earned Media or Sentiment.',
  'dimension', 'Dimension of the figure.',
  'base_unit_code', 'Unit of target_base and measured_base.',
  'aggregation', 'Sum or Latest.',
  'objective_id', 'Live gate 1 objective for the metric, or NULL when none was set.',
  'direction', 'At Least or At Most.',
  'target_value', 'Target as set, in target_unit_code.',
  'target_unit_code', 'Unit the target was set in.',
  'target_base', 'Target in the base unit.',
  'measured_count', 'Figures with a value (coverage rows for the earned media count).',
  'unmeasured_count', 'Figures recorded as not measured (coverage without a reach for earned media reach); never counted as zero.',
  'measured_base', 'Total (Sum) or most recent figure (Latest) in the base unit, over measured figures; NULL when nothing was measured.',
  'last_measured_on', 'Day of the most recent measured figure.',
  'outcome', 'Met, Not Met, Incomplete (unmeasured figures leave the objective undecided) or Unmeasured; NULL without an objective.'
]);

revoke all on app.project_measurement_summary from public, anon;
grant select on app.project_measurement_summary to authenticated, service_role;
