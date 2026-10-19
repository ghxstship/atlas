-- 1241_xls_import_dropped.sql
-- A57 (RRR-102), owner decision 28: importing legacy binary Excel (.xls) is dropped (ADR 0033). The
-- import worker never read .xls (it reads .csv and .xlsx only), so a .xls import could only fail late.
-- It is now refused up front, in the database, whatever the caller (Atlas, the API, the SDK):
--   * the imports bucket accepts only text/csv and .xlsx, and its object names end in .csv or .xlsx;
--   * a new import job whose source is XLS is refused with import_xls_unsupported, a plain-language
--     message telling the person to save the sheet as .xlsx or .csv.
-- The XLS value stays in app.import_source so earlier jobs keep their history; attachments may still
-- hold .xls files, which are stored and scanned but never parsed.

update storage.buckets
set allowed_mime_types = array['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
where id = 'imports';

create or replace function private.import_object_owner(p_object_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_object_name is null or p_object_name !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(csv|xlsx)$' then
    return null;
  end if;
  return split_part(p_object_name, '/', 1)::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

comment on function private.import_object_owner(text) is 'Person id that owns an imports object (<person_id>/<upload id>.<csv|xlsx>), or NULL for any other name, including a legacy .xls (1241). Takes the name as a value (ADR 0016 rule 14).';

create or replace function private.refuse_xls_import()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.source = 'XLS' then
    perform private.refuse('import_xls_unsupported',
      'Older .xls files cannot be read. Save the sheet as .xlsx or .csv and upload it again.');
  end if;
  return new;
end;
$$;

comment on function private.refuse_xls_import() is 'Owner decision 28 (1241): a new import job cannot read a legacy .xls file; the person saves it as .xlsx or .csv.';
revoke all on function private.refuse_xls_import() from public, anon, authenticated;

create trigger t40_refuse_xls_import before insert on app.import_jobs
  for each row execute function private.refuse_xls_import();

comment on column app.import_jobs.source is 'CSV, XLSX or a Google Sheets link. XLS remains only on jobs created before 1241; a new .xls import is refused.';
