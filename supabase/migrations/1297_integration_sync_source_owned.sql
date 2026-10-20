-- 1297_integration_sync_source_owned.sql
-- A69 security review (RRR-114), finding A69-006. app.enqueue_integration_sync takes p_source_uri, the
-- "<bucket>/<path>" of the file a run imports (the ticketing CSV), and stored it after a length check only. The
-- integration worker reads that path with the service role (packages/integrations/src/worker.ts), so an integration
-- manager could name any object in any bucket: another org's onboarding uploads, attachments or report results. The
-- worker would read it and report its rows, row errors included, into the manager's own sync run. The worker is not
-- deployed yet, so the flaw was latent; it is closed here before it can be.
--   * A run's source must be a spreadsheet in the imports bucket, named the way that bucket names uploads
--     (imports/<person id>/<upload id>.csv or .xlsx, private.import_object_owner).
--   * When a signed-in person enqueues the run, the file must be their own upload, as for an import job (1061).
--   * When the platform enqueues it (no person), the uploader must hold an active membership in the run's org.
-- The worker also reads only the imports bucket and only a Clean file (packages/integrations, same finding).

create or replace function private.integration_source_owner(p_source_uri text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case when p_source_uri like 'imports/%' then private.import_object_owner(substr(p_source_uri, 9)) end;
$$;

comment on function private.integration_source_owner(text) is 'Person who uploaded the file an integration sync run imports: the owner of an imports bucket object named imports/<person id>/<upload id>.csv or .xlsx, else NULL (A69-006).';
revoke all on function private.integration_source_owner(text) from public, anon, authenticated;

create or replace function private.guard_integration_sync_source()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_person uuid := private.current_person_id();
begin
  if new.source_uri is null then
    return new;
  end if;
  v_owner := private.integration_source_owner(new.source_uri);
  if v_owner is null then
    perform private.refuse('integration_source_location', 'A sync run imports a spreadsheet uploaded to the imports bucket.');
  end if;
  if v_person is not null and v_owner <> v_person then
    perform private.refuse('integration_source_owner', 'A sync run imports a spreadsheet you uploaded yourself.');
  end if;
  if v_person is null and not exists (
    select 1 from app.memberships m
    where m.person_id = v_owner and m.org_id = new.org_id and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
    perform private.refuse('integration_source_owner', 'A sync run imports a spreadsheet a member of its org uploaded.');
  end if;
  return new;
end;
$$;

comment on function private.guard_integration_sync_source() is 'Integration sync runs import only a spreadsheet in the imports bucket that the enqueuing person uploaded, or, when the platform enqueues, that a member of the run''s org uploaded, because the worker reads it with the service role (A69-006).';
revoke all on function private.guard_integration_sync_source() from public, anon, authenticated;

create trigger t42_guard_integration_sync_source before insert on app.integration_sync_runs
  for each row execute function private.guard_integration_sync_source();
