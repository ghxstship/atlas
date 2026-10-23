-- 1474_system_banners.sql
-- A90 operator console (RRR-135, finding A65-009; Section 4.10 "In-app system banners for maintenance windows,
-- incidents (linked to the status page) and plan notices", "system banners" in the console).
--   * app.system_banners: a platform-wide message with a kind, a severity, an audience (every shell, or only Atlas,
--     Gateway or Compass), a schedule in instants (starts_at, ends_at; an incident may run until an operator ends
--     it), a status page link (required for incidents), and whether a person may dismiss it (never a Critical one).
--     Copy is the operator's own, in en-US with an optional es-US version.
--   * api_public.active_system_banners(surface): the live banners of one shell, at most three, most severe first.
--     Callable before sign-in, so sign-in pages show maintenance too. The shells cache the answer and render it
--     after the page, so a banner never blocks or slows a page.
--   * console RPCs (banners.write): save a scheduled or live banner, end it early; ended banners never change.

create type app.system_banner_kind as enum ('Maintenance', 'Incident', 'Plan Notice', 'Notice');
comment on type app.system_banner_kind is 'What a system banner announces (Section 4.10): a maintenance window, an incident (linked to the status page), a plan notice or another notice.';

create type app.system_banner_severity as enum ('Info', 'Warning', 'Critical');
comment on type app.system_banner_severity is 'How a system banner renders: Info, Warning or Critical. A Critical banner cannot be dismissed.';

create type app.system_banner_audience as enum ('Everyone', 'Atlas', 'Gateway', 'Compass');
comment on type app.system_banner_audience is 'Which shells show a system banner: every shell, or only Atlas, Gateway or Compass.';

create table app.system_banners (
  id uuid primary key default private.uuid_v7(),
  banner_kind app.system_banner_kind not null,
  severity app.system_banner_severity not null default 'Info',
  audience app.system_banner_audience not null default 'Everyone',
  message text not null,
  message_es text,
  link_url text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  dismissible boolean not null default true,
  ended_at timestamptz,
  ended_by uuid references app.people (id),
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint system_banners_message_length check (char_length(btrim(message)) between 1 and 300),
  constraint system_banners_message_es_length check (message_es is null or char_length(btrim(message_es)) between 1 and 300),
  constraint system_banners_link_format check (link_url is null or (link_url ~ '^https://[^[:space:]<>"]+$' and char_length(link_url) <= 500)),
  constraint system_banners_window check (ends_at is null or (ends_at > starts_at and ends_at <= starts_at + interval '90 days')),
  constraint system_banners_incident_link check (banner_kind <> 'Incident' or link_url is not null),
  constraint system_banners_maintenance_window check (banner_kind <> 'Maintenance' or ends_at is not null),
  constraint system_banners_critical_stays check (not (severity = 'Critical' and dismissible)),
  constraint system_banners_ended check (ended_by is null or ended_at is not null)
);

create index system_banners_live_idx on app.system_banners (starts_at, ends_at)
  where ended_at is null and deleted_at is null;
create index system_banners_ended_by_idx on app.system_banners (ended_by);

call private.install_audit_columns('app.system_banners');
call private.describe('app.system_banners', 'Platform-wide in-app banners (A90, Section 4.10): maintenance windows, incidents linked to the status page, plan notices and other notices, scheduled in instants for every shell or one. Written only by the console RPCs (banners.write); read by the shells through api_public.active_system_banners. An ended banner never changes.', array[
  'id', 'Banner id, UUID v7.',
  'banner_kind', 'Maintenance, Incident, Plan Notice or Notice.',
  'severity', 'Info, Warning or Critical.',
  'audience', 'Everyone, Atlas, Gateway or Compass.',
  'message', 'The banner text in en-US, plain and direct, up to 300 characters.',
  'message_es', 'The banner text in es-US; the en-US text shows when it is missing.',
  'link_url', 'An https link, such as the status page; required for an incident.',
  'starts_at', 'When the banner starts showing.',
  'ends_at', 'When it stops showing, at most 90 days after it starts; null runs until an operator ends it (incidents and notices).',
  'dismissible', 'Whether a person may hide it on their device; never for a Critical banner.',
  'ended_at', 'When an operator ended it early.',
  'ended_by', 'Operator who ended it early.'
]);

alter table app.system_banners enable row level security;
revoke all on app.system_banners from public, anon, authenticated;
grant select on app.system_banners to authenticated;
grant all on app.system_banners to service_role;
create policy system_banners_read on app.system_banners for select to authenticated
  using ((select private.is_platform_staff()));

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.system_banners', 'Age', 'starts_at', interval '2 years', 'Delete', 'Past banners show what the platform announced and when.');

create or replace function private.guard_system_banner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.ended_at is not null then
    perform private.refuse('system_banner_ended', 'An ended banner never changes. Publish a new one.');
  end if;
  return new;
end;
$$;

comment on function private.guard_system_banner() is 'Ended system banners never change.';
revoke all on function private.guard_system_banner() from public, anon, authenticated;

create trigger t40_guard_system_banner before update on app.system_banners
  for each row execute function private.guard_system_banner();

-- The shells' read ---------------------------------------------------------------------------------------------------

create or replace function api_public.active_system_banners(p_surface text)
returns table (
  id uuid,
  banner_kind text,
  severity text,
  message text,
  message_es text,
  link_url text,
  starts_at timestamptz,
  ends_at timestamptz,
  dismissible boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.banner_kind::text, b.severity::text, b.message, b.message_es, b.link_url, b.starts_at, b.ends_at,
    b.dismissible
  from app.system_banners b
  where b.deleted_at is null and b.ended_at is null and b.starts_at <= now() and (b.ends_at is null or b.ends_at > now())
    and (b.audience = 'Everyone' or lower(b.audience::text) = lower(btrim(coalesce(p_surface, ''))))
  order by b.severity desc, b.starts_at desc, b.id desc
  limit 3;
$$;

comment on function api_public.active_system_banners(text) is 'The live system banners of one shell (atlas, gateway or compass), at most three, most severe first (A90, Section 4.10). Callable before sign-in; returns only what every visitor may see.';
revoke all on function api_public.active_system_banners(text) from public;
grant execute on function api_public.active_system_banners(text) to anon, authenticated, service_role;

-- Console RPCs ---------------------------------------------------------------------------------------------------------

create or replace function app.console_banners()
returns table (
  id uuid,
  banner_kind app.system_banner_kind,
  severity app.system_banner_severity,
  audience app.system_banner_audience,
  message text,
  message_es text,
  link_url text,
  starts_at timestamptz,
  ends_at timestamptz,
  dismissible boolean,
  ended_at timestamptz,
  live boolean,
  created_by_name text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_operator('tenants.read');
  return query
  select b.id, b.banner_kind, b.severity, b.audience, b.message, b.message_es, b.link_url, b.starts_at, b.ends_at,
    b.dismissible, b.ended_at,
    b.ended_at is null and b.starts_at <= now() and (b.ends_at is null or b.ends_at > now()),
    p.full_name, b.created_at
  from app.system_banners b
  left join app.people p on p.id = b.created_by
  where b.deleted_at is null
  order by (b.ended_at is null and (b.ends_at is null or b.ends_at > now())) desc, b.starts_at desc
  limit 100;
end;
$$;

comment on function app.console_banners() is 'System banners for the console (tenants.read): live and scheduled first, then the most recent past ones.';
revoke all on function app.console_banners() from public, anon;
grant execute on function app.console_banners() to authenticated;

create or replace function app.console_save_banner(
  p_banner_id uuid,
  p_kind app.system_banner_kind,
  p_severity app.system_banner_severity,
  p_audience app.system_banner_audience,
  p_message text,
  p_message_es text,
  p_link_url text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_dismissible boolean
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('banners.write');
  v_id uuid := p_banner_id;
  v_starts timestamptz := coalesce(p_starts_at, now());
begin
  if p_kind is null or p_severity is null or p_audience is null then
    perform private.refuse('system_banner_shape', 'Choose the kind, the severity and who sees the banner.');
  end if;
  if p_message is null or char_length(btrim(p_message)) not between 1 and 300
     or (p_message_es is not null and btrim(p_message_es) <> '' and char_length(btrim(p_message_es)) > 300) then
    perform private.refuse('system_banner_message', 'Write the banner in up to 300 characters.');
  end if;
  if p_link_url is not null and btrim(p_link_url) <> ''
     and (btrim(p_link_url) !~ '^https://[^[:space:]<>"]+$' or char_length(btrim(p_link_url)) > 500) then
    perform private.refuse('system_banner_link', 'Links start with https://.');
  end if;
  if p_kind = 'Incident' and coalesce(btrim(p_link_url), '') = '' then
    perform private.refuse('system_banner_incident_link', 'An incident banner links to the status page.');
  end if;
  if p_kind = 'Maintenance' and p_ends_at is null then
    perform private.refuse('system_banner_maintenance_window', 'A maintenance banner needs the end of the window.');
  end if;
  if p_ends_at is not null and (p_ends_at <= v_starts or p_ends_at > v_starts + interval '90 days' or p_ends_at <= now()) then
    perform private.refuse('system_banner_window', 'The banner must end after it starts, in the future and within 90 days.');
  end if;
  if p_severity = 'Critical' and coalesce(p_dismissible, false) then
    perform private.refuse('system_banner_critical_dismissible', 'A Critical banner stays until it ends; it cannot be dismissed.');
  end if;
  if v_id is null then
    insert into app.system_banners (banner_kind, severity, audience, message, message_es, link_url, starts_at, ends_at, dismissible)
    values (p_kind, p_severity, p_audience, btrim(p_message), nullif(btrim(p_message_es), ''), nullif(btrim(p_link_url), ''),
      v_starts, p_ends_at, coalesce(p_dismissible, p_severity <> 'Critical'))
    returning id into v_id;
  else
    update app.system_banners
    set banner_kind = p_kind, severity = p_severity, audience = p_audience, message = btrim(p_message),
      message_es = nullif(btrim(p_message_es), ''), link_url = nullif(btrim(p_link_url), ''), starts_at = v_starts,
      ends_at = p_ends_at, dismissible = coalesce(p_dismissible, p_severity <> 'Critical')
    where id = v_id and deleted_at is null;
    if not found then
      raise exception using errcode = '42501', message = 'system banner not found';
    end if;
  end if;
  perform private.log_operator_action('system_banner.saved', null, 'app.system_banners', v_id, null,
    jsonb_build_object('kind', p_kind, 'severity', p_severity, 'audience', p_audience, 'message', btrim(p_message),
      'starts_at', v_starts, 'ends_at', p_ends_at, 'dismissible', coalesce(p_dismissible, p_severity <> 'Critical')));
  return v_id;
end;
$$;

comment on function app.console_save_banner(uuid, app.system_banner_kind, app.system_banner_severity, app.system_banner_audience, text, text, text, timestamptz, timestamptz, boolean) is 'An operator (banners.write) publishes a system banner, or changes one that has not ended: kind, severity, audience, en-US text and optional es-US text, an https link (required for an incident), the window in instants (start now by default; an end within 90 days, required for maintenance) and whether it may be dismissed (never Critical). Returns the banner id.';
revoke all on function app.console_save_banner(uuid, app.system_banner_kind, app.system_banner_severity, app.system_banner_audience, text, text, text, timestamptz, timestamptz, boolean) from public, anon;
grant execute on function app.console_save_banner(uuid, app.system_banner_kind, app.system_banner_severity, app.system_banner_audience, text, text, text, timestamptz, timestamptz, boolean) to authenticated;

create or replace function app.console_end_banner(p_banner_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('banners.write');
  v_row app.system_banners;
begin
  select * into v_row from app.system_banners b where b.id = p_banner_id and b.deleted_at is null for update;
  if v_row.id is null then
    raise exception using errcode = '42501', message = 'system banner not found';
  end if;
  if v_row.ended_at is not null or (v_row.ends_at is not null and v_row.ends_at <= now()) then
    perform private.refuse('system_banner_ended', 'This banner has already ended.');
  end if;
  update app.system_banners set ended_at = now(), ended_by = v_operator where id = v_row.id;
  perform private.log_operator_action('system_banner.ended', null, 'app.system_banners', v_row.id, null,
    jsonb_build_object('message', v_row.message));
  return v_row.id;
end;
$$;

comment on function app.console_end_banner(uuid) is 'An operator (banners.write) ends a scheduled or live system banner now. Returns the banner id.';
revoke all on function app.console_end_banner(uuid) from public, anon;
grant execute on function app.console_end_banner(uuid) to authenticated;
