-- 1351_org_deletion.sql
-- A79 (RRR-124), finding A65-015, Section 14.7:
--   "At day 90, data is deleted, backups age out on their schedule, and the Owner receives a deletion certificate."
--   "Org deletion requires the Owner, step-up authentication and typing the org name. A 7-day recovery window applies."
--
--   * private.require_step_up: the seam every Owner action that needs step-up calls. It refuses step_up_required unless
--     the session passed a second factor (private.session_aal() = 'aal2', which A77's migration 1330 narrows to the last
--     15 minutes) and is not an API key. Atlas answers the refusal with the step-up flow and retries.
--   * app.org_deletion_requests: deletion, separate from cancellation. The Owner types the name with step-up; the
--     subscription ends and the org is read-only at once; the Owner may recover it for the rest of that day and 7 whole
--     days on the org's calendar (private.org_window_end, 1350); then it is deleted.
--   * app.deletion_certificates: the record of a deleted org, kept after the org is gone (no foreign key to it), with
--     the counts of what was deleted, the certificate PDF and its delivery to the former Owner.
--   * The purge, in three steps the hourly lifecycle job and the org-lifecycle worker share:
--       1. the job writes a certificate for each org due (day 90 of a cancellation on the org's calendar, counted from
--          the day it was canceled, or the end of a deletion request's recovery window), unless a legal hold stands;
--       2. the worker deletes the org's storage objects through the Storage API (SQL deletes of storage.objects are
--          refused), lists them with app.deletion_storage_objects and records that none remain;
--       3. the job deletes every row of the org with private.purge_organization, through the sanctioned tenant purge of
--          migration 1270 (private.begin_tenant_purge), in one transaction with no statement timeout;
--       4. the worker renders the PDF through the document pipeline (ADR 0031), stores it in the private
--          deletion-certificates bucket and emails it to the former Owner.
--     A legal hold holds the org (the purge refuses it too). A purge that would reach another org's rows refuses and
--     records why, as the demo removal does (infra/runbooks/promote-to-production.md); the platform resolves it.

-- Step-up seam ------------------------------------------------------------------------------------------------------

create or replace function private.require_step_up(p_action text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.api_key_scopes() is not null then
    perform private.refuse('step_up_session_only', format('%s needs a signed-in session, never an API key.', p_action));
  end if;
  if private.session_aal() <> 'aal2' then
    perform private.refuse('step_up_required', format('Confirm it is you with your second factor to %s.', p_action));
  end if;
end;
$$;

comment on function private.require_step_up(text) is 'Step-up seam (Section 9, Section 14.7): refuses step_up_required unless the session passed a second factor recently (private.session_aal() is aal2; A77''s 1330 bounds it to 15 minutes) and step_up_session_only for an API key. p_action names the action in the refusal, for example "delete the organization".';
revoke all on function private.require_step_up(text) from public, anon, authenticated;

-- Deletion requests -------------------------------------------------------------------------------------------------

-- Exempt before the table exists, so install_domain_table attaches no read-only guard to it.
insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.org_deletion_requests', 'A canceled org may still be deleted sooner, and a deletion request is recovered while the org is read-only.');

create table app.org_deletion_requests (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  reason text not null,
  requested_at timestamptz not null default now(),
  recover_until timestamptz not null,
  requested_by uuid not null references app.people (id),
  recovered_at timestamptz,
  recovered_by uuid references app.people (id),
  constraint org_deletion_requests_reason_length check (char_length(btrim(reason)) between 1 and 1000),
  constraint org_deletion_requests_window check (recover_until between requested_at + interval '6 days 22 hours' and requested_at + interval '8 days 2 hours'),
  constraint org_deletion_requests_recovered check ((recovered_at is null) = (recovered_by is null)),
  constraint org_deletion_requests_recovered_in_window check (recovered_at is null or recovered_at <= recover_until)
);

call private.install_domain_table('app.org_deletion_requests');
create unique index org_deletion_requests_one_live on app.org_deletion_requests (org_id) where recovered_at is null and deleted_at is null;
create index org_deletion_requests_requested_by_idx on app.org_deletion_requests (requested_by);
create index org_deletion_requests_recovered_by_idx on app.org_deletion_requests (recovered_by);

call private.describe('app.org_deletion_requests', 'An Owner''s request to delete the org (Section 14.7), separate from cancellation: made with step-up and the typed org name, it ends the subscription and makes the org read-only at once; the Owner may recover the org for 7 days, after which its data is deleted and the Owner receives a deletion certificate. Written only by app.request_org_deletion and app.recover_org_deletion.', array[
  'reason', 'Why the org is deleted, in the Owner''s words.',
  'requested_at', 'When the Owner asked for deletion.',
  'recover_until', 'End of the recovery window: midnight on the org''s calendar after the seventh whole day after the request; the org is deleted after it.',
  'requested_by', 'Owner who asked for deletion.',
  'recovered_at', 'When an Owner recovered the org inside the window.',
  'recovered_by', 'Owner who recovered it.'
]);

call private.install_policies('app.org_deletion_requests', $$org_id in (select private.my_org_ids())$$);
call private.install_audit_trail('app.org_deletion_requests');

create or replace function private.guard_org_deletion_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id <> old.org_id or new.requested_at <> old.requested_at or new.reason <> old.reason
     or new.requested_by <> old.requested_by
     or (old.recovered_at is not null and new.recovered_at is distinct from old.recovered_at) then
    perform private.refuse('org_deletion_request_immutable', 'A deletion request keeps its org, time, reason and requester; it is recovered once.');
  end if;
  return new;
end;
$$;

comment on function private.guard_org_deletion_request() is 'Deletion requests keep their org, time, reason and requester, and are recovered at most once.';
revoke all on function private.guard_org_deletion_request() from public, anon, authenticated;

create trigger t40_guard_org_deletion_request before update on app.org_deletion_requests
  for each row execute function private.guard_org_deletion_request();

-- Read-only: a canceled org, and an org waiting for deletion --------------------------------------------------------

create or replace function private.org_read_only_reason(p_org_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (select 1 from app.org_deletion_requests r
                 where r.org_id = p_org_id and r.recovered_at is null and r.deleted_at is null) then 'deletion'
    when exists (select 1 from app.org_cancellations c
                 where c.org_id = p_org_id and c.reactivated_at is null and c.deleted_at is null) then 'canceled'
  end;
$$;

comment on function private.org_read_only_reason(uuid) is 'Why an org is read-only: deletion while a deletion request waits out its recovery window, canceled during a cancellation, or null when it is writable (Section 14.7). Takes the org id as an argument (ADR 0016 rule 14).';
revoke all on function private.org_read_only_reason(uuid) from public, anon;
grant execute on function private.org_read_only_reason(uuid) to authenticated, service_role;

create or replace function private.org_read_only(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.org_read_only_reason(p_org_id) is not null;
$$;

comment on function private.org_read_only(uuid) is 'True while an org is read-only (Section 14.7): canceled and not reactivated, or waiting for deletion and not recovered. Takes the org id as an argument (ADR 0016 rule 14).';

create or replace function private.refuse_read_only_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := ((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'org_id')::uuid;
  v_reason text;
begin
  if private.current_person_id() is null or v_org is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  v_reason := private.org_read_only_reason(v_org);
  if v_reason = 'deletion' then
    perform private.refuse('org_read_only', 'This organization is waiting to be deleted and is read-only. The Owner can recover it in Settings, Danger zone, during the 7 days.');
  elsif v_reason = 'canceled' then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.');
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function private.refuse_read_only_org() is 'Refuses a person''s write to a row of a read-only org (Section 14.7): canceled, or waiting for deletion. Workers and retention (no person) still write.';

-- Request and recover -------------------------------------------------------------------------------------------------

insert into private.notification_templates (kind, channel, category_code, email_template_code)
select k.kind, c.channel, 'account', case when c.channel = 'Email' then 'notification' end
from (values ('organization.deletion_requested'), ('organization.deletion_recovered')) as k (kind)
cross join (values ('In App'::app.notification_channel), ('Email'), ('SMS'), ('Push')) as c (channel);

create or replace function private.org_owner_ids(p_org_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.person_id from app.memberships m
  join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
  where m.org_id = p_org_id and mr.role_id = private.system_role_id('owner')
    and m.deleted_at is null and m.valid_from <= now() and m.valid_to is null;
$$;

comment on function private.org_owner_ids(uuid) is 'People who hold the Owner role of an org now.';
revoke all on function private.org_owner_ids(uuid) from public, anon, authenticated;

create or replace function app.request_org_deletion(p_org_id uuid, p_confirm_name text, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_org app.organizations;
  v_sub app.subscriptions;
  v_id uuid;
  v_owner uuid;
  v_until timestamptz;
begin
  if not private.has_capability(p_org_id, 'org.organization.delete') then
    raise exception using errcode = '42501', message = 'org.organization.delete is required';
  end if;
  perform private.require_step_up('delete the organization');
  select * into v_org from app.organizations o where o.id = p_org_id and o.deleted_at is null for update;
  if exists (select 1 from app.org_deletion_requests r where r.org_id = p_org_id and r.recovered_at is null and r.deleted_at is null) then
    perform private.refuse('org_deletion_pending', 'This organization is already waiting to be deleted.');
  end if;
  if p_confirm_name is null or btrim(p_confirm_name) <> v_org.name then
    perform private.refuse('org_name_mismatch', 'Type the organization''s name exactly to confirm.');
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 1000 then
    perform private.refuse('org_deletion_reason', 'Say why the organization is deleted, in up to 1,000 characters.');
  end if;
  if exists (select 1 from app.organizations c where c.parent_org_id = p_org_id and c.deleted_at is null) then
    perform private.refuse('org_delete_has_clients', 'A partner with client orgs cannot be deleted; move each client to direct billing first.');
  end if;
  if exists (select 1 from app.legal_holds h where h.org_id = p_org_id and h.released_at is null and h.deleted_at is null) then
    perform private.refuse('org_deletion_legal_hold', 'This organization is under a legal hold and cannot be deleted until the hold is released.');
  end if;
  select * into v_sub from app.subscriptions s
  where s.org_id = p_org_id and s.subscription_state <> 'canceled' and s.deleted_at is null for update;
  if v_sub.id is not null then
    perform private.transition_subscription(v_sub.id, v_sub.subscription_state, 'canceled',
      'Deletion requested by the Owner: ' || left(btrim(p_reason), 400));
  end if;
  v_until := private.org_window_end(p_org_id, 7);
  insert into app.org_deletion_requests (org_id, reason, requested_at, recover_until, requested_by)
  values (p_org_id, btrim(p_reason), now(), v_until, v_person)
  returning id into v_id;
  -- "deleted after <date>": the window's last day on the org's calendar.
  for v_owner in select private.org_owner_ids(p_org_id) loop
    perform private.notify(p_org_id, v_owner, 'organization.deletion_requested', 'app.org_deletion_requests', v_id, null,
      jsonb_build_object('recover_until', private.org_day_mark(p_org_id, private.org_window_last_day(p_org_id, v_until))));
  end loop;
  return v_id;
end;
$$;

comment on function app.request_org_deletion(uuid, text, text) is 'Asks to delete an org (Section 14.7): the Owner (org.organization.delete) with step-up (private.require_step_up) types the org name and a reason. The subscription is canceled in the database (the billing service ends any Stripe subscription through its own seam), the org becomes read-only, every Owner is told, and the org is deleted after a recovery window of the rest of the day and 7 whole days on the org''s calendar. Refuses a partner with client orgs and an org under a legal hold. Returns the request id.';
revoke all on function app.request_org_deletion(uuid, text, text) from public, anon;
grant execute on function app.request_org_deletion(uuid, text, text) to authenticated, service_role;

create or replace function app.recover_org_deletion(p_org_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_request app.org_deletion_requests;
  v_owner uuid;
begin
  if not private.has_capability(p_org_id, 'org.organization.delete') then
    raise exception using errcode = '42501', message = 'org.organization.delete is required';
  end if;
  select * into v_request from app.org_deletion_requests r
  where r.org_id = p_org_id and r.recovered_at is null and r.deleted_at is null for update;
  if v_request.id is null then
    perform private.refuse('org_deletion_not_pending', 'This organization is not waiting to be deleted.');
  end if;
  if now() > v_request.recover_until then
    perform private.refuse('org_deletion_window', 'An organization can be recovered during the 7 days after deletion was requested.');
  end if;
  update app.org_deletion_requests set recovered_at = now(), recovered_by = v_person where id = v_request.id;
  if not exists (select 1 from app.org_cancellations c where c.org_id = p_org_id and c.reactivated_at is null and c.deleted_at is null)
     and not exists (select 1 from app.subscriptions s where s.org_id = p_org_id and s.subscription_state <> 'canceled' and s.deleted_at is null) then
    perform private.create_subscription(p_org_id, 'access');
  end if;
  for v_owner in select private.org_owner_ids(p_org_id) loop
    perform private.notify(p_org_id, v_owner, 'organization.deletion_recovered', 'app.org_deletion_requests', v_request.id, null, '{}'::jsonb);
  end loop;
  return v_request.id;
end;
$$;

comment on function app.recover_org_deletion(uuid) is 'Recovers an org waiting for deletion within its 7-day window (the Owner, org.organization.delete): writes work again and, unless the org is also canceled, it restarts on the Access plan, from which the Owner upgrades through billing. Every Owner is told. Returns the request id.';
revoke all on function app.recover_org_deletion(uuid) from public, anon;
grant execute on function app.recover_org_deletion(uuid) to authenticated, service_role;

-- Deletion certificates -----------------------------------------------------------------------------------------------

create table app.deletion_certificates (
  id uuid primary key default private.uuid_v7(),
  deleted_org_id uuid not null,
  org_name text not null,
  org_slug text not null,
  basis text not null,
  requested_at timestamptz not null,
  due_at timestamptz not null,
  owner_person_id uuid references app.people (id) on delete set null,
  owner_name text,
  owner_email text,
  locale text not null default 'en-US',
  time_zone text not null default 'UTC',
  held_at timestamptz,
  blocked_reason text,
  storage_cleared_at timestamptz,
  storage_objects_deleted integer not null default 0,
  purged_at timestamptz,
  tables_purged integer,
  rows_purged bigint,
  document_object text,
  document_sha256 text,
  issued_at timestamptz,
  delivered_at timestamptz,
  delivery_message_id text,
  attempts smallint not null default 0,
  locked_by text,
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint deletion_certificates_basis check (basis in ('cancellation', 'deletion_request')),
  constraint deletion_certificates_locale check (locale in ('en-US', 'es-US')),
  constraint deletion_certificates_purge_counts check ((purged_at is null) = (rows_purged is null) and (purged_at is null) = (tables_purged is null)),
  constraint deletion_certificates_purged_after_storage check (purged_at is null or storage_cleared_at is not null),
  constraint deletion_certificates_issued check ((issued_at is null) = (document_object is null) and (issued_at is null) = (document_sha256 is null)),
  constraint deletion_certificates_issued_after_purge check (issued_at is null or purged_at is not null),
  constraint deletion_certificates_delivered check (delivered_at is null or issued_at is not null),
  constraint deletion_certificates_sha check (document_sha256 is null or document_sha256 ~ '^[0-9a-f]{64}$'),
  constraint deletion_certificates_lock_pair check ((locked_by is null) = (locked_at is null)),
  constraint deletion_certificates_text_lengths check (
    char_length(org_name) <= 300 and char_length(org_slug) <= 100
    and (blocked_reason is null or char_length(blocked_reason) <= 2000)
    and (last_error is null or char_length(last_error) <= 2000)
    and (locked_by is null or char_length(locked_by) <= 200)
    and (owner_email is null or char_length(owner_email) <= 320))
);

create unique index deletion_certificates_org_key on app.deletion_certificates (deleted_org_id);
create index deletion_certificates_owner_person_id_idx on app.deletion_certificates (owner_person_id);
create index deletion_certificates_open_idx on app.deletion_certificates (due_at) where delivered_at is null;

call private.install_audit_columns('app.deletion_certificates');
call private.describe('app.deletion_certificates', 'The record of an org whose data was deleted (Section 14.7): day 90 of a cancellation or the end of a deletion request''s recovery window. Kept after the org is gone, so it names the org by id, name and slug with no foreign key. It tracks the purge (storage objects, then every row through the tenant purge), the certificate PDF and its email to the former Owner. Written only by the lifecycle job and the org-lifecycle worker; the former Owner reads their own.', array[
  'id', 'Certificate id, printed on the PDF.',
  'deleted_org_id', 'Id the org had. No foreign key: the org row is deleted.',
  'org_name', 'Name of the org when it was deleted.',
  'org_slug', 'Web address of the org when it was deleted.',
  'basis', 'cancellation (day 90 of a cancellation) or deletion_request (end of the 7-day recovery window).',
  'requested_at', 'When the Owner canceled or asked for deletion.',
  'due_at', 'When the data became due for deletion.',
  'owner_person_id', 'Former Owner the certificate goes to; null once their own account is deleted.',
  'owner_name', 'Name of the former Owner when the certificate was written.',
  'owner_email', 'Address the certificate is emailed to, kept with the certificate as delivery evidence.',
  'locale', 'Language of the certificate and its email: the Owner''s language in the org, en-US or es-US.',
  'time_zone', 'The org''s time zone when it was due (its locale.time_zone setting, UTC unset): the calendar the certificate and its email date the deletion on.',
  'held_at', 'When a legal hold was found on the org; the purge waits while it is set.',
  'blocked_reason', 'Why the purge refused, for example rows of another org that reference this one; the platform resolves it.',
  'storage_cleared_at', 'When the worker found no storage object of the org left after deleting them through the Storage API.',
  'storage_objects_deleted', 'Storage objects the worker deleted.',
  'purged_at', 'When every row of the org was deleted.',
  'tables_purged', 'Tables rows were deleted from.',
  'rows_purged', 'Rows deleted.',
  'document_object', 'Object name of the certificate PDF in the private deletion-certificates bucket.',
  'document_sha256', 'SHA-256 of the certificate PDF.',
  'issued_at', 'When the certificate PDF was stored.',
  'delivered_at', 'When the certificate was emailed to the former Owner.',
  'delivery_message_id', 'Message id the mail provider returned.',
  'attempts', 'Worker attempts so far.',
  'locked_by', 'Worker that holds the certificate while it works on it.',
  'locked_at', 'When the worker claimed it.',
  'last_error', 'Error of the latest failed attempt.'
]);

alter table app.deletion_certificates enable row level security;
revoke all on app.deletion_certificates from public, anon, authenticated;
grant select on app.deletion_certificates to authenticated;
grant all on app.deletion_certificates to service_role;
create policy deletion_certificates_read on app.deletion_certificates for select to authenticated
  using (owner_person_id = (select private.current_person_id()));

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.org_deletion_requests', 'Age', 'created_at', interval '7 years', 'Delete', 'A deletion request is a compliance record of the org''s lifecycle.'),
  ('app.deletion_certificates', 'Age', 'created_at', interval '7 years', 'Delete', 'The deletion certificate is the compliance record that the org''s data was deleted (Section 14.7).');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('deletion-certificates', 'deletion-certificates', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

-- The former Owner downloads their own certificate PDF; only the worker (service role) writes the bucket.
create policy deletion_certificates_object_read on storage.objects for select to authenticated
  using (bucket_id = 'deletion-certificates'
         and name in (select d.document_object from app.deletion_certificates d
                      where d.owner_person_id = (select private.current_person_id()) and d.document_object is not null));

-- Storage objects of an org -------------------------------------------------------------------------------------------

create or replace function private.org_storage_objects(p_org_id uuid)
returns table (bucket_id text, name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_col record;
  v_sql text := '';
begin
  -- Object names a row of the org points to, in columns that hold storage object names or paths.
  for v_col in
    select c.oid::regclass as rel, a.attname
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind in ('r', 'p') and not c.relispartition
      and a.attnum > 0 and not a.attisdropped and a.atttypid = 'text'::regtype
      and (a.attname ~ '(^|_)object_(name|path)$' or a.attname ~ '_path$')
      and a.attname <> 'field_path' and c.relname <> 'file_access_log'
      and exists (select 1 from pg_catalog.pg_attribute o where o.attrelid = c.oid and o.attname = 'org_id' and not o.attisdropped)
  loop
    v_sql := v_sql || format(' union select %I as path from %s where org_id = $1 and %I is not null', v_col.attname, v_col.rel, v_col.attname);
  end loop;
  return query execute format($q$
    select o.bucket_id, o.name from storage.objects o
    where o.bucket_id <> 'deletion-certificates'
      and (split_part(o.name, '/', 1) = $1::text
           or (o.bucket_id = 'onboarding-uploads'
               and private.onboarding_upload_item(o.name) in (select i.id from app.onboarding_items i where i.org_id = $1))
           or o.name in (select r.path from (select null::text as path %s) r where r.path is not null))
  $q$, v_sql) using p_org_id;
end;
$$;

comment on function private.org_storage_objects(uuid) is 'Every storage object of an org: names that start with the org id, onboarding uploads of its engagements, and objects its rows name in a column holding an object name or path (exports, imports, report results, inbound mail, form signatures, support screenshots). The purge deletes them through the Storage API before deleting the rows.';
revoke all on function private.org_storage_objects(uuid) from public, anon, authenticated;

-- Scheduling -------------------------------------------------------------------------------------------------------------

create or replace function private.person_language(p_person_id uuid, p_org_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select v.value_text from app.personal_setting_values v
     where v.person_id = p_person_id and v.setting_key = 'locale.language' and v.deleted_at is null
       and (v.org_id = p_org_id or v.org_id is null) and v.value_text in ('en-US', 'es-US')
     order by v.org_id nulls last limit 1),
    (select v.value_text from app.setting_values v
     where v.org_id = p_org_id and v.setting_key = 'locale.language' and v.scope_kind = 'Organization'
       and v.deleted_at is null and v.value_text in ('en-US', 'es-US') limit 1),
    'en-US');
$$;

comment on function private.person_language(uuid, uuid) is 'A person''s language in an org: their personal locale.language setting for the org or for every org, else the org''s, else en-US.';
revoke all on function private.person_language(uuid, uuid) from public, anon, authenticated;

create or replace function private.write_deletion_certificate(p_org_id uuid, p_basis text, p_requested_at timestamptz, p_due_at timestamptz, p_requester uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org app.organizations;
  v_owner uuid;
  v_id uuid;
begin
  select * into v_org from app.organizations o where o.id = p_org_id;
  select coalesce(
    (select p_requester where p_requester in (select private.org_owner_ids(p_org_id))),
    (select m.person_id from app.memberships m
     join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
     where m.org_id = p_org_id and mr.role_id = private.system_role_id('owner') and m.deleted_at is null
     order by (m.valid_to is null) desc, m.valid_from limit 1),
    p_requester) into v_owner;
  insert into app.deletion_certificates (deleted_org_id, org_name, org_slug, basis, requested_at, due_at,
    owner_person_id, owner_name, owner_email, locale, time_zone)
  select v_org.id, v_org.name, v_org.slug, p_basis, p_requested_at, p_due_at, v_owner, p.full_name, lower(u.email),
    private.person_language(v_owner, p_org_id), private.org_time_zone(p_org_id)
  from (select 1) one
  left join app.people p on p.id = v_owner
  left join auth.users u on u.id = p.user_id
  on conflict (deleted_org_id) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

comment on function private.write_deletion_certificate(uuid, text, timestamptz, timestamptz, uuid) is 'Writes the certificate of an org due for deletion, once, with the former Owner it goes to (the Owner who canceled or asked, while still an Owner, else the longest-standing Owner), their name, address and language.';
revoke all on function private.write_deletion_certificate(uuid, text, timestamptz, timestamptz, uuid) from public, anon, authenticated;

create or replace function private.schedule_deletions(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_due record;
  v_count integer := 0;
begin
  for v_due in
    select r.org_id, 'deletion_request' as basis, r.requested_at, r.recover_until as due_at, r.requested_by as requester
    from app.org_deletion_requests r
    where r.recovered_at is null and r.deleted_at is null and r.recover_until <= p_now
    union all
    select c.org_id, 'cancellation', c.canceled_at,
      private.zone_day_start(private.org_date(c.org_id, c.canceled_at) + 90, private.org_time_zone(c.org_id)), c.created_by
    from app.org_cancellations c
    where c.reactivated_at is null and c.deleted_at is null
      and private.org_date(c.org_id, p_now) >= private.org_date(c.org_id, c.canceled_at) + 90
      and not exists (select 1 from app.org_deletion_requests r
                      where r.org_id = c.org_id and r.recovered_at is null and r.deleted_at is null)
  loop
    if private.write_deletion_certificate(v_due.org_id, v_due.basis, v_due.requested_at, v_due.due_at, v_due.requester) is not null then
      v_count := v_count + 1;
    end if;
  end loop;
  -- A legal hold holds the purge; releasing it lets the purge go on.
  update app.deletion_certificates d
  set held_at = case when exists (select 1 from app.legal_holds h where h.org_id = d.deleted_org_id
                                   and h.released_at is null and h.deleted_at is null)
                     then coalesce(d.held_at, p_now) end
  where d.purged_at is null
    and (d.held_at is not null) <> exists (select 1 from app.legal_holds h where h.org_id = d.deleted_org_id
                                            and h.released_at is null and h.deleted_at is null);
  return v_count;
end;
$$;

comment on function private.schedule_deletions(timestamptz) is 'Deletion step of the lifecycle job: writes a certificate for each org due (the recovery window of a deletion request ended, or day 90 of a cancellation on the org''s calendar, from its midnight), and marks certificates held while a legal hold stands. Returns how many certificates it wrote.';
revoke all on function private.schedule_deletions(timestamptz) from public, anon, authenticated;

-- The purge ------------------------------------------------------------------------------------------------------------

create or replace function private.purge_key_expr(p_rel regclass, p_alias text)
returns text
language sql
stable
set search_path = ''
as $$
  select 'jsonb_build_object(' || string_agg(format('%L, %I.%I', a.attname, p_alias, a.attname), ', '
           order by array_position(k.conkey, a.attnum)) || ')'
  from pg_catalog.pg_constraint k
  join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
  where k.conrelid = p_rel and k.contype = 'p';
$$;

comment on function private.purge_key_expr(regclass, text) is 'SQL expression of a table''s primary key as jsonb, for the purge''s row marks. Every app and private table has a primary key.';
revoke all on function private.purge_key_expr(regclass, text) from public, anon, authenticated;

create or replace function private.purge_organization(p_certificate_id uuid)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cert app.deletion_certificates;
  v_org uuid;
  v_scope record;
  v_edge record;
  v_rel regclass;
  v_pass integer := 0;
  v_added bigint;
  v_progress integer;
  v_rows bigint;
  v_total bigint := 0;
  v_tables integer := 0;
  v_bad text;
  v_sql text;
  v_ord integer := 0;
  v_count bigint;
begin
  select * into v_cert from app.deletion_certificates d where d.id = p_certificate_id for update;
  if v_cert.id is null then
    perform private.refuse('deletion_certificate_unknown', 'No such deletion certificate.');
  end if;
  if v_cert.purged_at is not null then
    return v_cert.rows_purged;
  end if;
  v_org := v_cert.deleted_org_id;
  if v_cert.storage_cleared_at is null then
    perform private.refuse('purge_storage_first', 'The org''s storage objects are deleted through the Storage API before its rows.');
  end if;
  if exists (select 1 from private.org_storage_objects(v_org)) then
    update app.deletion_certificates set storage_cleared_at = null where id = v_cert.id;
    return null;
  end if;
  perform 1 from app.organizations o where o.id = v_org for update;
  if not found then
    perform private.refuse('purge_org_missing', 'The org row is already gone; the platform checks what remains.');
  end if;
  if exists (select 1 from app.organizations c where c.parent_org_id = v_org) then
    perform private.refuse('purge_org_has_clients', 'The org is still the partner of client orgs.');
  end if;

  drop table if exists pg_temp.purge_scope, pg_temp.purge_edges, pg_temp.purge_marks, pg_temp.purge_order, pg_temp.purge_vault;
  create temp table purge_scope on commit drop as
  select c.oid::regclass as rel, n.nspname::text as schema_name,
    exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id'
            and not a.attisdropped and a.atttypid = 'uuid'::regtype) as has_org
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('app', 'private') and c.relkind in ('r', 'p') and not c.relispartition
    and c.oid <> 'private.tenant_purge_scope'::regclass;

  -- Foreign keys the purge follows. Two are handled apart: a client org's parent_org_id (refused above) and a
  -- person's certifications, whose links to the org are cleared because they belong to the person.
  create temp table purge_edges on commit drop as
  select k.conrelid::regclass as child, k.confrelid::regclass as parent, k.confdeltype::text as on_delete,
    (select string_agg(format('c.%I = p.%I', ca.attname, pa.attname), ' and ' order by u.ord)
     from unnest(k.conkey, k.confkey) with ordinality as u (ck, pk, ord)
     join pg_catalog.pg_attribute ca on ca.attrelid = k.conrelid and ca.attnum = u.ck
     join pg_catalog.pg_attribute pa on pa.attrelid = k.confrelid and pa.attnum = u.pk) as join_condition
  from pg_catalog.pg_constraint k
  where k.contype = 'f' and k.conparentid = 0
    and k.conrelid in (select s.rel from pg_temp.purge_scope s) and k.confrelid in (select s.rel from pg_temp.purge_scope s)
    and not (k.conrelid = 'app.organizations'::regclass and k.confrelid = 'app.organizations'::regclass)
    and k.conrelid <> 'app.person_certifications'::regclass;

  create temp table purge_marks (rel regclass not null, key jsonb not null, org_id uuid, primary key (rel, key)) on commit drop;

  -- Every row of the org.
  for v_scope in select * from pg_temp.purge_scope s where s.has_org loop
    execute format('insert into pg_temp.purge_marks (rel, key, org_id) select %L::regclass, %s, c.org_id from %s c where c.org_id = $1 on conflict do nothing',
      v_scope.rel, private.purge_key_expr(v_scope.rel, 'c'), v_scope.rel) using v_org;
  end loop;
  insert into pg_temp.purge_marks (rel, key, org_id) values ('app.organizations'::regclass, jsonb_build_object('id', v_org), v_org)
  on conflict do nothing;

  -- Every row that references a marked row and would block or follow its delete, until nothing new is found.
  loop
    v_pass := v_pass + 1;
    v_added := 0;
    for v_edge in
      select e.* from pg_temp.purge_edges e
      where e.on_delete in ('a', 'r', 'c') and exists (select 1 from pg_temp.purge_marks m where m.rel = e.parent)
    loop
      execute format(
        'insert into pg_temp.purge_marks (rel, key, org_id) select %L::regclass, %s, %s from %s c where exists (select 1 from %s p join pg_temp.purge_marks m on m.rel = %L::regclass and m.key = %s where %s) on conflict do nothing',
        v_edge.child, private.purge_key_expr(v_edge.child, 'c'),
        case when (select s.has_org from pg_temp.purge_scope s where s.rel = v_edge.child) then 'c.org_id' else 'null::uuid' end,
        v_edge.child, v_edge.parent, v_edge.parent, private.purge_key_expr(v_edge.parent, 'p'), v_edge.join_condition);
      get diagnostics v_rows = row_count;
      v_added := v_added + v_rows;
    end loop;
    exit when v_added = 0 or v_pass > 50;
  end loop;

  -- Refuse anything that is not the org's own: rows of another org, or rows outside any org beyond the reviewed few.
  select string_agg(distinct m.rel::text, ', ') into v_bad
  from pg_temp.purge_marks m where m.org_id is not null and m.org_id <> v_org;
  if v_bad is not null then
    update app.deletion_certificates set blocked_reason = left('Rows of other orgs reference this org: ' || v_bad || '.', 2000),
      last_error = null where id = v_cert.id;
    return null;
  end if;
  select string_agg(distinct m.rel::text, ', ') into v_bad
  from pg_temp.purge_marks m
  where m.org_id is null and m.rel not in ('app.organizations'::regclass, 'app.blocks'::regclass,
    'private.integration_credentials'::regclass, 'private.rating_releases'::regclass);
  if v_bad is not null then
    update app.deletion_certificates set blocked_reason = left('Rows outside the org reference it: ' || v_bad || '.', 2000),
      last_error = null where id = v_cert.id;
    return null;
  end if;

  create temp table purge_vault on commit drop as
  select s.id from vault.secrets s
  where s.name in (select 'xos_integration_' || (m.key ->> 'id') from pg_temp.purge_marks m where m.rel = 'app.integration_connections'::regclass)
  union
  select c.vault_secret_id from private.integration_credentials c
  where c.integration_connection_id in (select (m.key ->> 'id')::uuid from pg_temp.purge_marks m where m.rel = 'app.integration_connections'::regclass);

  -- Children before parents (Kahn over the foreign keys between marked tables); a cycle goes last.
  create temp table purge_order (rel regclass primary key, ord integer not null, done boolean not null default false) on commit drop;
  loop
    insert into pg_temp.purge_order (rel, ord)
    select r.rel, v_ord from (select distinct m.rel from pg_temp.purge_marks m) r
    where r.rel not in (select o.rel from pg_temp.purge_order o)
      and not exists (select 1 from pg_temp.purge_edges e
                      where e.parent = r.rel and e.child <> r.rel
                        and e.child in (select m.rel from pg_temp.purge_marks m)
                        and e.child not in (select o.rel from pg_temp.purge_order o));
    get diagnostics v_rows = row_count;
    exit when v_rows = 0;
    v_ord := v_ord + 1;
  end loop;
  insert into pg_temp.purge_order (rel, ord)
  select distinct m.rel, v_ord from pg_temp.purge_marks m where m.rel not in (select o.rel from pg_temp.purge_order o);

  -- The sanctioned tenant purge (1270): guards let deletes of this org's rows through, and refuse a legal hold.
  perform private.begin_tenant_purge(array[v_org]);
  update app.person_certifications set verified_by_org_id = null where verified_by_org_id = v_org;
  update app.person_certifications set source_certification_holder_id = null
  where source_certification_holder_id in (select h.id from app.certification_holders h where h.org_id = v_org);

  v_pass := 0;
  loop
    v_pass := v_pass + 1;
    v_progress := 0;
    for v_rel in select o.rel from pg_temp.purge_order o where not o.done order by o.ord, o.rel::text loop
      begin
        execute format('delete from %s t where %s in (select m.key from pg_temp.purge_marks m where m.rel = %L::regclass)',
          v_rel, private.purge_key_expr(v_rel, 't'), v_rel);
        get diagnostics v_rows = row_count;
        v_total := v_total + v_rows;
        if v_rows > 0 then
          v_tables := v_tables + 1;
        end if;
        update pg_temp.purge_order set done = true where rel = v_rel;
        v_progress := v_progress + 1;
      exception when others then
        null;
      end;
    end loop;
    exit when not exists (select 1 from pg_temp.purge_order where not done);
    if v_progress = 0 then
      -- A foreign key cycle cannot go one table at a time: delete what is left in one statement.
      select 'with ' || string_agg(format('d%s as (delete from %s t where %s in (select m.key from pg_temp.purge_marks m where m.rel = %L::regclass) returning 1)',
               o.ord_no, o.rel, private.purge_key_expr(o.rel, 't'), o.rel), ', ')
             || ' select ' || string_agg(format('(select count(*) from d%s)', o.ord_no), ' + ')
        into v_sql
      from (select r.rel, row_number() over (order by r.ord, r.rel::text) as ord_no
            from pg_temp.purge_order r where not r.done) o;
      execute v_sql into v_rows;
      v_total := v_total + v_rows;
      v_tables := v_tables + (select count(*)::integer from pg_temp.purge_order where not done);
      update pg_temp.purge_order set done = true where not done;
    end if;
  end loop;

  delete from vault.secrets s where s.id in (select v.id from pg_temp.purge_vault v);
  delete from private.object_scans s where split_part(s.object_name, '/', 1) = v_org::text;
  perform private.end_tenant_purge();

  -- Verify: no row anywhere still carries the org.
  for v_scope in select * from pg_temp.purge_scope s where s.has_org loop
    execute format('select count(*) from %s where org_id = $1', v_scope.rel) into v_count using v_org;
    if v_count > 0 then
      perform private.refuse('purge_incomplete', format('%s still holds %s rows of the org.', v_scope.rel, v_count));
    end if;
  end loop;
  if exists (select 1 from app.organizations o where o.id = v_org) then
    perform private.refuse('purge_incomplete', 'The org row remains.');
  end if;

  update app.deletion_certificates
  set purged_at = now(), tables_purged = v_tables, rows_purged = v_total, blocked_reason = null, last_error = null
  where id = v_cert.id;
  drop table if exists pg_temp.purge_scope, pg_temp.purge_edges, pg_temp.purge_marks, pg_temp.purge_order, pg_temp.purge_vault;
  return v_total;
end;
$$;

comment on function private.purge_organization(uuid) is 'Deletes every row of the org a certificate names, in one transaction, through the tenant purge of 1270 (private.begin_tenant_purge): the org''s rows and every row that references them, children first, its integration credentials in Vault and its scan records. Needs the storage objects gone first (it clears storage_cleared_at and returns null when any remain). Records why and returns null when the purge would reach another org''s rows or rows outside any org beyond the reviewed few; refuses a legal hold (from 1270), a partner with clients, and an incomplete result. Writes the counts on the certificate and returns the rows deleted. Database owner only: the lifecycle job runs it with no statement timeout.';
revoke all on function private.purge_organization(uuid) from public, anon, authenticated;

create or replace function private.run_org_purges(p_limit integer default 5)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cert record;
  v_done integer := 0;
begin
  for v_cert in
    select d.id from app.deletion_certificates d
    where d.storage_cleared_at is not null and d.purged_at is null and d.held_at is null and d.blocked_reason is null
      and d.deleted_at is null
    order by d.due_at
    limit greatest(p_limit, 1)
  loop
    begin
      if private.purge_organization(v_cert.id) is not null then
        v_done := v_done + 1;
      end if;
    exception when others then
      update app.deletion_certificates set last_error = left(sqlerrm, 2000), attempts = attempts + 1 where id = v_cert.id;
    end;
  end loop;
  return v_done;
end;
$$;

comment on function private.run_org_purges(integer) is 'Purge step of the lifecycle job: purges up to p_limit orgs whose storage objects are gone and that are neither held nor blocked, each in its own subtransaction, recording a failure on its certificate. Returns how many orgs it purged.';
revoke all on function private.run_org_purges(integer) from public, anon, authenticated;

create or replace function private.run_org_lifecycle(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return private.run_trials(p_now) + private.schedule_deletions(p_now) + private.run_org_purges(5);
end;
$$;

comment on function private.run_org_lifecycle(timestamptz) is 'Hourly org lifecycle job (Section 14.7): trials, then certificates for orgs due for deletion, then the purge of orgs whose storage objects the worker deleted. Returns the actions taken.';

-- Worker API (service role) -------------------------------------------------------------------------------------------------

create or replace function app.claim_deletion_certificates(p_worker text, p_limit integer default 5)
returns setof app.deletion_certificates
language sql
volatile
security definer
set search_path = ''
as $$
  update app.deletion_certificates d
  set locked_by = left(p_worker, 200), locked_at = now(), attempts = d.attempts + 1
  where d.id in (
    select c.id from app.deletion_certificates c
    where c.delivered_at is null and c.held_at is null and c.blocked_reason is null and c.deleted_at is null
      and (c.locked_at is null or c.locked_at < now() - interval '15 minutes')
      and ((c.storage_cleared_at is null and c.purged_at is null
            and not exists (select 1 from app.legal_holds h where h.org_id = c.deleted_org_id
                            and h.released_at is null and h.deleted_at is null))
           or c.purged_at is not null)
    order by c.due_at
    limit least(greatest(p_limit, 1), 25)
    for update skip locked
  )
  returning d.*;
$$;

comment on function app.claim_deletion_certificates(text, integer) is 'Worker API (service role): claims certificates with work for the org-lifecycle worker, skipping locked ones: storage objects to delete before the purge, or a purged org''s certificate to render and email. A claim lapses after 15 minutes.';

create or replace function app.deletion_storage_objects(p_certificate_id uuid)
returns table (bucket_id text, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.bucket_id, o.name
  from app.deletion_certificates d
  cross join lateral private.org_storage_objects(d.deleted_org_id) o
  where d.id = p_certificate_id and d.purged_at is null
  order by 1, 2
  limit 1000;
$$;

comment on function app.deletion_storage_objects(uuid) is 'Worker API (service role): up to 1,000 storage objects of the org a certificate names, to delete through the Storage API before the purge.';

create or replace function app.record_deletion_storage_cleared(p_certificate_id uuid, p_deleted integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cert app.deletion_certificates;
  v_left boolean;
begin
  select * into v_cert from app.deletion_certificates d where d.id = p_certificate_id for update;
  if v_cert.id is null then
    perform private.refuse('deletion_certificate_unknown', 'No such deletion certificate.');
  end if;
  v_left := exists (select 1 from private.org_storage_objects(v_cert.deleted_org_id));
  update app.deletion_certificates
  set storage_objects_deleted = storage_objects_deleted + greatest(coalesce(p_deleted, 0), 0),
    storage_cleared_at = case when v_left then null else now() end,
    locked_by = null, locked_at = null, last_error = null
  where id = v_cert.id;
  return not v_left;
end;
$$;

comment on function app.record_deletion_storage_cleared(uuid, integer) is 'Worker API (service role): adds the objects the worker deleted and, when none of the org''s storage objects remain, records the storage as cleared so the lifecycle job purges the rows. Returns whether the storage is clear.';

create or replace function app.record_deletion_certificate_issued(p_certificate_id uuid, p_document_object text, p_document_sha256 text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update app.deletion_certificates
  set document_object = p_document_object, document_sha256 = lower(p_document_sha256),
    issued_at = coalesce(issued_at, now()), last_error = null
  where id = p_certificate_id and purged_at is not null;
  if not found then
    perform private.refuse('deletion_not_purged', 'A certificate is issued once the org''s data is deleted.');
  end if;
end;
$$;

comment on function app.record_deletion_certificate_issued(uuid, text, text) is 'Worker API (service role): records the stored certificate PDF of a purged org and its SHA-256.';

create or replace function app.record_deletion_certificate_delivered(p_certificate_id uuid, p_message_id text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update app.deletion_certificates
  set delivered_at = coalesce(delivered_at, now()), delivery_message_id = left(p_message_id, 200),
    locked_by = null, locked_at = null, last_error = null
  where id = p_certificate_id and issued_at is not null;
  if not found then
    perform private.refuse('deletion_not_issued', 'A certificate is emailed once its PDF is stored.');
  end if;
end;
$$;

comment on function app.record_deletion_certificate_delivered(uuid, text) is 'Worker API (service role): records that the certificate was emailed to the former Owner.';

create or replace function app.release_deletion_certificate(p_certificate_id uuid, p_error text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update app.deletion_certificates
  set locked_by = null, locked_at = null, last_error = left(p_error, 2000)
  where id = p_certificate_id;
$$;

comment on function app.release_deletion_certificate(uuid, text) is 'Worker API (service role): releases a claimed certificate after a failed attempt, keeping the error; the next run tries again.';

revoke all on function app.claim_deletion_certificates(text, integer) from public, anon, authenticated;
revoke all on function app.deletion_storage_objects(uuid) from public, anon, authenticated;
revoke all on function app.record_deletion_storage_cleared(uuid, integer) from public, anon, authenticated;
revoke all on function app.record_deletion_certificate_issued(uuid, text, text) from public, anon, authenticated;
revoke all on function app.record_deletion_certificate_delivered(uuid, text) from public, anon, authenticated;
revoke all on function app.release_deletion_certificate(uuid, text) from public, anon, authenticated;
grant execute on function app.claim_deletion_certificates(text, integer) to service_role;
grant execute on function app.deletion_storage_objects(uuid) to service_role;
grant execute on function app.record_deletion_storage_cleared(uuid, integer) to service_role;
grant execute on function app.record_deletion_certificate_issued(uuid, text, text) to service_role;
grant execute on function app.record_deletion_certificate_delivered(uuid, text) to service_role;
grant execute on function app.release_deletion_certificate(uuid, text) to service_role;
