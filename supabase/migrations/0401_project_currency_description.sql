-- 0401_project_currency_description.sql
-- A07 Projects (ADR 0022 range 0400 to 0409). Two project facts the frozen API contract (Project,
-- ADR 0014) and Section 20.2 journey 37 rely on but 0301 did not store:
--   * currency_code, the project's base currency. Money on the project is priced in it; switching it
--     is a project setting. When the caller gives none, the database takes the currency of the
--     project jurisdiction's country (canon xpms.jurisdiction). The late slot 0950 adds the org's
--     base currency setting (A30, 0851) as the last fallback and makes the column required.
--   * description, sentence-case prose about the project.
-- app.create_project gains both as optional arguments; the old signature is replaced.

alter table app.projects add column if not exists currency_code char(3) references private.currencies (currency_code);
alter table app.projects add column if not exists description text;

create index if not exists projects_currency_code_idx on app.projects (currency_code);

comment on column app.projects.currency_code is 'Base currency of the project (ISO 4217). Defaults to the currency of the jurisdiction''s country, then the org''s base currency setting, when the caller gives none.';
comment on column app.projects.description is 'What the project is, in sentence case.';

alter table app.projects drop constraint if exists projects_description_length;
alter table app.projects add constraint projects_description_length
  check (description is null or char_length(btrim(description)) between 1 and 20000);

create or replace function private.project_jurisdiction_currency(p_jurisdiction_id text)
returns char(3)
language sql
stable
security definer
set search_path = ''
as $$
  select j.currency::char(3) from xpms.jurisdiction j
  where j.jurisdiction_id = left(p_jurisdiction_id, 2) and j.level = 'country';
$$;

comment on function private.project_jurisdiction_currency(text) is 'Currency of the country a jurisdiction belongs to, from canon; null for a null or unknown jurisdiction.';

-- Backfill rows created before this migration from their jurisdiction.
update app.projects p set currency_code = private.project_jurisdiction_currency(p.jurisdiction_id)
where p.currency_code is null and p.jurisdiction_id is not null;

create or replace function private.default_project_currency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.currency_code is null then
    new.currency_code := private.project_jurisdiction_currency(new.jurisdiction_id);
  end if;
  return new;
end;
$$;

comment on function private.default_project_currency() is 'Before insert or update on app.projects: fills the currency from the jurisdiction''s country when absent. Replaced in 0950 with the org base currency fallback.';

drop trigger if exists t39_default_project_currency on app.projects;
create trigger t39_default_project_currency before insert or update of currency_code, jurisdiction_id on app.projects
  for each row execute function private.default_project_currency();

-- create_project with currency and description -------------------------------------------------------

drop function if exists app.create_project(uuid, text, text, text, text, text, text, uuid, date, date);

create or replace function app.create_project(
  p_org_id uuid,
  p_project_key text,
  p_name text,
  p_time_zone text,
  p_jurisdiction_id text default null,
  p_region_code text default null,
  p_tier_code text default null,
  p_venue_id uuid default null,
  p_starts_on date default null,
  p_ends_on date default null,
  p_currency_code text default null,
  p_description text default null
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_project uuid;
  v_key text := upper(btrim(p_project_key));
  v_name text := btrim(p_name);
begin
  insert into app.projects (org_id, project_key, name, time_zone, jurisdiction_id, region_code, tier_code,
    venue_id, starts_on, ends_on, currency_code, description)
  values (p_org_id, v_key, v_name, p_time_zone, p_jurisdiction_id, p_region_code, p_tier_code,
    p_venue_id, p_starts_on, p_ends_on, upper(nullif(btrim(p_currency_code), '')),
    nullif(btrim(p_description), ''))
  returning id into v_project;
  insert into app.scope_nodes (project_id, scope_kind, scope_code, name, venue_id, path)
  values (v_project, 'Engagement Root', v_key || '-E01', v_name, p_venue_id, extensions.text2ltree(v_key || '_E01'));
  return v_project;
end;
$$;

comment on function app.create_project(uuid, text, text, text, text, text, text, uuid, date, date, text, text) is 'Creates a project in Proposed at Scope together with its Engagement Root scope node, coded {KEY}-E01, in one transaction. Runs as the caller, so row level security decides (projects.project.create, then projects.scope.write through project oversight) and the guards apply: key format and uniqueness, IANA time zone, venue in the same org, the currency (given, the jurisdiction country''s or the org base currency) and the active_projects plan limit. Returns the project id.';

revoke all on function app.create_project(uuid, text, text, text, text, text, text, uuid, date, date, text, text) from public, anon;
grant execute on function app.create_project(uuid, text, text, text, text, text, text, uuid, date, date, text, text) to authenticated, service_role;
revoke all on function private.project_jurisdiction_currency(text) from public, anon, authenticated;
revoke all on function private.default_project_currency() from public, anon, authenticated;

-- Header edits name the new columns in project.updated (0400's trigger reads only the listed columns).
create or replace function private.emit_project_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed text[] := array[]::text[];
  v_data jsonb;
begin
  if new.archived_at is distinct from old.archived_at then
    perform private.emit_event(new.org_id,
      case when new.archived_at is null then 'project.restored' else 'project.archived' end,
      'projects', new.id, new.id, jsonb_build_object('project_key', new.project_key, 'name', new.name));
  end if;
  if new.project_key <> old.project_key then v_changed := array_append(v_changed, 'project_key'); end if;
  if new.name <> old.name then v_changed := array_append(v_changed, 'name'); end if;
  if new.description is distinct from old.description then v_changed := array_append(v_changed, 'description'); end if;
  if new.currency_code is distinct from old.currency_code then v_changed := array_append(v_changed, 'currency_code'); end if;
  if new.starts_on is distinct from old.starts_on then v_changed := array_append(v_changed, 'starts_on'); end if;
  if new.ends_on is distinct from old.ends_on then v_changed := array_append(v_changed, 'ends_on'); end if;
  if new.venue_id is distinct from old.venue_id then v_changed := array_append(v_changed, 'venue_id'); end if;
  if new.jurisdiction_id is distinct from old.jurisdiction_id then v_changed := array_append(v_changed, 'jurisdiction_id'); end if;
  if new.region_code is distinct from old.region_code then v_changed := array_append(v_changed, 'region_code'); end if;
  if new.tier_code is distinct from old.tier_code then v_changed := array_append(v_changed, 'tier_code'); end if;
  if new.time_zone <> old.time_zone then v_changed := array_append(v_changed, 'time_zone'); end if;
  if cardinality(v_changed) > 0 then
    select jsonb_object_agg(c, to_jsonb(new) -> c) into v_data from unnest(v_changed) c;
    perform private.emit_event(new.org_id, 'project.updated', 'projects', new.id, new.id,
      jsonb_build_object('changed', to_jsonb(v_changed), 'values', v_data, 'project_key', new.project_key));
  end if;
  return null;
end;
$$;
