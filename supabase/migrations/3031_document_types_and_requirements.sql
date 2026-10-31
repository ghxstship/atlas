-- 3031_document_types_and_requirements.sql
-- B14 Event types and project setup (RRR-238; parity gap G-266; ADR 0153 decisions D3 and D7; block 3030 to 3039).
-- Document types an org files its project documents under, the documents each event type needs, and the progress view
-- that shows how far a project's setup has come.
--
--   * app.document_types: an org's own list (a run sheet, a site plan, an insurance certificate), read by its members
--     and written with projects.template.write (D7). app.adopt_standard_document_types adds one type per distinct
--     DOCUMENT TYPE of the XOS Standard Library (xpms.std_document_library) the org does not already hold, so a second
--     run adds nothing. A type a live requirement names is not deleted (document_type_in_use).
--   * app.documents gains document_type_id. Typing a document is an ordinary documents update under 0353's
--     knowledge.document.write policy.
--   * app.event_type_document_requirements: per event type, each document type Required or Recommended, by a gate.
--     A Required type blocks the gate (3032); a Recommended one never blocks.
--   * app.project_setup_progress: one row per requirement of the project's event type, documents and fields, with
--     whether it is satisfied. Rows are limited to projects the caller reads documents on, so a reader who cannot see
--     documents never sees a false Missing. Requirements whose document type or custom field is deleted are ignored
--     here and by the gate.
-- Document types come back from Trash (ADR 0110); requirements are configuration of their event type and stay out. The
-- view revokes select from xos_backup (1650).

-- Document types ------------------------------------------------------------------------------------------------------------

create table app.document_types (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  description text,
  std_document_type text,
  deleted_at timestamptz,
  constraint document_types_name_length check (char_length(name) between 1 and 100 and name = btrim(name)),
  constraint document_types_description_length check (description is null or char_length(description) between 1 and 2000),
  constraint document_types_std_length check (std_document_type is null or char_length(std_document_type) between 1 and 200)
);

call private.install_domain_table('app.document_types');
create unique index document_types_name_key on app.document_types (org_id, lower(btrim(name))) where deleted_at is null;
call private.describe('app.document_types', 'Document types of an org (G-266, ADR 0153 D3): the kinds of project document it files, such as a site plan or an insurance certificate. Event types name the ones a project needs (app.event_type_document_requirements). Read by the org''s members; written with projects.template.write.', array[
  'name', 'Name of the type, unique in the org.',
  'description', 'What a document of this type holds.',
  'std_document_type', 'The XOS Standard Library DOCUMENT TYPE the type was added from; NULL for a type the org made.'
]);

create or replace function private.guard_document_type()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null
     and exists (select 1 from app.event_type_document_requirements r
                 join app.event_types t on t.id = r.event_type_id and t.deleted_at is null
                 where r.document_type_id = new.id and r.deleted_at is null) then
    perform private.refuse('document_type_in_use', 'Remove the event types'' requirements for this document type first.');
  end if;
  return new;
end;
$$;

comment on function private.guard_document_type() is 'Document types: a type a live requirement of a live event type names is not deleted (document_type_in_use).';
revoke all on function private.guard_document_type() from public, anon, authenticated;

call private.install_policies('app.document_types',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('projects.template.write'))$$);
call private.install_default_retention('app.document_types');
call private.install_audit_trail('app.document_types');

-- Typed documents ----------------------------------------------------------------------------------------------------------------

alter table app.documents add column document_type_id uuid references app.document_types (id);
create index documents_document_type_idx on app.documents (document_type_id);
call private.add_cross_org_references('app.documents', array['app.document_types', 'document_type_id']);
comment on column app.documents.document_type_id is 'Document type of the org the document is filed under (G-266); NULL for an untyped document. A live project document of a type with at least one version satisfies a requirement of that type.';

-- Requirements per event type ----------------------------------------------------------------------------------------------------

create type app.document_requirement as enum ('Required', 'Recommended');
comment on type app.document_requirement is 'How an event type asks for a document type or a field (G-266): Required blocks its gate until satisfied; Recommended shows in the progress view and never blocks.';

create table app.event_type_document_requirements (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  event_type_id uuid not null references app.event_types (id),
  document_type_id uuid not null references app.document_types (id),
  requirement app.document_requirement not null default 'Required',
  required_by_gate integer not null default 1 references xpms.dim_phase (gate),
  sort_order integer not null default 100,
  deleted_at timestamptz,
  constraint event_type_document_requirements_sort_order check (sort_order between 1 and 10000)
);

create unique index event_type_document_requirements_type_key on app.event_type_document_requirements (event_type_id, document_type_id)
  where deleted_at is null;
create index event_type_document_requirements_document_type_idx on app.event_type_document_requirements (document_type_id);
create index event_type_document_requirements_gate_idx on app.event_type_document_requirements (required_by_gate);

call private.install_domain_table('app.event_type_document_requirements', 'app.event_types', 'event_type_id',
  array['app.document_types', 'document_type_id']);
call private.describe('app.event_type_document_requirements', 'Document types a project of an event type needs (G-266, ADR 0153 D3), each Required or Recommended by a gate. A Required type needs a live project document of the type with at least one version before app.pass_gate passes its gate; a Recommended one never blocks.', array[
  'event_type_id', 'Event type the requirement belongs to.',
  'document_type_id', 'Document type asked for.',
  'requirement', 'Required (blocks the gate) or Recommended (never blocks).',
  'required_by_gate', 'Gate (1 to 9) the document is needed by.',
  'sort_order', 'Position in the progress view, 1 first (1 to 10000).'
]);

create or replace function private.guard_event_type_document_requirement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.event_type_id <> old.event_type_id or new.document_type_id <> old.document_type_id) then
    perform private.refuse('event_type_requirement_immutable', 'A requirement keeps its type and document type; remove it and add another.');
  end if;
  if new.deleted_at is null and not exists (
      select 1 from app.document_types d where d.id = new.document_type_id and d.deleted_at is null) then
    perform private.refuse('event_type_requirement_document_type', 'Choose a live document type.');
  end if;
  return new;
end;
$$;

comment on function private.guard_event_type_document_requirement() is 'Event type document requirements: a requirement keeps its type and document type (event_type_requirement_immutable) and names a live document type (event_type_requirement_document_type).';
revoke all on function private.guard_event_type_document_requirement() from public, anon, authenticated;

create trigger t40_guard_event_type_document_requirement before insert or update on app.event_type_document_requirements
  for each row execute function private.guard_event_type_document_requirement();

-- The deletion guard of document types reads the requirements, so it is created with them.
create trigger t40_guard_document_type before update of deleted_at on app.document_types
  for each row execute function private.guard_document_type();

call private.install_policies('app.event_type_document_requirements',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('projects.template.write'))$$);
call private.install_default_retention('app.event_type_document_requirements');
call private.install_audit_trail('app.event_type_document_requirements');

-- Adopting the Standard Library's document types --------------------------------------------------------------------------------

create or replace function app.adopt_standard_document_types(p_org_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform private.require_person();
  if not private.has_capability(p_org_id, 'projects.template.write') then
    raise exception using errcode = '42501', message = 'projects.template.write is required';
  end if;
  with canon as (
    select distinct on (lower(btrim(s.document_type))) btrim(s.document_type) as document_type
    from xpms.std_document_library s
    where nullif(btrim(s.document_type), '') is not null
      and s.record_id <> all (private.standard_library_withheld('document_library'))
    order by lower(btrim(s.document_type)), s.source_row
  )
  insert into app.document_types (org_id, name, std_document_type)
  select p_org_id, left(c.document_type, 100), c.document_type
  from canon c
  where not exists (
    select 1 from app.document_types d
    where d.org_id = p_org_id and d.deleted_at is null
      and (lower(btrim(d.name)) = lower(left(c.document_type, 100)) or lower(d.std_document_type) = lower(c.document_type)));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function app.adopt_standard_document_types(uuid) is 'Adds to the org one document type per distinct DOCUMENT TYPE of the XOS Standard Library (xpms.std_document_library), case and spaces ignored, leaving out rows private.standard_library_withheld holds back and every name the org already holds, its own types included, so a second run adds nothing (G-266). Needs projects.template.write in the org. Returns how many types it added.';
revoke all on function app.adopt_standard_document_types(uuid) from public, anon;
grant execute on function app.adopt_standard_document_types(uuid) to authenticated, service_role;

-- Whether a custom field value is present ------------------------------------------------------------------------------------------
-- private.value_column (0540) is revoked from authenticated, so the progress view and the gate read the typed columns
-- through this pure helper instead.

create or replace function private.custom_value_present(
  p_data_type app.custom_data_type,
  p_text text,
  p_number numeric,
  p_money_minor bigint,
  p_currency char(3),
  p_date date,
  p_timestamp timestamptz,
  p_boolean boolean,
  p_choice_id uuid,
  p_person_id uuid
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(case p_data_type
    when 'Text' then nullif(pg_catalog.btrim(p_text), '') is not null
    when 'Email' then nullif(pg_catalog.btrim(p_text), '') is not null
    when 'URL' then nullif(pg_catalog.btrim(p_text), '') is not null
    when 'Number' then p_number is not null
    when 'Money' then p_money_minor is not null and p_currency is not null
    when 'Date' then p_date is not null
    when 'Timestamp' then p_timestamp is not null
    when 'Boolean' then p_boolean is not null
    when 'Choice' then p_choice_id is not null
    when 'Person' then p_person_id is not null
  end, false);
$$;

comment on function private.custom_value_present(app.custom_data_type, text, numeric, bigint, char, date, timestamptz, boolean, uuid, uuid) is 'True when a custom field value holds a value in the typed column of its data type (0540''s private.value_column), a Money value with its currency; blank text counts as empty (G-266).';
revoke all on function private.custom_value_present(app.custom_data_type, text, numeric, bigint, char, date, timestamptz, boolean, uuid, uuid) from public, anon;
grant execute on function private.custom_value_present(app.custom_data_type, text, numeric, bigint, char, date, timestamptz, boolean, uuid, uuid) to authenticated, service_role;

-- The progress view ------------------------------------------------------------------------------------------------------------------

create view app.project_setup_progress with (security_invoker = true) as
select p.id as project_id, p.event_type_id, 'Document'::text as item_kind, r.id as requirement_id,
  r.document_type_id, null::uuid as custom_field_definition_id, dt.name as label, r.requirement, r.required_by_gate,
  r.sort_order, coalesce(dc.documents, 0)::integer as documents_count, coalesce(dc.documents, 0) > 0 as satisfied
from app.projects p
join app.event_type_document_requirements r on r.event_type_id = p.event_type_id and r.deleted_at is null
join app.document_types dt on dt.id = r.document_type_id and dt.deleted_at is null
left join lateral (
  select count(*) as documents from app.documents d
  where d.project_id = p.id and d.document_type_id = r.document_type_id and d.deleted_at is null
    and exists (select 1 from app.document_versions v where v.document_id = d.id and v.deleted_at is null)
) dc on true
where p.deleted_at is null and p.id in (select private.project_ids_with('knowledge.document.read'))
union all
select p.id, p.event_type_id, 'Field', f.id, null::uuid, f.custom_field_definition_id, d.label,
  (case when f.required_for_type then 'Required' else 'Recommended' end)::app.document_requirement, f.required_by_gate,
  f.sort_order, null::integer,
  exists (
    select 1 from app.custom_field_values v
    where v.custom_field_definition_id = d.id and v.target_id = p.id and v.deleted_at is null
      and private.custom_value_present(d.data_type, v.value_text, v.value_number, v.value_money_minor, v.value_currency,
        v.value_date, v.value_timestamp, v.value_boolean, v.value_choice_id, v.value_person_id))
from app.projects p
join app.event_type_fields f on f.event_type_id = p.event_type_id and f.deleted_at is null
join app.custom_field_definitions d on d.id = f.custom_field_definition_id and d.deleted_at is null
where p.deleted_at is null and p.id in (select private.project_ids_with('knowledge.document.read'));

call private.describe('app.project_setup_progress', 'Setup completeness of each typed project (G-266, ADR 0153 D3): one row per document requirement and per field of the project''s event type, with whether it is satisfied. A Document row is satisfied by a live project document of its type with at least one version; a Field row by a live value of the field. Requirements whose document type or field is deleted are left out, as app.pass_gate leaves them out. Runs as the reader and lists only projects the reader reads documents on (knowledge.document.read), so a reader who cannot see documents never sees a false Missing.', array[
  'project_id', 'Project.',
  'event_type_id', 'Event type of the project.',
  'item_kind', 'Document or Field.',
  'requirement_id', 'The requirement row: app.event_type_document_requirements for a document, app.event_type_fields for a field.',
  'document_type_id', 'For a document: the document type asked for.',
  'custom_field_definition_id', 'For a field: the project custom field asked for.',
  'label', 'Name of the document type or label of the field.',
  'requirement', 'Required (blocks its gate) or Recommended (never blocks); a field the type shows without requiring it reads Recommended.',
  'required_by_gate', 'Gate the item is needed by.',
  'sort_order', 'Position within its kind.',
  'documents_count', 'For a document: live project documents of the type with at least one version the reader sees; NULL for a field.',
  'satisfied', 'True when the requirement is met.'
]);
revoke all on app.project_setup_progress from public, anon;
grant select on app.project_setup_progress to authenticated, service_role;
revoke select on app.project_setup_progress from xos_backup;

-- Removed document types belong in Trash (ADR 0110); requirements go with their event type.
insert into private.trash_excluded_tables (table_name, rationale) values
  ('event_type_document_requirements', 'Document requirements are configuration of their event type; they go with the type and are set again in its editor.');
select private.sync_trash_tables();
