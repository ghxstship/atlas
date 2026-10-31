-- pgTAP: every source in packages/sync/sync-rules.yaml (A26 readiness check, Section 13, Section 8.7).
-- PowerSync replicates base tables only and resolves unqualified names in public, so each source must be a
-- schema-qualified table that exists, every column a bucket selects must exist in it, and every column an external
-- or person bucket selects must also be a column of the api_external projection named beside it, so an external
-- device never stores a column that projection leaves out. A column renamed by its projection is written
-- source>projection. packages/sync/test/sync-rules.test.ts parses the list below and fails when it and the
-- rules file differ, so the two stay in step.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select * from no_plan();

create temp table rule_sources (bucket text, source text, columns text, projection text);
insert into rule_sources values
  -- sync-rules: begin
  ('own_person', 'app.credentials', 'id,project_id,holder_person_id,credential_number,valid_from,valid_to,revoked_at,engagement_id', 'api_external.credentials'),
  ('own_person', 'app.incidents', 'id,org_id,project_id,incident_number,title,severity_enum_id,zone_id,occurred_at,reported_by,incident_state', null),
  ('own_person', 'app.incident_media', 'id,org_id,project_id,incident_id,media_uri,captured_at,created_by', null),
  ('internal_membership', 'app.shifts', '*', null),
  ('internal_membership', 'app.shift_swaps', '*', null),
  ('internal_membership', 'app.shift_swaps', '*', null),
  ('internal_membership', 'app.time_entries', '*', null),
  ('internal_membership', 'app.clock_punches', '*', null),
  ('internal_membership', 'app.asset_custody', '*', null),
  ('internal_project', 'app.projects', '*', null),
  ('internal_project', 'app.shifts', '*', null),
  ('internal_project', 'app.shift_swaps', '*', null),
  ('internal_project', 'app.time_entries', '*', null),
  ('internal_project', 'app.clock_punches', '*', null),
  ('internal_project', 'app.day_sheets', '*', null),
  ('internal_project', 'app.run_of_show', '*', null),
  ('internal_project', 'app.cues', '*', null),
  ('internal_project', 'app.incidents', '*', null),
  ('internal_project', 'app.incident_media', '*', null),
  ('internal_project', 'app.inspections', '*', null),
  ('internal_project', 'app.inspection_results', '*', null),
  ('internal_project', 'app.credentials', '*', null),
  ('internal_project', 'app.access_grid', '*', null),
  ('internal_project', 'app.access_scans', '*', null),
  ('internal_project', 'app.scan_intake', '*', null),
  ('internal_project', 'app.dock_slots', '*', null),
  ('internal_project', 'app.radio_channels', '*', null),
  ('internal_project', 'app.gate_queue', '*', null),
  ('internal_project', 'app.marshalling_log', '*', null),
  ('internal_project', 'app.fulfillments', '*', null),
  ('internal_org', 'app.inspection_templates', '*', null),
  ('internal_org', 'app.inspection_items', '*', null),
  ('internal_org', 'app.asset_units', '*', null),
  ('internal_org', 'app.asset_identifiers', '*', null),
  ('internal_org', 'app.asset_custody', '*', null),
  ('internal_org', 'app.sops', '*', null),
  ('internal_org', 'app.zones', '*', null),
  ('internal_org', 'app.emergency_codes', 'id,org_id,code,label,emergency,sort_order', null),
  ('internal_org', 'app.geofences', 'id,org_id,venue_id,zone_id,name,boundary', null),
  ('external_engagement', 'app.shifts', 'id,engagement_id,project_id,scope_node_id,role_code,starts_at,ends_at,time_zone,shift_state', 'api_external.shifts'),
  ('external_engagement', 'app.time_entries', 'id,engagement_id,project_id,shift_id,clock_in,clock_out,break_minutes,source', 'api_external.time_entries'),
  ('external_engagement', 'app.clock_punches', 'id,engagement_id,project_id,shift_id,time_entry_id,punch_kind,device_time,effective_at,geofence_verified,skew_flagged,source', 'api_external.clock_punches'),
  ('external_engagement', 'app.asset_custody', 'id,asset_unit_id,custodian_engagement_id>engagement_id,project_id,created_at>held_since', 'api_external.asset_custody'),
  ('external_engagement', 'app.credentials', 'id,project_id,holder_person_id,credential_number,valid_from,valid_to,revoked_at,engagement_id', 'api_external.credentials'),
  ('external_engagement', 'app.dock_slots', 'id,project_id,zone_id,shipment_id,starts_at,ends_at,engagement_id', 'api_external.dock_slots'),
  ('external_project', 'app.projects', 'id,org_id,name,time_zone,venue_id', 'api_external.projects'),
  ('external_project', 'app.radio_channels', 'id,project_id,channel_number,name,zone_id', 'api_external.radio_channels'),
  ('external_project', 'app.day_sheets', 'id,project_id,day,body', 'api_external.day_sheets'),
  ('external_project', 'app.run_of_show', 'id,project_id,name,show_date', 'api_external.run_of_show'),
  ('roster_entry', 'app.asset_custody', 'id,asset_unit_id,custodian_engagement_id>engagement_id,roster_entry_id,project_id,created_at>held_since', 'api_external.asset_custody'),
  ('external_project', 'app.cues', 'id,run_of_show_id,position,label,planned_at,duration,called_at,project_id,start_tbc', 'api_external.cues'),
  ('canon_reference', 'xpms.emergency_code', 'code,label,emergency,swatch,sort_order', null),
  ('canon_reference', 'xpms.std_enumeration', 'record_id,enum_code,enum_label,sort_order,color_code', null),
  ('canon_reference', 'xpms.std_enumeration', 'record_id,enum_code,enum_label,sort_order', null),
  ('canon_reference', 'xpms.role', 'role_code,job_title', null),
  -- sync-rules: end
  ('parameters', 'private.sync_scope_grants', 'scope_value,person_user_id,scope_key,audience', null);

-- Every source is a schema-qualified base or partitioned table.
select is(
  (select array_agg(distinct s.source order by s.source) from rule_sources s
   where to_regclass(s.source) is null
      or (select c.relkind from pg_class c where c.oid = to_regclass(s.source)) not in ('r', 'p')),
  null::text[], 'every source in the sync rules is a table that exists (never a view, never unqualified)');

-- Every selected column exists in its source.
select is(
  (select array_agg(s.source || '.' || split_part(col, '>', 1) order by 1) from rule_sources s,
     unnest(string_to_array(s.columns, ',')) col
   where col <> '*' and not exists (
     select 1 from pg_attribute a where a.attrelid = to_regclass(s.source) and a.attname = split_part(col, '>', 1)
       and a.attnum > 0 and not a.attisdropped)),
  null::text[], 'every column a bucket selects exists in its source table');

-- External and person buckets never select every column.
select is(
  (select array_agg(s.bucket || ' ' || s.source) from rule_sources s
   where s.columns = '*' and (s.bucket like 'external_%' or s.bucket in ('own_person', 'roster_entry', 'canon_reference'))),
  null::text[], 'external, person and canon buckets list their columns');

-- Every column an external bucket selects is a column of its api_external projection.
select is(
  (select array_agg(s.bucket || ' ' || s.source) from rule_sources s
   where s.bucket like 'external_%' and s.projection is null),
  null::text[], 'every external source names its api_external projection');
select is(
  (select array_agg(s.projection || '.' || coalesce(nullif(split_part(col, '>', 2), ''), col) order by 1) from rule_sources s,
     unnest(string_to_array(s.columns, ',')) col
   where s.projection is not null and not exists (
     select 1 from pg_attribute a where a.attrelid = to_regclass(s.projection)
       and a.attname = coalesce(nullif(split_part(col, '>', 2), ''), col) and a.attnum > 0 and not a.attisdropped)),
  null::text[], 'no external column outside its api_external projection');
select is(
  (select array_agg(distinct s.projection) from rule_sources s
   where s.projection is not null and (select c.relkind from pg_class c where c.oid = to_regclass(s.projection)) is distinct from 'v'),
  null::text[], 'every named projection is an api_external view');

-- Replication needs a replica identity; every table the rules read has a primary key.
select is(
  (select array_agg(distinct s.source) from rule_sources s
   where s.source not like 'private.%' and not exists (
     select 1 from pg_index i where i.indrelid = to_regclass(s.source) and i.indisprimary)),
  null::text[], 'every replicated source has a primary key');

select * from finish();
rollback;
