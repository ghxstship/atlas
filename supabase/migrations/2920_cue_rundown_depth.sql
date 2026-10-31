-- 2920_cue_rundown_depth.sql
-- B3 Run-of-show depth (RRR-227, ADR 0142; parity gap G-73). A running order gets the depth of a rundown tool: columns
-- the org defines, color-coded choices, a script for each cue and a color for each segment.
--
--   * Cues become a custom field target (private.custom_field_targets, 0540): the Settings page lists them through
--     app.custom_field_targets (1433) and A117's guards apply unchanged (types, choices, people, required, the
--     filterable index). private.guard_custom_field_value is restated from its latest definition (2110) with one rule
--     added: a signed-in person writes a cue's value only with show.run_of_show.write on its project
--     (custom_value_capability). The values policy (custom_writer_orgs, the Collaborator band) would otherwise let a
--     person who only reads the running order write its cue values.
--   * app.custom_field_choices.color_key: one of the themed categorical tokens cat-1 to cat-7 (packages/tokens
--     color.viz.cat-*), for any target. The choice label always shows beside the color, so color is never the only
--     signal.
--   * app.cue_field_audiences: who a cue field is for. Crew (members in Atlas), Showcaller (a showcaller link's portal,
--     2924) and Client (a Client engaged on the project, in Gateway). Every new cue field starts with Crew. Crew is
--     presentation only: members already read every value the cue's row level security lets them read. Showcaller and
--     Client are enforced where those surfaces read, and never take a Person, Money or Email field, since neither
--     surface has an account to resolve a person or holds money.
--   * api_external.cue_field_values: a Client's view of the Client-audience values of the cues of their projects. It
--     leaves api_external.cues (2790) as it is.
--   * app.cues.script: the words spoken on the cue, up to 20,000 characters. Internal, like the description.
--   * app.run_segment_colors: one color per segment name of a running order (ADR 0142 decision 7). The color is a
--     fact about the segment, so it is stored once, not on every cue: a cue added to the segment shows it, and a
--     renamed segment simply has no color until one is set. app.set_segment_color sets or clears it.
-- No column here is classified above Internal. The new tables have default retention (pgTAP 2390: the nightly sweep
-- adds none), and neither enters Trash (ADR 0110): an audience row is part of its field and a color returns with its
-- running order.

-- Cues take custom fields ------------------------------------------------------------------------------------------------

insert into private.custom_field_targets (table_name) values ('app.cues') on conflict do nothing;

-- From its latest definition (2110), with the cue rule added after the target check.
create or replace function private.guard_custom_field_value()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_def app.custom_field_definitions;
  v_org uuid;
begin
  select * into v_def from app.custom_field_definitions d where d.id = new.custom_field_definition_id and d.deleted_at is null;
  if v_def.id is null then
    perform private.refuse('custom_value_field', 'The field does not exist.');
  end if;
  execute format('select org_id from %s where id = $1', v_def.target_table) into v_org using new.target_id;
  if v_org is distinct from new.org_id then
    perform private.refuse('cross_org_reference', 'custom_field_values.target_id points to a row of another org.');
  end if;
  if tg_op = 'UPDATE' and new.target_id <> old.target_id then
    perform private.refuse('custom_value_target_immutable', 'A value stays on its row.');
  end if;
  -- A cue's values are part of the running order: writing them takes the running order's write capability (2920).
  if v_def.target_table = 'app.cues' and private.current_person_id() is not null
     and not private.can_on_project((select c.project_id from app.cues c where c.id = new.target_id), 'show.run_of_show.write') then
    perform private.refuse('custom_value_capability', 'Only a person who may edit the running order fills in its cue fields.');
  end if;
  perform private.check_typed_value(v_def.data_type, to_jsonb(new));
  if new.value_choice_id is not null and (select c.custom_field_definition_id from app.custom_field_choices c where c.id = new.value_choice_id) <> new.custom_field_definition_id then
    perform private.refuse('custom_value_choice', 'The option belongs to another field.');
  end if;
  if new.value_person_id is not null and new.org_id not in (select private.person_org_ids(new.value_person_id)) then
    perform private.refuse('custom_value_person', 'A person value names a member of the org.');
  end if;
  if v_def.required then
    if tg_op = 'UPDATE' and old.deleted_at is null and new.deleted_at is not null then
      perform private.refuse('custom_value_required', format('%s is required; change its value instead of removing it.', v_def.label));
    end if;
    if new.deleted_at is null and to_jsonb(new) ->> private.value_column(v_def.data_type) is null then
      perform private.refuse('custom_value_required', format('%s is required and needs a value.', v_def.label));
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_custom_field_value() is 'Custom field values: the target row exists in the same org and the value stays on it, only the field type''s column is filled, choices belong to the field, people belong to the org, a required field''s value is neither empty nor removed (2110), and a cue''s value is written only by a holder of show.run_of_show.write on its project (custom_value_capability, 2920).';

revoke all on function private.guard_custom_field_value() from public, anon, authenticated;

-- Choice colors -----------------------------------------------------------------------------------------------------------

alter table app.custom_field_choices
  add column color_key text,
  add constraint custom_field_choices_color_key check (color_key is null or color_key ~ '^cat-[1-7]$');

comment on column app.custom_field_choices.color_key is 'Color of the option: one of the themed categorical tokens cat-1 to cat-7 (color.viz.cat-* in light, dark and sunlight), or null for none. Shown beside the label, never instead of it.';

-- Cue field audiences --------------------------------------------------------------------------------------------------------

create type app.cue_field_audience as enum ('Crew', 'Showcaller', 'Client');
comment on type app.cue_field_audience is 'Who a cue custom field is for (ADR 0142): Crew, members in Atlas (presentation only); Showcaller, the portal of a showcaller link; Client, a Client engaged on the project, in Gateway.';

create table app.cue_field_audiences (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  custom_field_definition_id uuid not null references app.custom_field_definitions (id),
  audience app.cue_field_audience not null
);

create index cue_field_audiences_definition_idx on app.cue_field_audiences (custom_field_definition_id);

call private.install_domain_table('app.cue_field_audiences', 'app.custom_field_definitions', 'custom_field_definition_id');
call private.describe('app.cue_field_audiences', 'Who a cue custom field is shown to (ADR 0142): one row per audience. Crew lists the field in Atlas running orders (members read every value their access allows either way); Showcaller shows it on showcaller links; Client shows it to Clients engaged on the project, in Gateway. A new cue field starts with Crew. Person, Money and Email fields never take Showcaller or Client.', array[
  'custom_field_definition_id', 'Cue custom field.',
  'audience', 'Crew, Showcaller or Client.'
]);

create unique index cue_field_audiences_key on app.cue_field_audiences (custom_field_definition_id, audience) where deleted_at is null;

call private.install_policies('app.cue_field_audiences',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.custom_fields.write'))$$);
call private.install_default_retention('app.cue_field_audiences');

-- Audiences belong to cue fields, and the outside audiences take no Person, Money or Email field. Runs on the audience
-- rows and on a definition whose data type changes (the type guard of 0540 refuses that too; this keeps the rule
-- whole on its own).
create or replace function private.guard_cue_field_audience()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_def app.custom_field_definitions;
begin
  if tg_table_name = 'cue_field_audiences' then
    if new.deleted_at is not null then
      return new;
    end if;
    select * into v_def from app.custom_field_definitions d where d.id = new.custom_field_definition_id;
    if v_def.target_table is distinct from 'app.cues' then
      perform private.refuse('cue_field_audience_target', 'Audiences apply to cue fields only.');
    end if;
    if new.audience in ('Showcaller', 'Client') and v_def.data_type in ('Person', 'Money', 'Email') then
      perform private.refuse('cue_field_audience_type', 'A Person, Money or Email field stays with the crew: showcaller links and Clients never see it.');
    end if;
  elsif new.data_type is distinct from old.data_type and new.data_type in ('Person', 'Money', 'Email')
        and exists (select 1 from app.cue_field_audiences a
                    where a.custom_field_definition_id = new.id and a.deleted_at is null and a.audience in ('Showcaller', 'Client')) then
    perform private.refuse('cue_field_audience_type', 'A field shown to showcaller links or Clients cannot become a Person, Money or Email field.');
  end if;
  return new;
end;
$$;

comment on function private.guard_cue_field_audience() is 'Cue field audiences (ADR 0142): an audience row names a cue field (cue_field_audience_target), and Showcaller or Client never take a Person, Money or Email field, on the audience row or when a definition''s data type changes (cue_field_audience_type).';
revoke all on function private.guard_cue_field_audience() from public, anon, authenticated;

create trigger t40_guard_cue_field_audience before insert or update on app.cue_field_audiences
  for each row execute function private.guard_cue_field_audience();
create trigger t40_guard_cue_field_audience before update of data_type on app.custom_field_definitions
  for each row execute function private.guard_cue_field_audience();

-- Every new cue field is for the crew until the org says otherwise.
create or replace function private.default_cue_field_audience()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into app.cue_field_audiences (custom_field_definition_id, audience) values (new.id, 'Crew');
  return null;
end;
$$;

comment on function private.default_cue_field_audience() is 'After a cue custom field is defined: gives it the Crew audience (ADR 0142).';
revoke all on function private.default_cue_field_audience() from public, anon, authenticated;

create trigger t80_default_cue_field_audience after insert on app.custom_field_definitions
  for each row when (new.target_table = 'app.cues')
  execute function private.default_cue_field_audience();

-- A Client's cue fields ----------------------------------------------------------------------------------------------------------

-- Like api_external.cues, the view runs as its owner and applies its own predicate: live values of live Client-audience
-- fields, for live cues of live running orders on projects where the caller is engaged as Client. Person, Money and
-- Email are left out even if an audience row were to slip past the guard.
create view api_external.cue_field_values as
select v.target_id as cue_id, d.field_key, d.label, d.data_type, d.sort_order,
  v.value_text, v.value_number, v.value_date, v.value_timestamp, v.value_boolean,
  ch.label as choice_label, ch.color_key as choice_color_key
from app.custom_field_values v
join app.custom_field_definitions d on d.id = v.custom_field_definition_id and d.deleted_at is null and d.target_table = 'app.cues'
join app.cues c on c.id = v.target_id and c.deleted_at is null and c.org_id = v.org_id
join app.run_of_show r on r.id = c.run_of_show_id and r.deleted_at is null
left join app.custom_field_choices ch on ch.id = v.value_choice_id and ch.deleted_at is null
where v.deleted_at is null
  and d.data_type not in ('Person', 'Money', 'Email')
  and (d.data_type <> 'Choice' or ch.id is not null)
  and exists (select 1 from app.cue_field_audiences a
              where a.custom_field_definition_id = d.id and a.audience = 'Client' and a.deleted_at is null)
  and private.engaged_as(r.project_id, 'Client');

comment on view api_external.cue_field_values is 'Cue custom field values a Client sees in Gateway (ADR 0142): the Client-audience fields of live cues of live running orders on projects where the caller is engaged as Client. Never a Person, Money or Email field.';
comment on column api_external.cue_field_values.cue_id is 'Cue the value belongs to (api_external.cues.id).';
comment on column api_external.cue_field_values.field_key is 'Field key, unique per org.';
comment on column api_external.cue_field_values.label is 'Field label, the org''s own text.';
comment on column api_external.cue_field_values.data_type is 'Data type; decides which value column is filled.';
comment on column api_external.cue_field_values.sort_order is 'Position of the field among the cue fields.';
comment on column api_external.cue_field_values.value_text is 'Text and URL values.';
comment on column api_external.cue_field_values.value_number is 'Number values.';
comment on column api_external.cue_field_values.value_date is 'Date values.';
comment on column api_external.cue_field_values.value_timestamp is 'Timestamp values.';
comment on column api_external.cue_field_values.value_boolean is 'Boolean values.';
comment on column api_external.cue_field_values.choice_label is 'Label of the chosen option, for Choice fields.';
comment on column api_external.cue_field_values.choice_color_key is 'Color of the chosen option (cat-1 to cat-7), or null.';

revoke all on api_external.cue_field_values from public, anon;
grant select on api_external.cue_field_values to authenticated, service_role;

-- The cue's script ------------------------------------------------------------------------------------------------------------------

alter table app.cues
  add column script text,
  add constraint cues_script_length check (script is null or char_length(script) <= 20000);

comment on column app.cues.script is 'What is said on the cue (the script), up to 20,000 characters. Internal, like the description.';

-- Segment colors -------------------------------------------------------------------------------------------------------------------

create table app.run_segment_colors (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  run_of_show_id uuid not null references app.run_of_show (id),
  segment text not null,
  color_key text not null,
  constraint run_segment_colors_segment_length check (char_length(btrim(segment)) between 1 and 200),
  constraint run_segment_colors_color_key check (color_key ~ '^cat-[1-7]$')
);

create index run_segment_colors_run_idx on app.run_segment_colors (run_of_show_id);

call private.install_child_table('app.run_segment_colors', 'app.run_of_show', 'run_of_show_id', 'show.run_of_show.read', 'show.run_of_show.write');
create unique index run_segment_colors_key on app.run_segment_colors (run_of_show_id, lower(btrim(segment))) where deleted_at is null;
call private.describe('app.run_segment_colors', 'Color of a segment of a running order (ADR 0142): one row per segment name, matched to the cues'' segment text ignoring case and outer spaces, so every cue of the segment shows it, a new one included. Set and cleared by app.set_segment_color.', array[
  'run_of_show_id', 'Running order.',
  'segment', 'Segment name, as the cues write it.',
  'color_key', 'One of the themed categorical tokens cat-1 to cat-7.'
]);
call private.install_default_retention('app.run_segment_colors');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('cue_field_audiences', 'An audience is part of its cue field and changes with it in Settings.'),
  ('run_segment_colors', 'A segment color returns with its running order; set it again to change it.')
on conflict (table_name) do nothing;

create or replace function app.set_segment_color(p_run_of_show_id uuid, p_segment text, p_color_key text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.run_of_show;
  v_segment text := nullif(btrim(coalesce(p_segment, '')), '');
begin
  perform private.require_person();
  select * into v_run from app.run_of_show r where r.id = p_run_of_show_id and r.deleted_at is null;
  if v_run.id is null or not private.can_on_project(v_run.project_id, 'show.run_of_show.write') then
    raise exception using errcode = '42501', message = 'show.run_of_show.write is required on the running order';
  end if;
  if v_segment is null then
    perform private.refuse('segment_color_segment', 'Name the segment before you color it.');
  end if;
  if p_color_key is not null and p_color_key !~ '^cat-[1-7]$' then
    perform private.refuse('segment_color_key', 'Pick one of the seven segment colors, or none.');
  end if;
  if p_color_key is null then
    update app.run_segment_colors set deleted_at = now()
    where run_of_show_id = v_run.id and lower(btrim(segment)) = lower(v_segment) and deleted_at is null;
  else
    insert into app.run_segment_colors (run_of_show_id, segment, color_key)
    values (v_run.id, v_segment, p_color_key)
    on conflict (run_of_show_id, (lower(btrim(segment)))) where deleted_at is null
    do update set color_key = excluded.color_key;
  end if;
end;
$$;

comment on function app.set_segment_color(uuid, text, text) is 'Sets the color of a segment of a running order (cat-1 to cat-7), or clears it with NULL, in one statement (ADR 0142). Every live cue whose segment text matches, ignoring case and outer spaces, shows it. Needs show.run_of_show.write on the project; refuses a blank segment (segment_color_segment) and an unknown color (segment_color_key).';
revoke all on function app.set_segment_color(uuid, text, text) from public, anon;
grant execute on function app.set_segment_color(uuid, text, text) to authenticated, service_role;

select private.sync_trash_tables();
