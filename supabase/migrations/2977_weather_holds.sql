-- 2977_weather_holds.sql
-- B8 Weather hold and all-clear (RRR-232, gap G-150, ADR 0147 decision 9). A dispatcher calls a weather hold with a
-- message and gives the all-clear when it is over. Holds have their own table, because app.crisis_alerts (0353)
-- requires a canon emergency code and the canon has no weather code.
--
--   * app.weather_message_templates: a project's Hold and All Clear texts, prefilled in the dialogs; without one the
--     page offers the catalog's default in the caller's language.
--   * app.weather_holds: at most one open hold per project, written only by the RPCs, under the audit trail.
--   * app.call_weather_hold and app.give_weather_all_clear (safety.incident.dispatch) tell the project's alert-role
--     people, its dispatchers and everyone app.zone_presence places in its zones now, each once. The presence view is
--     read inside the definer function, so the list is complete whoever calls.
--   * Compass queues both offline (private.sync_rpcs). A replay arrives late, so each takes a client id (a replay by the
--     same person returns the stored hold; anyone else's id refuses weather_hold_id_taken) and the device time: a hold
--     or all-clear made more than 10 minutes before it reaches the server is refused (weather_hold_stale), so a hold
--     called offline never goes out late. Atlas sends no device time.

create type app.weather_message_kind as enum ('Hold', 'All Clear');
comment on type app.weather_message_kind is 'Which weather message a template holds: the hold or the all-clear.';

create table app.weather_message_templates (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  message_kind app.weather_message_kind not null,
  body text not null,
  constraint weather_message_templates_body_length check (char_length(btrim(body)) between 1 and 1000)
);
call private.install_domain_table('app.weather_message_templates', 'app.projects', 'project_id');
create unique index weather_message_templates_key on app.weather_message_templates (project_id, message_kind) where deleted_at is null;
call private.describe('app.weather_message_templates', 'A project''s weather hold and all-clear texts (gap G-150), prefilled in the dialogs and editable before sending.', array[
  'project_id', 'Project.',
  'message_kind', 'Hold or All Clear.',
  'body', 'Text, 1 to 1,000 characters.'
]);
call private.install_policies('app.weather_message_templates',
  $$project_id in (select private.project_ids_with('safety.incident.read'))$$,
  $$org_id in (select private.orgs_with_capability('safety.emergency_code.write')) and project_id in (select private.readable_project_ids())$$);
call private.install_audit_trail('app.weather_message_templates');
call private.install_default_retention('app.weather_message_templates');

create table app.weather_holds (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  hazard app.weather_hazard,
  weather_alert_id uuid references app.weather_alerts (id),
  weather_warning_id uuid references app.weather_warnings (id),
  message text not null,
  called_at timestamptz not null default now(),
  cleared_at timestamptz,
  cleared_by uuid references app.people (id),
  all_clear_message text,
  all_clear_request_id uuid,
  constraint weather_holds_message_length check (char_length(btrim(message)) between 1 and 1000),
  constraint weather_holds_clear check ((cleared_at is null) = (cleared_by is null)
    and (cleared_at is null) = (all_clear_message is null) and (cleared_at is null or cleared_at >= called_at)),
  constraint weather_holds_all_clear_length check (all_clear_message is null or char_length(btrim(all_clear_message)) between 1 and 1000),
  constraint weather_holds_request check (all_clear_request_id is null or cleared_at is not null)
);
create index weather_holds_project_idx on app.weather_holds (project_id, called_at desc);
create index weather_holds_alert_idx on app.weather_holds (weather_alert_id);
create index weather_holds_warning_idx on app.weather_holds (weather_warning_id);
create index weather_holds_cleared_by_idx on app.weather_holds (cleared_by);
create unique index weather_holds_all_clear_request_key on app.weather_holds (all_clear_request_id) where all_clear_request_id is not null;
call private.install_domain_table('app.weather_holds', 'app.projects', 'project_id',
  array['app.weather_alerts', 'weather_alert_id', 'app.weather_warnings', 'weather_warning_id']);
create unique index weather_holds_open_key on app.weather_holds (project_id) where cleared_at is null and deleted_at is null;
call private.describe('app.weather_holds', 'Weather holds of a project (gap G-150, ADR 0147 decision 9): the message a dispatcher sent to stop work for the weather, and the all-clear that ended it. At most one open hold per project. Written only by app.call_weather_hold and app.give_weather_all_clear.', array[
  'project_id', 'Project.',
  'hazard', 'Hazard the hold is for, when one is named.',
  'weather_alert_id', 'Alert that prompted it, when one did.',
  'weather_warning_id', 'Official warning that prompted it, when one did.',
  'message', 'Hold message sent, 1 to 1,000 characters.',
  'called_at', 'When the hold was called.',
  'cleared_at', 'When the all-clear was given.',
  'cleared_by', 'Who gave the all-clear.',
  'all_clear_message', 'All-clear message sent.',
  'all_clear_request_id', 'Client id of the all-clear, so a replayed queued call is recognized.'
]);
call private.install_policies('app.weather_holds', $$project_id in (select private.project_ids_with('safety.incident.read'))$$);
call private.install_audit_trail('app.weather_holds');
call private.install_default_retention('app.weather_holds');
create trigger t39_weather_holds_same_project before insert or update on app.weather_holds
  for each row execute function private.assert_same_project('app.weather_alerts', 'weather_alert_id', 'app.weather_warnings', 'weather_warning_id');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('weather_holds', 'A safety record written only by the hold and all-clear RPCs; nobody deletes or restores a hold.')
on conflict (table_name) do nothing;

do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_catalog.pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'app'
                     and tablename = 'weather_holds') then
    alter publication supabase_realtime add table app.weather_holds;
  end if;
end;
$$;

-- Who hears a hold ---------------------------------------------------------------------------------------------------------

create function private.weather_hold_recipients(p_project_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select ra.person_id from app.role_assignments ra
  join app.weather_alert_roles r on r.project_id = ra.project_id and r.role_code = ra.role_code and r.deleted_at is null
  where ra.project_id = p_project_id and ra.person_id is not null and ra.deleted_at is null
  union
  select private.project_member_people_with(p_project_id, 'safety.incident.dispatch')
  union
  select z.person_id from app.zone_presence z where z.project_id = p_project_id and z.person_id is not null;
$$;
comment on function private.weather_hold_recipients(uuid) is 'Everyone a weather hold or all-clear reaches, each once: the people of every alert role of the project, its dispatchers, and the people app.zone_presence places in its zones now (read as the definer, so the list is complete).';
revoke all on function private.weather_hold_recipients(uuid) from public, anon, authenticated;

-- Calling and clearing ------------------------------------------------------------------------------------------------------

create function app.call_weather_hold(
  p_project_id uuid,
  p_message text,
  p_hazard app.weather_hazard default null,
  p_weather_alert_id uuid default null,
  p_weather_warning_id uuid default null,
  p_id uuid default null,
  p_device_at timestamptz default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_org uuid := (select p.org_id from app.projects p where p.id = p_project_id and p.deleted_at is null);
  v_message text := btrim(coalesce(p_message, ''));
  v_existing app.weather_holds;
  v_id uuid;
  v_recipient uuid;
begin
  if v_org is null or not private.can_on_project(p_project_id, 'safety.incident.dispatch') then
    raise exception using errcode = '42501', message = 'calling a weather hold needs safety.incident.dispatch on the project';
  end if;
  if p_id is not null then
    select * into v_existing from app.weather_holds h where h.id = p_id;
    if v_existing.id is not null then
      if v_existing.created_by is distinct from v_person or v_existing.project_id <> p_project_id then
        perform private.refuse('weather_hold_id_taken', 'Another hold already uses this id.');
      end if;
      return v_existing.id;
    end if;
  end if;
  if p_device_at is not null and p_device_at < now() - interval '10 minutes' then
    perform private.refuse('weather_hold_stale', 'This hold was made more than 10 minutes ago and was not sent. Check the weather and call it again.');
  end if;
  if char_length(v_message) not between 1 and 1000 then
    perform private.refuse('weather_hold_message', 'Write a message of 1 to 1,000 characters.');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('weather_hold:' || p_project_id, 0));
  if exists (select 1 from app.weather_holds h where h.project_id = p_project_id and h.cleared_at is null and h.deleted_at is null) then
    perform private.refuse('weather_hold_open', 'A weather hold is already open on this project. Give the all-clear first.');
  end if;
  insert into app.weather_holds (id, project_id, hazard, weather_alert_id, weather_warning_id, message)
  values (coalesce(p_id, private.uuid_v7()), p_project_id, p_hazard, p_weather_alert_id, p_weather_warning_id, v_message)
  returning id into v_id;
  for v_recipient in select distinct r from private.weather_hold_recipients(p_project_id) r loop
    perform private.notify(v_org, v_recipient, 'weather.hold', 'app.weather_holds', v_id, p_project_id,
      jsonb_build_object('message', v_message, 'hazard', p_hazard));
  end loop;
  return v_id;
end;
$$;
comment on function app.call_weather_hold(uuid, text, app.weather_hazard, uuid, uuid, uuid, timestamptz) is 'Calls a weather hold on a project (safety.incident.dispatch): one open hold at a time (weather_hold_open), a message of 1 to 1,000 characters (weather_hold_message), optionally naming the hazard, alert or warning. Tells the alert-role people, the dispatchers and everyone present in the project''s zones now, each once (weather.hold). A client id makes it idempotent for the same person (weather_hold_id_taken for anyone else); a device time more than 10 minutes old refuses weather_hold_stale. Returns the hold id.';
revoke all on function app.call_weather_hold(uuid, text, app.weather_hazard, uuid, uuid, uuid, timestamptz) from public, anon;
grant execute on function app.call_weather_hold(uuid, text, app.weather_hazard, uuid, uuid, uuid, timestamptz) to authenticated, service_role;

create function app.give_weather_all_clear(
  p_hold_id uuid,
  p_message text,
  p_id uuid default null,
  p_device_at timestamptz default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_hold app.weather_holds;
  v_message text := btrim(coalesce(p_message, ''));
  v_recipient uuid;
begin
  select * into v_hold from app.weather_holds h where h.id = p_hold_id and h.deleted_at is null for update;
  if v_hold.id is null or not private.can_on_project(v_hold.project_id, 'safety.incident.dispatch') then
    raise exception using errcode = '42501', message = 'giving the all-clear needs safety.incident.dispatch on the project';
  end if;
  if p_id is not null and exists (select 1 from app.weather_holds h where h.all_clear_request_id = p_id) then
    if v_hold.all_clear_request_id is distinct from p_id or v_hold.cleared_by is distinct from v_person then
      perform private.refuse('weather_hold_id_taken', 'Another all-clear already uses this id.');
    end if;
    return v_hold.id;
  end if;
  if v_hold.cleared_at is not null then
    perform private.refuse('weather_hold_closed', 'This weather hold already has its all-clear.');
  end if;
  if p_device_at is not null and p_device_at < now() - interval '10 minutes' then
    perform private.refuse('weather_hold_stale', 'This all-clear was made more than 10 minutes ago and was not sent. Check the weather and give it again.');
  end if;
  if char_length(v_message) not between 1 and 1000 then
    perform private.refuse('weather_hold_message', 'Write a message of 1 to 1,000 characters.');
  end if;
  update app.weather_holds set cleared_at = now(), cleared_by = v_person, all_clear_message = v_message, all_clear_request_id = p_id
  where id = v_hold.id;
  for v_recipient in select distinct r from private.weather_hold_recipients(v_hold.project_id) r loop
    perform private.notify(v_hold.org_id, v_recipient, 'weather.all_clear', 'app.weather_holds', v_hold.id, v_hold.project_id,
      jsonb_build_object('message', v_message, 'hazard', v_hold.hazard));
  end loop;
  return v_hold.id;
end;
$$;
comment on function app.give_weather_all_clear(uuid, text, uuid, timestamptz) is 'Ends a weather hold (safety.incident.dispatch on its project) with an all-clear message of 1 to 1,000 characters (weather_hold_message), once (weather_hold_closed). Tells the same people a hold reaches, computed now (weather.all_clear). A client id makes it idempotent for the same person (weather_hold_id_taken for anyone else); a device time more than 10 minutes old refuses weather_hold_stale. Returns the hold id.';
revoke all on function app.give_weather_all_clear(uuid, text, uuid, timestamptz) from public, anon;
grant execute on function app.give_weather_all_clear(uuid, text, uuid, timestamptz) to authenticated, service_role;

insert into private.sync_rpcs (rpc, description) values
  ('app.call_weather_hold', 'A dispatcher calls a weather hold; replays are idempotent on the client id, and one made more than 10 minutes earlier is refused.'),
  ('app.give_weather_all_clear', 'A dispatcher gives the weather all-clear; replays are idempotent on the client id, and one made more than 10 minutes earlier is refused.');

select private.sync_trash_tables();
