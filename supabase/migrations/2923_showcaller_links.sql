-- 2923_showcaller_links.sql
-- B3 Showcaller portal (RRR-227, ADR 0142; parity gap G-80). A showcaller link lets someone with no account call one
-- running order (one stage's show day: its scope node is the stage, its show_date the day) and edit it live, with an
-- access code, as an Atlas showcaller would. This migration holds the links; 2924 the anonymous reads and writes and 2925
-- the Realtime channel.
--
--   * app.showcaller_links is its own table, not a third live_link_kind (2780): write-by-token stays apart from P1's
--     read-only links and from the /live-links API enum. It reuses P1's secrets and limits: tokens and codes are hashed
--     with private.share_token_hash and share_code_hash (1380), the code is drawn by private.new_live_link_code, and
--     the default expiry is P1's display default (the end of the day after the show in the project's zone), capped
--     at 14 days. A token is xscl_ and 256 random bits, a device grant xcgr_, a channel key xcch_.
--   * A link names its creator's caller (caller_name, shown to members), never a person of the org; its note is never
--     shown on the portal. At most 5 live links per running order. Making one needs membership of the org and both
--     show.run_of_show.write and show.cue.call on the project, in an org that is not read-only. Regenerating and
--     revoking follow P1: the creator, or a holder of show.run_of_show.write on the project who is a member of the org.
--     Revoking stays possible in a read-only org (Section 14.7). Signing devices out drops every grant.
--   * Device grants (private.showcaller_link_grants) last until the link expires or 48 hours, at most 5 at once.
--   * A cue called through a link records the link (app.cues.called_via_link_id), not a person: cues_called_pair now
--     says a called cue has exactly one of called_by and called_via_link_id. private.guard_cue is restated from its
--     latest definition (2792): inside the trusted operation showcaller_link a call is stamped with the link and no
--     person, and the capability checks are the RPC's (2924). Outside it, an insert carries no link, and an update
--     never changes the link a call was stamped with. The cue.called triggers (0412) carry called_via_link_id.
--   * The links keep the default 7-year retention, not P1's 2 years: called_via_link_id references them, so a link must
--     never be purged before the cues that name it.
--   * Links stay out of Trash (ADR 0110): a revoked link is never restored.

-- Secrets ------------------------------------------------------------------------------------------------------------------

create or replace function private.new_showcaller_link_token()
returns text
language sql
volatile
set search_path = ''
as $$
  select 'xscl_' || encode(extensions.gen_random_bytes(32), 'hex');
$$;

comment on function private.new_showcaller_link_token() is 'A new showcaller link token: xscl_ and 256 random bits in hex. Only its SHA-256 hash is stored.';
revoke all on function private.new_showcaller_link_token() from public, anon, authenticated;

create or replace function private.new_showcaller_channel_key()
returns text
language sql
volatile
set search_path = ''
as $$
  select 'xcch_' || encode(extensions.gen_random_bytes(32), 'hex');
$$;

comment on function private.new_showcaller_channel_key() is 'A new showcaller link channel key: xcch_ and 256 random bits in hex. The portal''s Realtime topic is xcall: and this key (2925).';
revoke all on function private.new_showcaller_channel_key() from public, anon, authenticated;

-- Links ----------------------------------------------------------------------------------------------------------------------

create table app.showcaller_links (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  run_of_show_id uuid not null references app.run_of_show (id),
  caller_name text not null,
  note text,
  token_hash bytea not null,
  token_hint text not null,
  access_code_hash bytea not null,
  expires_at timestamptz not null,
  failed_attempts smallint not null default 0,
  open_count integer not null default 0,
  last_opened_at timestamptz,
  rotated_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references app.people (id),
  constraint showcaller_links_caller_name_length check (char_length(btrim(caller_name)) between 1 and 120),
  constraint showcaller_links_note_length check (note is null or char_length(btrim(note)) between 1 and 200),
  constraint showcaller_links_token_hash_length check (octet_length(token_hash) = 32),
  constraint showcaller_links_code_hash_length check (octet_length(access_code_hash) = 32),
  constraint showcaller_links_token_hint check (token_hint ~ '^[0-9a-f]{4}$'),
  constraint showcaller_links_failed_attempts check (failed_attempts between 0 and 5),
  constraint showcaller_links_open_count check (open_count >= 0),
  constraint showcaller_links_revoked check ((revoked_at is null) = (revoked_by is null))
);

create unique index showcaller_links_token_key on app.showcaller_links (token_hash);
create index showcaller_links_run_of_show_idx on app.showcaller_links (run_of_show_id);
create index showcaller_links_project_idx on app.showcaller_links (project_id);
create index showcaller_links_revoked_by_idx on app.showcaller_links (revoked_by);

-- Revoking withdraws access, so it stays possible while a canceled org is read-only; the RPCs refuse new links and
-- regeneration themselves (as 2780).
insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.showcaller_links', 'Revoking a showcaller link withdraws access; new links and regeneration are refused by the showcaller link RPCs.')
on conflict (table_name) do nothing;

create or replace function private.stamp_showcaller_link_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.project_id := (select r.project_id from app.run_of_show r where r.id = new.run_of_show_id);
  return new;
end;
$$;

comment on function private.stamp_showcaller_link_project() is 'Before insert or update on showcaller links: a link''s project is its running order''s project, as a cue''s is (0412).';
revoke all on function private.stamp_showcaller_link_project() from public, anon, authenticated;

create trigger t05_stamp_showcaller_link_project before insert or update on app.showcaller_links
  for each row execute function private.stamp_showcaller_link_project();

call private.install_domain_table('app.showcaller_links', 'app.projects', 'project_id',
  array['app.run_of_show', 'run_of_show_id']);
call private.describe('app.showcaller_links', 'Showcaller links (ADR 0142): a no-account link and access code that let an outside showcaller call one running order and edit it live, within that running order only. Expires within 14 days; the token and the code are returned once and stored only as hashes. Made by app.create_showcaller_link, opened by api_public.open_showcaller_link, read by api_public.showcaller_run, written through the api_public.showcaller_* RPCs, and changed only by app.regenerate_showcaller_link, app.revoke_showcaller_link and app.sign_out_showcaller_devices. app.showcaller_link_states gives each link''s state.', array[
  'project_id', 'Project of the running order, stamped by the database.',
  'run_of_show_id', 'Running order the link calls: one stage''s show day. A link never reaches another.',
  'caller_name', 'Name of the showcaller the link is for, shown to members beside each cue called through it.',
  'note', 'What the link is for, as its creator described it. Never shown on the portal.',
  'token_hash', 'SHA-256 of the link token, set by the database. The token is shown once and never stored. Never readable by signed-in callers.',
  'token_hint', 'Last four characters of the token, to tell links apart.',
  'access_code_hash', 'SHA-256 of the token, a colon and the 6-digit access code, set by the database. Never readable by signed-in callers.',
  'expires_at', 'When the link stops opening and writing: after it was made and at most 14 days ahead.',
  'failed_attempts', 'Wrong access codes entered since the link was made or regenerated; the link locks at 5.',
  'open_count', 'Successful opens (a correct code), counted on the link.',
  'last_opened_at', 'When the link was last opened successfully.',
  'rotated_at', 'When the link was last regenerated; the previous token, code and device grants stopped working then.',
  'revoked_at', 'When the link was revoked; a revoked link never opens again.',
  'revoked_by', 'Person who revoked the link.'
]);
call private.install_audit_trail('app.showcaller_links');
call private.install_default_retention('app.showcaller_links');

create index showcaller_links_run_live_idx on app.showcaller_links (run_of_show_id) where revoked_at is null and deleted_at is null;

-- Members read the links of running orders they can read, in their own orgs, without the hashes. Writes go through the
-- RPCs only.
call private.install_policies('app.showcaller_links',
  $$private.is_member(org_id) and private.can_on_project(project_id, 'show.run_of_show.read')$$);
revoke select on app.showcaller_links from authenticated;
grant select (id, org_id, project_id, run_of_show_id, caller_name, note, token_hint, expires_at, failed_attempts, open_count,
  last_opened_at, rotated_at, revoked_at, revoked_by, created_at, created_by, updated_at, updated_by, deleted_at)
  on app.showcaller_links to authenticated;
revoke insert, update, delete on app.showcaller_links from authenticated;

create or replace function private.guard_showcaller_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.in_trusted_operation('showcaller_link_service') then
    perform private.refuse('showcaller_link_immutable', 'A showcaller link is made, opened, regenerated and revoked only through its RPCs.');
  end if;
  if tg_op = 'UPDATE' and (new.run_of_show_id <> old.run_of_show_id or new.project_id <> old.project_id) then
    perform private.refuse('showcaller_link_immutable', 'A showcaller link keeps its running order; make a new link instead.');
  end if;
  if tg_op = 'UPDATE' and old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    perform private.refuse('showcaller_link_revoked', 'A revoked showcaller link stays revoked. Make a new link instead.');
  end if;
  return new;
end;
$$;

comment on function private.guard_showcaller_link() is 'Showcaller links: rows are inserted and changed only inside the showcaller link RPCs (trusted operation showcaller_link_service); a link keeps its running order, and a revoked link stays revoked.';
revoke all on function private.guard_showcaller_link() from public, anon, authenticated;

create trigger t40_guard_showcaller_link before insert or update on app.showcaller_links
  for each row execute function private.guard_showcaller_link();

-- Computed state, never stored. Runs as the caller; the device count is app.showcaller_link_devices.
create view app.showcaller_link_states with (security_invoker = true) as
select l.id,
  case
    when l.revoked_at is not null then 'Revoked'
    when l.expires_at <= now() then 'Expired'
    when l.failed_attempts >= 5 then 'Locked'
    else 'Active'
  end as link_state
from app.showcaller_links l
where l.deleted_at is null;

comment on view app.showcaller_link_states is 'State of each showcaller link, computed when read (ADR 0142): Revoked once revoked, else Expired past its expiry, else Locked after 5 wrong access codes (existing devices keep working), else Active.';
comment on column app.showcaller_link_states.id is 'Showcaller link.';
comment on column app.showcaller_link_states.link_state is 'Active, Locked, Expired or Revoked.';
revoke all on app.showcaller_link_states from public, anon;
grant select on app.showcaller_link_states to authenticated, service_role;
revoke select on app.showcaller_link_states from xos_backup;

-- Private state: channel keys, device grants and retired tokens -----------------------------------------------------------

create table private.showcaller_link_channels (
  showcaller_link_id uuid primary key references app.showcaller_links (id),
  channel_key text not null,
  created_at timestamptz not null default now(),
  constraint showcaller_link_channels_key_format check (channel_key ~ '^xcch_[0-9a-f]{64}$')
);

create unique index showcaller_link_channels_key on private.showcaller_link_channels (channel_key);
call private.describe('private.showcaller_link_channels', 'Each showcaller link''s Realtime channel key (ADR 0142, 2925). The portal joins xcall:<key>, which only the database sends to; regenerating a link draws a new key.', array[
  'showcaller_link_id', 'Showcaller link.',
  'channel_key', 'xcch_ and 256 random bits in hex; handed to the portal only after the access code and with a valid device grant.',
  'created_at', 'When the key was drawn.'
]);
alter table private.showcaller_link_channels enable row level security;
revoke all on private.showcaller_link_channels from public, anon, authenticated;
grant select on private.showcaller_link_channels to service_role;

create table private.showcaller_link_grants (
  grant_hash bytea primary key,
  showcaller_link_id uuid not null references app.showcaller_links (id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint showcaller_link_grants_hash_length check (octet_length(grant_hash) = 32)
);

create index showcaller_link_grants_link_idx on private.showcaller_link_grants (showcaller_link_id);
create index showcaller_link_grants_expires_idx on private.showcaller_link_grants (expires_at);
call private.describe('private.showcaller_link_grants', 'Device grants of showcaller links (ADR 0142): a correct access code earns the browser a grant, kept in an HttpOnly cookie, that carries its later reads and writes without the code until the link expires or 48 hours pass. At most 5 unexpired grants per link. Regenerating or revoking the link, signing its devices out, or 20 out-of-scope writes by the grant in 10 minutes delete grants. Only the SHA-256 of the grant is stored.', array[
  'grant_hash', 'SHA-256 of the grant (xcgr_ and 256 random bits in hex).',
  'showcaller_link_id', 'Showcaller link the grant opens.',
  'expires_at', 'When the grant stops working: the link''s expiry or 48 hours after the open, whichever comes first.',
  'created_at', 'When the grant was issued.'
]);
alter table private.showcaller_link_grants enable row level security;
revoke all on private.showcaller_link_grants from public, anon, authenticated;
grant select on private.showcaller_link_grants to service_role;

create table private.retired_showcaller_link_tokens (
  token_hash bytea primary key,
  retired_at timestamptz not null default now(),
  constraint retired_showcaller_link_tokens_hash_length check (octet_length(token_hash) = 32)
);

create index retired_showcaller_link_tokens_retired_idx on private.retired_showcaller_link_tokens (retired_at);
call private.describe('private.retired_showcaller_link_tokens', 'SHA-256 hashes of showcaller link tokens that were regenerated away or revoked, kept a year so a portal left open on a dead link is answered showcaller_link_invalid without counting as a failed guess against its address (as 2780).', array[
  'token_hash', 'SHA-256 of the retired token.',
  'retired_at', 'When the token was regenerated away or revoked.'
]);
alter table private.retired_showcaller_link_tokens enable row level security;
revoke all on private.retired_showcaller_link_tokens from public, anon, authenticated;
grant select on private.retired_showcaller_link_tokens to service_role;

select cron.schedule('xos_prune_showcaller_link_tokens', '47 4 * * *', $$
  delete from private.retired_showcaller_link_tokens where retired_at < now() - interval '1 year';
  delete from private.showcaller_link_grants where expires_at < now() - interval '1 day';
$$);

-- Making links ---------------------------------------------------------------------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('showcaller_link.created', 'showcaller_links', 'A showcaller link to a running order was made.'),
  ('showcaller_link.regenerated', 'showcaller_links', 'A showcaller link was regenerated: a new token and access code, and every device grant dropped.'),
  ('showcaller_link.revoked', 'showcaller_links', 'A showcaller link was revoked.')
on conflict (code) do nothing;

create or replace function private.showcaller_link_default_expiry(p_run_of_show_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select least(private.live_display_default_expiry(p_run_of_show_id), now() + interval '14 days');
$$;

comment on function private.showcaller_link_default_expiry(uuid) is 'Default expiry of a showcaller link: the display screen default (the end of the day after the show day in the project''s zone, or now plus one day for a show day already past), at most 14 days ahead.';
revoke all on function private.showcaller_link_default_expiry(uuid) from public, anon, authenticated;

create or replace function app.create_showcaller_link(
  p_run_of_show_id uuid,
  p_caller_name text,
  p_expires_at timestamptz default null,
  p_note text default null
)
returns table (showcaller_link_id uuid, token text, access_code text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_run app.run_of_show;
  v_token text := private.new_showcaller_link_token();
  v_code text := private.new_live_link_code();
  v_expires timestamptz;
  v_id uuid;
begin
  perform private.require_person();
  select * into v_run from app.run_of_show r where r.id = p_run_of_show_id and r.deleted_at is null;
  if v_run.id is null or not private.is_member(v_run.org_id)
     or v_run.project_id not in (select private.project_ids_with('show.run_of_show.read')) then
    raise exception using errcode = '42501', message = 'running order not found';
  end if;
  if not (private.can_on_project(v_run.project_id, 'show.run_of_show.write') and private.can_on_project(v_run.project_id, 'show.cue.call')) then
    perform private.refuse('showcaller_link_capability', 'Showcaller links need show.run_of_show.write and show.cue.call on the project.');
  end if;
  if private.org_read_only(v_run.org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.');
  end if;
  if char_length(btrim(coalesce(p_caller_name, ''))) not between 1 and 120 then
    perform private.refuse('showcaller_link_caller_name', 'Name the showcaller, in 1 to 120 characters.');
  end if;
  v_expires := coalesce(p_expires_at, private.showcaller_link_default_expiry(v_run.id));
  if v_expires is null or v_expires <= now() or v_expires > now() + interval '14 days' then
    perform private.refuse('showcaller_link_expiry_range', 'A showcaller link expires after now and within 14 days.');
  end if;
  if (select count(*) from app.showcaller_links l
      where l.run_of_show_id = v_run.id and l.revoked_at is null and l.deleted_at is null and l.expires_at > now()) >= 5 then
    perform private.refuse('showcaller_link_limit', 'This running order has 5 showcaller links. Revoke one before you add another.');
  end if;
  perform private.begin_trusted_operation('showcaller_link_service');
  insert into app.showcaller_links as l (run_of_show_id, caller_name, note, token_hash, token_hint, access_code_hash, expires_at)
  values (v_run.id, btrim(p_caller_name), nullif(btrim(coalesce(p_note, '')), ''), private.share_token_hash(v_token),
    right(v_token, 4), private.share_code_hash(v_token, v_code), v_expires)
  returning l.id into v_id;
  perform private.end_trusted_operation('showcaller_link_service');
  insert into private.showcaller_link_channels (showcaller_link_id, channel_key) values (v_id, private.new_showcaller_channel_key());
  perform private.emit_event(v_run.org_id, 'showcaller_link.created', 'showcaller_links', v_id, v_run.project_id,
    jsonb_build_object('run_of_show_id', v_run.id, 'expires_at', v_expires));
  return query select v_id, v_token, v_code, v_expires;
end;
$$;

comment on function app.create_showcaller_link(uuid, text, timestamptz, text) is 'Makes a showcaller link to a running order (ADR 0142): needs membership of its org and both show.run_of_show.write and show.cue.call on the project (showcaller_link_capability), an org that is not read-only, a caller name of 1 to 120 characters (showcaller_link_caller_name), an expiry after now and within 14 days (showcaller_link_expiry_range; by default the end of the day after the show in the project''s zone), and fewer than 5 live links on the running order (showcaller_link_limit). Returns the token and the 6-digit access code once; only their hashes are kept.';
revoke all on function app.create_showcaller_link(uuid, text, timestamptz, text) from public, anon;
grant execute on function app.create_showcaller_link(uuid, text, timestamptz, text) to authenticated, service_role;

-- Managing links ---------------------------------------------------------------------------------------------------------------

-- The link, locked, when the signed-in person may manage it: a member of its org who made it or holds
-- show.run_of_show.write on the project. Anyone else is told it does not exist.
create or replace function private.manageable_showcaller_link(p_showcaller_link_id uuid)
returns app.showcaller_links
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_link app.showcaller_links;
begin
  select * into v_link from app.showcaller_links l where l.id = p_showcaller_link_id and l.deleted_at is null for update;
  if v_link.id is null or not private.is_member(v_link.org_id)
     or (v_link.created_by is distinct from v_person and not private.can_on_project(v_link.project_id, 'show.run_of_show.write')) then
    raise exception using errcode = '42501', message = 'showcaller link not found';
  end if;
  return v_link;
end;
$$;

comment on function private.manageable_showcaller_link(uuid) is 'Locks and returns a showcaller link the signed-in person may manage: a member of its org who made it or holds show.run_of_show.write on the project; otherwise raises showcaller link not found.';
revoke all on function private.manageable_showcaller_link(uuid) from public, anon, authenticated;

create or replace function app.regenerate_showcaller_link(p_showcaller_link_id uuid)
returns table (token text, access_code text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_link app.showcaller_links := private.manageable_showcaller_link(p_showcaller_link_id);
  v_token text := private.new_showcaller_link_token();
  v_code text := private.new_live_link_code();
begin
  if v_link.revoked_at is not null then
    perform private.refuse('showcaller_link_revoked', 'A revoked showcaller link stays revoked. Make a new link instead.');
  end if;
  if private.org_read_only(v_link.org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.');
  end if;
  insert into private.retired_showcaller_link_tokens (token_hash) values (v_link.token_hash) on conflict do nothing;
  perform private.begin_trusted_operation('showcaller_link_service');
  update app.showcaller_links
  set token_hash = private.share_token_hash(v_token), token_hint = right(v_token, 4),
    access_code_hash = private.share_code_hash(v_token, v_code), failed_attempts = 0, rotated_at = now()
  where id = v_link.id;
  perform private.end_trusted_operation('showcaller_link_service');
  update private.showcaller_link_channels set channel_key = private.new_showcaller_channel_key(), created_at = now()
  where showcaller_link_id = v_link.id;
  delete from private.showcaller_link_grants g where g.showcaller_link_id = v_link.id;
  perform private.emit_event(v_link.org_id, 'showcaller_link.regenerated', 'showcaller_links', v_link.id, v_link.project_id,
    jsonb_build_object('run_of_show_id', v_link.run_of_show_id));
  return query select v_token, v_code, v_link.expires_at;
end;
$$;

comment on function app.regenerate_showcaller_link(uuid) is 'Regenerates a showcaller link (ADR 0142): its creator, or a holder of show.run_of_show.write on the project, gets a new token and access code once. The old token is retired (it answers showcaller_link_invalid without counting a failure), the channel key is redrawn, wrong-code attempts reset and every device grant is dropped. Refused for a revoked link and in a read-only org.';
revoke all on function app.regenerate_showcaller_link(uuid) from public, anon;
grant execute on function app.regenerate_showcaller_link(uuid) to authenticated, service_role;

create or replace function app.revoke_showcaller_link(p_showcaller_link_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_link app.showcaller_links := private.manageable_showcaller_link(p_showcaller_link_id);
begin
  if v_link.revoked_at is not null then
    return v_link.revoked_at;
  end if;
  insert into private.retired_showcaller_link_tokens (token_hash) values (v_link.token_hash) on conflict do nothing;
  perform private.begin_trusted_operation('showcaller_link_service');
  update app.showcaller_links set revoked_at = now(), revoked_by = v_person where id = v_link.id;
  perform private.end_trusted_operation('showcaller_link_service');
  delete from private.showcaller_link_grants g where g.showcaller_link_id = v_link.id;
  perform private.emit_event(v_link.org_id, 'showcaller_link.revoked', 'showcaller_links', v_link.id, v_link.project_id,
    jsonb_build_object('run_of_show_id', v_link.run_of_show_id));
  return now();
end;
$$;

comment on function app.revoke_showcaller_link(uuid) is 'Revokes a showcaller link so it never opens or writes again (ADR 0142): its creator, or a holder of show.run_of_show.write on the project, may. Retires the token and drops every device grant. Idempotent: a revoked link answers its first revocation time. Allowed in a read-only org, since it withdraws access.';
revoke all on function app.revoke_showcaller_link(uuid) from public, anon;
grant execute on function app.revoke_showcaller_link(uuid) to authenticated, service_role;

-- The cues called through a link -------------------------------------------------------------------------------------------------

alter table app.cues add column called_via_link_id uuid references app.showcaller_links (id);
create index cues_called_via_link_idx on app.cues (called_via_link_id);
call private.add_cross_org_references('app.cues', array['app.showcaller_links', 'called_via_link_id']);
comment on column app.cues.called_via_link_id is 'Showcaller link the cue was called through (ADR 0142), stamped by the database; then called_by is null. Never accepted from the caller and never changed.';

alter table app.cues drop constraint cues_called_pair;
alter table app.cues add constraint cues_called_pair check (
  (called_at is null) = (called_by is null and called_via_link_id is null)
  and (called_by is null or called_via_link_id is null));

-- From its latest definition (2792), with the showcaller link stamps.
create or replace function private.guard_cue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_via_link boolean := private.in_trusted_operation('showcaller_link');
begin
  if tg_op = 'UPDATE' and new.run_of_show_id <> old.run_of_show_id then
    perform private.refuse('cue_run_of_show_immutable', 'A cue stays in its running order.');
  end if;
  -- The link a call came through is the database's: never sent by a caller, never changed afterwards.
  if tg_op = 'INSERT' and new.called_via_link_id is not null then
    perform private.refuse('cue_called_via_link', 'A cue is called through a showcaller link only by the link.');
  elsif tg_op = 'UPDATE' then
    new.called_via_link_id := old.called_via_link_id;
  end if;
  if new.standby_at is not null and (tg_op = 'INSERT' or old.standby_at is distinct from new.standby_at) then
    if new.called_at is not null or (tg_op = 'UPDATE' and old.called_at is not null) then
      perform private.refuse('cue_standby_called', 'A called cue cannot go on standby.');
    end if;
    if auth.uid() is not null and not v_via_link
       and not private.can_on_project((select r.project_id from app.run_of_show r where r.id = new.run_of_show_id), 'show.cue.call') then
      perform private.refuse('cue_standby_capability', 'Only a person who may call cues on the project puts a cue on standby.');
    end if;
    new.standby_at := now();
  end if;
  if new.called_at is not null and (tg_op = 'INSERT' or old.called_at is null) then
    if v_via_link then
      -- The showcaller link RPCs (2924) checked the link, its grant and its creator's access.
      new.called_at := now();
      new.called_by := null;
      new.called_via_link_id := nullif(current_setting('xos.showcaller_link_id', true), '')::uuid;
    else
      if auth.uid() is not null
         and not private.can_on_project((select r.project_id from app.run_of_show r where r.id = new.run_of_show_id), 'show.cue.call') then
        perform private.refuse('cue_call_capability', 'Only a person who may call cues on the project calls a cue.');
      end if;
      new.called_at := now();
      new.called_by := private.current_person_id();
      new.called_via_link_id := null;
    end if;
  elsif tg_op = 'UPDATE' and old.called_at is not null then
    new.called_at := old.called_at;
    new.called_by := old.called_by;
  end if;
  return new;
end;
$$;

comment on function private.guard_cue() is 'Cues stay in their running order; a cue is called once and stamped with the database time and either the person, who must hold show.cue.call on the project, or, inside the showcaller link RPCs (trusted operation showcaller_link), the link and no person (2923). The link is never sent by a caller and never changes. Putting an uncalled cue on standby also needs show.cue.call (or the showcaller link RPCs) and is stamped with the database time; clearing a standby needs only the row''s update policy.';

-- The cue.called events name the link (from 0412).
drop trigger t90_emit_cue_called_insert on app.cues;
drop trigger t90_emit_cue_called on app.cues;
create trigger t90_emit_cue_called_insert after insert on app.cues
  for each row when (new.called_at is not null)
  execute function private.emit_row_event('cue.called', 'project_id', 'run_of_show_id', 'position', 'label', 'called_at', 'called_via_link_id');
create trigger t90_emit_cue_called after update of called_at on app.cues
  for each row when (old.called_at is null and new.called_at is not null)
  execute function private.emit_row_event('cue.called', 'project_id', 'run_of_show_id', 'position', 'label', 'called_at', 'called_via_link_id');

-- Device count and portal heading ----------------------------------------------------------------------------------------------------

create or replace function app.showcaller_link_devices(p_showcaller_link_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
  v_link app.showcaller_links;
begin
  select * into v_link from app.showcaller_links l where l.id = p_showcaller_link_id and l.deleted_at is null;
  if v_person is null or v_link.id is null or not private.is_member(v_link.org_id)
     or (v_link.created_by is distinct from v_person and not private.can_on_project(v_link.project_id, 'show.run_of_show.write')) then
    raise exception using errcode = '42501', message = 'showcaller link not found';
  end if;
  return (select count(*)::integer from private.showcaller_link_grants g
          where g.showcaller_link_id = v_link.id and g.expires_at > now());
end;
$$;

comment on function app.showcaller_link_devices(uuid) is 'How many devices hold an unexpired grant of a showcaller link (at most 5), for the links list. Answers only someone who may manage the link: a member of its org who made it or holds show.run_of_show.write on the project.';
revoke all on function app.showcaller_link_devices(uuid) from public, anon;
grant execute on function app.showcaller_link_devices(uuid) to authenticated, service_role;

create or replace function app.sign_out_showcaller_devices(p_showcaller_link_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_link app.showcaller_links := private.manageable_showcaller_link(p_showcaller_link_id);
  v_count integer;
begin
  delete from private.showcaller_link_grants g where g.showcaller_link_id = v_link.id;
  get diagnostics v_count = row_count;
  perform private.write_audit_event(v_link.org_id, 'showcaller_link.signed_out', 'app.showcaller_links', v_link.id,
    jsonb_build_object('devices', v_count));
  perform private.live_link_ping(array(
    select 'xcall:' || c.channel_key from private.showcaller_link_channels c where c.showcaller_link_id = v_link.id));
  return v_count;
end;
$$;

comment on function app.sign_out_showcaller_devices(uuid) is 'Signs every device out of a showcaller link (ADR 0142): drops its grants, so each device must enter the code again, writes an audit event and pings the portal. Its creator, or a holder of show.run_of_show.write on the project, may, also in a read-only org. Returns how many grants were dropped.';
revoke all on function app.sign_out_showcaller_devices(uuid) from public, anon;
grant execute on function app.sign_out_showcaller_devices(uuid) to authenticated, service_role;

create or replace function private.showcaller_link_meta(p_link app.showcaller_links)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'project_name', p.name,
    'time_zone', coalesce(nullif(btrim(p.time_zone), ''), private.calendar_feed_setting(p_link.org_id, null, 'locale.time_zone'), 'UTC'),
    'brand_name', coalesce(b.display_name, o.name),
    'brand_logo_light_path', b.logo_light_path,
    'brand_logo_dark_path', b.logo_dark_path,
    'brand_accent_hex', b.accent_hex,
    'brand_suppress_powered_by', coalesce(b.suppress_powered_by, false),
    'caller_name', p_link.caller_name,
    'expires_at', p_link.expires_at)
  from app.projects p
  join app.organizations o on o.id = p_link.org_id
  left join app.org_brands b on b.org_id = p_link.org_id and b.deleted_at is null
  where p.id = p_link.project_id;
$$;

comment on function private.showcaller_link_meta(app.showcaller_links) is 'Heading of a showcaller portal: the project''s name and zone (else the org''s locale.time_zone, else UTC), the org brand''s Public columns (name, logos, accent, whether Powered by XOS is suppressed), the caller name and the link''s expiry. Never the link''s note.';
revoke all on function private.showcaller_link_meta(app.showcaller_links) from public, anon, authenticated;

-- Trash (ADR 0110) ----------------------------------------------------------------------------------------------------------------

insert into private.trash_excluded_tables (table_name, rationale) values
  ('showcaller_links', 'A revoked or regenerated showcaller link never opens again; a new link is made instead.')
on conflict (table_name) do nothing;

select private.sync_trash_tables();
