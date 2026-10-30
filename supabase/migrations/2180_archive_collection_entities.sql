-- 2180_archive_collection_entities.sql
-- A124 (RRR-169), trace row S4.10-02. Archive and unarchive for records of every kind (punch items through their
-- Task record), custom object records, vendors, venues, documents and work orders. Projects, notifications, groups
-- and help desk teams already keep archived_at.
--
--   * archived_at and archived_by on each table. An archived row stays readable and editable under its usual row
--     level security; lists and search leave it out unless asked (packages/data, 2181). Archive is not Trash:
--     deleted_at still means deleted.
--   * app.archive_row and app.unarchive_row (entity, id): the only way to set or clear archived_at. Each checks the
--     capability the table's update policy checks, writes one <table>.archived or <table>.unarchived event to the
--     audit ledger, and leaves an already archived (or live) row unchanged. A guard on each table refuses any other
--     change to the two columns. No domain event or notification kind is added.
--   * Venues archived through deleted_at until now (0420, the Places kit). Those rows become archived rows, so what
--     Places showed under Archived stays there and can still be restored; venue.archived and venue.restored now
--     follow archived_at, and a venue's name is unique among live, unarchived venues (ADR 0085).

-- Columns ------------------------------------------------------------------------------------------------------------

alter table app.records add column archived_at timestamptz, add column archived_by uuid references app.people (id);
alter table app.custom_object_records add column archived_at timestamptz, add column archived_by uuid references app.people (id);
alter table app.vendors add column archived_at timestamptz, add column archived_by uuid references app.people (id);
alter table app.venues add column archived_at timestamptz, add column archived_by uuid references app.people (id);
alter table app.documents add column archived_at timestamptz, add column archived_by uuid references app.people (id);
alter table app.work_orders add column archived_at timestamptz, add column archived_by uuid references app.people (id);

create index records_archived_by_idx on app.records (archived_by) where archived_by is not null;
create index custom_object_records_archived_by_idx on app.custom_object_records (archived_by) where archived_by is not null;
create index vendors_archived_by_idx on app.vendors (archived_by) where archived_by is not null;
create index venues_archived_by_idx on app.venues (archived_by) where archived_by is not null;
create index documents_archived_by_idx on app.documents (archived_by) where archived_by is not null;
create index work_orders_archived_by_idx on app.work_orders (archived_by) where archived_by is not null;

comment on column app.records.archived_at is 'When the record was archived (app.archive_row); an archived record leaves lists and search unless asked for, and stays readable. A punch item is archived through its Task record.';
comment on column app.records.archived_by is 'Person who archived the record; NULL while it is not archived.';
comment on column app.custom_object_records.archived_at is 'When the custom object record was archived (app.archive_row); it leaves lists unless asked for, and stays readable.';
comment on column app.custom_object_records.archived_by is 'Person who archived the custom object record; NULL while it is not archived.';
comment on column app.vendors.archived_at is 'When the vendor was archived (app.archive_row); it leaves the vendor directory unless asked for, and stays readable.';
comment on column app.vendors.archived_by is 'Person who archived the vendor; NULL while it is not archived.';
comment on column app.venues.archived_at is 'When the venue was archived (app.archive_row); it leaves the venue list unless asked for, and stays readable.';
comment on column app.venues.archived_by is 'Person who archived the venue; NULL while it is not archived, and for venues archived before 2180.';
comment on column app.documents.archived_at is 'When the document was archived (app.archive_row); it leaves lists and search unless asked for, and stays readable.';
comment on column app.documents.archived_by is 'Person who archived the document; NULL while it is not archived.';
comment on column app.work_orders.archived_at is 'When the work order was archived (app.archive_row); it leaves lists unless asked for, and stays readable.';
comment on column app.work_orders.archived_by is 'Person who archived the work order; NULL while it is not archived.';

-- Venues archived through deleted_at -----------------------------------------------------------------------------------
-- The venue events move to archived_at before the rows do, so moving them emits nothing; the audit trail records each.

drop trigger t90_emit_venue_archived on app.venues;
drop trigger t90_emit_venue_restored on app.venues;

drop index app.venues_org_name_key;
create unique index venues_org_name_key on app.venues (org_id, lower(name)) where deleted_at is null and archived_at is null;

update app.venues set archived_at = deleted_at, deleted_at = null where deleted_at is not null;

create trigger t90_emit_venue_archived after update on app.venues
  for each row when (old.archived_at is null and new.archived_at is not null)
  execute function private.emit_row_event('venue.archived', '-', 'name');
create trigger t90_emit_venue_restored after update on app.venues
  for each row when (old.archived_at is not null and new.archived_at is null)
  execute function private.emit_row_event('venue.restored', '-', 'name');

-- Guard -----------------------------------------------------------------------------------------------------------------

create or replace function private.guard_archive_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.in_trusted_operation('archive') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.archived_at is not null or new.archived_by is not null then
      perform private.refuse('archive_rpc_only', 'A row is created live; archive it with app.archive_row.');
    end if;
  elsif new.archived_at is distinct from old.archived_at or new.archived_by is distinct from old.archived_by then
    perform private.refuse('archive_rpc_only', 'A row is archived and unarchived only through app.archive_row and app.unarchive_row.');
  end if;
  return new;
end;
$$;

comment on function private.guard_archive_columns() is 'Before insert or update trigger on every archivable table: archived_at and archived_by change only inside app.archive_row and app.unarchive_row, which check the capability and write the audit event (A124).';
revoke all on function private.guard_archive_columns() from public, anon, authenticated;

create trigger t39_guard_archive_columns before insert or update of archived_at, archived_by on app.records
  for each row execute function private.guard_archive_columns();
create trigger t39_guard_archive_columns before insert or update of archived_at, archived_by on app.custom_object_records
  for each row execute function private.guard_archive_columns();
create trigger t39_guard_archive_columns before insert or update of archived_at, archived_by on app.vendors
  for each row execute function private.guard_archive_columns();
create trigger t39_guard_archive_columns before insert or update of archived_at, archived_by on app.venues
  for each row execute function private.guard_archive_columns();
create trigger t39_guard_archive_columns before insert or update of archived_at, archived_by on app.documents
  for each row execute function private.guard_archive_columns();
create trigger t39_guard_archive_columns before insert or update of archived_at, archived_by on app.work_orders
  for each row execute function private.guard_archive_columns();

-- Archive and unarchive --------------------------------------------------------------------------------------------------

create or replace function private.set_row_archived(p_entity text, p_id uuid, p_archive boolean)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_id uuid := p_id;
  v_org uuid;
  v_archived_at timestamptz;
  v_readable boolean;
  v_writable boolean;
  v_capability text;
  v_person uuid := private.require_person();
  v_now timestamptz := now();
begin
  if p_entity = 'punch_items' then
    -- A punch item is a Task record (0410): archiving it archives that record.
    select pi.record_id into v_id from app.punch_items pi where pi.id = p_id and pi.deleted_at is null;
  end if;

  -- Each entity reads as its select policy does and writes as its update policy does.
  case p_entity
    when 'records', 'punch_items' then
      v_table := 'records';
      v_capability := 'work.record.write';
      select r.org_id, r.archived_at,
        r.project_id in (select private.project_ids_with('work.record.read'))
          or r.id in (select private.my_record_ids('work.record.read'))
          or r.org_id in (select private.oversight_org_ids('work.record.read')),
        r.project_id in (select private.project_ids_with('work.record.write'))
          or r.id in (select private.my_record_ids('work.record.write'))
          or (r.project_id in (select private.project_ids_with('work.punch_list.write'))
              and exists (select 1 from app.punch_items pi where pi.record_id = r.id and pi.deleted_at is null))
      into v_org, v_archived_at, v_readable, v_writable
      from app.records r where r.id = v_id and r.deleted_at is null
      for update;
    when 'work_orders' then
      v_table := 'work_orders';
      v_capability := 'work.work_order.write';
      select w.org_id, w.archived_at,
        w.project_id in (select private.project_ids_with('work.work_order.read'))
          or w.org_id in (select private.oversight_org_ids('work.work_order.read')),
        w.project_id in (select private.project_ids_with('work.work_order.write'))
      into v_org, v_archived_at, v_readable, v_writable
      from app.work_orders w where w.id = v_id and w.deleted_at is null
      for update;
    when 'custom_object_records' then
      v_table := 'custom_object_records';
      v_capability := 'a Collaborator role or higher';
      select c.org_id, c.archived_at,
        c.org_id in (select private.my_org_ids()),
        c.org_id in (select private.custom_writer_orgs())
      into v_org, v_archived_at, v_readable, v_writable
      from app.custom_object_records c where c.id = v_id and c.deleted_at is null
      for update;
    when 'vendors' then
      v_table := 'vendors';
      v_capability := 'vendors.vendor.write';
      select v.org_id, v.archived_at,
        v.org_id in (select private.orgs_with_capability('vendors.vendor.read')),
        v.org_id in (select private.orgs_with_capability('vendors.vendor.write'))
      into v_org, v_archived_at, v_readable, v_writable
      from app.vendors v where v.id = v_id and v.deleted_at is null
      for update;
    when 'venues' then
      v_table := 'venues';
      v_capability := 'places.venue.write';
      select v.org_id, v.archived_at,
        v.org_id in (select private.orgs_with_capability('places.venue.read'))
          or v.id in (select p.venue_id from app.projects p where p.id in (select private.readable_project_ids())),
        v.org_id in (select private.orgs_with_capability('places.venue.write'))
      into v_org, v_archived_at, v_readable, v_writable
      from app.venues v where v.id = v_id and v.deleted_at is null
      for update;
    when 'documents' then
      v_table := 'documents';
      v_capability := 'knowledge.document.write';
      select d.org_id, d.archived_at,
        (d.project_id is null and d.org_id in (select private.orgs_with_capability('knowledge.document.read')))
          or d.project_id in (select private.project_ids_with('knowledge.document.read')),
        (d.project_id is null and d.org_id in (select private.orgs_with_capability('knowledge.document.write')))
          or d.project_id in (select private.project_ids_with('knowledge.document.write'))
      into v_org, v_archived_at, v_readable, v_writable
      from app.documents d where d.id = v_id and d.deleted_at is null
      for update;
    else
      perform private.refuse('archive_entity_unknown',
        'Records, punch items, work orders, custom object records, vendors, venues and documents are archived.');
  end case;

  if v_org is null or not coalesce(v_readable, false) then
    perform private.refuse('archive_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  if not coalesce(v_writable, false) then
    raise exception using errcode = '42501', message = format('%s is required to archive or unarchive this row.', v_capability);
  end if;
  if (v_archived_at is not null) = p_archive then
    return v_archived_at;
  end if;

  begin
    perform private.begin_trusted_operation('archive');
    execute format('update app.%I set archived_at = $1, archived_by = $2 where id = $3', v_table)
      using case when p_archive then v_now end, case when p_archive then v_person end, v_id;
    perform private.end_trusted_operation('archive');
  exception when unique_violation then
    perform private.refuse('archive_name_taken', 'A live venue already has this name; rename one of them first.');
  end;

  perform private.write_audit_event(v_org, v_table || case when p_archive then '.archived' else '.unarchived' end,
    'app.' || v_table, v_id,
    jsonb_build_object('archived_at', jsonb_build_array(v_archived_at, case when p_archive then v_now end)));
  return case when p_archive then v_now end;
end;
$$;

comment on function private.set_row_archived(text, uuid, boolean) is 'Archives or unarchives one row of records (or a punch item''s Task record), work_orders, custom_object_records, vendors, venues or documents: refused when the row is gone or not visible to the caller (archive_row_not_found), 42501 without the capability of the table''s update policy, unchanged when already in that state, and otherwise stamped and written to the audit ledger as <table>.archived or <table>.unarchived (A124).';
revoke all on function private.set_row_archived(text, uuid, boolean) from public, anon, authenticated;

create or replace function app.archive_row(p_entity text, p_id uuid)
returns timestamptz
language sql
volatile
security definer
set search_path = ''
as $$
  select private.set_row_archived(p_entity, p_id, true);
$$;

comment on function app.archive_row(text, uuid) is 'Archives a row (Section 4.10, A124): p_entity is records, punch_items, work_orders, custom_object_records, vendors, venues or documents. Answers when it was archived; an archived row leaves lists and search unless asked for and stays readable. Needs the capability that edits the row.';
revoke all on function app.archive_row(text, uuid) from public, anon;
grant execute on function app.archive_row(text, uuid) to authenticated, service_role;

create or replace function app.unarchive_row(p_entity text, p_id uuid)
returns timestamptz
language sql
volatile
security definer
set search_path = ''
as $$
  select private.set_row_archived(p_entity, p_id, false);
$$;

comment on function app.unarchive_row(text, uuid) is 'Unarchives a row archived with app.archive_row, so it returns to lists and search; answers NULL. Needs the capability that edits the row.';
revoke all on function app.unarchive_row(text, uuid) from public, anon;
grant execute on function app.unarchive_row(text, uuid) to authenticated, service_role;
