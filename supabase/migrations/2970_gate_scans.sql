-- 2970_gate_scans.sql
-- B8 Access control (RRR-232, gap G-145, ADR 0147 decisions 1 and 2). Gate scans gain a direction, the database's
-- reason for a refusal and a supervisor override:
--
--   * app.access_scans.direction: In or Out. Existing rows read as In. Exit is never refused, and an Out scan ends
--     presence (2971).
--   * app.access_scans.refusal_reason: set by private.decide_access_scan on every Denied row from now on, in the order
--     Compass's decideGate checks (revoked, not yet valid, expired, no zone access, outside the window). Denied rows
--     recorded before this migration keep no reason: the table is append-only, and a reason worked out afterwards
--     would be an invented fact, so access_scans_refusal only says a reason belongs to a Denied row.
--   * An override is a new Granted In row that names the Denied In scan it overrides and why
--     (override_of_scan_id, override_reason). The log stays append-only. Only app.override_access_scan writes such a
--     row, inside the trusted operation access_scan_override, for a holder of credentials.credential.issue on the
--     project who is not the holder (invariant 21), within 15 minutes of the denial, once, and never for a badge that
--     is revoked or deleted now. There is no foreign key: a key into the partitioned table would need
--     (id, created_at), and 1511 keeps access_scans unreferenced; the RPC checks the scan. The advisory lock on the
--     denied scan's id is the only guard against two overrides, because a unique index on a partitioned table must
--     include created_at.
--   * app.record_scan (from 0470, its only definition) takes p_direction, default In, so released Compass builds that
--     call it by name keep working, and returns the direction and the reason after its 0470 columns.

create type app.scan_direction as enum ('In', 'Out');
comment on type app.scan_direction is 'Whether a gate scan lets someone in or records them leaving. Exit is never refused.';

create type app.scan_refusal_reason as enum ('Revoked', 'Not Yet Valid', 'Expired', 'No Zone Access', 'Outside Window');
comment on type app.scan_refusal_reason is 'Why the database denied an In scan, one to one with Compass''s device reasons except unknown: the database refuses an unknown code (credential_unknown) before any scan row exists.';

-- Columns on the partitioned parent reach every partition ------------------------------------------------------------

alter table app.access_scans add column direction app.scan_direction not null default 'In';
alter table app.access_scans add column refusal_reason app.scan_refusal_reason;
alter table app.access_scans add column override_of_scan_id uuid;
alter table app.access_scans add column override_reason text;

alter table app.access_scans add constraint access_scans_refusal check (refusal_reason is null or result = 'Denied');
alter table app.access_scans add constraint access_scans_override_pair check ((override_of_scan_id is null) = (override_reason is null));
alter table app.access_scans add constraint access_scans_override_reason_length
  check (override_reason is null or char_length(btrim(override_reason)) between 1 and 300);
alter table app.access_scans add constraint access_scans_override_in
  check (override_of_scan_id is null or (direction = 'In' and result = 'Granted'));

create index access_scans_override_idx on app.access_scans (override_of_scan_id) where override_of_scan_id is not null;

comment on column app.access_scans.direction is 'In or Out. Rows recorded before migration 2970 read as In. An Out scan is never refused and ends the person''s presence in the zone.';
comment on column app.access_scans.refusal_reason is 'Why the database denied an In scan: Revoked, Not Yet Valid, Expired, No Zone Access or Outside Window. Set by the database on every Denied row since migration 2970; NULL on a Granted row and on Denied rows recorded before it.';
comment on column app.access_scans.override_of_scan_id is 'The Denied In scan this Granted In row overrides; written only by app.override_access_scan. No foreign key into the partitioned table; the RPC checks it.';
comment on column app.access_scans.override_reason is 'Why the supervisor let the person in, 1 to 300 characters; set with override_of_scan_id.';

-- The decision (from 0352, its only definition) -----------------------------------------------------------------------

create or replace function private.decide_access_scan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential app.credentials;
begin
  new.scanned_at := now();
  new.refusal_reason := null;
  if (new.override_of_scan_id is not null or new.override_reason is not null)
     and not private.in_trusted_operation('access_scan_override') then
    perform private.refuse('scan_override_rpc', 'An override is recorded through app.override_access_scan.');
  end if;
  if new.direction = 'Out' or private.in_trusted_operation('access_scan_override') then
    new.result := 'Granted';
    return new;
  end if;
  select * into v_credential from app.credentials c where c.id = new.credential_id;
  new.refusal_reason := case
    when v_credential.revoked_at is not null or v_credential.deleted_at is not null then 'Revoked'
    when v_credential.valid_from > now() then 'Not Yet Valid'
    when v_credential.valid_to is not null and v_credential.valid_to <= now() then 'Expired'
    when not exists (select 1 from app.access_grid g
                     where g.credential_category_id = v_credential.credential_category_id and g.zone_id = new.zone_id
                       and g.deleted_at is null) then 'No Zone Access'
    when not exists (select 1 from app.access_grid g
                     where g.credential_category_id = v_credential.credential_category_id and g.zone_id = new.zone_id
                       and g.deleted_at is null and g.window_starts_at <= now() and g.window_ends_at > now()) then 'Outside Window'
  end::app.scan_refusal_reason;
  new.result := case when new.refusal_reason is null then 'Granted' else 'Denied' end::app.scan_result;
  return new;
end;
$$;
comment on function private.decide_access_scan() is 'Decides an access scan at the database time. An Out scan is always Granted (exit is never refused). An In scan is Granted, or Denied with the first failing check as its reason: Revoked (revoked or deleted), Not Yet Valid, Expired, No Zone Access (no live access grid row for the category and zone) or Outside Window (no such row whose window contains now). Inside the trusted operation access_scan_override the override row is Granted; outside it a row naming an override is refused (scan_override_rpc).';
revoke all on function private.decide_access_scan() from public, anon, authenticated;

-- The scanner's insert path (from 0470, its only definition) ------------------------------------------------------------

drop function app.record_scan(uuid, uuid, text, uuid, timestamptz, app.scan_result);

create function app.record_scan(
  p_zone_id uuid,
  p_credential_id uuid default null,
  p_credential_number text default null,
  p_id uuid default null,
  p_device_scanned_at timestamptz default null,
  p_offline_result app.scan_result default null,
  p_direction app.scan_direction default 'In'
)
returns table (
  id uuid,
  credential_id uuid,
  credential_number text,
  holder_name text,
  category_code text,
  zone_id uuid,
  zone_code text,
  scanned_at timestamptz,
  result app.scan_result,
  replayed boolean,
  direction app.scan_direction,
  refusal_reason app.scan_refusal_reason
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_zone app.zones;
  v_credential app.credentials;
  v_project uuid;
  v_scan app.access_scans;
  v_replayed boolean := false;
  v_direction app.scan_direction := coalesce(p_direction, 'In');
begin
  select * into v_zone from app.zones z where z.id = p_zone_id and z.deleted_at is null;
  if v_zone.id is null then
    raise exception using errcode = '42501', message = 'the zone does not exist or is not visible';
  end if;
  if p_credential_id is not null then
    select * into v_credential from app.credentials c where c.id = p_credential_id and c.deleted_at is null;
  elsif p_credential_number is not null then
    select * into v_credential from app.credentials c
    where c.org_id = v_zone.org_id and c.credential_number = upper(btrim(p_credential_number)) and c.deleted_at is null;
  end if;
  if v_credential.id is null or v_credential.org_id <> v_zone.org_id then
    perform private.refuse('credential_unknown', 'No credential of this organization matches the scanned code.');
  end if;
  v_project := (select cc.project_id from app.credential_categories cc where cc.id = v_credential.credential_category_id);
  if not private.can_on_project(v_project, 'credentials.scan.write') then
    raise exception using errcode = '42501', message = 'credentials.scan.write is required on the project';
  end if;

  if p_id is not null then
    select * into v_scan from app.access_scans s where s.id = p_id;
    if v_scan.id is not null then
      if v_scan.created_by is distinct from v_person or v_scan.credential_id <> v_credential.id or v_scan.zone_id <> v_zone.id
         or v_scan.direction <> v_direction then
        perform private.refuse('scan_id_taken', 'Another scan already uses this id.');
      end if;
      v_replayed := true;
    end if;
  end if;

  if not v_replayed then
    insert into app.access_scans (id, org_id, credential_id, zone_id, device_scanned_at, offline_result, direction)
    values (coalesce(p_id, private.uuid_v7()), v_zone.org_id, v_credential.id, v_zone.id, p_device_scanned_at, p_offline_result,
            v_direction)
    returning * into v_scan;
  end if;

  return query
  select v_scan.id, v_credential.id, v_credential.credential_number,
    (select p.full_name from app.people p where p.id = v_credential.holder_person_id),
    (select cc.code from app.credential_categories cc where cc.id = v_credential.credential_category_id),
    v_zone.id, v_zone.code, v_scan.scanned_at, v_scan.result, v_replayed, v_scan.direction, v_scan.refusal_reason;
end;
$$;
comment on function app.record_scan(uuid, uuid, text, uuid, timestamptz, app.scan_result, app.scan_direction) is 'Records a credential scan at a zone, In (the default) or Out, by credential id or printed number, for a person with credentials.scan.write on the credential''s project. The database decides the result and, for a denial, the reason (migration 2970); an Out scan is never refused. A client id makes the call idempotent: replaying the same id by the same person with the same credential, zone and direction returns the stored scan with replayed = true; any other replay is refused (scan_id_taken).';
revoke all on function app.record_scan(uuid, uuid, text, uuid, timestamptz, app.scan_result, app.scan_direction) from public, anon;
grant execute on function app.record_scan(uuid, uuid, text, uuid, timestamptz, app.scan_result, app.scan_direction) to authenticated, service_role;

-- The supervisor override ----------------------------------------------------------------------------------------------

create function app.override_access_scan(p_scan_id uuid, p_reason text, p_id uuid default null)
returns table (
  id uuid,
  credential_id uuid,
  credential_number text,
  holder_name text,
  category_code text,
  zone_id uuid,
  zone_code text,
  scanned_at timestamptz,
  result app.scan_result,
  replayed boolean,
  direction app.scan_direction,
  refusal_reason app.scan_refusal_reason,
  overridden_scan_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_denied app.access_scans;
  v_credential app.credentials;
  v_project uuid;
  v_scan app.access_scans;
  v_replayed boolean := false;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform pg_advisory_xact_lock(hashtextextended('access_scan_override:' || coalesce(p_scan_id::text, ''), 0));
  select * into v_denied from app.access_scans s where s.id = p_scan_id;
  if v_denied.id is null or not private.can_on_project(v_denied.project_id, 'credentials.scan_log.read') then
    raise exception using errcode = '42501', message = 'the scan does not exist or is not visible';
  end if;
  select * into v_credential from app.credentials c where c.id = v_denied.credential_id;
  v_project := (select cc.project_id from app.credential_categories cc where cc.id = v_credential.credential_category_id);
  if not private.can_on_project(v_project, 'credentials.credential.issue') then
    raise exception using errcode = '42501', message = 'credentials.credential.issue is required on the project to override a denied scan';
  end if;

  if p_id is not null then
    select * into v_scan from app.access_scans s where s.id = p_id;
    if v_scan.id is not null then
      if v_scan.created_by is distinct from v_person or v_scan.override_of_scan_id is distinct from v_denied.id then
        perform private.refuse('scan_id_taken', 'Another scan already uses this id.');
      end if;
      v_replayed := true;
    end if;
  end if;

  if not v_replayed then
    if v_denied.result <> 'Denied' or v_denied.direction <> 'In' then
      perform private.refuse('scan_not_denied', 'Only a denied entry scan is overridden.');
    end if;
    if v_denied.refusal_reason = 'Revoked' or v_credential.revoked_at is not null or v_credential.deleted_at is not null then
      perform private.refuse('scan_override_revoked', 'A revoked credential is never let in. Issue a new one.');
    end if;
    if v_denied.created_at < now() - interval '15 minutes' then
      perform private.refuse('scan_override_stale', 'A denial is overridden within 15 minutes. Scan the credential again.');
    end if;
    if exists (select 1 from app.access_scans s where s.override_of_scan_id = v_denied.id) then
      perform private.refuse('scan_override_taken', 'This denial was already overridden.');
    end if;
    if v_credential.holder_person_id = v_person then
      perform private.refuse('scan_override_self', 'Nobody overrides a denial of their own credential.');
    end if;
    if char_length(v_reason) not between 1 and 300 then
      perform private.refuse('scan_override_reason', 'Say why in 1 to 300 characters.');
    end if;
    perform private.begin_trusted_operation('access_scan_override');
    insert into app.access_scans (id, org_id, credential_id, zone_id, direction, override_of_scan_id, override_reason)
    values (coalesce(p_id, private.uuid_v7()), v_denied.org_id, v_denied.credential_id, v_denied.zone_id, 'In', v_denied.id, v_reason)
    returning * into v_scan;
    perform private.end_trusted_operation('access_scan_override');
  end if;

  return query
  select v_scan.id, v_credential.id, v_credential.credential_number,
    (select p.full_name from app.people p where p.id = v_credential.holder_person_id),
    (select cc.code from app.credential_categories cc where cc.id = v_credential.credential_category_id),
    v_scan.zone_id, (select z.code from app.zones z where z.id = v_scan.zone_id),
    v_scan.scanned_at, v_scan.result, v_replayed, v_scan.direction, v_scan.refusal_reason, v_scan.override_of_scan_id;
end;
$$;
comment on function app.override_access_scan(uuid, text, uuid) is 'A supervisor lets in someone the gate denied (ADR 0147 decision 1): records a new Granted In scan at the same zone for the same credential, naming the denied scan and the reason. Needs credentials.scan_log.read and credentials.credential.issue on the project (42501). Refuses scan_not_denied (not a Denied In scan), scan_override_revoked (the denial was Revoked, or the credential is revoked or deleted now), scan_override_stale (older than 15 minutes), scan_override_taken (already overridden), scan_override_self (the caller holds the credential) and scan_override_reason (1 to 300 characters). A client id makes it idempotent: the same person replaying it gets the stored row with replayed = true; anyone else''s id is refused (scan_id_taken).';
revoke all on function app.override_access_scan(uuid, text, uuid) from public, anon;
grant execute on function app.override_access_scan(uuid, text, uuid) to authenticated, service_role;

insert into private.sync_rpcs (rpc, description) values
  ('app.override_access_scan', 'Gate supervisor override of a denied entry scan, queued after the denied record_scan; replays are idempotent on the override''s client id.');
